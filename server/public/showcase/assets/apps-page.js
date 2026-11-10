import { api, getSession, ApiError } from './account-client.js';

const apps = {
  'discord-app': { name: 'Crazy_Batto Discord App', path: '/api/account/download/discord-app', guide: 'discord-app.html#cb-discord-access-title' },
  'music-remote': { name: 'Crazy_Batto Musik', path: '/api/account/download/music-remote', guide: 'musik-app.html#einrichtung' },
};
const dialog = document.getElementById('app-download-dialog');
const state = document.getElementById('apps-access-state');
const label = document.getElementById('apps-access-label');
const title = document.getElementById('apps-access-title');
const description = document.getElementById('apps-access-description');
const account = document.getElementById('apps-account-link');
const download = document.getElementById('apps-download-link');
const release = document.getElementById('apps-release-details');
const refresh = document.getElementById('apps-refresh');
const closeButton = document.getElementById('apps-dialog-close');
let activeApp;
let opener;
let generation = 0;
let refreshTimer;

function clearDownload() {
  download.hidden = true;
  release.hidden = true;
  release.textContent = '';
}
function show(key, badge, heading, text, action = 'Mein Konto öffnen') {
  clearDownload();
  state.dataset.state = key;
  label.textContent = badge;
  title.textContent = heading;
  description.textContent = text;
  account.hidden = !action;
  account.textContent = action || '';
}
function showError(error) {
  if (error.status === 401 || ['auth', 'LOGIN_REQUIRED'].includes(error.code)) {
    show('signed-out', 'Anmeldung erforderlich', 'Melde dich mit deinem Webseitenkonto an',
      'Nach der Anmeldung kommst du hierher zurück und öffnest deinen Download erneut.', 'Anmelden oder Konto erstellen');
  } else if (error.code === 'email_unconfirmed') {
    show('unconfirmed', 'E-Mail bestätigen', 'Bestätige zuerst deine E-Mail-Adresse',
      'Öffne den Bestätigungslink in deiner E-Mail. Danach kannst du deinen Zugang erneut prüfen.');
  } else if (error.code === 'suspended') {
    show('suspended', 'Konto gesperrt', 'Dein Konto ist derzeit gesperrt',
      'Mit diesem Konto ist aktuell kein Download möglich. Den Status findest du unter „Mein Konto“.');
  } else if (error.code === 'app_access' || error.status === 403) {
    show('revoked', 'Keine aktuelle Freigabe', 'Dein Zugang ist nicht freigegeben',
      'Prüfe unter „Mein Konto“ deine Anfrage zur „Crazy_Batto Discord App“. Diese Freigabe gilt für beide Apps.');
  } else if (error.code === 'unconfigured' || error.status === 503 || error.status === 404) {
    show('unavailable', 'Download nicht verfügbar', 'Die App-Datei ist gerade nicht bereit',
      'Bitte versuche es später über „Status aktualisieren“ erneut.', null);
  } else if (error.status === 429) {
    show('error', 'Bitte kurz warten', 'Zu viele Statusabfragen',
      'Warte einen Moment und wähle dann erneut „Status aktualisieren“.', null);
  } else {
    show('error', 'Prüfung fehlgeschlagen', 'Der Download konnte nicht bestätigt werden',
      'Prüfe deine Internetverbindung und wähle „Status aktualisieren“.', null);
  }
}
function mayCheckDownload(session) {
  const user = session.user;
  if (!user) { showError({ status: 401 }); return false; }
  if (user.suspended) { showError({ code: 'suspended' }); return false; }
  if (!user.confirmed) { showError({ code: 'email_unconfirmed' }); return false; }
  const request = session.requests?.find(item => item.appId === 'discord-app');
  if (user.isAdmin || request?.status === 'approved') return true;
  if (request?.status === 'pending') {
    show('pending', 'Wartet auf Freigabe', 'Deine Anfrage ist eingegangen',
      'Ich prüfe deinen Zugang persönlich. Nach meiner Freigabe kannst du beide Android-Apps herunterladen.', 'Anfragestatus ansehen');
  } else if (['rejected', 'revoked'].includes(request?.status)) {
    show(request.status, request.status === 'revoked' ? 'Freigabe zurückgenommen' : 'Anfrage abgelehnt',
      'Der Download ist noch nicht freigegeben',
      'Unter „Mein Konto“ siehst du deine Anfrage und kannst erneut Zugang anfragen.', 'Anfrage ansehen');
  } else if (session.profileComplete !== true) {
    show('profile-incomplete', 'Profil vervollständigen', 'Bereite deine Zugangsanfrage vor',
      'Vervollständige dein Profil unter „Mein Konto“. Danach kannst du den App-Zugang anfragen.', 'Profil vervollständigen');
  } else {
    show('no-request', 'Zugang anfragen', 'Deine persönliche Freigabe fehlt noch',
      'Frage unter „Mein Konto“ den Zugang zur „Crazy_Batto Discord App“ an. Eine Freigabe gilt für beide Android-Apps.', 'Zugang anfragen');
  }
  return false;
}
async function getRelease(app) {
  if (app === apps['music-remote']) {
    const metadata = await api(app.path + '/metadata');
    if (metadata.downloadUrl !== app.path || metadata.applicationId !== 'de.crazybatto.music'
      || typeof metadata.version !== 'string' || !metadata.version.trim()
      || !Number.isFinite(metadata.bytes) || metadata.bytes <= 0) {
      throw new ApiError('Die Downloadbestätigung ist unvollständig.', 'INVALID_RESPONSE');
    }
    return metadata;
  }
  // The Discord endpoint has no metadata route. HEAD checks the protected file without downloading it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(app.path, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new ApiError('Die App-Datei konnte nicht bestätigt werden.', 'REQUEST_FAILED', response.status);
    const bytes = Number(response.headers.get('content-length'));
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/vnd.android.package-archive'
      || !Number.isFinite(bytes) || bytes <= 0) throw new ApiError('Die App-Datei konnte nicht bestätigt werden.', 'INVALID_RESPONSE');
    return { bytes };
  } finally { clearTimeout(timer); }
}
function releaseText(metadata) {
  const unit = metadata.bytes < 1024 * 1024 ? 'KB' : 'MB';
  const size = metadata.bytes / (unit === 'KB' ? 1024 : 1024 * 1024);
  return [
    metadata.version ? 'Version ' + metadata.version : null,
    size.toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' ' + unit,
    metadata.minimumAndroid ? 'Android ' + metadata.minimumAndroid + ' oder neuer' : 'Android · APK',
  ].filter(Boolean).join(' · ');
}
async function checkAccess({ startDownload = false } = {}) {
  clearTimeout(refreshTimer);
  if (!dialog.open || !activeApp) return;
  const app = activeApp;
  const current = ++generation;
  show('loading', 'Status wird geprüft', startDownload ? 'Download wird vorbereitet' : 'Deinen Zugang prüfen',
    'Deine Anmeldung, die aktuelle Freigabe und die App-Datei werden geprüft.', null);
  state.setAttribute('aria-busy', 'true');
  refresh.disabled = true;
  try {
    const session = await getSession();
    if (current !== generation || !dialog.open) return;
    if (!mayCheckDownload(session)) return;
    const metadata = await getRelease(app);
    if (current !== generation || !dialog.open) return;
    show('approved', 'Freigegeben', 'Deine App ist bereit',
      'Lade die APK auf dein Android-Handy. Melde dich nach der Installation mit deinem Webseitenkonto an.');
    release.textContent = releaseText(metadata);
    release.hidden = false;
    download.hidden = false;
    if (startDownload) {
      description.textContent = 'Der Download wird geöffnet. Du findest die APK anschließend in deinen Downloads.';
      window.location.assign(app.path);
    }
  } catch (error) {
    if (current === generation && dialog.open) showError(error);
  } finally {
    if (current === generation) {
      state.setAttribute('aria-busy', 'false');
      refresh.disabled = false;
    }
  }
}
function invalidate() {
  generation++;
  clearTimeout(refreshTimer);
  clearDownload();
}
function openDownload(key, trigger) {
  if (!Object.hasOwn(apps, key)) return;
  invalidate();
  activeApp = apps[key];
  opener = trigger || document.querySelector('[data-app-download="' + key + '"]');
  document.getElementById('apps-dialog-title').textContent = activeApp.name;
  document.getElementById('apps-guide-link').href = activeApp.guide;
  dialog.querySelector('details').open = false;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add('cb-apps-modal-open');
  closeButton.focus({ preventScroll: true });
  void checkAccess();
}
function scheduleCheck() {
  if (!dialog.open) return;
  invalidate();
  show('loading', 'Status wird geprüft', 'Deinen Zugang erneut prüfen', 'Deine aktuelle Freigabe wird geladen.', null);
  state.setAttribute('aria-busy', 'true');
  refresh.disabled = true;
  if (document.visibilityState === 'visible') refreshTimer = setTimeout(() => void checkAccess(), 100);
}
document.querySelectorAll('[data-app-download]').forEach(button => {
  button.addEventListener('click', () => openDownload(button.dataset.appDownload, button));
});
closeButton.addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  invalidate();
  activeApp = null;
  document.body.classList.remove('cb-apps-modal-open');
  opener?.focus({ preventScroll: true });
});
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
refresh.addEventListener('click', () => void checkAccess());
download.addEventListener('click', () => {
  if (!download.hidden && state.dataset.state === 'approved') void checkAccess({ startDownload: true });
});
window.addEventListener('focus', scheduleCheck);
document.addEventListener('visibilitychange', scheduleCheck);
window.addEventListener('pagehide', invalidate);
window.addEventListener('pageshow', event => { if (event.persisted) scheduleCheck(); });
const requestedApp = new URLSearchParams(window.location.search).get('app');
if (requestedApp && Object.hasOwn(apps, requestedApp)) openDownload(requestedApp);
