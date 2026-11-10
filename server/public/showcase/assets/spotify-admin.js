import { api, getSession, errorText } from './account-client.js';

const $ = id => document.getElementById(id);
let config = null;
let busy = false;
function message(text, error = false) {
  $('spotifyAdminFeedback').textContent = text;
  $('spotifyAdminFeedback').classList.toggle('is-error', error);
}
function lock(value) {
  busy = value;
  $('spotifyAdmin').setAttribute('aria-busy', String(value));
  $('spotifyAdminContent').querySelectorAll('button,input').forEach(node => { node.disabled = value || Boolean(config?.previewOnly); });
  $('spotifyAdminRefresh').disabled = value;
  $('spotifyCheckCredentials').disabled = value || !config?.configured || Boolean(config?.previewOnly);
  $('spotifyCopyCallback').disabled = value || !config?.redirectUri || Boolean(config?.previewOnly);
}
function clearPrivate() {
  config = null;
  $('spotifyAdminContent').hidden = true;
  $('spotifyAdminGate').hidden = false;
  $('spotifyClientId').value = '';
  $('spotifyClientSecret').value = '';
  $('spotifyCallback').value = '';
  $('spotifyCredentialCheck').textContent = 'Noch keine Prüfung in dieser Ansicht durchgeführt.';
}
async function load() {
  const session = await getSession();
  if (!session.user?.confirmed || session.user.suspended || !session.user.isAdmin) {
    clearPrivate();
    $('spotifyAdminGateText').textContent = session.user?.suspended ? 'Dein Konto ist gesperrt.' : session.user && !session.user.confirmed ? 'Bitte bestätige zuerst deine E-Mail-Adresse.' : 'Diese Einrichtung benötigt dein bestätigtes Administratorkonto.';
    return false;
  }
  const result = await api('/api/admin/spotify');
  if (!Number.isSafeInteger(result.revision) || typeof result.clientId !== 'string' || (result.redirectUri !== null && typeof result.redirectUri !== 'string')) throw new Error('Die Spotify-Konfiguration konnte nicht gelesen werden.');
  config = result;
  $('spotifyClientId').value = result.clientId;
  $('spotifyClientSecret').value = '';
  $('spotifyCallback').value = result.redirectUri || '';
  $('spotifyCallbackHelp').textContent = result.redirectUri ? 'Die Adresse stammt aus der Serverkonfiguration. Bei einer falschen Domain muss die Betreiberadresse am Server berichtigt werden.' : 'Die öffentliche Betreiberadresse fehlt oder ist ungültig. Sie muss zuerst am Server eingerichtet werden; eine Spotify-Verbindung ist bis dahin nicht möglich.';
  $('spotifyAdminPreview').hidden = !result.previewOnly;
  $('spotifyCredentialsState').textContent = result.secretConfigured ? 'Ein Client Secret ist gespeichert. Sein Inhalt bleibt verborgen.' : 'Noch kein Client Secret gespeichert.';
  $('spotifyAdminGate').hidden = true;
  $('spotifyAdminContent').hidden = false;
  return true;
}
async function run(action) {
  if (busy) return;
  lock(true);
  try { await action(); }
  catch (error) {
    if ([401,403].includes(error.status)) clearPrivate();
    if (error.status === 409) {
      try { await load(); } catch { clearPrivate(); }
      message('Die Konfiguration wurde inzwischen geändert. Der aktuelle Stand wurde neu geladen. Prüfe deine Angaben vor dem erneuten Speichern.', true);
    } else message(errorText(error), true);
  } finally { lock(false); }
}
$('spotifyAdminRefresh').addEventListener('click', () => run(async () => {
  clearPrivate();
  message(await load() ? 'Konfiguration geladen. Zugangsdaten werden erst auf deinen Klick geprüft.' : 'Die Einrichtung benötigt Administratorrechte.');
}));
$('spotifyCredentialsForm').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !config || config.previewOnly || !event.currentTarget.reportValidity()) return;
  const clientId = $('spotifyClientId').value.trim();
  let secret = $('spotifyClientSecret').value.trim();
  if ((!config.secretConfigured || clientId !== config.clientId) && !secret) {
    message('Für diese Client ID wird ein Client Secret benötigt.', true);
    $('spotifyClientSecret').focus(); return;
  }
  const body = { clientId, expectedRevision: config.revision, ...(secret ? { clientSecret: secret } : {}) };
  $('spotifyClientSecret').value = ''; secret = '';
  run(async () => {
    try { await api('/api/admin/spotify', { method: 'PUT', body }); }
    finally { delete body.clientSecret; }
    await load();
    $('spotifyCredentialCheck').textContent = 'Geänderte Zugangsdaten wurden noch nicht geprüft.';
    message('Spotify-Zugangsdaten gespeichert. Bestehende Spotify-Verbindungen müssen erneut verbunden werden.');
  });
});
$('spotifyCheckCredentials').addEventListener('click', () => run(async () => {
  if (!config?.configured || config.previewOnly) return;
  $('spotifyCredentialCheck').textContent = 'Gespeicherte Zugangsdaten werden geprüft …';
  try {
    const result = await api('/api/admin/spotify/check-credentials', { method: 'POST', body: { expectedRevision: config.revision } });
    if (result.ok !== true) throw new Error('Der Server hat die Zugangsdaten nicht als gültig bestätigt.');
    $('spotifyCredentialCheck').textContent = 'Spotify hat die gespeicherten App-Zugangsdaten angenommen.';
    message('Prüfung abgeschlossen. Die Nutzerverbindung erfolgt separat im Player.');
  } catch (error) { $('spotifyCredentialCheck').textContent = 'Die Prüfung ist fehlgeschlagen. Einzelheiten stehen oben.'; throw error; }
}));
$('spotifyCopyCallback').addEventListener('click', async () => {
  if (!config?.redirectUri) return;
  try { await navigator.clipboard.writeText(config.redirectUri); message('Callback-Adresse kopiert.'); }
  catch { $('spotifyCallback').focus(); $('spotifyCallback').select(); message('Bitte die markierte Callback-Adresse kopieren.'); }
});
run(async () => { message(await load() ? (config.previewOnly ? 'Lokale Vorschau: Eingabe und Prüfung echter Spotify-Zugangsdaten sind hier gesperrt.' : 'Konfiguration geladen. Es wurde noch keine Verbindung zu Spotify geprüft.') : 'Die Einrichtung benötigt Administratorrechte.'); });
