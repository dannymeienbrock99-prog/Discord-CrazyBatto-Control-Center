import { api, getSession, logout, errorText, statusLabel, formatDate, storageStatusText } from './account-client.js';
import { createVisitorStats } from './visitor-stats.js';

const $ = id => document.getElementById(id);
let session = { user: null };
let overview = null;
let busy = false;
let lastRefresh = 0;
let generation = 0;
const drafts = new Map();
const visitorStats = createVisitorStats({
  getContext: () => ({ generation, allowed: Boolean(overview && session.user?.isAdmin && session.user.confirmed && !session.user.suspended && !$('adminContent').hidden) }),
  onAuthError: () => {
    generation++;
    session = { user: null };
    hidePrivate();
    lock(false);
    message('Bitte melde dich erneut mit deinem Administratorkonto an.');
    $('adminLiveStatus').textContent = 'Anmeldung mit Administratorkonto erforderlich.';
  },
});
function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  $('adminFeedback').textContent = text;
  $('adminFeedback').classList.toggle('is-error', error);
}
function lock(value) {
  busy = value;
  $('adminContent').setAttribute('aria-busy', String(value));
  document.querySelectorAll('#adminContent button, #adminContent input, #adminContent textarea, #adminContent select').forEach(node => { node.disabled = value || node.dataset.suiteDecisionDenied === 'true'; });
  $('adminRefresh').disabled = value;
  $('adminLogout').disabled = value;
  visitorStats.setLocked(value);
}
function hidePrivate({ preserveDrafts = false } = {}) {
  visitorStats.clear();
  overview = null;
  $('adminContent').hidden = true;
  $('adminGate').hidden = false;
  $('adminUsers').replaceChildren();
  $('adminRequests').replaceChildren();
  $('adminUploadPassword').value = $('adminUploadPasswordRepeat').value = '';
  $('adminLogout').hidden = true;
  if (!preserveDrafts) drafts.clear();
}
function userToggle(user, key, label) {
  const wrap = element('label', '', 'cb-admin-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(user[key]);
  input.disabled = busy || (key === 'suspended' && user.id === session.user?.id);
  input.setAttribute('aria-label', `${label}: ${user.name || user.email}`);
  input.addEventListener('change', () => mutate(async () => {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { [key]: input.checked } });
  }, 'Berechtigung gespeichert.'));
  wrap.append(input, element('span', label));
  return wrap;
}
function renderUsers() {
  if (!overview) return;
  const query = $('adminUserSearch').value.trim().toLocaleLowerCase('de-DE');
  const users = overview.users.filter(user => `${user.name} ${user.email}`.toLocaleLowerCase('de-DE').includes(query));
  const fragment = document.createDocumentFragment();
  for (const user of users) {
    const row = document.createElement('tr');
    const name = element('td', user.name || 'Ohne Namen');
    if (user.isAdmin) name.append(element('small', 'Administrator'));
    const email = element('td', user.email);
    email.append(element('small', user.confirmed ? 'E-Mail bestätigt' : 'E-Mail noch nicht bestätigt'));
    const created = element('td', formatDate(user.createdAt));
    const rights = document.createElement('td');
    rights.append(userToggle(user, 'canUpload', 'Musik hochladen'));
    const suspension = document.createElement('td');
    suspension.append(userToggle(user, 'suspended', 'Konto sperren'));
    row.append(name, email, created, rights, suspension);
    ['Name', 'E-Mail', 'Registriert', 'Musikrechte', 'Kontostatus'].forEach((label, index) => { row.children[index].dataset.label = label; });
    fragment.append(row);
  }
  if (!users.length) {
    const row = document.createElement('tr');
    const cell = element('td', 'Keine passenden Registrierungen.');
    cell.colSpan = 5;
    row.append(cell);
    fragment.append(row);
  }
  $('adminUsers').replaceChildren(fragment);
}
function renderRequests() {
  if (!overview) return;
  const filter = $('adminRequestFilter').value;
  const requests = overview.requests.filter(request => !filter || request.status === filter);
  const fragment = document.createDocumentFragment();
  for (const request of requests) {
    const row = element('article', '', 'cb-account-item');
    const heading = element('div', '', 'cb-admin-request-head');
    heading.append(element('h3', request.userName || request.email || 'Registriertes Konto'));
    const badge = element('span', statusLabel(request.status), 'cb-account-badge');
    badge.dataset.state = request.status;
    heading.append(badge);
    row.append(heading, element('p', `${request.email || ''} · ${request.appId === 'discord-app' ? 'Discord- und Musik-App' : request.appId === 'batto-3-in-1' ? 'Batto 3-in-1 für Windows' : request.appId}`), element('p', `Angefragt: ${formatDate(request.createdAt)}`));
    if (request.note) row.append(element('p', `Nachricht: ${request.note}`));
    if (request.reason) row.append(element('p', `Bisherige Antwort: ${request.reason}`));
    const label = element('label', 'Antwort an den Nutzer (optional)', 'cb-account-label');
    const reason = document.createElement('textarea');
    reason.rows = 2;
    reason.maxLength = 500;
    reason.placeholder = 'Kurze Begründung oder Nachricht';
    reason.value = drafts.get(request.id) || '';
    reason.addEventListener('input', () => { if (reason.value) drafts.set(request.id, reason.value); else drafts.delete(request.id); });
    label.append(reason);
    const note = element('details', '', 'cb-admin-request-note');
    note.open = Boolean(reason.value);
    note.append(element('summary', 'Antwort hinzufügen (optional)'));
    const form = element('div', '', 'cb-account-form');
    form.append(label);
    note.append(form);
    const actions = element('div', '', 'cb-account-actions');
    const decisions = request.status === 'approved' ? [['revoked', request.appId === 'batto-3-in-1' ? 'Lizenzabruf sperren' : 'Zugang sperren']]
      : request.status === 'pending' ? [['approved', 'Freigeben'], ['rejected', 'Ablehnen']]
      : [['approved', 'Erneut freigeben']];
    for (const [decision, text] of decisions) {
      const button = element('button', text, `cb-account-button${decision === 'approved' ? '' : ' secondary'}`);
      button.type = 'button';
      button.disabled = busy || request.canDecide === false;
      if (request.canDecide === false) button.dataset.suiteDecisionDenied = 'true';
      button.addEventListener('click', () => mutate(async () => {
        await api(`/api/admin/requests/${encodeURIComponent(request.id)}/decision`, { method: 'POST', body: { decision, reason: reason.value.trim() } });
        drafts.delete(request.id);
      }, 'Entscheidung gespeichert.'));
      actions.append(button);
    }
    row.append(actions, note);
    if (request.appId === 'batto-3-in-1') row.append(element('p', request.canDecide === false ? 'Diese Lizenzanfrage kann nur Crazy_Batto persönlich entscheiden.' : 'Eine Sperre beendet künftige Lizenzabrufe im Konto. Ein bereits ausgegebener Schlüssel wird dadurch nicht zurückgerufen.', 'cb-account-help'));
    fragment.append(row);
  }
  if (!requests.length) fragment.append(element('p', 'Keine Anfragen in dieser Ansicht.'));
  $('adminRequests').replaceChildren(fragment);
}
function renderOverview() {
  $('adminContent').hidden = false;
  $('adminGate').hidden = true;
  $('adminLogout').hidden = false;
  $('adminCountUsers').textContent = String(overview.counts?.users ?? overview.users.length);
  $('adminCountPending').textContent = String(overview.counts?.pending ?? overview.requests.filter(request => request.status === 'pending').length);
  $('adminCountUploaders').textContent = String(overview.counts?.uploaders ?? overview.users.filter(user => user.canUpload).length);
  $('adminStorageStatus').textContent = storageStatusText(overview.storage);
  $('adminBotStatus').textContent = overview.bot?.message || (overview.bot?.configured ? 'Bot ist eingerichtet.' : 'Bot ist noch nicht eingerichtet.');
  $('adminPasswordState').textContent = overview.settings?.uploadPasswordSet ? 'Ein Upload-Kennwort ist eingerichtet. Du kannst es hier ersetzen.' : 'Noch kein Upload-Kennwort eingerichtet. Uploads bleiben bis zur Einrichtung gesperrt.';
  renderUsers();
  renderRequests();
}
async function loadOverview(current) {
  const result = await api('/api/admin/overview');
  if (current !== generation) return false;
  if (!Array.isArray(result.users) || !Array.isArray(result.requests)) throw new Error('Die Verwaltungsdaten sind unvollständig. Bitte neu laden.');
  overview = result;
  renderOverview();
  return true;
}
async function refresh({ automatic = false } = {}) {
  if (busy) return;
  if (automatic && (document.hidden || navigator.onLine === false || Date.now() - lastRefresh < 1500)) return;
  if (automatic && (drafts.size || document.activeElement?.matches('#adminContent input, #adminContent textarea, #adminContent select'))) {
    $('adminLiveStatus').textContent = 'Du bearbeitest gerade etwas. Automatische Aktualisierung pausiert; dein Entwurf bleibt erhalten.';
    return;
  }
  lock(true);
  visitorStats.cancel();
  const current = ++generation;
  if (!automatic) message('Verwaltung wird geladen …');
  try {
    const nextSession = await getSession();
    if (current !== generation) return;
    if (session.user?.id && session.user.id !== nextSession.user?.id) drafts.clear();
    session = nextSession;
    if (!session.user?.isAdmin || !session.user.confirmed || session.user.suspended) { hidePrivate(); message('Bitte melde dich mit deinem freigeschalteten Administratorkonto an.'); $('adminLiveStatus').textContent = 'Anmeldung mit Administratorkonto erforderlich.'; return; }
    if (!await loadOverview(current)) return;
    void visitorStats.refresh();
    lastRefresh = Date.now();
    $('adminLiveStatus').textContent = `Aktuell um ${new Date(lastRefresh).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} · neue Anfragen alle 30 Sekunden.`;
    if (!automatic) message('Verwaltung aktualisiert.');
  } catch (error) {
    if (current !== generation) return;
    hidePrivate({ preserveDrafts: ![401, 403].includes(error.status) });
    message(errorText(error), true); $('adminLiveStatus').textContent = 'Keine aktuelle Verbindung. Bitte erneut aktualisieren.';
  }
  finally { if (current === generation) { lock(false); if (overview) renderUsers(); } }
}
async function mutate(action, success) {
  if (busy) return;
  lock(true);
  visitorStats.cancel();
  const current = ++generation;
  message('Änderung wird gespeichert …');
  try { await action(); if (current !== generation || !await loadOverview(current)) return; void visitorStats.refresh(); lastRefresh = Date.now(); message(success); }
  catch (error) { if (current !== generation) return; if ([401, 403].includes(error.status)) hidePrivate(); message(errorText(error), true); }
  finally { if (current === generation) { lock(false); if (overview) { renderUsers(); renderRequests(); } } }
}
$('adminPasswordForm').addEventListener('submit', event => {
  event.preventDefault();
  if (busy || !event.currentTarget.reportValidity()) return;
  if ($('adminUploadPassword').value !== $('adminUploadPasswordRepeat').value) { message('Die beiden Kennwörter stimmen nicht überein.', true); return; }
  const password = $('adminUploadPassword').value;
  void mutate(async () => {
    await api('/api/admin/upload-password', { method: 'PUT', body: { password } });
    $('adminUploadPassword').value = $('adminUploadPasswordRepeat').value = '';
  }, 'Upload-Kennwort gespeichert. Bereits erteilte Upload-Freigaben müssen das neue Kennwort eingeben.');
});
$('adminRefresh').addEventListener('click', refresh);
$('adminLogout').addEventListener('click', async () => {
  if (busy) return;
  visitorStats.clear();
  lock(true);
  try { await logout(); session = { user: null }; hidePrivate(); message('Du bist abgemeldet.'); $('adminLiveStatus').textContent = ''; }
  catch (error) { message(errorText(error), true); }
  finally { lock(false); }
});
$('adminUserSearch').addEventListener('input', renderUsers);
$('adminRequestFilter').addEventListener('change', renderRequests);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh({ automatic: true }); });
window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
window.addEventListener('online', () => { void refresh(); });
window.addEventListener('offline', () => { generation++; lock(false); hidePrivate({ preserveDrafts: true }); message('Du bist offline. Freigaben brauchen eine Internetverbindung. Dein Antwortentwurf bleibt für diese Sitzung erhalten.', true); $('adminLiveStatus').textContent = 'Nicht verbunden.'; });
setInterval(() => { if (session.user?.isAdmin) void refresh({ automatic: true }); }, 30_000);
if (location.hash === '#app-install') $('app-install').open = true;
void refresh();
