import { api, getSession, errorText } from './account-client.js';

const $ = id => document.getElementById(id);
const pane = $('spotifySdk');
const audio = $('audioPlayer');
let user = null;
let connection = null;
let player = null;
let deviceId = null;
let playback = null;
let generation = 0;
let busy = false;
let sdkScript = null;
let sdkPending = null;
let pendingConnection = null;
let pollPending = false;
let revoking = false;
let oauthPending = false;
let activationNeeded = false;
let playbackIssue = '';
const previewNotice = 'Die Spotify-Anmeldung ist in dieser lokalen Vorschau deaktiviert.';
function message(text, error = false) {
  $('spotifySdkStatus').textContent = text;
  $('spotifySdkStatus').classList.toggle('is-error', error);
}
function sdkDiagnostic(event, detail) {
  const code = event === 'initialization_error' ? 'SPOTIFY_INIT' : 'SPOTIFY_PLAYBACK';
  // Only a bounded message is considered; never serialize SDK objects, tokens or URLs.
  let text = typeof detail?.message === 'string' && detail.message.length <= 2048 ? detail.message : '';
  try { text = decodeURIComponent(text); } catch { /* Also remove encoded values below. */ }
  if (/%[a-f0-9]{2}/i.test(text)) text = ''; // Do not expose nested or partially encoded values.
  text = text.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ' ')
    .replace(/\\\//g, '/')
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"']+|\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\bspotify:[^\s<>"']+/gi, '[Adresse entfernt]')
    .replace(/[^\s<>"'(),;:=/]+@[^\s<>"'(),;:=/]+/g, '[E-Mail entfernt]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[Zugang entfernt]')
    .replace(/\b(?:authorization|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|client[_ -]?secret|password|code_verifier|api[_ -]?key)\b["']?\s*(?:[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[Zugang entfernt]')
    .replace(/"[^"]*"|'[^']*'/g, '[Wert entfernt]')
    .replace(/[A-Za-z0-9_.~+/=-]{16,}|\b\d{6,}\b|(?:%[a-f0-9]{2})+/gi, '[Wert entfernt]')
    .replace(/\s+/g, ' ').trim();
  if (text.length > 180) text = text.slice(0, 177) + '…';
  return ` Diagnose ${code}${text ? ': ' + text : ': Spotify hat keine sicher darstellbaren Details geliefert.'}`;
}
function allowedAccount() { return Boolean(user?.confirmed && !user.suspended); }
function consent() { return window.CBConsent?.allowsSpotify() === true; }
function formatTime(ms) {
  const seconds = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function controls() {
  const eligible = allowedAccount() && connection?.configured && !connection?.previewOnly && !revoking;
  $('spotifySdkConnect').hidden = Boolean(connection?.connected);
  $('spotifySdkConnect').disabled = busy || !eligible;
  $('spotifySdkStart').hidden = !connection?.connected || Boolean(player);
  $('spotifySdkStart').disabled = busy || !eligible;
  $('spotifySdkStop').hidden = !player;
  $('spotifySdkUnlink').hidden = !connection?.connected;
  $('spotifySdkUnlink').disabled = revoking;
  $('spotifySdkRefresh').disabled = busy;
  $('spotifySdkTransport').hidden = !player;
  const ready = !busy && eligible && Boolean(deviceId && player);
  const disallows = playback?.disallows || {};
  $('spotifySdkPlay').disabled = !ready || (!playback && !activationNeeded) || (playback?.paused !== false ? disallows.resuming : disallows.pausing) === true;
  $('spotifySdkPlay').textContent = playback && !playback.paused ? 'Pause' : 'Abspielen';
  $('spotifySdkPrevious').disabled = !ready || !playback || disallows.skipping_prev === true;
  $('spotifySdkNext').disabled = !ready || !playback || disallows.skipping_next === true;
  $('spotifySdkSeek').disabled = !ready || !playback?.duration || disallows.seeking === true;
  $('spotifySdkVolume').disabled = !ready;
  $('spotifySdkLinkPlay').disabled = !ready;
  $('spotifySdkUrl').disabled = !ready;
  $('spotifySdkLogin').hidden = allowedAccount();
  $('spotifySdkAdmin').hidden = !allowedAccount() || user.isAdmin !== true;
  $('spotifySdkPreview').hidden = !connection?.previewOnly;
  $('spotifySdkIdentity').textContent = connection?.connected
    ? `Verbunden mit ${connection.spotifyUser?.displayName || 'deinem Spotify-Konto'}.`
    : 'Noch kein Spotify-Konto verbunden.';
}
function renderPlayback(state) {
  playback = state;
  const track = state?.track_window?.current_track;
  $('spotifySdkTrack').textContent = track?.name || 'Noch kein Titel auf diesem Player';
  $('spotifySdkArtist').textContent = track?.artists?.map(artist => artist.name).filter(Boolean).join(', ') || 'Starte einen Titel, ein Album oder eine Playlist über den Spotify-Link.';
  const trackId = /^spotify:track:([A-Za-z0-9]{22})$/.exec(track?.uri || '')?.[1];
  $('spotifySdkTrackLink').hidden = !trackId;
  if (trackId) $('spotifySdkTrackLink').href = `https://open.spotify.com/track/${trackId}`;
  else $('spotifySdkTrackLink').removeAttribute('href');
  $('spotifySdkSeek').max = String(state?.duration || 1);
  $('spotifySdkSeek').value = String(state?.position || 0);
  $('spotifySdkPosition').textContent = formatTime(state?.position);
  $('spotifySdkDuration').textContent = formatTime(state?.duration);
  controls();
}
function localStop(text) {
  generation++;
  const old = player;
  player = null; deviceId = null; playback = null; activationNeeded = false; playbackIssue = '';
  if (pendingConnection) pendingConnection.cancel();
  if (old) {
    try { Promise.resolve(old.pause()).catch(() => {}); } catch { /* Disconnect still proceeds. */ }
    try { old.disconnect(); } catch { /* Local UI must be cleared even after SDK failure. */ }
  }
  if (sdkPending) sdkPending.cancel();
  sdkScript?.remove(); sdkScript = null;
  document.querySelectorAll('iframe[src]').forEach(frame => {
    try { if (new URL(frame.src, window.location.href).origin === 'https://sdk.scdn.co') frame.remove(); }
    catch { /* Other page frames remain untouched. */ }
  });
  renderPlayback(null);
  if (text) message(text);
}
async function refresh() {
  let epoch = generation;
  const previousId = user?.id;
  const session = await getSession();
  if (epoch !== generation) return false;
  user = session.user;
  if (previousId && previousId !== user?.id) { localStop(); epoch = generation; }
  if (!allowedAccount()) {
    connection = null; localStop();
    message(user?.suspended ? 'Dein Websitekonto ist gesperrt.' : user && !user.confirmed ? 'Bitte bestätige zuerst deine E-Mail-Adresse.' : 'Melde dich mit deinem bestätigten Websitekonto an, um dein Spotify-Konto zu verbinden.');
    controls(); return false;
  }
  const status = await api('/api/spotify/status');
  if (epoch !== generation) return false;
  connection = status;
  if ((player || sdkPending) && (!connection.connected || connection.previewOnly || !connection.configured)) localStop();
  controls();
  if (connection.previewOnly) message(previewNotice);
  else if (!connection.configured) message('Spotify ist für diese Website noch nicht eingerichtet. Der vorhandene Musikplayer bleibt verfügbar.');
  else if (player && playbackIssue) message(playbackIssue, true);
  else if (connection.connected) message(player && deviceId ? 'Spotify-Player bereit.' : 'Spotify-Konto verbunden. Klicke auf „Spotify-Player starten“, um die Wiedergabe hier zu laden.');
  else message('Verbinde dein eigenes Spotify-Konto. Für die Wiedergabe im Browser wird Spotify Premium benötigt.');
  return true;
}
async function run(action) {
  if (busy) return;
  busy = true; pane.setAttribute('aria-busy', 'true'); controls();
  try { await action(); }
  catch (error) {
    if (error.status === 401 || (error.status === 403 && ['suspended', 'forbidden'].includes(error.code))) { connection = null; user = null; localStop(); }
    message(errorText(error), true);
  } finally { busy = false; pane.setAttribute('aria-busy', 'false'); controls(); }
}
async function requireConnection() {
  const epoch = generation;
  if (revoking) return false;
  if (!consent()) {
    message('Erlaube Spotify in den Cookie-Einstellungen und klicke anschließend erneut auf die gewünschte Spotify-Aktion.');
    window.CBConsent?.openSettings(); return false;
  }
  if (!await refresh() || epoch !== generation || revoking || !connection?.configured || connection.previewOnly) return false;
  return consent();
}
function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (sdkPending) return sdkPending.promise;
  let finish;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Der Spotify-Player konnte nicht geladen werden. Prüfe deine Verbindung und erlaube die Wiedergabe in deinem Browser.')), 20000);
    finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (window.onSpotifyWebPlaybackSDKReady === ready) delete window.onSpotifyWebPlaybackSDKReady;
      sdkPending = null;
      if (error) { sdkScript?.remove(); sdkScript = null; reject(error); } else resolve();
    };
    const ready = () => window.Spotify?.Player ? finish() : finish(new Error('Spotify hat keinen verwendbaren Browserplayer bereitgestellt.'));
    window.onSpotifyWebPlaybackSDKReady = ready;
    sdkScript = document.createElement('script');
    sdkScript.src = 'https://sdk.scdn.co/spotify-player.js';
    sdkScript.async = true;
    sdkScript.addEventListener('error', () => finish(new Error('Der Spotify-Player wird vom Browser oder der Verbindung blockiert.')), { once: true });
    document.head.append(sdkScript);
  });
  sdkPending = { promise, cancel: () => finish(new Error('Das Laden des Spotify-Players wurde beendet.')) };
  return promise;
}
function acceptState(state, instance, epoch) {
  if (instance !== player || epoch !== generation || !consent()) return;
  if (playbackIssue) { message(playbackIssue, true); return; }
  if (state && !state.paused) {
    activationNeeded = false;
    audio.pause();
    window.dispatchEvent(new CustomEvent('cb-spotify-sdk-playing'));
    message('Spotify spielt auf diesem Browserplayer.');
  } else if (state) message('Spotify ist pausiert.');
  renderPlayback(state);
}
function connectSdk(instance) {
  let finish;
  const pending = { cancel: () => finish(new Error('Die Spotify-Verbindung wurde beendet.')) };
  pendingConnection = pending;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Spotify antwortet nicht auf den Verbindungsversuch. Bitte starte den Player erneut.')), 20000);
    finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (pendingConnection === pending) pendingConnection = null;
      if (error) reject(error); else resolve(value);
    };
    try { Promise.resolve(instance.connect()).then(value => finish(null, value), error => finish(error)); }
    catch (error) { finish(error); }
  });
}
async function start() {
  const intent = generation;
  if (!await requireConnection() || intent !== generation || !connection.connected) return;
  localStop();
  const epoch = generation;
  message('Spotify-Player wird geladen …');
  try { await loadSdk(); }
  catch (error) { if (epoch === generation) throw error; return; }
  if (epoch !== generation || !consent()) return;
  const instance = new window.Spotify.Player({
    name: 'Crazy_Batto Webplayer', volume: Number($('spotifySdkVolume').value) / 100,
    getOAuthToken: callback => {
      if (epoch !== generation || !consent()) return;
      api('/api/spotify/token', { method: 'POST', body: {} }).then(result => {
        if (epoch !== generation || instance !== player || !consent()) return;
        if (typeof result.accessToken !== 'string' || !result.accessToken) throw new Error('Spotify hat keinen Wiedergabezugang bereitgestellt.');
        callback(result.accessToken);
        // Tokens remain only in this callback and the Spotify SDK, never in browser storage.
      }).catch(error => {
        if (epoch !== generation) return;
        localStop(); message(errorText(error), true);
      });
    },
  });
  player = instance;
  const current = () => instance === player && epoch === generation;
  instance.addListener('ready', ({ device_id }) => {
    if (!current() || !consent()) return;
    deviceId = device_id;
    message(playbackIssue || 'Spotify-Player bereit. Füge einen Spotify-Link ein und starte die Wiedergabe.', Boolean(playbackIssue)); controls();
  });
  instance.addListener('not_ready', () => { if (current()) { deviceId = null; renderPlayback(null); message('Der Spotify-Player ist momentan nicht erreichbar. Beende ihn und starte ihn erneut.', true); } });
  instance.addListener('player_state_changed', state => acceptState(state, instance, epoch));
  const errors = {
    initialization_error: 'Dein Browser unterstützt die Spotify-Wiedergabe nicht oder blockiert geschützte Medien.',
    authentication_error: 'Spotify konnte deine Verbindung nicht bestätigen. Trenne das Konto und verbinde es erneut.',
    account_error: 'Spotify erlaubt die Wiedergabe für dieses Konto nicht. Prüfe Spotify Premium, die Nutzerfreigabe im Development Mode und die Spotify-Berechtigungen.',
  };
  Object.entries(errors).forEach(([event, text]) => instance.addListener(event, detail => {
    if (!current()) return;
    localStop();
    message(text + (event === 'initialization_error' ? sdkDiagnostic(event, detail) : ''), true);
  }));
  instance.addListener('playback_error', detail => {
    if (!current()) return;
    playbackIssue = 'Spotify konnte diesen Inhalt nicht abspielen. Versuche einen anderen Titel. Falls das erneut passiert, beende und starte den Player.' + sdkDiagnostic('playback_error', detail);
    renderPlayback(null);
    message(playbackIssue, true);
  });
  instance.addListener('autoplay_failed', () => { if (current()) { activationNeeded = true; controls(); if (!playbackIssue) message('Dein Browser benötigt einen weiteren Klick auf „Abspielen“, um den Ton zu starten.'); } });
  controls();
  try {
    const connected = await connectSdk(instance);
    if (current() && connected !== true) throw new Error('Der Spotify-Player konnte keine Verbindung herstellen.');
  } catch (error) { if (!current()) return; localStop(); throw error; }
}
async function unlink(fromConsent = false) {
  if (revoking) return;
  revoking = true;
  localStop(fromConsent ? 'Spotify wurde durch deine Cookie-Auswahl gestoppt. Die Kontoverbindung wird entfernt …' : 'Spotify wird getrennt …');
  controls();
  try {
    const session = await getSession(); user = session.user;
    if (!user) {
      connection = null;
      message('Der Spotify-Player ist gestoppt. Melde dich wieder mit deinem Websitekonto an, um auch die gespeicherte Spotify-Verbindung zu entfernen.', true);
      return;
    }
    await api('/api/spotify/disconnect', { method: 'POST', body: {} });
    connection = connection ? { ...connection, connected: false, spotifyUser: null } : null;
    message(fromConsent ? 'Spotify ist gestoppt und die Verbindung auf dieser Website wurde entfernt.' : 'Spotify-Konto auf dieser Website getrennt. Eine Freigabe bei Spotify selbst kannst du zusätzlich in deinen Spotify-Appberechtigungen entfernen.');
  } catch (error) {
    message(`Der Player ist gestoppt. Die gespeicherte Kontoverbindung konnte noch nicht entfernt werden: ${errorText(error)} Bitte erneut „Spotify-Konto trennen“ wählen.`, true);
  } finally { revoking = false; controls(); }
}
function activate() {
  if (!player || !consent()) return;
  try { Promise.resolve(player.activateElement()).catch(() => {}); } catch { /* Playback reports a useful error if activation fails. */ }
}
async function command(action, retryPlayback = false) {
  if (!player || !deviceId || !consent()) return;
  const instance = player; const epoch = generation;
  if (retryPlayback) playbackIssue = '';
  await action(instance);
  if (instance !== player || epoch !== generation) return;
  const state = await instance.getCurrentState(); acceptState(state, instance, epoch);
}
$('spotifySdkRefresh').addEventListener('click', () => run(refresh));
$('spotifySdkConnect').addEventListener('click', () => run(async () => {
  oauthPending = true;
  try {
    const intent = generation;
    if (!await requireConnection() || intent !== generation) return;
    const epoch = generation;
    const result = await api('/api/spotify/connect', { method: 'POST', body: {} });
    const target = new URL(result.authorizationUrl);
    if (target.protocol !== 'https:' || target.hostname !== 'accounts.spotify.com' || target.pathname !== '/authorize' || target.username || target.password || target.port) throw new Error('Die Spotify-Anmeldeadresse konnte nicht bestätigt werden.');
    if (epoch !== generation || !consent()) return;
    window.location.assign(target.href);
  } finally { oauthPending = false; }
}));
$('spotifySdkStart').addEventListener('click', () => run(start));
$('spotifySdkStop').addEventListener('click', () => localStop('Spotify-Player beendet. Dein Spotify-Konto bleibt auf dieser Website verbunden.'));
$('spotifySdkUnlink').addEventListener('click', () => unlink());
$('spotifySdkPlay').addEventListener('click', () => { activate(); const resume = playback?.paused !== false; run(() => command(instance => resume ? instance.resume() : instance.pause(), resume)); });
$('spotifySdkPrevious').addEventListener('click', () => { activate(); run(() => command(instance => instance.previousTrack(), true)); });
$('spotifySdkNext').addEventListener('click', () => { activate(); run(() => command(instance => instance.nextTrack(), true)); });
$('spotifySdkSeek').addEventListener('change', event => { const position = Number(event.target.value); run(() => command(instance => instance.seek(position))); });
$('spotifySdkVolume').addEventListener('input', event => { $('spotifySdkVolumeValue').textContent = `${event.target.value} %`; });
$('spotifySdkVolume').addEventListener('change', event => { const volume = Number(event.target.value) / 100; run(() => command(instance => instance.setVolume(volume))); });
$('spotifySdkLinkForm').addEventListener('submit', event => {
  event.preventDefault(); activate();
  if (!event.currentTarget.reportValidity()) return;
  run(async () => {
    if (!player || !deviceId || !consent()) return;
    const epoch = generation;
    playbackIssue = '';
    message('Wiedergabe wird bei Spotify angefordert …');
    await api('/api/spotify/play', { method: 'POST', body: { uri: $('spotifySdkUrl').value.trim(), deviceId } });
    if (epoch === generation && !playbackIssue) message('Wiedergabe bei Spotify angefordert. Der Player bestätigt den tatsächlichen Start.');
  });
});
audio.addEventListener('play', () => { if (player || sdkPending) localStop('Spotify-Player beendet, damit deine eigene Musik abgespielt werden kann.'); });
window.addEventListener('cb-spotify-embed-loading', () => { if (player || sdkPending) localStop('Spotify-Player beendet. Die Einbettung wird separat geöffnet.'); });
window.addEventListener('cb-consent-change', event => {
  if (event.detail?.spotify !== false) return;
  if (player || sdkPending || connection?.connected || oauthPending) unlink(true);
});
window.addEventListener('pagehide', () => localStop());
setInterval(async () => {
  if (pollPending || !player || !playback || playback.paused || document.visibilityState !== 'visible') return;
  const instance = player; const epoch = generation; pollPending = true;
  try { acceptState(await instance.getCurrentState(), instance, epoch); }
  catch { /* SDK error events and explicit controls report connection failures. */ }
  finally { pollPending = false; }
}, 1500);
run(async () => {
  await refresh();
  if (connection?.connected && !consent()) await unlink(true);
  const url = new URL(window.location.href);
  const callback = url.searchParams.get('spotify');
  if (callback) {
    url.searchParams.delete('spotify'); window.history.replaceState(null, '', url);
    if (callback === 'error') message('Spotify konnte nicht verbunden werden. Prüfe die Freigabe deines Kontos und versuche die Verbindung erneut.', true);
    else if (callback === 'connected' && connection?.connected) message('Dein Spotify-Konto ist verbunden. Starte den Spotify-Player mit einem Klick.');
  }
});
