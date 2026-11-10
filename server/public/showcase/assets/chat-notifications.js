import { api, getSession } from './account-client.js';

let instance;
let activeThread = null;
export function setChatFocus(threadId) { activeThread = threadId; }
const node = (tag, text = '', css = '') => { const result = document.createElement(tag); result.textContent = text; result.className = css; return result; };
const stored = (key, fallback = null) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

export function startChatNotifications() {
  if (instance) return instance;
  const state = { userId: null, observed: new Map(), unread: new Set(), sound: false, push: false, busy: false, timer: null, registration: null, audio: null, stopped: false, ready: false, bound: false, epoch: 0, pushBusy: false };
  const title = document.title;
  let panel, soundButton, pushButton, settingsNote, badge, toast;
  const nativeIos = /(?:^|\s)CBChat-iOS\//.test(navigator.userAgent || '');
  const supportsPush = () => !nativeIos && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext;
  const key = suffix => 'cb-chat-' + suffix + ':' + state.userId;
  async function registration() {
    if (!state.registration) {
      await navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' });
      state.registration = await navigator.serviceWorker.ready;
    }
    return state.registration;
  }
  async function worker(message) {
    if (!('serviceWorker' in navigator)) return; const reg = await registration();
    if (message.type === 'CHAT_BIND' && message.userId !== state.userId || message.type === 'CHAT_ALERT' && message.payload.recipientId !== state.userId) return;
    (reg.active || navigator.serviceWorker.controller)?.postMessage(message);
  }
  function settings() {
    if (!panel) return;
    soundButton.textContent = state.sound ? 'Ton ausschalten' : 'Ton einschalten'; soundButton.setAttribute('aria-pressed', String(state.sound));
    pushButton.textContent = state.push ? 'Push ausschalten' : 'Benachrichtigungen einschalten'; pushButton.setAttribute('aria-pressed', String(state.push));
    pushButton.disabled = !supportsPush() || state.pushBusy || !state.userId;
    if (!supportsPush()) settingsNote.textContent = nativeIos ? 'Benachrichtigungen bei geschlossener iPhone-App sind in dieser vorbereiteten Version noch nicht verfügbar.' : 'Öffne die Webseite in Chrome oder Safari und installiere sie als Web-App. Dieser eingebettete Browser unterstützt keine Push-Mitteilungen.';
  }
  function updateBadge() {
    if (!badge) return; const count = state.unread.size;
    badge.hidden = !state.userId || location.pathname === '/nachrichten.html' && count === 0;
    badge.textContent = count ? 'Nachrichten · ' + count + ' neu' : 'Nachrichten';
    document.title = count ? '(' + count + ') ' + title : title;
  }
  async function unlockAudio() {
    if (!state.sound) return;
    const Audio = window.AudioContext || window.webkitAudioContext; if (!Audio) return;
    state.audio ||= new Audio(); if (state.audio.state === 'suspended') await state.audio.resume();
  }
  async function chime() {
    if (!state.sound || !state.audio || state.audio.state !== 'running') return;
    const now = state.audio.currentTime;
    for (const [offset, frequency] of [[0, 660], [.13, 880]]) {
      const oscillator = state.audio.createOscillator(), gain = state.audio.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, now + offset); gain.gain.linearRampToValueAtTime(.07, now + offset + .015); gain.gain.exponentialRampToValueAtTime(.001, now + offset + .19);
      oscillator.connect(gain); gain.connect(state.audio.destination); oscillator.start(now + offset); oscillator.stop(now + offset + .21);
    }
  }
  function showToast(payload) {
    if (!state.userId || payload.recipientId !== state.userId) return false;
    if (document.hidden || !document.hasFocus()) return false;
    if (!toast) { toast = node('a', '', 'cb-chat-toast'); toast.setAttribute('role', 'status'); document.body.append(toast); }
    toast.textContent = payload.type === 'request' ? 'Neue Kontaktanfrage · Öffnen' : 'Neue Nachricht · Öffnen';
    toast.href = '/nachrichten.html?thread=' + encodeURIComponent(payload.threadId); toast.hidden = false;
    if (payload.threadId !== activeThread) { state.unread.add(payload.threadId); updateBadge(); }
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => { toast.hidden = true; }, 6000); void chime(); return true;
  }
  function build() {
    if (panel) return;
    const style = node('link'); style.rel = 'stylesheet'; style.href = '/assets/chat-notifications.css'; document.head.append(style);
    badge = node('a', 'Nachrichten', 'cb-chat-launcher'); badge.href = '/nachrichten.html'; document.body.append(badge);
    panel = node('section', '', 'cb-chat-settings'); panel.id = 'chat-notifications'; panel.setAttribute('aria-label', 'Nachrichten-Benachrichtigungen');
    const heading = node('h2', 'Benachrichtigungen & Ton'), intro = node('p', nativeIos ? 'Schalte den Ton für neue Nachrichten ein, während dein Chat geöffnet ist.' : 'Lass dich auch bei geschlossener App über neue Nachrichten informieren.');
    soundButton = node('button'); soundButton.type = 'button'; pushButton = node('button'); pushButton.type = 'button';
    const install = node('button', 'Installation & Hilfe'); install.type = 'button'; install.dataset.cbInstall = '';
    settingsNote = node('p', '', 'cb-chat-settings-note'); settingsNote.setAttribute('role', 'status');
    const help = node('p', nativeIos ? 'Für Benachrichtigungen bei geschlossener App kannst du bis zur Fertigstellung die iPhone-Web-App verwenden.' : 'iPhone-Web-App: zuerst zum Home-Bildschirm hinzufügen und dort öffnen. Den Ton bei geschlossener App steuern die Benachrichtigungseinstellungen deines Handys.', 'cb-chat-settings-help');
    panel.append(heading, intro, soundButton, pushButton, install, settingsNote, help);
    if (location.pathname === '/nachrichten.html') { document.querySelector('[data-community-page="inbox"]')?.append(panel); }
    window.dispatchEvent(new Event('cb-install-controls-ready'));
    soundButton.addEventListener('click', async () => { state.sound = !state.sound; save(key('sound'), state.sound); settings(); if (state.sound) { await unlockAudio(); await chime(); } });
    pushButton.addEventListener('click', async () => {
      if (!state.userId || state.pushBusy) return;
      const userId = state.userId, epoch = state.epoch;
      const current = () => state.userId === userId && state.epoch === epoch;
      const ensureCurrent = () => { if (!current()) throw new Error('Die Anmeldung hat sich geändert. Bitte erneut auswählen.'); };
      state.pushBusy = true; settings(); settingsNote.textContent = 'Wird eingerichtet …';
      try {
        if (state.push) {
          const reg = await registration(); ensureCurrent(); const sub = await reg.pushManager.getSubscription(); ensureCurrent();
          if (sub) { await api('/api/community/push', { method: 'DELETE', body: { endpoint: sub.endpoint } }); ensureCurrent(); await sub.unsubscribe(); ensureCurrent(); }
          state.push = false; save(key('push'), false); await worker({ type: 'CHAT_BIND', userId, enabled: false }); ensureCurrent(); settingsNote.textContent = 'Push-Mitteilungen sind auf diesem Gerät ausgeschaltet.';
        } else {
          // The permission prompt must be initiated directly by this user gesture.
          const permission = await Notification.requestPermission(); ensureCurrent();
          if (permission !== 'granted') { settingsNote.textContent = 'Benachrichtigungen sind nicht erlaubt. Du kannst sie in den Browser-Einstellungen freigeben.'; return; }
          const reg = await registration(); ensureCurrent(); const config = await api('/api/community/push'); ensureCurrent();
          const base64 = config.publicKey.replace(/-/g, '+').replace(/_/g, '/');
          const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
          let sub = await reg.pushManager.getSubscription(); ensureCurrent(); if (!sub) { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }); ensureCurrent(); }
          await api('/api/community/push', { method: 'POST', body: { subscription: sub.toJSON() } }); ensureCurrent();
          state.push = true; save(key('push'), true); await worker({ type: 'CHAT_BIND', userId, enabled: true }); ensureCurrent();
          settingsNote.textContent = 'Benachrichtigungen sind für dieses Gerät eingeschaltet – auch wenn die Web-App geschlossen ist.';
        }
      } catch (error) { if (current()) settingsNote.textContent = error.message || 'Die Benachrichtigungen konnten nicht eingerichtet werden. Bitte erneut versuchen.'; }
      finally { if (current()) state.pushBusy = false; settings(); }
    });
    settings();
  }
  async function bindUser(user) {
    const next = user?.confirmed && !user.suspended ? user.id : null;
    if (next === state.userId && state.bound) return;
    state.bound = true; state.epoch++; const epoch = state.epoch; state.pushBusy = false;
    state.userId = next; state.observed.clear(); state.unread.clear(); state.ready = false; if (toast) toast.hidden = true;
    state.sound = next ? stored(key('sound'), false) : false; state.push = next ? stored(key('push'), false) : false;
    if (next) build(); if (badge) badge.hidden = !next; if (panel) panel.hidden = !next; settings(); updateBadge();
    if ('serviceWorker' in navigator) await worker({ type: 'CHAT_BIND', userId: next, enabled: false }).catch(() => {});
    if (epoch !== state.epoch) return;
    if (next && state.push && supportsPush()) {
      try {
        const sub = await (await registration()).pushManager.getSubscription();
        if (epoch !== state.epoch) return;
        if (Notification.permission !== 'granted' || !sub) { state.push = false; save(key('push'), false); settings(); }
        else { await api('/api/community/push', { method: 'POST', body: { subscription: sub.toJSON() } }); if (epoch === state.epoch) await worker({ type: 'CHAT_BIND', userId: next, enabled: true }); }
      } catch { if (epoch === state.epoch) { state.push = false; settings(); if (settingsNote) settingsNote.textContent = 'Push-Verbindung wird beim nächsten Öffnen erneut geprüft.'; } }
    }
  }
  async function alertIncoming(thread, eventId, type) {
    const payload = { recipientId: state.userId, eventId, threadId: thread.id, type };
    if ('serviceWorker' in navigator) await worker({ type: 'CHAT_ALERT', payload }).catch(() => {});
    else showToast(payload);
  }
  async function poll() {
    if (state.busy || state.stopped) return; state.busy = true;
    try {
      const initialEpoch = state.epoch, session = await getSession(); if (initialEpoch !== state.epoch) return;
      await bindUser(session.user); if (!state.userId) return; const epoch = state.epoch;
      const inbox = await api('/api/community/inbox', { timeout: 10000 });
      if (epoch !== state.epoch) return;
      if (inbox.viewer?.userId !== state.userId) { await bindUser(null); return; }
      for (const thread of inbox.threads) {
        const message = thread.latestMessage, eventId = message?.id || thread.status === 'pending' && !thread.isRequester && thread.id;
        const previous = state.observed.get(thread.id); state.observed.set(thread.id, eventId || null);
        if (thread.id === activeThread && !document.hidden && document.hasFocus()) state.unread.delete(thread.id);
        if (!eventId || !state.ready || eventId === previous || message && message.senderId === state.userId) continue;
        if (thread.id !== activeThread || document.hidden || !document.hasFocus()) state.unread.add(thread.id);
        await alertIncoming(thread, eventId, message ? 'message' : 'request');
      }
      state.ready = true; updateBadge();
    } catch (error) { if (error.status === 401 || ['suspended', 'email_unconfirmed'].includes(error.code)) await bindUser(null); }
    finally { state.busy = false; }
  }
  function schedule() { clearTimeout(state.timer); if (!state.stopped) state.timer = setTimeout(async () => { await poll(); schedule(); }, document.hidden ? 15000 : 6000); }
  document.addEventListener('pointerdown', () => { if (state.sound) void unlockAudio().catch(() => {}); }, { passive: true });
  document.addEventListener('keydown', () => { if (state.sound) void unlockAudio().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); schedule(); });
  window.addEventListener('online', () => void poll());
  window.addEventListener('pagehide', () => { state.stopped = true; clearTimeout(state.timer); state.audio?.close().catch(() => {}); state.audio = null; });
  window.addEventListener('pageshow', event => { if (event.persisted) { state.stopped = false; void poll().finally(schedule); } });
  window.addEventListener('cb-account-changed', event => { void bindUser(event.detail?.user || null).then(poll).catch(() => {}); });
  window.addEventListener('storage', event => { if (event.key === 'cb-account-change') void bindUser(null).then(poll).catch(() => {}); });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'CHAT_INCOMING') { const shown = showToast(event.data.payload); event.ports?.[0]?.postMessage({ shown }); }
    if (event.data?.type === 'CHAT_OPEN' && /^[a-f0-9-]{36}$/.test(event.data.threadId)) location.href = '/nachrichten.html?thread=' + event.data.threadId;
  });
  instance = { poll, state }; void poll().finally(schedule); return instance;
}
