import { api, getSession, errorText, formatDate } from './account-client.js';
import { createChatMediaComposer, renderChatAttachments } from './chat-media.js';
import { setChatFocus } from './chat-notifications.js';

const names = { pending: 'Anfrage offen', approved: 'Chat geöffnet', rejected: 'Anfrage abgelehnt', blocked: 'Chat blockiert' };
const el = (tag, text = '', css = '') => { const node = document.createElement(tag); node.textContent = text; node.className = css; return node; };
const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
const endpoint = id => '/api/community/threads/' + encodeURIComponent(id);
const otherName = thread => thread.isRequester ? thread.recipientName : thread.requesterName;
const byRecent = (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id);
function button(label, action, css = 'secondary') { const node = el('button', label, 'cc-button ' + css); node.type = 'button'; if (action) node.addEventListener('click', action); return node; }
function note() { const node = el('p', '', 'cc-feedback'); node.setAttribute('role', 'status'); return node; }
function inputField(label, tag = 'input') { const wrap = el('label', label), input = el(tag); wrap.append(input); return { wrap, input }; }

export async function initPrivateChat({ root, content, feedback, refresh }) {
  const state = { user: null, threads: [], selected: null, draft: new Map(), seen: new Map(), unread: new Set(), active: null, busy: false, polling: false, generation: 0, timer: null, inboxCursor: null, listKey: '', lastInbox: 0, stopped: false };
  let list, view, connection, directory, directoryQuery, directoryResults, directoryNote, directorySequence = 0;
  function tell(target, text, error = false) { target.textContent = text; target.classList.toggle('is-error', error); }
  function live(text = 'Live · Nachrichten werden automatisch aktualisiert', error = false) { if (connection) { connection.textContent = text; connection.classList.toggle('is-offline', error); } }
  function draft(id) { if (!state.draft.has(id)) state.draft.set(id, { text: '', clientId: crypto.randomUUID() }); return state.draft.get(id); }
  function pauseMessages() { state.active?.box?.querySelectorAll('audio').forEach(audio => audio.pause()); state.active?.box?.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
  function gate(message) {
    pauseMessages(); state.active?.media?.dispose(); setChatFocus(null);
    state.stopped = true; state.generation++; clearTimeout(state.timer); state.active = null; state.threads = []; state.draft.clear(); state.selected = null;
    const panel = el('section', '', 'cc-panel'), login = el('a', 'Zur Anmeldung', 'cc-button'); login.href = 'registrierung.html?returnTo=chat';
    panel.append(el('h2', 'Anmeldung erforderlich'), el('p', message || 'Melde dich mit deinem bestätigten Konto an, um private Nachrichten zu schreiben.'), login); content.replaceChildren(panel); tell(feedback, '');
  }
  const authFailure = error => error.status === 401 || ['suspended', 'email_unconfirmed'].includes(error.code);
  function handleError(error, target = feedback) { if (authFailure(error)) gate(errorText(error)); else tell(target?.isConnected ? target : feedback, errorText(error), true); }
  async function action(task, target = feedback) {
    if (state.busy || state.stopped) return; state.busy = true;
    try { if (state.pollComplete) await state.pollComplete; if (!state.stopped) await task(); } catch (error) { handleError(error, target); }
    finally { state.busy = false; }
  }
  function upsert(thread) { state.threads = merge(state.threads, [thread]).sort(byRecent); }
  function markSeen(thread) { state.seen.set(thread.id, thread.updatedAt); state.unread.delete(thread.id); }
  function renderList() {
    const key = JSON.stringify([state.selected, state.inboxCursor, state.threads.map(t => [t.id, otherName(t), t.status, t.updatedAt, t.adminBlocked, state.unread.has(t.id)])]);
    if (key === state.listKey) return; state.listKey = key; list.replaceChildren();
    if (!state.threads.length) list.append(el('p', 'Noch keine Chats. Wähle oben „Neue Nachricht“ und suche ein Mitglied.', 'cc-empty'));
    for (const thread of state.threads) {
      const item = button('', () => void action(() => selectThread(thread))); item.className = 'cc-thread-button'; item.setAttribute('aria-pressed', String(thread.id === state.selected));
      item.append(el('strong', otherName(thread) || 'Mitglied'), el('span', names[thread.status] || thread.status, 'cc-date'));
      if (state.unread.has(thread.id) || thread.status === 'pending' && !thread.isRequester) item.append(el('span', thread.status === 'pending' ? 'Neue Anfrage' : 'Neu', 'pc-unread'));
      item.append(el('time', formatDate(thread.updatedAt), 'cc-date')); list.append(item);
    }
    if (state.inboxCursor) list.append(button('Ältere Chats laden', () => void action(async () => {
      const result = await api('/api/community/inbox?before=' + encodeURIComponent(state.inboxCursor));
      state.threads = merge(state.threads, result.threads).sort(byRecent); state.inboxCursor = result.nextCursor; renderList();
    })));
  }
  async function syncInbox(initial = false) {
    const result = await api('/api/community/inbox', { timeout: 10000 });
    if (state.stopped) return;
    if (result.viewer?.userId !== state.user.id) { gate('Deine Anmeldung hat sich geändert. Bitte öffne die Nachrichten erneut.'); return; }
    if (!Array.isArray(result.threads)) throw new Error('Die Unterhaltungen konnten nicht geladen werden.');
    for (const thread of result.threads) {
      const previous = state.threads.find(item => item.id === thread.id);
      if (!initial && thread.id !== state.selected && (!previous || thread.updatedAt > (state.seen.get(thread.id) ?? previous.updatedAt))) state.unread.add(thread.id);
      if (initial) state.seen.set(thread.id, thread.updatedAt);
    }
    state.threads = initial ? result.threads : merge(state.threads, result.threads).sort(byRecent);
    if (initial || !state.inboxCursor) state.inboxCursor = result.nextCursor;
    state.lastInbox = Date.now(); renderList();
  }
  function renderMessages(active, { bottom = false, older = false } = {}) {
    if (active !== state.active) return;
    const box = active.box, nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90, top = box.scrollTop, height = box.scrollHeight;
    active.messageNodes ||= new Map();
    if (!active.messages.length && !box.childNodes.length) box.append(el('p', 'Hier beginnt eure Unterhaltung.', 'pc-empty-history'));
    if (active.messages.length) box.querySelector('.pc-empty-history')?.remove();
    let preceding = null;
    for (const message of [...active.messages].sort((a, b) => a.seq - b.seq)) {
      let row = active.messageNodes.get(message.id);
      if (!row) {
        const own = message.senderId === state.user.id; row = el('article', '', 'cc-message' + (own ? ' is-own' : ''));
        row.append(el('strong', own ? 'Du' : otherName(active.thread)));
        if (message.text) row.append(el('p', message.text, 'cc-copy'));
        if (message.attachments?.length) row.append(renderChatAttachments(message.attachments));
        row.append(el('time', formatDate(message.createdAt), 'cc-date')); active.messageNodes.set(message.id, row);
      }
      // Keep existing audio elements attached so incoming messages do not interrupt playback.
      const next = preceding ? preceding.nextSibling : box.firstChild;
      if (next !== row) box.insertBefore(row, next);
      preceding = row;
    }
    if (older) box.scrollTop = top + box.scrollHeight - height;
    else if (bottom || nearBottom) { box.scrollTop = box.scrollHeight; active.jump.hidden = true; }
    else active.jump.hidden = false;
    active.more.hidden = !active.nextCursor;
  }
  function renderControls(active) {
    const thread = active.thread;
    const key = JSON.stringify([thread.status, thread.canDecide, thread.canBlock, thread.canSend, thread.adminBlocked]);
    active.heading.textContent = otherName(thread); active.badge.textContent = names[thread.status] || thread.status;
    active.badge.dataset.state = thread.status;
    if (key === active.controlKey) return; active.controlKey = key; active.media?.dispose(); active.media = null; active.controls.replaceChildren(); active.composer.replaceChildren();
    const decide = status => void action(async () => {
      if (status !== 'approved' && !confirm(status === 'blocked' ? 'Diesen Chat blockieren? Danach können keine Nachrichten mehr gesendet werden.' : 'Diese Kontaktanfrage ablehnen?')) return;
      const result = await api(endpoint(thread.id) + '/decision', { method: 'POST', body: { status } });
      active.thread = result.thread; upsert(result.thread); renderControls(active); renderList(); await syncMessages(active); tell(active.note, status === 'approved' ? 'Anfrage angenommen. Ihr könnt jetzt schreiben.' : names[status]);
    }, active.note);
    if (!thread.adminBlocked && thread.status === 'pending' && thread.canDecide) active.controls.append(button('Anfrage annehmen', () => decide('approved'), ''), button('Ablehnen', () => decide('rejected')));
    if (!thread.adminBlocked && (thread.canBlock || thread.canDecide && thread.status === 'approved')) active.controls.append(button('Chat blockieren', () => decide('blocked'), 'danger'));
    if (!thread.canSend || thread.status !== 'approved' || thread.adminBlocked) {
      active.composer.append(el('p', thread.status === 'pending' ? thread.isRequester ? 'Deine Anfrage ist angekommen. Sobald sie angenommen wird, könnt ihr hier schreiben.' : 'Nimm die Anfrage an, um miteinander zu schreiben.' : 'Dieser Chat ist geschlossen. Neue Nachrichten sind momentan nicht möglich.', 'cc-empty')); return;
    }
    const form = el('form', '', 'cc-form pc-compose'), text = inputField('Deine Nachricht', 'textarea'), send = button('Senden', null, ''), sendNote = note();
    text.input.rows = 3; text.input.maxLength = 4000; text.input.placeholder = 'Schreib eine Nachricht …'; text.input.value = draft(thread.id).text; send.type = 'submit';
    text.input.addEventListener('input', () => { state.draft.set(thread.id, { text: text.input.value, clientId: crypto.randomUUID() }); });
    text.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    active.media = createChatMediaComposer({ threadId: thread.id, isAllowed: () => active === state.active && active.thread.canSend && !state.stopped,
      onChange: () => { const value = draft(thread.id); state.draft.set(thread.id, { ...value, clientId: crypto.randomUUID() }); },
      onError: error => tell(sendNote, typeof error === 'string' ? error : error.message, true) });
    form.append(text.wrap, active.media.element, el('p', 'Enter zum Senden · Umschalt + Enter für eine neue Zeile', 'cc-help pc-key-help'), send, sendNote); active.composer.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); void action(async () => {
        const pending = draft(thread.id), value = pending.text.trim(); if (!value && !active.media.hasPending()) { tell(sendNote, 'Bitte eine Nachricht schreiben oder eine Datei/Sprachnachricht anhängen.', true); return; }
        if (active.media.isRecording()) { tell(sendNote, 'Bitte die Aufnahme zuerst beenden.', true); return; }
        send.disabled = true; text.input.disabled = true; active.media.setDisabled(true); tell(sendNote, 'Wird gesendet …');
        try {
          const attachmentIds = await active.media.prepareUploads();
          const result = await api(endpoint(thread.id) + '/messages', { method: 'POST', body: { text: value, attachmentIds, clientId: pending.clientId } });
          if (!result.message?.id) throw new Error('Die Bestätigung fehlt. Du kannst dieselbe Nachricht erneut senden.');
          active.media.clear(); state.draft.delete(thread.id); text.input.value = ''; active.messages = merge(active.messages, [result.message]);
          // Do not advance the receive cursor here: another person's earlier message may still be in flight.
          renderMessages(active, { bottom: true }); tell(sendNote, 'Gesendet');
          await syncMessages(active); state.lastInbox = 0;
        } finally { send.disabled = false; text.input.disabled = false; active.media?.setDisabled(false); if (text.input.isConnected) text.input.focus(); }
      }, sendNote);
    });
  }
  async function selectThread(thread) {
    pauseMessages(); state.active?.media?.dispose(); setChatFocus(thread.id);
    const generation = ++state.generation; state.selected = thread.id; state.active = null; renderList();
    view.replaceChildren(el('p', 'Chat wird geöffnet …', 'cc-empty'));
    const result = await api(endpoint(thread.id) + '/messages');
    if (generation !== state.generation || state.stopped) return;
    const active = { thread: result.thread, messages: result.messages, nextCursor: result.nextCursor, cursor: result.latestCursor || '0', controlKey: null };
    state.active = active; upsert(result.thread); markSeen(result.thread);
    const panel = el('section', '', 'cc-panel pc-chat'), header = el('header', '', 'pc-chat-heading'); active.heading = el('h2', otherName(result.thread)); active.badge = el('span', '', 'cc-badge');
    header.append(active.heading, active.badge); active.note = note(); active.controls = el('div', '', 'cc-actions pc-decisions');
    const privacy = el('details', '', 'pc-privacy'); privacy.append(el('summary', 'Hinweis zur Privatsphäre'), el('p', result.thread.administrationNotice, 'cc-chat-notice'));
    panel.append(header, privacy);
    if (result.thread.note) { const intro = el('div', '', 'pc-introduction'); intro.append(el('strong', 'Kontaktanfrage von ' + result.thread.requesterName), el('p', result.thread.note, 'cc-copy')); panel.append(intro); }
    active.more = button('Ältere Nachrichten laden', () => void action(async () => {
      const previous = await api(endpoint(thread.id) + '/messages?before=' + encodeURIComponent(active.nextCursor));
      if (active !== state.active) return;
      active.messages = merge(previous.messages, active.messages); active.nextCursor = previous.nextCursor; renderMessages(active, { older: true });
    }, active.note));
    active.box = el('div', '', 'cc-messages pc-history'); active.box.setAttribute('role', 'log'); active.box.setAttribute('aria-label', 'Nachrichtenverlauf'); active.box.setAttribute('aria-live', 'polite'); active.box.tabIndex = 0;
    active.jump = button('Neue Nachrichten ↓', () => { active.box.scrollTop = active.box.scrollHeight; active.jump.hidden = true; }); active.jump.hidden = true;
    active.composer = el('div', '', 'pc-composer'); panel.append(active.controls, active.note, active.more, active.box, active.jump, active.composer); view.replaceChildren(panel);
    renderControls(active); renderMessages(active, { bottom: true }); renderList(); tell(feedback, ''); live();
  }
  async function syncMessages(active) {
    if (!active || active !== state.active) return;
    for (let batch = 0; batch < 10; batch++) {
      const result = await api(endpoint(active.thread.id) + '/messages?after=' + encodeURIComponent(active.cursor), { timeout: 10000 });
      if (active !== state.active || state.stopped) return;
      active.thread = result.thread; upsert(result.thread); markSeen(result.thread); renderControls(active);
      const oldCount = active.messages.length; active.messages = merge(active.messages, result.messages);
      if (active.messages.length !== oldCount) renderMessages(active);
      const previousCursor = active.cursor; active.cursor = result.latestCursor; renderList();
      if (!result.hasMore || previousCursor === active.cursor) break;
    }
  }
  async function poll(force = false) {
    if (state.stopped || state.polling || state.busy) return;
    if (!state.user) { await start(); return; }
    state.polling = true; let finished; state.pollComplete = new Promise(resolve => { finished = resolve; });
    try {
      if (force || Date.now() - state.lastInbox >= 6000) {
        if (force) content.hidden = true;
        const session = await getSession();
        if (session.user?.id !== state.user.id || !session.user.confirmed || session.user.suspended) { gate('Deine Anmeldung hat sich geändert. Bitte öffne die Nachrichten erneut.'); content.hidden = false; return; }
        content.hidden = false; await syncInbox();
      }
      if (!state.active && state.selected) { const selected = state.threads.find(item => item.id === state.selected); if (selected) await selectThread(selected); }
      if (!state.busy) await syncMessages(state.active);
      if (!state.stopped) live();
    } catch (error) {
      if (authFailure(error)) { gate(errorText(error)); content.hidden = false; }
      else if (error.status === 404 && state.active) { pauseMessages(); state.active.media?.dispose(); setChatFocus(null); state.threads = state.threads.filter(item => item.id !== state.selected); state.selected = null; state.active = null; view.replaceChildren(el('p', 'Dieser Chat ist nicht mehr verfügbar.', 'cc-empty')); renderList(); }
      else { live('Verbindung unterbrochen · Wir versuchen es automatisch erneut', true); if (content.hidden) tell(feedback, 'Verbindung wird wiederhergestellt. Dein Entwurf bleibt erhalten.', true); }
    } finally { state.polling = false; state.pollComplete = null; finished(); }
  }
  function schedule() { clearTimeout(state.timer); if (!state.stopped) state.timer = setTimeout(async () => { await poll(); schedule(); }, document.hidden ? 10000 : 2000); }
  async function searchMembers() {
    const sequence = ++directorySequence; tell(directoryNote, 'Mitglieder werden gesucht …');
    try {
      const result = await api('/api/community/members?q=' + encodeURIComponent(directoryQuery.value.trim()));
      if (sequence !== directorySequence || state.stopped) return;
      directoryResults.replaceChildren();
      for (const member of result.members) directoryResults.append(button(member.name + ' · Nachricht schreiben', () => composeRequest(member)));
      tell(directoryNote, result.members.length ? result.hasMore ? 'Weitere Mitglieder vorhanden. Grenze die Suche mit einem Namen ein.' : '' : 'Keine passenden Mitglieder gefunden.');
    } catch (error) { if (sequence === directorySequence) handleError(error, directoryNote); }
  }
  function composeRequest(member) {
    if (state.busy) return; directorySequence++;
    const form = el('form', '', 'cc-form'), intro = inputField('Deine erste Nachricht / Kontaktanfrage', 'textarea'), send = button('Kontaktanfrage senden', null, ''), requestNote = note();
    intro.input.rows = 3; intro.input.maxLength = 1000; intro.input.required = true; intro.input.placeholder = 'Hallo ' + member.name + ', …'; send.type = 'submit';
    form.append(el('h3', 'Nachricht an ' + member.name), intro.wrap, el('p', 'Nach der Annahme könnt ihr hier direkt miteinander schreiben.', 'cc-help'), send, button('Zurück zur Mitgliederauswahl', () => void searchMembers()), requestNote); directoryResults.replaceChildren(form); intro.input.focus();
    form.addEventListener('submit', event => { event.preventDefault(); void action(async () => {
      if (!intro.input.value.trim()) return;
      send.disabled = true;
      try {
        const result = await api('/api/community/threads', { method: 'POST', body: { recipientId: member.id, note: intro.input.value.trim() } });
        if (!result.created) state.draft.set(result.thread.id, { text: intro.input.value.trim(), clientId: crypto.randomUUID() });
        upsert(result.thread); directory.open = false; await selectThread(result.thread);
        tell(feedback, result.created ? 'Kontaktanfrage gesendet. Die Antwort erscheint hier automatisch.' : 'Eure bestehende Unterhaltung ist geöffnet. Dein Text wurde als Entwurf übernommen.');
      } finally { send.disabled = false; }
    }, requestNote); });
  }
  function build() {
    const layout = el('div', '', 'cc-inbox pc-inbox'), aside = el('aside', '', 'pc-sidebar'); view = el('div', '', 'cc-thread-view');
    connection = el('p', '', 'pc-connection'); connection.setAttribute('role', 'status'); live();
    directory = el('details', '', 'cc-panel pc-directory'); directory.append(el('summary', '＋ Neue Nachricht'));
    const search = inputField('Mitglied suchen'); directoryQuery = search.input; directoryQuery.type = 'search'; directoryQuery.placeholder = 'Name eingeben …';
    directoryResults = el('div', '', 'pc-members'); directoryNote = note(); directory.append(search.wrap, directoryNote, directoryResults);
    let searchTimer; directoryQuery.addEventListener('input', () => { directorySequence++; clearTimeout(searchTimer); searchTimer = setTimeout(() => void searchMembers(), 250); });
    directory.addEventListener('toggle', () => { if (directory.open) { void searchMembers(); directoryQuery.focus(); } });
    list = el('div', '', 'cc-thread-list'); aside.append(directory, el('h2', 'Unterhaltungen'), list); layout.append(aside, view); content.replaceChildren(connection, layout);
    view.append(el('section', 'Wähle eine Unterhaltung oder starte mit „Neue Nachricht“ einen Chat.', 'cc-panel cc-empty')); renderList();
  }
  refresh?.addEventListener('click', () => { if (state.stopped) location.reload(); else void poll(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(true); schedule(); });
  window.addEventListener('online', () => void poll(true));
  window.addEventListener('pagehide', () => { clearTimeout(state.timer); state.stopped = true; pauseMessages(); state.active?.media?.dispose(); setChatFocus(null); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  async function start() {
  if (state.starting || state.stopped) return; state.starting = true;
  try {
    const session = await getSession(); if (!session.user || !session.user.confirmed || session.user.suspended) { gate(); return; }
    state.user = session.user; build(); await syncInbox(true);
    const wanted = new URLSearchParams(location.search).get('thread'), selected = state.threads.find(thread => thread.id === wanted) || state.threads[0];
    if (selected) await selectThread(selected); else tell(feedback, '');
    document.querySelectorAll('[data-community-admin-link]').forEach(item => { item.hidden = !session.user.isAdmin; });
  } catch (error) { handleError(error); if (!state.stopped) live('Verbindung unterbrochen · Wir versuchen es automatisch erneut', true); }
  finally { state.starting = false; schedule(); }
  }
  await start();
}
