import { api, getSession } from './account-client.js';

const DOWNLOAD_PATH = '/api/account/download/music-remote';
const card = document.getElementById('music-download-card');
const label = document.getElementById('music-access-label');
const title = document.getElementById('music-access-title');
const description = document.getElementById('music-access-description');
const accountLink = document.getElementById('music-account-link');
const downloadLink = document.getElementById('music-download-link');
const releaseDetails = document.getElementById('music-release-details');
const refreshButton = document.getElementById('music-refresh');
let generation = 0;
let refreshTimer;

function clearDownload() {
  downloadLink.hidden = true;
  downloadLink.removeAttribute('href');
  releaseDetails.hidden = true;
  releaseDetails.textContent = '';
}

function show(state, badge, heading, text, action = 'Mein Konto öffnen') {
  clearDownload();
  card.dataset.state = state;
  label.textContent = badge;
  title.textContent = heading;
  description.textContent = text;
  accountLink.hidden = !action;
  accountLink.textContent = action || '';
}

function showError(error) {
  if (error.status === 401 || error.code === 'auth' || error.code === 'LOGIN_REQUIRED') {
    show('signed-out', 'Anmeldung erforderlich', 'Melde dich auf der Webseite an',
      'Verwende dein Konto von crazybatto.de. Danach kannst du hier deine Freigabe prüfen und die Musik-App herunterladen.', 'Anmelden oder Konto erstellen');
  } else if (error.code === 'email_unconfirmed') {
    show('unconfirmed', 'E-Mail noch offen', 'Bestätige deine E-Mail-Adresse',
      'Öffne den Bestätigungslink in deiner E-Mail. Melde dich anschließend auf der Webseite an und prüfe deinen Status erneut.');
  } else if (error.code === 'suspended') {
    show('suspended', 'Konto gesperrt', 'Dein Konto ist derzeit gesperrt',
      'Mit diesem Konto ist aktuell kein Download möglich. Öffne dein Konto, um den Status anzusehen.');
  } else if (error.code === 'app_access' || error.status === 403) {
    show('revoked', 'Keine aktuelle Freigabe', 'Dein Zugang ist nicht freigegeben',
      'Für den Download brauchst du die aktuelle Freigabe zur „Crazy_Batto Discord App“. Prüfe deine Anfrage unter „Mein Konto“.');
  } else if (error.code === 'unconfigured') {
    show('unavailable', 'Download nicht verfügbar', 'Die App-Datei ist gerade nicht bereit',
      'Der Download konnte noch nicht bereitgestellt werden. Bitte versuche es später mit „Status aktualisieren“ erneut.');
  } else if (error.status === 429) {
    show('error', 'Bitte kurz warten', 'Zu viele Statusabfragen',
      'Bitte warte einen Moment und wähle anschließend erneut „Status aktualisieren“.');
  } else {
    show('error', 'Status nicht verfügbar', 'Dein Zugang konnte nicht geprüft werden',
      'Prüfe deine Internetverbindung und wähle „Status aktualisieren“. Solange der Server deinen Zugang nicht bestätigt, bleibt der Download ausgeblendet.');
  }
}

function mayCheckDownload(session) {
  const user = session.user;
  if (!user) {
    show('signed-out', 'Anmeldung erforderlich', 'Dein Zugang beginnt mit einem Konto',
      'Melde dich an oder erstelle dein Konto auf crazybatto.de. Nach meiner persönlichen Freigabe erscheint hier dein Android-Download.', 'Anmelden oder Konto erstellen');
    return false;
  }
  if (user.suspended) {
    showError({ code: 'suspended' });
    return false;
  }
  if (!user.confirmed) {
    showError({ code: 'email_unconfirmed' });
    return false;
  }
  const request = session.requests?.find(item => item.appId === 'discord-app');
  if (user.isAdmin || request?.status === 'approved') return true;
  if (request?.status === 'pending') {
    show('pending', 'Wartet auf Freigabe', 'Deine Anfrage ist eingegangen',
      'Ich prüfe deinen Zugang persönlich. Sobald die Anfrage zur „Crazy_Batto Discord App“ freigegeben ist, kannst du auch die Musik-App herunterladen.', 'Anfragestatus ansehen');
  } else if (request?.status === 'rejected' || request?.status === 'revoked') {
    const revoked = request.status === 'revoked';
    show(request.status, revoked ? 'Freigabe zurückgenommen' : 'Anfrage abgelehnt',
      revoked ? 'Dein Zugang ist nicht mehr freigegeben' : 'Deine Anfrage wurde nicht freigegeben',
      'Der Download ist deshalb nicht verfügbar. Unter „Mein Konto“ siehst du deine Anfrage und kannst erneut Zugang anfragen.', 'Anfrage ansehen');
  } else if (session.profileComplete !== true) {
    show('profile-incomplete', 'Profil vervollständigen', 'Bereite deine Zugangsanfrage vor',
      'Vervollständige unter „Mein Konto“ zuerst dein Profil. Danach kannst du den Zugang zur „Crazy_Batto Discord App“ anfragen.', 'Profil vervollständigen');
  } else {
    show('no-request', 'Zugang noch nicht angefragt', 'Frage deinen App-Zugang an',
      'Wähle unter „Mein Konto“ die „Crazy_Batto Discord App“ und sende deine Zugangsanfrage. Eine Freigabe gilt auch für diese Musik-App.', 'Zugang anfragen');
  }
  return false;
}

async function checkAccess({ download = false } = {}) {
  clearTimeout(refreshTimer);
  const current = ++generation;
  show('loading', 'Status wird geprüft', download ? 'Download wird vorbereitet' : 'Deinen Zugang prüfen',
    'Deine Anmeldung, die aktuelle Freigabe und die verfügbare App-Datei werden geprüft.', null);
  card.setAttribute('aria-busy', 'true');
  refreshButton.disabled = true;
  try {
    const session = await getSession();
    if (current !== generation) return;
    if (!mayCheckDownload(session)) return;
    const metadata = await api(`${DOWNLOAD_PATH}/metadata`);
    if (current !== generation) return;
    if (metadata.downloadUrl !== DOWNLOAD_PATH || metadata.applicationId !== 'de.crazybatto.music'
      || typeof metadata.version !== 'string' || !metadata.version.trim()
      || !Number.isFinite(metadata.bytes) || metadata.bytes <= 0) {
      throw new Error('Unvollständige Downloadbestätigung');
    }
    show('approved', 'Freigegeben', 'Deine Musik-App ist bereit',
      'Lade die Android-App auf dein Handy und öffne danach „Crazy_Batto Musik“. Melde dich dort mit deinem Webseitenkonto an.', 'Mein Konto öffnen');
    const sizeUnit = metadata.bytes < 1024 * 1024 ? 'KB' : 'MB';
    const size = metadata.bytes / (sizeUnit === 'KB' ? 1024 : 1024 * 1024);
    releaseDetails.textContent = `Version ${metadata.version} · ${size.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${sizeUnit} · Android ${metadata.minimumAndroid || '8.0'} oder neuer`;
    releaseDetails.hidden = false;
    accountLink.className = 'cb-portal-text-button cursor-interaction';
    downloadLink.href = DOWNLOAD_PATH;
    downloadLink.hidden = false;
    if (download) {
      description.textContent = 'Der Download wird geöffnet. Du findest die APK anschließend in deinen Downloads. Die Installationsschritte stehen weiter unten.';
      window.location.assign(DOWNLOAD_PATH);
    }
  } catch (error) {
    if (current === generation) showError(error);
  } finally {
    if (current === generation) {
      card.setAttribute('aria-busy', 'false');
      refreshButton.disabled = false;
      if (card.dataset.state !== 'approved') accountLink.className = 'cb-button cb-button-gold cursor-interaction';
    }
  }
}

function invalidate() {
  generation++;
  clearTimeout(refreshTimer);
  clearDownload();
  card.setAttribute('aria-busy', 'false');
  refreshButton.disabled = false;
}

function scheduleCheck() {
  invalidate();
  if (document.visibilityState === 'visible') refreshTimer = setTimeout(() => void checkAccess(), 100);
}

refreshButton.addEventListener('click', () => void checkAccess());
downloadLink.addEventListener('click', event => {
  event.preventDefault();
  if (downloadLink.hidden || !downloadLink.hasAttribute('href')) return;
  void checkAccess({ download: true });
});
window.addEventListener('focus', scheduleCheck);
document.addEventListener('visibilitychange', scheduleCheck);
window.addEventListener('pagehide', invalidate);
window.addEventListener('pageshow', event => { if (event.persisted) scheduleCheck(); });
void checkAccess();
