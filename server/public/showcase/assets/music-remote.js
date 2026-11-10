import { api, getSession, login, logout, errorText } from './account-client.js';

const $ = id => document.getElementById(id);
// Presentation only: Android delegates the OAuth start link to the browser.
// All account and Discord permissions are checked independently by the server.
if (new URLSearchParams(location.search).get('native') === '1') {
  document.querySelectorAll('a[target="_blank"]').forEach(link => link.removeAttribute('target'));
  document.getElementById('musicApkSection').hidden = true;
}
let session = { user: null }, snapshot = null, busy = false, fresh = false;
let refreshPending = false, refreshAgain = false, refreshTimer, linkTimer, linkFlow = null, linkPolling = false;
let selectedPlaylist = 'all', selectedChannel = '', currentPage = 'player', requestGeneration = 0;

function feedback(text = '', error = false) {
  $('feedback').textContent = text;
  $('feedback').classList.toggle('error', error);
}
function node(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text;
  if (className) el.className = className;
  return el;
}
function iconButton(icon, label, handler) {
  const button = node('button', '', 'icon-button'); button.type = 'button'; button.setAttribute('aria-label', label);
  const image = document.createElement('img'); image.src = 'assets/player-icons/' + icon + '.svg'; image.alt = '';
  button.append(image); button.disabled = !canControl(); button.addEventListener('click', handler); return button;
}
function canControl() { return Boolean(fresh && !busy && snapshot?.permissions?.canControl); }
function setBusy(value) { busy = value; renderControls(); renderAccount(); }
function finishMutation() { requestGeneration++; setBusy(false); void refresh(); }
function showPage(name) {
  currentPage = name; $('playerPage').hidden = name !== 'player'; $('accountPage').hidden = name !== 'account';
  for (const [id, active] of [['navPlayer', name === 'player'], ['navAccount', name === 'account']]) {
    if (active) $(id).setAttribute('aria-current', 'page'); else $(id).removeAttribute('aria-current');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
}
function playlistTracks() {
  const tracks = snapshot?.library?.tracks || [];
  if (selectedPlaylist === 'all') return tracks;
  const ids = snapshot?.library?.playlists?.find(p => p.id === selectedPlaylist)?.trackIds || [];
  const byId = new Map(tracks.map(t => [t.id, t])); return ids.map(id => byId.get(id)).filter(Boolean);
}
function renderControls() {
  const bot = snapshot?.bot, connected = Boolean(bot?.connected), current = Boolean(bot?.currentTrack || bot?.track);
  const allowed = canControl();
  $('playPause').disabled = !allowed || (!current && !playlistTracks().length);
  const pausing = current && !bot?.paused;
  $('playIcon').src = 'assets/player-icons/' + (pausing ? 'pause' : 'play') + '.svg';
  $('playPause').setAttribute('aria-label', pausing ? 'Pausieren' : current ? 'Fortsetzen' : 'Playlist abspielen');
  $('previous').disabled = !allowed || !connected || !current || bot.position <= 1;
  $('next').disabled = !allowed || !connected || !current;
  $('stop').disabled = !allowed || !connected;
  $('volume').disabled = !allowed;
  $('voiceChannel').disabled = busy || !fresh || !(snapshot?.channels?.length);
  $('playlist').disabled = busy || !snapshot?.library;
  $('refresh').disabled = busy;
  for (const button of document.querySelectorAll('.track-row button')) button.disabled = !allowed;
}
function renderAccount() {
  const user = session.user;
  $('loginForm').hidden = Boolean(user); $('signedIn').hidden = !user;
  $('accountName').textContent = user?.name || '';
  $('accountEmail').textContent = user?.email || '';
  $('loginForm').querySelectorAll('input,button').forEach(el => { el.disabled = busy; });
  $('logout').disabled = busy;
  const linked = snapshot?.discord?.linked === true;
  $('discordName').textContent = linked ? 'Verbunden mit ' + (snapshot.discord.user?.displayName || snapshot.discord.user?.username || 'deinem Discord-Konto') : 'Noch kein Discord-Konto verbunden.';
  $('linkDiscord').hidden = linked || Boolean(linkFlow); $('unlinkDiscord').hidden = !linked;
  $('linkDiscord').disabled = busy || !fresh || snapshot?.approved === false; $('unlinkDiscord').disabled = busy || !fresh;
  $('cancelLink').disabled = busy; $('linkFlow').hidden = !linkFlow;
}
function renderTracks() {
  const query = $('search').value.trim().toLocaleLowerCase('de');
  const list = playlistTracks().filter(t => (t.title + ' ' + (t.artist || '')).toLocaleLowerCase('de').includes(query));
  const fragment = document.createDocumentFragment();
  for (const [index, track] of list.entries()) {
    const row = node('article', '', 'track-row' + (snapshot?.bot?.currentTrack?.id === track.id ? ' current' : ''));
    const info = node('div', '', 'track-info'); info.append(node('h3', track.title || 'Ohne Titel'));
    info.append(node('p', [track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ')));
    row.append(node('span', String(index + 1).padStart(2, '0'), 'track-number'), info,
      iconButton('plus', track.title + ' zur Warteschlange hinzufügen', () => control({ action: 'queue', playlistId: selectedPlaylist, trackId: track.id, channelId: selectedChannel })),
      iconButton('play', track.title + ' abspielen', () => control({ action: 'play', playlistId: selectedPlaylist, trackId: track.id, channelId: selectedChannel })));
    fragment.append(row);
  }
  $('trackList').replaceChildren(fragment); $('libraryEmpty').hidden = list.length > 0;
  $('libraryEmpty').textContent = !session.user ? 'Deine Musik erscheint nach der Anmeldung hier.' : !snapshot ? 'Die Bibliothek ist gerade nicht verfügbar.' : query ? 'Keine passenden Titel gefunden.' : 'Deine Musik erscheint hier.';
  const queue = snapshot?.queue || [], queueFragment = document.createDocumentFragment();
  for (const track of queue) {
    const row = node('article', '', 'track-row' + (track.current ? ' current' : ''));
    const info = node('div', '', 'track-info'); info.append(node('h3', track.title || 'Ohne Titel'), node('p', [track.current ? 'Aktueller Titel' : '', track.artist, formatDuration(track.duration)].filter(Boolean).join(' · ')));
    row.append(node('span', String(track.position), 'track-number'), info); queueFragment.append(row);
  }
  $('queueList').replaceChildren(queueFragment); $('queueEmpty').hidden = queue.length > 0;
  $('queueCount').textContent = queue.length ? String(queue.length) : '';
}
function render() {
  const bot = snapshot?.bot;
  $('guildName').hidden = !snapshot?.guild?.name; $('guildName').textContent = snapshot?.guild?.name || '';
  const channels = snapshot?.channels || [];
  if (!channels.some(c => c.id === selectedChannel)) selectedChannel = snapshot?.permissions?.voiceChannelId || '';
  const placeholder = node('option', 'Kanal auswählen'); placeholder.value = '';
  $('voiceChannel').replaceChildren(placeholder, ...channels.map(channel => {
    const option = node('option', channel.name + (channel.joined ? ' · Du bist hier' : '') + (channel.botCanJoin ? '' : ' · Bot-Rechte fehlen'));
    option.value = channel.id; option.disabled = channel.botCanJoin === false; return option;
  }));
  $('voiceChannel').value = selectedChannel;
  $('connectionState').dataset.state = !fresh ? 'unknown' : bot?.connected ? 'ready' : bot?.message ? 'error' : 'unknown';
  $('connectionText').textContent = !fresh ? 'Status noch nicht verfügbar' : bot?.message ? 'Wiedergabe fehlgeschlagen' : bot?.connected ? (bot.paused ? 'Wiedergabe pausiert' : 'Mit Sprachkanal verbunden') : snapshot?.permissions?.canControl ? 'Bereit für Musik' : 'Noch nicht verbunden';
  $('permissionNote').textContent = !session.user ? 'Melde dich unter „Konto“ an, um den Musikbot zu steuern.' : !fresh ? 'Verbindung unterbrochen. Die Steuerung wird nach dem nächsten Abruf wieder freigegeben.' : snapshot?.permissions?.reason || bot?.message || snapshot?.storage?.message || 'Die Musik läuft in eurem Discord-Sprachkanal.';
  $('currentTitle').textContent = bot?.currentTrack?.title || bot?.track || 'Noch kein Titel';
  $('currentArtist').textContent = bot?.currentTrack?.artist || (bot?.track ? '' : 'Wähle Musik aus deiner Bibliothek.');
  $('queuePosition').hidden = !bot?.track; $('queuePosition').textContent = bot?.track ? 'Titel ' + bot.position + ' von ' + bot.total : '';
  if (document.activeElement !== $('volume')) $('volume').value = String(bot?.volume ?? 50);
  $('volumeValue').textContent = Number.isFinite(bot?.volume) ? bot.volume + ' %' : '–';
  const playlists = snapshot?.library?.playlists || [];
  if (selectedPlaylist !== 'all' && !playlists.some(p => p.id === selectedPlaylist)) selectedPlaylist = 'all';
  const all = node('option', 'Alle Titel'); all.value = 'all';
  $('playlist').replaceChildren(all, ...playlists.filter(p => p.id !== 'all').map(p => { const option = node('option', p.name); option.value = p.id; return option; }));
  $('playlist').value = selectedPlaylist;
  renderTracks(); renderControls(); renderAccount();
}
async function refresh({ announce = false, loadSession = false } = {}) {
  if (refreshPending) { refreshAgain = true; return; }
  refreshPending = true; const generation = requestGeneration;
  try {
    if (loadSession || !session.user) {
      const result = await getSession(); if (generation !== requestGeneration) return; session = result;
    }
    if (!session.user) { snapshot = null; fresh = false; render(); if (announce) feedback('Melde dich mit deinem Webseitenkonto an.'); return; }
    const result = await api('/api/music-remote', { timeout: 25000 });
    if (generation !== requestGeneration) return;
    snapshot = result; fresh = true;
    if (result.link && !linkFlow) restoreLink(result.link);
    render(); if (announce) feedback('Verbindung aktualisiert.');
  } catch (error) {
    if (generation !== requestGeneration) return;
    fresh = false;
    if (error.status === 401) { session = { user: null }; snapshot = null; clearLink(); }
    if (error.status === 403) snapshot = null;
    render(); if (announce || error.status === 401 || error.status === 403) feedback(errorText(error), true);
  } finally {
    refreshPending = false; clearTimeout(refreshTimer);
    if (refreshAgain) { refreshAgain = false; queueMicrotask(() => refresh()); }
    else if (!document.hidden) refreshTimer = setTimeout(() => refresh(), 10000);
  }
}
async function control(body) {
  if (!canControl()) return;
  if (['play', 'queue'].includes(body.action) && (!selectedChannel || selectedChannel !== snapshot.permissions.voiceChannelId)) {
    feedback('Tritt dem ausgewählten Sprachkanal zuerst in Discord bei und aktualisiere die Verbindung.', true); return;
  }
  requestGeneration++; setBusy(true); feedback('Musikbefehl wird ausgeführt …');
  try {
    const result = await api('/api/music-remote/control', { method: 'POST', body, timeout: 60000 });
    if (snapshot) snapshot = { ...snapshot, bot: result.bot, queue: result.queue };
    render(); feedback(result.message || 'Musikbefehl ausgeführt.');
  } catch (error) { fresh = false; feedback(errorText(error), true); }
  finally { finishMutation(); }
}
function clearLink() { clearTimeout(linkTimer); linkFlow = null; $('authorizeDiscord').removeAttribute('href'); renderAccount(); }
function restoreLink(value) {
  const url = new URL(value.authorizePath, location.origin);
  if (url.origin !== location.origin || !/^\/oauth\/start\/[A-Za-z0-9_-]+$/.test(url.pathname) || !Number.isFinite(Number(value.expiresAt))) throw new Error('Die Discord-Anmeldeadresse ist ungültig.');
  clearTimeout(linkTimer);
  linkFlow = { expiresAt: Number(value.expiresAt), intervalMs: Math.max(3000, Number(value.intervalMs) || 5000) };
  $('authorizeDiscord').href = url.href; $('linkCode').textContent = value.displayCode ? 'Verbindungscode: ' + value.displayCode : '';
  renderAccount(); linkTimer = setTimeout(pollLink, linkFlow.intervalMs);
}
async function pollLink() {
  if (!linkFlow || document.hidden || linkPolling) return;
  if (Date.now() >= linkFlow.expiresAt) { clearLink(); feedback('Die Discord-Verbindung ist abgelaufen. Bitte erneut verbinden.', true); return; }
  linkPolling = true; const flow = linkFlow;
  try {
    const result = await api('/api/music-remote/link/poll', { method: 'POST', body: {} });
    if (linkFlow !== flow) return;
    if (result.status === 'authorized') { requestGeneration++; clearLink(); feedback('Discord ist verbunden.'); await refresh(); }
    else if (result.status !== 'pending') { clearLink(); feedback('Die Verbindung wurde nicht abgeschlossen. Bitte erneut versuchen.', true); }
  } catch (error) { if (linkFlow === flow) { clearLink(); feedback(errorText(error), true); } }
  finally { linkPolling = false; if (linkFlow && !document.hidden) linkTimer = setTimeout(pollLink, linkFlow.intervalMs); }
}
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
  setBusy(true); requestGeneration++; feedback('Anmeldung läuft …');
  try { session = await login($('email').value.trim(), $('password').value); $('password').value = ''; snapshot = null; await refresh({ announce: true }); renderAccount(); }
  catch (error) { feedback(errorText(error), true); }
  finally { finishMutation(); }
});
$('logout').addEventListener('click', async () => {
  if (busy) return; requestGeneration++; setBusy(true);
  try { await logout(); requestGeneration++; session = { user: null }; snapshot = null; fresh = false; clearLink(); render(); feedback('Du bist abgemeldet. Laufende Musik bleibt im Sprachkanal.'); }
  catch (error) { feedback(errorText(error), true); }
  finally { finishMutation(); }
});
$('linkDiscord').addEventListener('click', async () => {
  if (busy || !session.user) return; requestGeneration++; setBusy(true); feedback('Discord-Verbindung wird vorbereitet …');
  try {
    const result = await api('/api/music-remote/link/start', { method: 'POST', body: {} });
    restoreLink(result); feedback('Tippe auf „Discord öffnen“, um dein Konto zu verbinden.');
  } catch (error) { feedback(errorText(error), true); }
  finally { finishMutation(); }
});
$('cancelLink').addEventListener('click', async () => {
  if (busy) return; requestGeneration++; setBusy(true); clearLink();
  try { await api('/api/music-remote/link/cancel', { method: 'POST', body: {} }); clearLink(); feedback('Verbindung abgebrochen.'); }
  catch (error) { feedback(errorText(error), true); }
  finally { finishMutation(); }
});
$('unlinkDiscord').addEventListener('click', async () => {
  if (busy) return; requestGeneration++; setBusy(true); clearLink();
  try { await api('/api/music-remote/link', { method: 'DELETE', body: {} }); clearLink(); await refresh(); feedback('Dein Discord-Konto wurde von der Musik-App getrennt.'); }
  catch (error) { feedback(errorText(error), true); }
  finally { finishMutation(); }
});
$('voiceChannel').addEventListener('change', event => { selectedChannel = event.target.value; if (selectedChannel !== snapshot?.permissions?.voiceChannelId) feedback('Öffne Discord und tritt diesem Sprachkanal bei.'); else feedback(''); });
$('playlist').addEventListener('change', event => { selectedPlaylist = event.target.value; renderTracks(); renderControls(); });
$('search').addEventListener('input', renderTracks);
$('playPause').addEventListener('click', () => control(snapshot?.bot?.track ? { action: snapshot.bot.paused ? 'resume' : 'pause' } : { action: 'play', playlistId: selectedPlaylist, channelId: selectedChannel }));
for (const [id, action] of [['previous','previous'],['next','next'],['stop','stop']]) $(id).addEventListener('click', () => control({ action }));
$('volume').addEventListener('input', event => { $('volumeValue').textContent = event.target.value + ' %'; });
$('volume').addEventListener('change', event => control({ action: 'volume', volume: Number(event.target.value) }));
for (const [id, page] of [['navPlayer','player'],['navAccount','account'],['accountShortcut','account']]) $(id).addEventListener('click', () => showPage(page));
function selectTab(tab) {
  for (const name of ['library', 'queue']) { $(name + 'Tab').setAttribute('aria-selected', String(name === tab)); $(name + 'Tab').tabIndex = name === tab ? 0 : -1; $(name + 'Panel').hidden = name !== tab; }
}
for (const name of ['library', 'queue']) {
  $(name + 'Tab').addEventListener('click', () => selectTab(name));
  $(name + 'Tab').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'library' : event.key === 'End' ? 'queue' : name === 'library' ? 'queue' : 'library'; selectTab(next); $(next + 'Tab').focus(); } });
}
$('refresh').addEventListener('click', () => refresh({ announce: true, loadSession: true }));
document.addEventListener('visibilitychange', () => {
  clearTimeout(refreshTimer); clearTimeout(linkTimer);
  if (!document.hidden) { void refresh({ loadSession: true }); if (linkFlow) void pollLink(); }
});
window.addEventListener('online', () => refresh({ announce: true }));
window.addEventListener('offline', () => { fresh = false; render(); feedback('Dein Handy ist offline. Laufende Musik wird auf dem Server weiter abgespielt.', true); });
render(); void refresh({ announce: true, loadSession: true });
