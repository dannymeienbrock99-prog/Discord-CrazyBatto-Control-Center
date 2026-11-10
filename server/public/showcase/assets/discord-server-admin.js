import { api, getSession, errorText, formatDate } from './account-client.js';

const $ = id => document.getElementById(id);
const root = $('directoryAdmin');
const endpoint = '/api/admin/discord-servers';
const ownerGuildId = '900000000000000018';
let entries = [], revision = null, limits = { entries: 20, description: 300 };
let identity = null, generation = 0, localSequence = 0;
let busy = false, loaded = false, dirty = false, conflict = false, saveUncertain = false, needsAccessCheck = false;

function element(tag, text = '', className = '') {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error = false) {
  $('directoryFeedback').textContent = text;
  $('directoryFeedback').classList.toggle('is-error', error);
}
function clearPrivate() {
  entries = []; revision = null; loaded = false; dirty = false; conflict = false; saveUncertain = false;
  $('directoryEntries').replaceChildren(); $('directoryCount').textContent = '';
  $('directoryEditor').hidden = true; $('directoryDiscard').hidden = true;
}
function gate(text) {
  clearPrivate(); identity = null; $('directoryGate').hidden = false;
  $('directoryGateCopy').textContent = text || 'Melde dich mit deinem bestätigten Administratorkonto an, um die Serverübersicht zu verwalten.';
}
function identityOf(session) { return session?.user ? `${session.user.id}:${session.csrfToken}` : null; }
async function access(ticket, expected = null) {
  const session = await getSession();
  if (ticket !== generation) return null;
  if (!session.user?.confirmed || !session.user.isAdmin || session.user.suspended) {
    gate(session.user ? 'Dieses Konto hat derzeit keine bestätigte Administratorfreigabe.' : undefined);
    return null;
  }
  const next = identityOf(session);
  if ((identity && identity !== next) || (expected && expected !== next)) {
    clearPrivate(); identity = next;
    message('Die Anmeldung hat sich geändert. Lade den gespeicherten Stand erneut.', true);
    return null;
  }
  identity = next; $('directoryGate').hidden = true;
  return next;
}
function syncControls() {
  root.setAttribute('aria-busy', String(busy));
  root.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = busy; });
  $('directoryAdd').disabled = busy || !loaded || entries.length >= limits.entries;
  $('directorySave').disabled = busy || !loaded || !dirty || conflict || saveUncertain;
  entries.forEach((entry, index) => {
    const row = document.getElementById(entry.key);
    if (!row) return;
    row.querySelector('[data-move="up"]').disabled = busy || index === 0;
    row.querySelector('[data-move="down"]').disabled = busy || index === entries.length - 1;
    row.querySelector('[data-owner-banner]').disabled = !ownerAllowed(entry);
  });
  $('directoryDraftState').textContent = saveUncertain
    ? 'Die Speicherung konnte nicht bestätigt werden. Dein Entwurf bleibt hier erhalten. Lade den gespeicherten Stand, bevor du weitere Änderungen speicherst.'
    : conflict
    ? 'Der gespeicherte Stand wurde inzwischen geändert. Dein Entwurf bleibt hier erhalten. Lade den aktuellen Stand, bevor du erneut speicherst.'
    : dirty ? 'Ungespeicherte Änderungen. Erst „Änderungen speichern“ veröffentlicht deinen Entwurf.'
      : 'Alle angezeigten Einträge entsprechen dem zuletzt geladenen Stand.';
}
function markDirty() { dirty = true; $('directoryDiscard').hidden = true; syncControls(); }
function ownerAllowed(entry) {
  return entry.source.trim() === ownerGuildId
    || (entry.source.trim() === entry.resolvedSource && entry.guildId === ownerGuildId);
}
function sameOriginImage(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, location.origin);
    const approvedImage = /^\/api\/(?:admin\/)?discord-servers\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/images\/(?:banner|icon)$/.test(url.pathname)
      || ['/assets/crazy-batto-discord-banner.gif', '/assets/team-alpha-banner-20261016.webp', '/assets/team-alpha-banner-poster-20261016.webp', '/assets/team-alpha-banner-motion-20261016.gif', '/assets/team-alpha-banner-motion-poster-20261016.webp'].includes(url.pathname);
    return url.origin === location.origin && !url.username && !url.password && approvedImage ? url.href : null;
  } catch { return null; }
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('de-DE') : 'Nicht verfügbar'; }
function readResponse(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries)
    || value.entries.length > 20) throw new Error('Die Serverübersicht ist unvollständig. Bitte den gespeicherten Stand erneut laden.');
  const seen = new Set();
  const next = value.entries.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)
      || typeof entry.source !== 'string' || typeof entry.description !== 'string'
      || typeof entry.visible !== 'boolean' || !['discord', 'owner'].includes(entry.bannerMode)) {
      throw new Error('Ein Servereintrag konnte nicht gelesen werden. Bitte erneut laden.');
    }
    seen.add(entry.id);
    return { id: entry.id, source: entry.source, description: entry.description, visible: entry.visible,
      bannerMode: entry.bannerMode, server: entry.server && typeof entry.server === 'object' ? entry.server : null,
      guildId: typeof entry.guildId === 'string' ? entry.guildId : entry.server?.guildId,
      resolvedSource: entry.source.trim(), resolvedBannerMode: entry.bannerMode, key: `directory-entry-${++localSequence}` };
  });
  return { revision: value.revision, entries: next, limits: {
    entries: Number.isSafeInteger(value.limits?.entries) ? Math.max(1, Math.min(20, value.limits.entries)) : 20,
    description: Number.isSafeInteger(value.limits?.description) ? Math.max(1, Math.min(300, value.limits.description)) : 300,
  } };
}
function install(value) {
  const next = readResponse(value);
  entries = next.entries; revision = next.revision; limits = next.limits;
  loaded = true; dirty = false; conflict = false; saveUncertain = false; $('directoryDiscard').hidden = true;
  $('directoryEditor').hidden = false; render();
}
function inputLabel(text, control) {
  const label = element('label', text); label.htmlFor = control.id;
  const field = element('div', '', 'cb-directory-admin-field'); field.append(label, control); return field;
}
function paintSummary(entry, row, index) {
  const current = entry.source.trim() === entry.resolvedSource;
  const server = current ? entry.server : null;
  row.querySelector('h2').textContent = server?.name ? `${index + 1}. ${server.name}` : `Server ${index + 1}`;
  const summary = row.querySelector('[data-server-summary]');
  summary.replaceChildren();
  if (!server) {
    summary.append(element('p', 'Name, Banner und Mitgliederzahlen werden nach dem Speichern von Discord geladen.', 'cb-account-help'));
  } else {
    const state = { ready: 'Daten geladen', stale: 'Zuletzt bekannter Stand', unavailable: 'Discord-Daten derzeit nicht verfügbar' }[server.status] || 'Daten derzeit nicht verfügbar';
    summary.append(element('p', `${state} · Mitglieder: ${count(server.memberCount)} · Online: ${count(server.onlineCount)}`, 'cb-account-help'));
    if (server.updatedAt) summary.append(element('p', `Stand: ${formatDate(server.updatedAt)} · Discord-Zahlen können gerundet sein.`, 'cb-account-help'));
  }
  const image = row.querySelector('[data-banner-preview]');
  const source = entry.bannerMode === entry.resolvedBannerMode ? sameOriginImage(server?.bannerPosterUrl || server?.bannerUrl) : null;
  image.hidden = !source;
  if (source) { image.src = source; image.alt = `Gespeichertes Banner: ${server.name || 'Discord-Server'}`; }
  else image.removeAttribute('src');
  const ownerOption = row.querySelector('[data-owner-banner]'); ownerOption.disabled = !ownerAllowed(entry);
  if (entry.bannerMode === 'owner' && !ownerAllowed(entry)) {
    entry.bannerMode = 'discord'; row.querySelector('[data-banner-mode]').value = 'discord';
  }
}
function move(entry, direction) {
  const index = entries.indexOf(entry), next = index + direction;
  if (busy || next < 0 || next >= entries.length) return;
  [entries[index], entries[next]] = [entries[next], entries[index]];
  markDirty(); render();
  document.getElementById(entry.key)?.querySelector('input')?.focus();
}
function render() {
  const list = document.createDocumentFragment();
  entries.forEach((entry, index) => {
    const row = element('section', '', 'cb-account-card cb-directory-admin-entry'); row.id = entry.key;
    const heading = element('h2'); heading.id = `${entry.key}-title`; row.setAttribute('aria-labelledby', heading.id); row.append(heading);
    const image = element('img', '', 'cb-directory-admin-banner'); image.dataset.bannerPreview = ''; image.loading = 'lazy'; image.hidden = true;
    image.addEventListener('error', () => { image.hidden = true; }); row.append(image);
    const summary = element('div', '', 'cb-directory-admin-summary'); summary.dataset.serverSummary = ''; row.append(summary);
    const source = element('input'); source.id = `${entry.key}-source`; source.type = 'text'; source.required = true;
    source.maxLength = 250; source.autocomplete = 'off'; source.spellcheck = false; source.value = entry.source;
    source.placeholder = 'https://discord.gg/… oder Server-ID';
    const sourceHelp = element('small', 'Eine Einladung ist auch für Server möglich, auf denen der Bot nicht Mitglied ist. Für eine reine Server-ID muss unser Bot Mitglied des Servers sein.', 'cb-account-help');
    sourceHelp.id = `${entry.key}-source-help`; source.setAttribute('aria-describedby', sourceHelp.id);
    source.addEventListener('input', () => { entry.source = source.value; paintSummary(entry, row, index); markDirty(); });
    row.append(inputLabel('Einladungslink, Einladungscode oder Server-ID', source), sourceHelp);
    const description = element('textarea'); description.id = `${entry.key}-description`; description.rows = 3;
    description.maxLength = limits.description; description.value = entry.description;
    const descriptionHelp = element('small', `${entry.description.length} / ${limits.description} Zeichen`, 'cb-account-help');
    descriptionHelp.id = `${entry.key}-description-help`; description.setAttribute('aria-describedby', descriptionHelp.id);
    description.addEventListener('input', () => { entry.description = description.value; descriptionHelp.textContent = `${entry.description.length} / ${limits.description} Zeichen`; markDirty(); });
    row.append(inputLabel('Eigene Beschreibung', description), descriptionHelp);
    const banner = element('select'); banner.id = `${entry.key}-banner`; banner.dataset.bannerMode = '';
    const discord = element('option', 'Discord-Banner'); discord.value = 'discord';
    const owner = element('option', 'Crazy_Batto-Banner · nur eigener Server'); owner.value = 'owner'; owner.dataset.ownerBanner = '';
    banner.append(discord, owner); banner.value = entry.bannerMode;
    banner.addEventListener('change', () => { entry.bannerMode = banner.value; paintSummary(entry, row, index); markDirty(); });
    row.append(inputLabel('Banner auswählen', banner));
    const visibleLabel = element('label', '', 'cb-admin-toggle cb-directory-admin-visible');
    const visible = element('input'); visible.type = 'checkbox'; visible.id = `${entry.key}-visible`; visible.checked = entry.visible;
    visibleLabel.htmlFor = visible.id; visibleLabel.append(visible, element('span', 'Öffentlich anzeigen'));
    visible.addEventListener('change', () => { entry.visible = visible.checked; markDirty(); }); row.append(visibleLabel);
    const actions = element('div', '', 'cb-account-actions');
    for (const [direction, label, offset] of [['up', 'Nach oben', -1], ['down', 'Nach unten', 1]]) {
      const button = element('button', label, 'cb-account-button secondary'); button.type = 'button'; button.dataset.move = direction;
      button.setAttribute('aria-label', `Server ${index + 1}: ${label}`); button.addEventListener('click', () => move(entry, offset)); actions.append(button);
    }
    const remove = element('button', 'Nur aus Liste entfernen', 'cb-account-button secondary'); remove.type = 'button';
    remove.setAttribute('aria-label', `Server ${index + 1} nur aus Liste entfernen`);
    remove.addEventListener('click', () => {
      if (busy) return;
      entries = entries.filter(item => item !== entry); markDirty(); render();
      message('Eintrag aus dem Entwurf entfernt. Mit „Änderungen speichern“ übernehmen.'); $('directoryAdd').focus();
    }); actions.append(remove); row.append(actions); paintSummary(entry, row, index); list.append(row);
  });
  $('directoryEntries').replaceChildren(list); $('directoryEmpty').hidden = entries.length > 0;
  $('directoryCount').textContent = `${entries.length} von ${limits.entries} Servern · Reihenfolge wie in der öffentlichen Übersicht.`;
  syncControls();
}
async function perform(kind) {
  if (kind === 'access') $('directoryEditor').hidden = true;
  if (busy) { if (kind === 'access') needsAccessCheck = true; return; }
  busy = true; const ticket = ++generation; let submitted = false; syncControls();
  if (kind !== 'access') message(kind === 'save' ? 'Serverübersicht wird gespeichert …' : 'Gespeicherter Stand wird geladen …');
  try {
    const who = await access(ticket);
    if (!who || ticket !== generation) return;
    if (kind === 'access') { if (loaded) $('directoryEditor').hidden = false; return; }
    let value;
    if (kind === 'save') {
      submitted = true;
      value = await api(endpoint, { method: 'PUT', timeout: 120000, body: { expectedRevision: revision, entries: entries.map(entry => ({ id: entry.id, source: entry.source.trim(), description: entry.description, visible: entry.visible, bannerMode: entry.bannerMode })) } });
    } else value = await api(endpoint);
    if (ticket !== generation || !await access(ticket, who) || ticket !== generation) return;
    install(value); message(kind === 'save' ? 'Serverübersicht gespeichert. Sichtbare Einträge sind jetzt veröffentlicht.' : 'Gespeicherter Stand geladen.');
  } catch (error) {
    if (ticket !== generation) return;
    if (error.status === 401 || error.status === 403) gate('Deine Anmeldung oder Administratorfreigabe ist nicht mehr gültig. Bitte erneut anmelden.');
    else if (error.status === 409 && kind === 'save') {
      conflict = true;
      message('Ein anderer gespeicherter Stand ist neuer als dein Entwurf. Deine Änderungen bleiben hier erhalten. Lade den aktuellen Stand, bevor du erneut speicherst.', true);
      return;
    }
    else if (submitted && (!error.status || error.status >= 500 || ['TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code))) {
      saveUncertain = true;
      message('Die Bestätigung der Speicherung fehlt. Möglicherweise wurde dein Entwurf bereits übernommen. Deine Änderungen bleiben hier erhalten. Lade den gespeicherten Stand, bevor du erneut speicherst.', true);
      return;
    }
    message(errorText(error), true);
  } finally {
    if (ticket === generation) {
      busy = false; syncControls();
      if (needsAccessCheck && document.visibilityState === 'visible') { needsAccessCheck = false; void perform('access'); }
    }
  }
}
$('directoryAdd').addEventListener('click', () => {
  if (busy || !loaded || entries.length >= limits.entries) return;
  const entry = { id: null, source: '', description: '', visible: true, bannerMode: 'discord', server: null, resolvedSource: '', resolvedBannerMode: 'discord', key: `directory-entry-${++localSequence}` };
  entries.push(entry); markDirty(); render(); document.getElementById(`${entry.key}-source`).focus();
});
$('directoryForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!busy && loaded && dirty && !conflict && !saveUncertain && $('directoryForm').reportValidity()) void perform('save');
});
$('directoryReload').addEventListener('click', () => {
  if (busy) return;
  if (dirty) { $('directoryDiscard').hidden = false; $('directoryDiscardCancel').focus(); }
  else void perform('load');
});
$('directoryDiscardCancel').addEventListener('click', () => {
  $('directoryDiscard').hidden = true; $('directoryReload').focus();
  if (loaded && $('directoryEditor').hidden) void perform('access');
});
$('directoryDiscardConfirm').addEventListener('click', () => { $('directoryDiscard').hidden = true; void perform('load'); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { generation++; busy = false; $('directoryEditor').hidden = true; });
window.addEventListener('pageshow', event => { if (event.persisted) void perform(loaded ? 'access' : 'load'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') $('directoryEditor').hidden = true;
  else void perform(loaded ? 'access' : 'load');
});
void perform('load');
