import { api, getSession, login, register, logout, errorText, statusLabel, formatDate } from './account-client.js';

// Confirmation links may carry a provider session in the fragment. This app
// deliberately signs in through its server, so never retain those credentials.
const confirmationFragment = new URLSearchParams(location.hash.slice(1));
const confirmationError = confirmationFragment.has('error');
if (['access_token', 'refresh_token', 'error', 'error_description'].some(key => confirmationFragment.has(key))) {
  history.replaceState(null, '', location.pathname + location.search);
}

const $ = id => document.getElementById(id);
let session = { user: null };
let apps = [];
let busy = false;
let licenseGeneration = 0;
const licenseTimers = new Set();
function clearSuiteLicenses() {
  licenseGeneration++;
  for (const timer of licenseTimers) clearTimeout(timer);
  licenseTimers.clear();
  for (const output of document.querySelectorAll('[data-suite-license]')) { output.textContent = ''; output.hidden = true; }
}
function suiteLicenseControls(row) {
  const button = element('button', 'Lizenzschlüssel anzeigen', 'cb-account-button'); button.type = 'button';
  const output = element('code', '', 'cb-account-help cb-suite-license-output'); output.dataset.suiteLicense = 'true'; output.hidden = true;
  const feedback = element('p', '', 'cb-account-help'); feedback.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    clearSuiteLicenses(); const generation = licenseGeneration, userId = session.user?.id;
    if (!userId) return;
    button.disabled = true; feedback.textContent = 'Persönliche Lizenzfreigabe wird geprüft …';
    try {
      const result = await api('/api/account/license/batto-3-in-1', { method: 'POST', body: {} });
      if (generation !== licenseGeneration || session.user?.id !== userId) return;
      if (typeof result.licenseKey !== 'string' || !result.licenseKey || result.licenseKey.length > 512) throw new Error('Die Lizenzantwort ist unvollständig.');
      output.textContent = result.licenseKey; output.hidden = false;
      feedback.textContent = 'Für dein persönlich freigegebenes Konto. Die Anzeige wird nach 60 Sekunden oder beim Verlassen ausgeblendet.';
      const timer = setTimeout(clearSuiteLicenses, 60_000); licenseTimers.add(timer);
    } catch (error) { if (generation === licenseGeneration) feedback.textContent = errorText(error); }
    finally { button.disabled = busy; }
  });
  row.append(button, output, feedback);
}
for (const event of ['pagehide', 'blur', 'offline', 'cb-account-changed']) window.addEventListener(event, clearSuiteLicenses);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearSuiteLicenses(); });

function message(value, error = false) {
  $('accountFeedback').textContent = value;
  $('accountFeedback').classList.toggle('is-error', error);
}
function lock(value) {
  busy = value;
  document.querySelectorAll('.cb-account-wrap button').forEach(button => { button.disabled = value; });
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function render() {
  clearSuiteLicenses();
  const selectedApp = $('requestApp').value || new URLSearchParams(location.search).get('app');
  const user = session.user;
  const approved = !session.approval || session.approval.status === 'approved' || user?.isAdmin;
  $('accountForms').hidden = Boolean(user);
  $('signedInAccount').hidden = !user;
  $('accountAdminLink').hidden = !user?.isAdmin;
  $('requestArea').hidden = !user || !user.confirmed || user.suspended || !approved;
  $('memberApproval').hidden = !user || approved;
  $('profileLink').hidden = !approved;
  $('pcSupportLink').hidden = !user || !approved;
  if (!user) return;
  if (!approved) {
    $('memberApprovalTitle').textContent = session.approval.status === 'rejected' ? 'Registrierung nicht freigegeben' : 'Deine Freigabe steht noch aus';
    $('memberApprovalText').textContent = session.approval.status === 'rejected' ? 'Das Team hat deine Registrierung geprüft. ' + (session.approval.reason || 'Bitte wende dich bei Fragen an Crazy_Batto.') : 'Deine E-Mail ist bestätigt. Crazy_Batto prüft nun deine Registrierung. Nach der Freigabe kannst du die geschützten Mitgliederfunktionen nutzen. Über „Status aktualisieren“ kannst du die Entscheidung abrufen.';
  }
  if ($('profileCompletionNote')) $('profileCompletionNote').hidden = !approved || session.profileComplete !== false;
  if (session.profileComplete === false && !user.isAdmin) $('requestArea').hidden = true;
  $('accountName').textContent = user.name || 'Dein Konto';
  $('accountEmail').textContent = user.email;
  $('accountRights').textContent = user.suspended ? 'Dein Konto ist gesperrt.' : user.confirmed ? (user.canUpload ? 'Musik-Uploads sind für dich freigegeben. Zusätzlich benötigst du das Upload-Kennwort.' : 'Deine E-Mail ist bestätigt. Musik-Uploads kann Crazy_Batto für dich freigeben.') : 'Bitte bestätige zuerst deine E-Mail-Adresse.';
  const requests = session.requests || [];
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const row = element('article', '', 'cb-account-item');
    row.append(element('h3', apps.find(app => app.id === request.appId)?.name || 'App-Zugang'));
    const badge = element('span', statusLabel(request.status), 'cb-account-badge');
    badge.dataset.state = request.status;
    row.append(badge, element('p', `Angefragt: ${formatDate(request.createdAt)}`));
    if (request.note) row.append(element('p', `Deine Nachricht: ${request.note}`));
    if (request.reason) row.append(element('p', `Antwort von Crazy_Batto: ${request.reason}`));
    if (approved && request.status === 'approved' && request.appId === 'discord-app') {
      const download = element('a', 'Meine Apps herunterladen', 'cb-account-button');
      download.href = 'apps.html';
      row.append(download, element('p', 'Discord-App und Musik-App findest du zusammen im Downloadfenster. Deine Freigabe gilt für beide Apps.', 'cb-account-help'));
    }
    if (request.appId === 'batto-3-in-1') {
      row.append(element('p', 'Installer, ZIP und Präsentation sind öffentlich. Der Lizenzschlüssel ist erst nach persönlicher Freigabe von Crazy_Batto in diesem Konto abrufbar.', 'cb-account-help'));
      if (approved && request.status === 'approved' && user.confirmed && !user.suspended) suiteLicenseControls(row);
    }
    fragment.append(row);
  }
  if (!requests.length) fragment.append(element('p', 'Du hast noch keinen App-Zugang angefragt.'));
  $('requestHistory').replaceChildren(fragment);
  $('requestApp').replaceChildren(...apps.map(app => {
    const option = element('option', app.name);
    option.value = app.id;
    return option;
  }));
  if (apps.some(app => app.id === selectedApp)) $('requestApp').value = selectedApp;
  $('requestSubmit').disabled = busy || !apps.length;
}

async function refresh() {
  lock(true);
  message('Dein Konto wird geladen …');
  try {
    const results = await Promise.all([getSession(), api('/api/account/apps')]);
    session = results[0];
    apps = Array.isArray(results[1].apps) ? results[1].apps : [];
    render();
    message(session.user ? 'Dein Kontostand ist aktuell.' : confirmationError ? 'Der Bestätigungslink konnte nicht verwendet werden. Bitte prüfe, ob du bereits angemeldet werden kannst, oder fordere einen neuen Link an.' : new URLSearchParams(location.search).has('confirmed') ? 'Melde dich mit deiner E-Mail und deinem Passwort an. Dabei wird die E-Mail-Bestätigung geprüft.' : 'Erstelle dein Konto oder melde dich an.', confirmationError);
  } catch (error) {
    session = { user: null };
    render();
    message(errorText(error), true);
  } finally { lock(false); render(); }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !event.currentTarget.reportValidity()) return;
  lock(true);
  message('Du wirst angemeldet …');
  try {
    session = await login($('loginEmail').value.trim(), $('loginPassword').value);
    $('loginPassword').value = '';
    render();
    message('Du bist angemeldet.');
    $('accountName').focus();
    const returnTo = new URLSearchParams(location.search).get('returnTo');
    if (returnTo === 'admin' && session.user?.isAdmin && session.user.confirmed && !session.user.suspended) location.assign('admin.html');
    else if (session.approval && session.approval.status !== 'approved' && !session.user?.isAdmin) message(session.approval.status === 'rejected' ? 'Angemeldet. Deine Registrierung wurde nicht freigegeben. Die Begründung findest du unten.' : 'Angemeldet. Deine Registrierung wartet noch auf die Freigabe durch das Team.');
    else if (returnTo === 'chat' && session.user?.confirmed && !session.user.suspended) location.assign('nachrichten.html?app=chat');
    else if (session.profileComplete === false) location.assign('mein-profil.html');
  } catch (error) { message(errorText(error), true); }
  finally { lock(false); render(); }
});

$('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !event.currentTarget.reportValidity()) return;
  if ($('registerPassword').value !== $('registerPasswordRepeat').value) { message('Die beiden Passwörter stimmen nicht überein.', true); return; }
  lock(true);
  message('Deine Registrierung wird gesendet …');
  try {
    const result = await register($('registerName').value.trim(), $('registerEmail').value.trim(), $('registerPassword').value, $('registerBirthDate').value, $('registerBirthdayShared').checked);
    $('loginEmail').value = $('registerEmail').value.trim();
    $('registerPassword').value = $('registerPasswordRepeat').value = '';
    message(result.message || 'Prüfe deine E-Mail auf eine Bestätigung. Melde dich nach der Bestätigung hier an.');
  } catch (error) { message(errorText(error), true); }
  finally { lock(false); }
});

$('requestForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !session.user || (session.approval && session.approval.status !== 'approved' && !session.user.isAdmin) || !event.currentTarget.reportValidity()) return;
  lock(true);
  message('Deine Anfrage wird gesendet …');
  try {
    const result = await api('/api/account/requests', { method: 'POST', body: { appId: $('requestApp').value, note: $('requestNote').value.trim() } });
    if (!result.request?.id) throw new Error('Die Bestätigung der Anfrage fehlt. Bitte aktualisiere deinen Kontostand.');
    session.requests = [...(session.requests || []).filter(request => request.id !== result.request.id), result.request];
    $('requestNote').value = '';
    render();
    message(`Anfrage gespeichert: ${statusLabel(result.request.status)}.`);
  } catch (error) { message(errorText(error), true); }
  finally { lock(false); render(); }
});

$('accountLogout').addEventListener('click', async () => {
  if (busy) return;
  lock(true);
  try { await logout(); session = { user: null }; render(); message('Du bist abgemeldet.'); }
  catch (error) { message(errorText(error), true); }
  finally { lock(false); }
});
$('accountRefresh').addEventListener('click', refresh);
void refresh();
