import { api, getSession, errorText, storageStatusText } from './account-client.js';

const $ = (id) => document.getElementById(id);
const LIMIT = 80 * 1024 * 1024;
const EXTENSIONS = /\.(mp3|mp4)$/i;
const audio = $('audioPlayer');
const stage = document.querySelector('.cb-player-page');
const state = { user: null, accountLoaded: false, tracks: [], playlists: [], playlistId: 'all', currentId: null, shuffle: false, repeat: false, favoritesOnly: false, popup: null, editingId: undefined, uploading: false, storageOnline: null, storage: null, uploadToken: null, uploadExpiresAt: 0 };

function announce(message) { $('playerFeedback').textContent = message; }
function setIcon(element, name) {
  const icon = document.createElement('span');
  icon.className = `cb-icon cb-i-${name}`;
  icon.setAttribute('aria-hidden', 'true');
  element.replaceChildren(icon);
}
function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function safeTitle(filename) { return filename.replace(/\.[^.]+$/, '').replace(/[\s_-]+/g, ' ').trim() || 'Unbenannter Titel'; }
function favoritesList() {
  try { const saved = JSON.parse(localStorage.getItem('cb-player-favorites') || '[]'); return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []; }
  catch { return []; }
}

function currentTrack() { return state.tracks.find((track) => track.id === state.currentId) || null; }

function playlistTracks() {
  if (state.playlistId === 'all') return state.tracks;
  const ids = state.playlists.find(p => p.id === state.playlistId)?.trackIds || [];
  return ids.map(id => state.tracks.find(t => t.id === id)).filter(Boolean);
}
function queueTracks() {
  const tracks = playlistTracks();
  return state.favoritesOnly ? tracks.filter(t => favoritesList().includes(t.id)) : tracks;
}
function renderPlaylistSelector() {
  const options = [{ id: 'all', name: 'Alle Titel' }, ...state.playlists].map(item => {
    const el = document.createElement('option'); el.value = item.id; el.textContent = item.name; return el;
  });
  $('playlistSelect').replaceChildren(...options); $('playlistSelect').value = state.playlistId;
  const selected = state.playlists.find(p => p.id === state.playlistId);
  $('createPlaylist').disabled = !canManagePlaylist();
  $('editPlaylist').disabled = !selected || !canManagePlaylist(selected);
  const tracks = playlistTracks();
  $('selectedPlaylistTitle').textContent = selected?.name || 'Alle Titel';
  $('selectedPlaylistSummary').textContent = `${tracks.length} Titel · ${formatTime(tracks.reduce((sum, track) => sum + (track.duration || 0), 0))} Min.`;
  const hint = $('playlistAccessHint');
  hint.replaceChildren();
  hint.textContent = !state.accountLoaded ? 'Dein Konto wird geprüft …' : !state.user ? 'Melde dich an, um eigene Playlists anzulegen. ' : !canManagePlaylist() ? 'Für eigene Playlists brauchst du ein bestätigtes Konto mit Musik-Freigabe. ' : selected && !canManagePlaylist(selected) ? 'Diese Playlist gehört einem anderen Mitglied. Du kannst eine eigene Playlist erstellen.' : 'Mit „Neue Playlist“ wählst du Songs aus der Bibliothek. Bestehende Listen änderst du über „Playlist bearbeiten“.';
  if (state.accountLoaded && !canManagePlaylist()) { const link = document.createElement('a'); link.href = 'registrierung.html'; link.textContent = 'Mein Konto öffnen'; hint.append(link); }
}
function canManagePlaylist(playlist = null) {
  const user = state.user;
  return Boolean(user?.confirmed && !user.suspended && (user.isAdmin || user.canUpload && (!playlist || playlist.createdBy === user.id)));
}

function renderPlaylist() {
  const filter = $('trackSearch').value.trim().toLocaleLowerCase('de-DE');
  const favorites = favoritesList();
  const tracks = playlistTracks().filter((track) => `${track.title} ${track.artist}`.toLocaleLowerCase('de-DE').includes(filter) && (!state.favoritesOnly || favorites.includes(track.id)));
  const rows = [];
  const addTrackRow = (track, index) => {
    const row = document.createElement('li');
    row.className = `cb-track-row${track.id === state.currentId ? ' is-current' : ''}`;
    const number = document.createElement('span');
    number.className = 'cb-track-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const thumb = document.createElement('span');
    thumb.className = 'cb-track-thumb cb-track-placeholder-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    setIcon(thumb, 'music');
    const copy = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'cb-track-title';
    title.textContent = track.title;
    const artist = document.createElement('span');
    artist.className = 'cb-track-artist';
    artist.textContent = track.artist || 'Interpret nicht angegeben';
    copy.append(title, artist);
    const duration = document.createElement('span');
    duration.className = 'cb-track-duration';
    duration.textContent = formatTime(track.duration);
    const play = document.createElement('button');
    play.className = 'cb-track-play';
    play.type = 'button';
    play.disabled = !track.source || state.storageOnline === false;
    play.setAttribute('aria-label', `Abspielen: ${track.title}`);
    setIcon(play, track.id === state.currentId && !audio.paused ? 'pause' : 'play');
    play.setAttribute('aria-label', `${track.id === state.currentId && !audio.paused ? 'Pause' : 'Abspielen'}: ${track.title}`);
    play.addEventListener('click', () => track.id === state.currentId ? togglePlayback() : selectAndPlay(track));
    const playCell = document.createElement('span');
    playCell.className = 'cb-track-actions';
    playCell.append(play);
    row.append(number, thumb, copy, duration, playCell);
    if (canManageTrack(track)) {
      const del = document.createElement('button');
      del.className = 'cb-track-delete';
      del.type = 'button';
      setIcon(del, 'trash');
      del.setAttribute('aria-label', `Musikdatei löschen: ${track.title}`);
      del.title = 'Musikdatei aus der gesamten Bibliothek löschen';
      del.addEventListener('click', () => deleteTrack(track));
      playCell.append(del);
    }
    rows.push(row);
  };
  tracks.forEach((track, index) => addTrackRow(track, index));
  const list = $('trackList');
  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'cb-player-hint';
    empty.textContent = state.favoritesOnly ? 'Noch keine passenden Favoriten. Markiere einen Titel mit dem Herz in der Wiedergabeleiste.' : state.playlistId !== 'all' && !playlistTracks().length ? 'Diese Playlist ist noch leer. Wähle „Playlist bearbeiten“, um Titel hinzuzufügen.' : state.tracks.length ? 'Keine passenden Titel gefunden.' : 'Noch keine Titel vorhanden. Über „Upload“ kannst du Musikdateien hinzufügen.';
    rows.push(empty);
  }
  list.replaceChildren(...rows);
  $('playerHint').textContent = `${playlistTracks().length} Titel in dieser Playlist · ${state.tracks.length} Titel insgesamt`;
  renderPlaylistSelector();
  const track = currentTrack();
  $('nowTitle').textContent = track?.title || 'Deine Musik beginnt hier';
  $('nowArtist').textContent = track?.artist || (state.tracks.length ? 'Wähle einen Titel zum Abspielen' : 'Wähle deinen ersten Titel');
  $('playButton').disabled = !queueTracks().length || state.storageOnline === false;
  $('previousButton').disabled = $('nextButton').disabled = !queueTracks().length || state.storageOnline === false;
  $('favoriteButton').disabled = !track;
  setIcon($('playButton'), audio.paused ? 'play' : 'pause');
  $('playButton').setAttribute('aria-label', audio.paused ? 'Abspielen' : 'Pause');
  $('seek').disabled = !Number.isFinite(audio.duration) || !audio.duration;
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('duration').textContent = Number.isFinite(audio.duration) && audio.duration ? formatTime(audio.duration) : '--:--';
  $('remaining').textContent = Number.isFinite(audio.duration) && audio.duration ? `−${formatTime(Math.max(0, audio.duration - audio.currentTime))}` : '−--:--';
  $('favoriteButton').setAttribute('aria-pressed', String(Boolean(track && favorites.includes(track.id))));
  $('favoriteButton').setAttribute('aria-label', track && favorites.includes(track.id) ? 'Favorit entfernen' : 'Als Favorit markieren');
  setIcon($('favoriteButton'), track && favorites.includes(track.id) ? 'heart-filled' : 'heart');
  if (state.editingId !== (track?.id || null)) {
    $('trackTitle').value = track?.title || '';
    $('trackArtist').value = track?.artist === 'Interpret nicht angegeben' ? '' : (track?.artist || '');
    state.editingId = track?.id || null;
  }
  const mayEdit = canManageTrack(track);
  $('trackTitle').disabled = !mayEdit;
  $('trackArtist').disabled = !mayEdit;
  $('saveMetadata').disabled = !mayEdit;
}

async function selectAndPlay(track) {
  if (state.storageOnline === false) { announce(storageStatusText(state.storage)); return; }
  state.currentId = track.id;
  audio.pause();
  $('videoStage').hidden = true;
  audio.src = track.source || '';
  audio.load();
  renderPlaylist();
  try {
    await audio.play();
    announce(`Wiedergabe: ${track.title}`);
  } catch {
    announce('Der Titel konnte nicht gestartet werden. Prüfe das Audioformat oder die Verbindung.');
  }
}
function selectTrack(track) {
  state.currentId = track.id;
  audio.pause();
  $('videoStage').hidden = true;
  audio.src = track.source || '';
  audio.load();
  renderPlaylist();
  announce(`${track.title} ausgewählt. Drücke Abspielen, um zu starten.`);
}
async function togglePlayback() {
  if (state.storageOnline === false) { announce(storageStatusText(state.storage)); return; }
  const track = currentTrack() || queueTracks()[0];
  if (!track) return;
  if (state.currentId !== track.id) { await selectAndPlay(track); return; }
  if (audio.paused) {
    if (!audio.src) audio.src = track.source || '';
    try { await audio.play(); announce(`Wiedergabe: ${track.title}`); }
    catch { announce('Der Titel konnte nicht gestartet werden. Prüfe das Audioformat oder die Verbindung.'); }
  } else audio.pause();
  renderPlaylist();
}
function moveTrack(direction) {
  const tracks = queueTracks();
  if (!tracks.length) return;
  let index = tracks.findIndex(track => track.id === state.currentId);
  if (index < 0) { void selectAndPlay(tracks[direction < 0 ? tracks.length - 1 : 0]); return; }
  if (state.shuffle && tracks.length > 1) {
    const choices = tracks.filter(track => track.id !== state.currentId);
    void selectAndPlay(choices[Math.floor(Math.random() * choices.length)]); return;
  }
  void selectAndPlay(tracks[(index + direction + tracks.length) % tracks.length]);
}
function playbackEnded() {
  const tracks = queueTracks();
  if (state.repeat) { audio.currentTime = 0; void audio.play().catch(() => announce('Drücke Abspielen, um fortzufahren.')); }
  else if (state.shuffle || tracks.findIndex(track => track.id === state.currentId) < tracks.length - 1) moveTrack(1);
  else { audio.pause(); renderPlaylist(); announce('Playlist zu Ende.'); }
}

function canManageTrack(track) {
  return Boolean(track && state.user && !state.user.suspended && (state.user.isAdmin || (state.user.canUpload && track.uploadedBy === state.user.id)));
}
function showUploadStatus(text, error = false) {
  $('uploadStatus').textContent = text;
  $('uploadStatus').classList.toggle('is-error', error);
}
function updateAccount(user) {
  state.user = user;
  state.accountLoaded = true;
  $('cloudTitle').textContent = user ? `Angemeldet: ${user.name || user.email}` : 'Musik hören · ohne Anmeldung';
  $('playerAdminLink').hidden = !user?.isAdmin;
  renderPlaylist();
}
async function openUpload() {
  if (state.uploading) return;
  state.uploadToken = null;
  state.uploadExpiresAt = 0;
  $('uploadPassword').value = '';
  $('uploadAccountLink').hidden = true;
  $('uploadUnlockForm').hidden = true;
  $('uploadFileChoice').hidden = true;
  showUploadStatus('Deine Upload-Berechtigung wird geprüft …');
  if (!$('uploadDialog').open) $('uploadDialog').showModal();
  if (state.storageOnline === false) { showUploadStatus(storageStatusText(state.storage), true); return; }
  try {
    const session = await getSession();
    updateAccount(session.user);
    if (!session.user) { $('uploadAccountLink').hidden = false; showUploadStatus('Melde dich zuerst mit deinem App-Konto an.'); return; }
    if (!session.user.confirmed || session.user.suspended || !session.user.canUpload) {
      showUploadStatus(session.user.suspended ? 'Dein Konto ist gesperrt.' : !session.user.confirmed ? 'Bestätige zuerst deine E-Mail-Adresse.' : 'Crazy_Batto muss Musik-Uploads für dein Konto freigeben.', true);
      return;
    }
    $('uploadUnlockForm').hidden = false;
    showUploadStatus('Gib das von Crazy_Batto festgelegte Upload-Kennwort ein.');
    $('uploadPassword').focus();
  } catch (error) { showUploadStatus(errorText(error), true); }
}
$('uploadUnlockForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('uploadUnlockForm').reportValidity()) return;
  $('uploadUnlockButton').disabled = true;
  showUploadStatus('Upload wird freigeschaltet …');
  try {
    const result = await api('/api/music/unlock', { method: 'POST', body: { password: $('uploadPassword').value } });
    if (!result.uploadToken || !result.expiresAt) throw new Error('Der Server hat keine gültige Upload-Freigabe geliefert.');
    state.uploadToken = result.uploadToken;
    state.uploadExpiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
    $('uploadPassword').value = '';
    $('uploadUnlockForm').hidden = true;
    $('uploadFileChoice').hidden = false;
    showUploadStatus('Upload freigeschaltet. Wähle jetzt deine Dateien aus.');
    $('chooseUploadFiles').focus();
  } catch (error) { showUploadStatus(errorText(error), true); }
  finally { $('uploadUnlockButton').disabled = false; }
});
$('chooseUploadFiles').addEventListener('click', () => {
  if (!state.uploadToken || !Number.isFinite(state.uploadExpiresAt) || Date.now() >= state.uploadExpiresAt) {
    void openUpload();
    return;
  }
  $('audioFiles').click();
});
$('uploadClose').addEventListener('click', () => $('uploadDialog').close());
$('uploadDialog').addEventListener('close', () => {
  $('uploadPassword').value = '';
  if (!state.uploading) { state.uploadToken = null; state.uploadExpiresAt = 0; }
});
async function addFiles(fileList) {
  if (state.uploading) return;
  if (state.storageOnline === false) { showUploadStatus(storageStatusText(state.storage), true); return; }
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.uploadToken || !Number.isFinite(state.uploadExpiresAt) || Date.now() >= state.uploadExpiresAt) { announce('Bitte gib das Upload-Kennwort erneut ein.'); await openUpload(); return; }
  const invalid = files.find(file => !EXTENSIONS.test(file.name) || !file.size || file.size > LIMIT);
  if (invalid) { showUploadStatus(`${invalid.name}: Erlaubt sind nur MP3 oder MP4 mit maximal 80 MB pro Datei.`, true); return; }
  state.uploading = true;
  ['addFilesButton', 'quickAddButton', 'audioFiles', 'chooseUploadFiles'].forEach(id => { $(id).disabled = true; });
  let added = 0;
  const errors = [];
  try {
    const session = await getSession();
    updateAccount(session.user);
    if (!session.user?.confirmed || session.user.suspended || !session.user.canUpload) throw new Error('Deine Upload-Berechtigung ist nicht mehr gültig. Bitte erneut anmelden oder Crazy_Batto kontaktieren.');
    for (const file of files) {
      try {
        showUploadStatus(`${file.name} wird in den Musikspeicher übertragen …`);
        announce(`${file.name} wird hochgeladen …`);
        const result = await api('/api/music/tracks', { method: 'POST', raw: true, body: file, timeout: 180000, headers: {
          'Content-Type': /\.mp3$/i.test(file.name) ? 'audio/mpeg' : 'video/mp4',
          'X-Upload-Token': state.uploadToken,
          'X-File-Name': encodeURIComponent(file.name),
          'X-Track-Title': encodeURIComponent(safeTitle(file.name)),
          'X-Track-Artist': encodeURIComponent($('uploadArtist').value.trim() || 'Interpret nicht angegeben'),
        } });
        if (!result.track?.id) throw new Error('Die Speicherbestätigung fehlt. Bitte aktualisiere die Playlist, bevor du erneut hochlädst.');
        const track = normalizeTrack(result.track);
        state.tracks = [...state.tracks.filter(item => item.id !== track.id), track];
        state.storageOnline = true;
        state.storage = { configured: true, online: true };
        $('cloudStatus').textContent = storageStatusText(state.storage);
        if (!state.currentId) state.currentId = track.id;
        renderPlaylist();
        added++;
      } catch (error) { errors.push(`${file.name}: ${errorText(error)}`); }
    }
    const report = `${added} ${added === 1 ? 'Titel' : 'Titel'} gespeichert.${errors.length ? '\n' + errors.join('\n') : ' Du kannst sie jetzt abspielen.'}`;
    announce(report);
    showUploadStatus(report, Boolean(errors.length));
  } catch (error) { announce(errorText(error)); showUploadStatus(errorText(error), true); }
  finally {
    state.uploading = false;
    ['addFilesButton', 'quickAddButton', 'audioFiles', 'chooseUploadFiles'].forEach(id => { $(id).disabled = false; });
    state.uploadToken = null;
    state.uploadExpiresAt = 0;
    $('uploadFileChoice').hidden = true;
    $('uploadUnlockForm').hidden = false;
    $('uploadPassword').value = '';
  }
}
async function deleteTrack(track) {
  if (!canManageTrack(track) || !window.confirm(`Musikdatei „${track.title}“ aus der gesamten Bibliothek und allen Playlists löschen?`)) return;
  try {
    await api(`/api/music/tracks/${encodeURIComponent(track.id)}`, { method: 'DELETE' });
    if (track.id === state.currentId) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; $('seek').value = '0'; }
    state.tracks = state.tracks.filter(item => item.id !== track.id);
    renderPlaylist();
    state.playlists.forEach(playlist => { playlist.trackIds = playlist.trackIds.filter(id => id !== track.id); });
    announce('Musikdatei aus der Bibliothek gelöscht.');
  } catch (error) { announce(errorText(error)); }
}
function normalizeTrack(track) {
  const source = new URL(track.url, location.origin);
  if (source.origin !== location.origin || !source.pathname.startsWith('/api/music/')) throw new Error('Die Musikadresse konnte nicht bestätigt werden.');
  return { ...track, source: source.href };
}
async function loadCloudTracks() {
  const [result, lists] = await Promise.all([api('/api/music/tracks'), api('/api/music/playlists')]);
  state.playlists = lists.playlists || [];
  if (state.playlistId !== 'all' && !state.playlists.some(p => p.id === state.playlistId)) state.playlistId = 'all';
  if (!Array.isArray(result.tracks)) throw new Error('Die Playlist-Antwort ist unvollständig.');
  state.tracks = result.tracks.map(normalizeTrack);
  state.storage = result.storage || null;
  state.storageOnline = state.storage?.configured !== false && state.storage?.online === true;
  if (state.currentId && !state.tracks.some(track => track.id === state.currentId)) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; }
  if (!state.storageOnline) audio.pause();
  $('cloudStatus').textContent = storageStatusText(state.storage);
  if (!state.storageOnline) announce($('cloudStatus').textContent);
  renderPlaylist();
}
async function setupCloud() {
  $('cloudRefresh').disabled = true;
  const results = await Promise.allSettled([getSession(), loadCloudTracks()]);
  if (results[0].status === 'fulfilled') updateAccount(results[0].value.user);
  else { updateAccount(null); $('cloudTitle').textContent = 'Konto momentan nicht erreichbar'; }
  if (results[1].status === 'rejected') { state.storageOnline = false; state.storage = null; $('cloudStatus').textContent = errorText(results[1].reason); announce($('cloudStatus').textContent); renderPlaylist(); }
  $('cloudRefresh').disabled = false;
}
$('cloudRefresh').addEventListener('click', () => void setupCloud());
$('addFilesButton').addEventListener('click', openUpload);
$('quickAddButton').addEventListener('click', openUpload);
const settingsPanel = $('playerSettings');
function syncSettings() {
  const expanded = Boolean(settingsPanel.open);
  $('settingsButton').setAttribute('aria-expanded', String(expanded));
  stage.classList.toggle('is-managing', expanded);
}
settingsPanel.addEventListener('toggle', syncSettings);
$('settingsButton').addEventListener('click', () => {
  settingsPanel.open = !settingsPanel.open;
  syncSettings();
  if (settingsPanel.open) {
    settingsPanel.querySelector('summary')?.focus({ preventScroll: true });
    settingsPanel.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth', block: 'start' });
  }
});
$('favoritesFilterButton').addEventListener('click', (event) => {
  state.favoritesOnly = !state.favoritesOnly;
  event.currentTarget.setAttribute('aria-pressed', String(state.favoritesOnly));
  event.currentTarget.setAttribute('aria-label', state.favoritesOnly ? 'Alle Titel anzeigen' : 'Nur Favoriten anzeigen');
  setIcon(event.currentTarget, state.favoritesOnly ? 'heart-filled' : 'heart');
  renderPlaylist();
});
$('audioFiles').addEventListener('change', (event) => { void addFiles(event.target.files); event.target.value = ''; });
$('trackSearch').addEventListener('input', renderPlaylist);
$('playButton').addEventListener('click', () => void togglePlayback());
$('previousButton').addEventListener('click', () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  moveTrack(-1);
});
$('nextButton').addEventListener('click', () => moveTrack(1));
$('shuffleButton').addEventListener('click', (event) => {
  state.shuffle = !state.shuffle;
  event.currentTarget.setAttribute('aria-pressed', String(state.shuffle));
  event.currentTarget.setAttribute('aria-label', `Zufallswiedergabe ${state.shuffle ? 'ausschalten' : 'einschalten'}`);
});
$('repeatButton').addEventListener('click', (event) => {
  state.repeat = !state.repeat;
  event.currentTarget.setAttribute('aria-pressed', String(state.repeat));
  event.currentTarget.setAttribute('aria-label', `Wiederholung ${state.repeat ? 'ausschalten' : 'einschalten'}`);
});
$('volume').addEventListener('input', (event) => {
  audio.volume = Number(event.target.value);
  $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`;
  $('muteButton').setAttribute('aria-pressed', String(audio.muted));
  setIcon($('muteButton'), audio.muted || audio.volume === 0 ? 'speaker-muted' : 'speaker-high');
});
$('muteButton').addEventListener('click', (event) => {
  audio.muted = !audio.muted;
  event.currentTarget.setAttribute('aria-pressed', String(audio.muted));
  event.currentTarget.setAttribute('aria-label', audio.muted ? 'Ton einschalten' : 'Stummschalten');
  setIcon(event.currentTarget, audio.muted || audio.volume === 0 ? 'speaker-muted' : 'speaker-high');
});
$('favoriteButton').addEventListener('click', () => {
  const track = currentTrack();
  if (!track) { announce('Wähle zuerst einen Titel aus.'); return; }
  const favorites = new Set(favoritesList());
  if (favorites.has(track.id)) { favorites.delete(track.id); announce('Titel aus den Favoriten entfernt.'); }
  else { favorites.add(track.id); announce('Titel zu den Favoriten hinzugefügt.'); }
  try { localStorage.setItem('cb-player-favorites', JSON.stringify([...favorites])); }
  catch { announce('Favoriten können in diesem Browser nicht gespeichert werden.'); }
  renderPlaylist();
});
$('seek').addEventListener('input', (event) => { if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(event.target.value) / 1000 * audio.duration; });
$('minimizeButton').addEventListener('click', (event) => {
  const minimized = stage.classList.toggle('is-minimized');
  event.currentTarget.setAttribute('aria-expanded', String(!minimized));
  setIcon(event.currentTarget, minimized ? 'plus' : 'minus');
  event.currentTarget.title = minimized ? 'Player öffnen' : 'Player minimieren';
  event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
});
function sendPlaybackToPopup() {
  if (!state.popup || state.popup.closed) return;
  state.popup.postMessage({
    type: 'cb-player-transfer', track: currentTrack(), time: audio.currentTime,
    volume: audio.volume, muted: audio.muted, shuffle: state.shuffle,
    repeat: state.repeat, playing: !audio.paused, playlistId: state.playlistId
  }, location.origin);
}
let transferredPlayback = false;
window.addEventListener('message', async (event) => {
  if (event.origin !== location.origin || !event.data || typeof event.data !== 'object') return;
  if (state.popup && event.source === state.popup && event.data.type === 'cb-player-ready') sendPlaybackToPopup();
  if (state.popup && event.source === state.popup && event.data.type === 'cb-player-active') audio.pause();
  if (state.popup && event.source === state.popup && event.data.type === 'cb-player-prepared') {
    audio.pause();
    event.source.postMessage({ type: 'cb-player-resume' }, location.origin);
    announce('Playerfenster bereit. Du kannst jetzt andere Seiten öffnen.');
  }
  if (!window.opener || event.source !== window.opener) return;
  if (event.data.type === 'cb-player-pause') audio.pause();
  if (event.data.type === 'cb-player-transfer') {
    const snapshot = event.data;
    try { await loadCloudTracks(); } catch (error) { announce(errorText(error)); return; }
    state.playlistId = state.playlists.some(p => p.id === snapshot.playlistId) ? snapshot.playlistId : 'all';
    const track = state.tracks.find(item => item.id === snapshot.track?.id);
    if (track) {
      selectTrack(track);
      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(snapshot.time) && Number.isFinite(audio.duration)) audio.currentTime = Math.max(0, Math.min(snapshot.time, audio.duration));
      }, { once: true });
    }
    audio.volume = Number.isFinite(snapshot.volume) ? Math.max(0, Math.min(1, snapshot.volume)) : .78;
    audio.muted = Boolean(snapshot.muted);
    $('volume').value = String(audio.volume);
    $('volumeValue').textContent = `${Math.round(audio.volume * 100)}%`;
    $('muteButton').setAttribute('aria-pressed', String(audio.muted));
    $('muteButton').setAttribute('aria-label', audio.muted ? 'Ton einschalten' : 'Stummschalten');
    setIcon($('muteButton'), audio.muted || audio.volume === 0 ? 'speaker-muted' : 'speaker-high');
    state.shuffle = Boolean(snapshot.shuffle);
    state.repeat = Boolean(snapshot.repeat);
    for (const [id, active, name] of [['shuffleButton', state.shuffle, 'Zufallswiedergabe'], ['repeatButton', state.repeat, 'Wiederholung']]) {
      $(id).setAttribute('aria-pressed', String(active));
      $(id).setAttribute('aria-label', `${name} ${active ? 'ausschalten' : 'einschalten'}`);
    }
    renderPlaylist();
    transferredPlayback = Boolean(track && snapshot.playing);
    window.opener.postMessage({ type: 'cb-player-prepared' }, location.origin);
  }
  if (event.data.type === 'cb-player-resume' && transferredPlayback) {
    transferredPlayback = false;
    try { await audio.play(); announce('Wiedergabe im Playerfenster übernommen.'); }
    catch { announce('Titel und Position übernommen. Drücke hier Abspielen, um weiterzuhören.'); }
  }
});
$('popoutButton').addEventListener('click', () => {
  if (state.popup && !state.popup.closed) { state.popup.focus(); if (!audio.paused) sendPlaybackToPopup(); return; }
  const url = new URL('media-player.html?popup=1', location.href).href;
  state.popup = window.open(url, 'crazyBattoPlayer', 'popup,width=1250,height=900,resizable=yes,scrollbars=yes');
  if (!state.popup) announce('Der Browser hat das Playerfenster blockiert. Erlaube Pop-ups für diese Website und versuche es erneut.');
  else state.popup.focus();
});
if (new URLSearchParams(location.search).get('popup') === '1') {
  document.body.classList.add('cb-player-popup');
  $('popoutButton').hidden = true;
}
audio.volume = Number($('volume').value);
audio.addEventListener('timeupdate', () => {
  $('elapsed').textContent = formatTime(audio.currentTime);
  $('remaining').textContent = Number.isFinite(audio.duration) && audio.duration ? `−${formatTime(Math.max(0, audio.duration - audio.currentTime))}` : '−--:--';
  if (audio.duration) $('seek').value = String(Math.round(audio.currentTime / audio.duration * 1000));
});
audio.addEventListener('loadedmetadata', () => { $('videoStage').hidden = !audio.videoWidth; renderPlaylist(); });
audio.addEventListener('emptied', () => { $('videoStage').hidden = true; });
audio.addEventListener('play', renderPlaylist);
audio.addEventListener('play', () => {
  if (state.popup && !state.popup.closed) state.popup.postMessage({ type: 'cb-player-pause' }, location.origin);
  if (window.opener && new URLSearchParams(location.search).get('popup') === '1') window.opener.postMessage({ type: 'cb-player-active' }, location.origin);
});
audio.addEventListener('pause', renderPlaylist);
audio.addEventListener('ended', playbackEnded);
audio.addEventListener('error', () => announce('Der Titel ist gerade nicht abspielbar. Prüfe die Verbindung zum Musikspeicher über „Playlist aktualisieren“.'));
$('trackMetaForm').addEventListener('submit', async event => {
  event.preventDefault();
  const track = currentTrack();
  if (!canManageTrack(track)) return;
  const title = $('trackTitle').value.trim();
  const artist = $('trackArtist').value.trim() || 'Interpret nicht angegeben';
  if (!title) { announce('Gib dem Titel zuerst einen Namen.'); $('trackTitle').focus(); return; }
  $('saveMetadata').disabled = true;
  try {
    const result = await api(`/api/music/tracks/${encodeURIComponent(track.id)}`, { method: 'PATCH', body: { title, artist } });
    if (!result.track?.id) throw new Error('Die Speicherbestätigung fehlt. Bitte aktualisiere die Playlist.');
    Object.assign(track, normalizeTrack(result.track));
    state.editingId = undefined;
    renderPlaylist();
    announce('Titel und Künstler gespeichert.');
  } catch (error) { announce(errorText(error)); }
  finally { $('saveMetadata').disabled = !canManageTrack(track); }
});

let playlistDraft = null, playlistBusy = false, pendingCreation = null;
const MAX_PLAYLIST_TRACKS = 500;
function draftMatches() {
  const query = $('playlistSearch').value.trim().toLocaleLowerCase('de');
  return state.tracks.filter(track => `${track.title} ${track.artist}`.toLocaleLowerCase('de').includes(query));
}
function drawPlaylistDraft() {
  if (!playlistDraft) return;
  const draft = playlistDraft, selected = new Set(draft.trackIds), matches = draftMatches();
  const focus = document.activeElement?.dataset.playlistFocus;
  const leftScroll = $('playlistAvailable').scrollTop, rightScroll = $('playlistOrder').scrollTop;
  $('playlistLibraryCount').textContent = `${matches.length} Titel`;
  const totalSeconds = state.tracks.filter(track => selected.has(track.id)).reduce((sum, track) => sum + (track.duration || 0), 0);
  $('playlistDraftCount').textContent = `${selected.size} Titel · ${formatTime(totalSeconds)} Min.`;
  $('playlistEmpty').hidden = selected.size > 0;
  $('playlistAvailable').replaceChildren(...matches.map(track => {
    const row = document.createElement('label'); row.className = 'cb-playlist-choice';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(track.id);
    input.dataset.playlistFocus = 'pick-' + track.id;
    input.setAttribute('aria-label', `${track.title} – ${track.artist || 'Interpret nicht angegeben'}`);
    input.disabled = playlistBusy || Boolean(pendingCreation) || !input.checked && selected.size >= MAX_PLAYLIST_TRACKS;
    input.addEventListener('change', () => {
      if (playlistBusy || pendingCreation) return;
      if (input.checked && draft.trackIds.length < MAX_PLAYLIST_TRACKS) draft.trackIds.push(track.id);
      else draft.trackIds = draft.trackIds.filter(id => id !== track.id);
      drawPlaylistDraft();
    });
    const copy = document.createElement('span'), title = document.createElement('strong'), artist = document.createElement('small');
    title.textContent = track.title; artist.textContent = track.artist || 'Interpret nicht angegeben'; copy.append(title, artist);
    const duration = document.createElement('small'); duration.className = 'cb-playlist-duration'; duration.textContent = formatTime(track.duration);
    row.append(input, copy, duration); return row;
  }));
  if (!matches.length) {
    const empty = document.createElement('p'); empty.className = 'cb-playlist-no-results';
    empty.textContent = state.tracks.length ? 'Keine Treffer. Versuche einen anderen Titel oder Künstler.' : 'Noch keine Musik vorhanden. Lade zuerst über „Upload“ Musikdateien hoch.';
    $('playlistAvailable').append(empty);
  }
  $('playlistOrder').replaceChildren(...draft.trackIds.map((id, index) => {
    const track = state.tracks.find(t => t.id === id);
    const row = document.createElement('li'); row.className = 'cb-playlist-order-row';
    const number = document.createElement('span'); number.className = 'cb-playlist-position'; number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span'); copy.className = 'cb-playlist-order-copy';
    const title = document.createElement('strong'); title.textContent = track?.title || 'Titel nicht mehr verfügbar';
    const artist = document.createElement('small'); artist.textContent = track?.artist || 'Bitte diesen Titel entfernen.'; copy.append(title, artist);
    const actions = document.createElement('span'); actions.className = 'cb-playlist-order-actions';
    for (const [text, delta] of [['↑', -1], ['↓', 1], ['×', 0]]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.dataset.playlistFocus = id + '-' + delta;
      button.setAttribute('aria-label', `${track?.title || 'Titel'} ${delta === -1 ? 'nach oben' : delta === 1 ? 'nach unten' : 'aus Playlist entfernen'}`);
      button.disabled = playlistBusy || Boolean(pendingCreation) || delta !== 0 && (index + delta < 0 || index + delta >= draft.trackIds.length);
      button.addEventListener('click', () => {
        if (playlistBusy || pendingCreation) return;
        if (!delta) draft.trackIds.splice(index, 1);
        else [draft.trackIds[index], draft.trackIds[index + delta]] = [draft.trackIds[index + delta], draft.trackIds[index]];
        drawPlaylistDraft();
        if (!delta) $('playlistDraftCount').focus();
      }); actions.append(button);
    }
    row.append(number, copy, actions); return row;
  }));
  $('playlistAddAll').disabled = playlistBusy || Boolean(pendingCreation) || selected.size >= MAX_PLAYLIST_TRACKS || !matches.some(t => !selected.has(t.id));
  $('playlistSave').disabled = playlistBusy || Boolean(pendingCreation);
  $('playlistSave').textContent = playlistBusy ? 'Wird gespeichert …' : draft.id ? 'Änderungen speichern' : 'Playlist erstellen';
  $('playlistAvailable').scrollTop = leftScroll; $('playlistOrder').scrollTop = rightScroll;
  if (focus) {
    const controls = [...$('playlistForm').querySelectorAll('[data-playlist-focus]')];
    const id = draft.trackIds.find(id => focus.startsWith(id + '-'));
    const target = controls.find(el => el.dataset.playlistFocus === focus && !el.disabled) || controls.find(el => id && el.dataset.playlistFocus === id + '-0' && !el.disabled);
    target?.focus({ preventScroll: true });
  }
}
function setPlaylistBusy(busy) {
  playlistBusy = busy;
  $('playlistForm').setAttribute('aria-busy', String(busy));
  for (const id of ['playlistName','playlistSearch','playlistClose','playlistCancel','playlistDelete','playlistReload','playlistCheck']) $(id).disabled = busy;
  if (pendingCreation) $('playlistName').disabled = true;
  drawPlaylistDraft();
}
function editPlaylist(existing) {
  if (playlistBusy || !canManagePlaylist(existing)) return;
  pendingCreation = null;
  playlistDraft = existing ? { ...existing, trackIds: [...existing.trackIds] } : { name: '', trackIds: [] };
  $('playlistName').value = playlistDraft.name; $('playlistName').setCustomValidity(''); $('playlistSearch').value = '';
  $('playlistDialogTitle').textContent = existing ? 'Playlist bearbeiten' : 'Neue Playlist';
  $('playlistDelete').hidden = !playlistDraft.id;
  $('playlistReload').hidden = $('playlistCheck').hidden = true;
  $('playlistFeedback').textContent = 'Deine Auswahl wird erst beim Speichern übernommen.';
  setPlaylistBusy(false);
  if (!$('playlistDialog').open) $('playlistDialog').showModal();
  $('playlistName').focus();
}
function applySavedPlaylist(playlist) {
  if (!playlist?.id || !Array.isArray(playlist.trackIds)) throw new Error('Die Speicherbestätigung fehlt.');
  state.playlists = [...state.playlists.filter(p => p.id !== playlist.id), playlist]; state.playlistId = playlist.id;
  $('trackSearch').value = ''; state.favoritesOnly = false; $('favoritesFilterButton').setAttribute('aria-pressed', 'false');
  if (state.currentId && !playlistTracks().some(t => t.id === state.currentId)) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; }
  pendingCreation = null;
  renderPlaylist(); $('playlistDialog').close(); announce(`„${playlist.name}“ gespeichert – ${playlist.trackIds.length} Titel.`);
}
async function checkPendingCreation() {
  const pending = pendingCreation;
  if (!pending) return;
  const result = await api('/api/music/playlists');
  const matches = result.playlists.filter(p => !pending.beforeIds.includes(p.id) && p.createdBy === state.user?.id && p.name === pending.name && JSON.stringify(p.trackIds) === JSON.stringify(pending.trackIds));
  if (matches.length === 1) { applySavedPlaylist(matches[0]); return; }
  $('playlistFeedback').textContent = 'Noch keine eindeutige Speicherbestätigung. Prüfe den Status erneut oder schließe das Fenster und aktualisiere die Playlists. Dein Entwurf bleibt hier erhalten.';
}
$('playlistSelect').addEventListener('change', () => {
  state.playlistId = $('playlistSelect').value; $('trackSearch').value = ''; state.favoritesOnly = false; $('favoritesFilterButton').setAttribute('aria-pressed', 'false');
  audio.pause(); audio.removeAttribute('src'); audio.load(); state.currentId = null; renderPlaylist();
});
$('createPlaylist').addEventListener('click', () => editPlaylist(null));
$('editPlaylist').addEventListener('click', () => { const selected = state.playlists.find(p => p.id === state.playlistId); if (selected) editPlaylist(selected); });
$('playlistName').addEventListener('input', () => $('playlistName').setCustomValidity(''));
$('playlistSearch').addEventListener('input', drawPlaylistDraft);
$('playlistAddAll').addEventListener('click', () => {
  if (!playlistDraft || playlistBusy || pendingCreation) return;
  const fresh = draftMatches().filter(t => !playlistDraft.trackIds.includes(t.id));
  playlistDraft.trackIds.push(...fresh.slice(0, MAX_PLAYLIST_TRACKS - playlistDraft.trackIds.length).map(t => t.id)); drawPlaylistDraft();
});
for (const id of ['playlistClose','playlistCancel']) $(id).addEventListener('click', () => { if (!playlistBusy) $('playlistDialog').close(); });
$('playlistDialog').addEventListener('cancel', event => { if (playlistBusy) event.preventDefault(); });
$('playlistForm').addEventListener('submit', async event => {
  event.preventDefault(); if (playlistBusy || pendingCreation || !playlistDraft) return;
  const name = $('playlistName').value.trim(); $('playlistName').setCustomValidity(name ? '' : 'Bitte gib deiner Playlist einen Namen.');
  if (!event.currentTarget.reportValidity()) return;
  const draft = { ...playlistDraft, name, trackIds: [...playlistDraft.trackIds] };
  const pending = { name, trackIds: draft.trackIds, beforeIds: state.playlists.map(p => p.id) };
  $('playlistFeedback').textContent = 'Playlist wird gespeichert …'; $('playlistReload').hidden = true; setPlaylistBusy(true);
  try {
    const result = await api('/api/music/playlists' + (draft.id ? '/' + draft.id : ''), {
      method: draft.id ? 'PUT' : 'POST', body: { name, trackIds: draft.trackIds, ...(draft.id ? { revision: draft.revision } : {}) }
    });
    applySavedPlaylist(result.playlist);
  } catch (error) {
    $('playlistFeedback').textContent = errorText(error);
    $('playlistReload').hidden = !draft.id || error.status !== 409;
    if (!draft.id && (!error.status || error.status >= 500 || error.code === 'INVALID_RESPONSE')) {
      pendingCreation = pending; $('playlistCheck').hidden = false;
      try { await checkPendingCreation(); } catch { $('playlistFeedback').textContent = 'Die Speicherbestätigung fehlt. Nutze „Speicherung prüfen“, bevor du die Playlist erneut anlegst.'; }
    }
  } finally { setPlaylistBusy(false); }
});
$('playlistCheck').addEventListener('click', async () => {
  if (playlistBusy || !pendingCreation) return; setPlaylistBusy(true);
  try { await checkPendingCreation(); } catch (error) { $('playlistFeedback').textContent = errorText(error); }
  finally { setPlaylistBusy(false); }
});
$('playlistReload').addEventListener('click', async () => {
  if (playlistBusy || !playlistDraft?.id) return; const id = playlistDraft.id; setPlaylistBusy(true);
  try {
    await loadCloudTracks(); const latest = state.playlists.find(p => p.id === id); setPlaylistBusy(false);
    if (latest) editPlaylist(latest); else { $('playlistDialog').close(); announce('Diese Playlist wurde inzwischen gelöscht.'); }
  } catch (error) { $('playlistFeedback').textContent = errorText(error); }
  finally { setPlaylistBusy(false); }
});
$('playlistDelete').addEventListener('click', async () => {
  if (playlistBusy || !playlistDraft?.id || !window.confirm('Diese Playlist löschen? Die Musikdateien bleiben erhalten.')) return;
  const id = playlistDraft.id; setPlaylistBusy(true);
  try {
    await api('/api/music/playlists/' + id, { method: 'DELETE' });
    state.playlists = state.playlists.filter(p => p.id !== id); state.playlistId = 'all';
    renderPlaylist(); $('playlistDialog').close(); announce('Playlist gelöscht. Die Musikdateien bleiben in deiner Bibliothek.');
  } catch (error) { $('playlistFeedback').textContent = errorText(error); }
  finally { setPlaylistBusy(false); }
});


// Keep the complete player visible while account and storage services connect.
renderPlaylist();
window.dispatchEvent(new Event('cb-player-initialized'));

if (window.opener && new URLSearchParams(location.search).get('popup') === '1') window.opener.postMessage({ type: 'cb-player-ready' }, location.origin);
void setupCloud();
