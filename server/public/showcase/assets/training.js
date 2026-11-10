import { api, getSession, errorText, formatDate } from './account-client.js';

const root = document.querySelector('[data-training-page]');
const isAdminPage = root?.dataset.trainingPage === 'admin';
const $ = id => document.getElementById(id);
const courses = { creator: 'Live-Creator', moderator: 'Moderator' };
const statuses = { pending: 'Offen', accepted: 'Angenommen', rejected: 'Abgelehnt' };
let user = null, registrations = [], busy = false;

function element(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false, target = $('trainingFeedback')) {
  const output = target?.isConnected ? target : $('trainingFeedback');
  output.textContent = text; output.classList.toggle('is-error', error);
}
function registration(value) {
  if (!value || typeof value.id !== 'string' || !Object.hasOwn(courses, value.course) || !Object.hasOwn(statuses, value.status) || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('Die Serverantwort zur Anmeldung ist unvollständig. Bitte den Stand aktualisieren.');
  }
  return value;
}
function privateContent(clearForm = false) {
  registrations = []; $('trainingRegistrations').replaceChildren(); $('trainingContent').hidden = true;
  if ($('trainingAdminLink')) $('trainingAdminLink').hidden = true;
  if ($('trainingCount')) $('trainingCount').textContent = '';
  if (clearForm) $('trainingForm')?.reset();
}
function gate(reason) {
  privateContent(true); $('trainingGate').hidden = false;
  $('trainingGateTitle').textContent = isAdminPage ? 'Nur für Administratoren' : 'Mit deinem Konto anmelden';
  $('trainingGateCopy').textContent = reason || (isAdminPage ? 'Diese Übersicht benötigt dein bestätigtes Administratorkonto.' : 'Melde dich mit deiner bestätigten E-Mail-Adresse an, um eine Schulung anzufragen und deine Anmeldungen zu sehen.');
}
async function access() {
  const result = await getSession(), next = result.user;
  if (user?.id !== next?.id) privateContent(true);
  user = next || null;
  if (!user || !user.confirmed || user.suspended || (isAdminPage && !user.isAdmin)) {
    gate(user?.suspended ? 'Dein Konto ist gesperrt. Eine Schulungsanmeldung ist derzeit nicht möglich.' : user && !user.confirmed ? 'Bitte bestätige zuerst deine E-Mail-Adresse und aktualisiere anschließend diese Seite.' : undefined);
    return false;
  }
  $('trainingGate').hidden = true; return true;
}
async function run(action, pending = 'Wird geladen …', target = $('trainingFeedback')) {
  if (busy) return;
  busy = true; root.setAttribute('aria-busy', 'true');
  const controls = [...root.querySelectorAll('button,input,select')].map(node => [node, node.disabled]);
  controls.forEach(([node]) => { node.disabled = true; }); message(pending, false, target);
  try { await action(); }
  catch (error) {
    if (error.status === 401) { user = null; gate(); }
    else if (error.status === 403) {
      try { await access(); } catch { privateContent(true); }
    }
    message(errorText(error), true, target);
  } finally {
    controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
    busy = false; root.setAttribute('aria-busy', 'false');
    if (!isAdminPage) courseAvailability();
  }
}
function detail(list, title, value) {
  const pair = element('div'); pair.append(element('dt', title), element('dd', String(value ?? '–'))); list.append(pair);
}
function card(entry) {
  const article = element('article', '', 'cb-training-registration'), header = element('div', '', 'cb-training-registration-heading');
  const status = element('span', statuses[entry.status], 'cb-account-badge'); status.dataset.state = entry.status;
  header.append(element('h3', courses[entry.course]), status); article.append(header);
  const fields = element('dl', '', 'cb-training-details');
  detail(fields, 'Name', entry.name); detail(fields, 'Alter bei der Anmeldung', entry.age);
  detail(fields, 'TikTok-Name', entry.tiktokName); detail(fields, 'Discord-Name', entry.discordName);
  detail(fields, 'Angemeldet am', formatDate(entry.createdAt)); detail(fields, 'Zuletzt geändert', formatDate(entry.updatedAt));
  if (isAdminPage) {
    detail(fields, 'Registriertes Konto', entry.user?.name); detail(fields, 'E-Mail', entry.user?.email);
    detail(fields, 'Kontostatus', entry.user?.suspended ? 'Gesperrt' : entry.user?.confirmed ? 'Bestätigt' : 'E-Mail nicht bestätigt');
  }
  if (entry.reviewedAt != null) detail(fields, 'Entschieden am', formatDate(entry.reviewedAt));
  article.append(fields);
  if (!isAdminPage) article.append(element('p', {
    pending: 'Crazy_Batto prüft deine Anmeldung. Aktualisiere diese Seite, um eine Entscheidung zu sehen.',
    accepted: 'Deine Anmeldung wurde angenommen. Damit sind noch kein Termin und kein zusätzlicher Zugang festgelegt.',
    rejected: 'Deine Anmeldung wurde abgelehnt. Falls du erneut teilnehmen möchtest, kannst du eine neue Anfrage stellen.'
  }[entry.status], 'cb-account-help'));
  else article.append(statusForm(entry));
  return article;
}
function courseAvailability() {
  const select = $('trainingCourse'); if (!select) return;
  let available = 0;
  for (const option of select.options) {
    if (!Object.hasOwn(courses, option.value)) continue;
    const active = registrations.find(entry => entry.course === option.value && ['pending', 'accepted'].includes(entry.status));
    option.disabled = Boolean(active); option.textContent = courses[option.value] + (active ? ' · bereits ' + (active.status === 'accepted' ? 'angenommen' : 'angefragt') : '');
    if (!active) available++;
  }
  if (select.selectedOptions[0]?.disabled) select.value = '';
  $('trainingSubmit').disabled = busy || !user || available === 0;
  $('trainingSubmit').textContent = available ? 'Anmeldung senden' : 'Für beide Schulungen bereits angemeldet';
}
function render() {
  let rows = registrations;
  if (isAdminPage) {
    const status = $('trainingStatusFilter').value, course = $('trainingCourseFilter').value, search = $('trainingSearch').value.trim().toLocaleLowerCase('de-DE');
    rows = rows.filter(entry => (!status || entry.status === status) && (!course || entry.course === course) && (!search || [entry.name, entry.tiktokName, entry.discordName, entry.user?.name, entry.user?.email].join(' ').toLocaleLowerCase('de-DE').includes(search)));
    $('trainingCount').textContent = rows.length + ' von ' + registrations.length + ' Anmeldungen';
  }
  $('trainingRegistrations').replaceChildren(...rows.map(card));
  if (!rows.length) $('trainingRegistrations').append(element('p', isAdminPage ? (registrations.length ? 'Keine Anmeldungen passen zu diesen Filtern.' : 'Es liegen noch keine Schulungsanmeldungen vor.') : 'Du hast noch keine Schulungsanmeldung gesendet.', 'cb-account-help'));
  if (!isAdminPage) courseAvailability();
}
async function load() {
  privateContent();
  if (!await access()) { message(isAdminPage ? 'Die Schulungsverwaltung benötigt Administratorrechte.' : 'Melde dich an, um deine Schulungsanmeldung zu senden.'); return false; }
  const result = await api(isAdminPage ? '/api/admin/training' : '/api/training');
  if (!Array.isArray(result.registrations)) throw new Error('Die Anmeldungen konnten nicht vollständig geladen werden. Bitte erneut versuchen.');
  if (!isAdminPage && result.user?.id !== user.id) { privateContent(true); throw new Error('Dein Konto wurde gewechselt. Bitte den Stand erneut aktualisieren.'); }
  registrations = result.registrations.map(registration);
  if (!isAdminPage) {
    $('trainingAccount').textContent = 'Angemeldet als ' + user.name;
    if (!$('trainingName').value.trim()) $('trainingName').value = user.name || '';
    $('trainingAdminLink').hidden = !user.isAdmin;
  }
  render(); $('trainingContent').hidden = false; message('Die Schulungsanmeldungen sind aktuell.'); return true;
}
function statusForm(entry) {
  const form = element('form', '', 'cb-account-form cb-training-status-form'), wrap = element('div', '', 'cb-training-field'), label = element('label', 'Anmeldestatus'), select = element('select');
  select.id = 'training-status-' + entry.id; label.htmlFor = select.id;
  for (const [value, text] of Object.entries(statuses)) {
    const option = element('option', text); option.value = value;
    option.disabled = value !== 'rejected' && (!entry.user?.confirmed || entry.user?.suspended); select.append(option);
  }
  select.value = entry.status; wrap.append(label, select);
  const save = element('button', 'Status speichern'); save.type = 'submit';
  const note = element('p', '', 'cb-account-feedback'); note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
  form.append(wrap, save, note);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (busy || !form.reportValidity()) return;
    if (select.value === entry.status) { message('Der Status ist unverändert.', false, note); return; }
    const status = select.value;
    void run(async () => {
      let result;
      try { result = await api('/api/admin/training/registrations/' + encodeURIComponent(entry.id), { method: 'PATCH', body: { status, expectedRevision: entry.revision } }); }
      catch (error) {
        if (error.status === 409) {
          const updated = await load();
          if (updated) throw new Error(errorText(error) + ' Der aktuelle Stand wurde geladen. Bitte deine Entscheidung erneut prüfen.');
        }
        throw error;
      }
      const saved = registration(result.registration);
      if (saved.id !== entry.id || saved.status !== status) throw new Error('Die Statusänderung konnte nicht bestätigt werden. Bitte die Anmeldungen aktualisieren.');
      registrations = registrations.map(item => item.id === saved.id ? { ...saved, user: item.user } : item); render();
      message('Anmeldung von ' + saved.name + ': ' + statuses[saved.status] + '. Der Status wurde gespeichert.');
    }, 'Status wird gespeichert …', note);
  });
  return form;
}

$('trainingRefresh')?.addEventListener('click', () => { void run(load, 'Anmeldungen werden geladen …'); });
if (isAdminPage) {
  $('trainingStatusFilter').addEventListener('change', render); $('trainingCourseFilter').addEventListener('change', render); $('trainingSearch').addEventListener('input', render);
} else if (root) {
  $('trainingForm').addEventListener('submit', event => {
    event.preventDefault(); if (busy || !event.currentTarget.reportValidity()) return;
    const body = { course: $('trainingCourse').value, name: $('trainingName').value.trim(), age: Number($('trainingAge').value), tiktokName: $('trainingTikTok').value.trim(), discordName: $('trainingDiscord').value.trim() };
    if (!Object.hasOwn(courses, body.course) || body.name.length < 2 || !Number.isSafeInteger(body.age) || body.age < 1 || body.age > 120 || !body.tiktokName || !body.discordName) { message('Bitte wähle eine Schulung und fülle alle Angaben vollständig aus. Das Alter muss eine ganze Zahl zwischen 1 und 120 sein.', true); return; }
    void run(async () => {
      let result;
      try { result = await api('/api/training/registrations', { method: 'POST', body }); }
      catch (error) { if (error.status === 409) await load(); throw error; }
      const saved = registration(result.registration);
      if (saved.course !== body.course || saved.status !== 'pending') throw new Error('Die neue Anmeldung konnte nicht bestätigt werden. Bitte den Stand aktualisieren.');
      registrations = [saved, ...registrations.filter(entry => entry.id !== saved.id)]; $('trainingCourse').value = ''; render();
      message('Deine Anmeldung für ' + courses[saved.course] + ' wurde gespeichert. Status: Offen. Crazy_Batto prüft deine Anfrage.');
    }, 'Deine Anmeldung wird gespeichert …');
  });
}
if (root) void run(load, isAdminPage ? 'Administrator-Rechte werden geprüft …' : 'Deine Anmeldungen werden geladen …');
