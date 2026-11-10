// The app always loads live pages. No account data, media, API responses or
// downloads are cached, and no write requests are queued or replayed offline.
const RELEASE = '2026-10-18-chat-media-1';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin
    || url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth') || url.pathname.startsWith('/v2/')) return;
  event.respondWith(fetch(request).catch(() => new Response(
    '<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Keine Verbindung · Crazy_Batto</title><body><main><h1>Du bist gerade offline.</h1>'
    + '<p>Verbinde dein Handy mit dem Internet und öffne die App erneut. Freigaben werden nur mit aktueller Serververbindung gespeichert.</p>'
    + '<p><a href="/admin.html">Verwaltung erneut öffnen</a> · <a href="/index.html">Webseite erneut öffnen</a></p></main></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'X-App-Release': RELEASE } }
  )));
});

// Only device preferences and event IDs are stored here, never chat text or files.
const chatId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
function chatDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cb-chat-notifications', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function chatStored(key, value, write = false) {
  const db = await chatDb();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction('state', write ? 'readwrite' : 'readonly'), store = tx.objectStore('state');
    const request = write ? store.put(value, key) : store.get(key);
    let result; request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
let chatQueue = Promise.resolve();
function serializeChat(task) { const next = chatQueue.then(task); chatQueue = next.catch(() => {}); return next; }
async function showChatInWindow(client, payload) {
  const channel = new MessageChannel();
  try { return await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 1500);
    channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data?.shown === true); };
    try { client.postMessage({ type: 'CHAT_INCOMING', payload }, [channel.port2]); }
    catch { clearTimeout(timer); resolve(false); }
  }); } finally { channel.port1.close(); channel.port2.close(); }
}
async function notifyChat(payload, fromPush) {
  if (!payload || !chatId(payload.threadId) || !chatId(payload.recipientId) || !chatId(payload.eventId) || !['request', 'message'].includes(payload.type)) return;
  const binding = await chatStored('binding');
  if (!binding || binding.userId !== payload.recipientId || fromPush && !binding.enabled) return;
  const seen = await chatStored('seen') || [];
  const eventKey = payload.recipientId + ':' + payload.type + ':' + payload.eventId;
  const alreadySeen = seen.includes(eventKey);
  if (alreadySeen && !fromPush) return;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const focused = clients.find(client => client.visibilityState === 'visible' && client.focused);
  const foregroundShown = focused && !alreadySeen ? await showChatInWindow(focused, payload) : false;
  let shown = foregroundShown;
  if (binding.enabled && (fromPush || !shown)) {
    // showNotification enforces permission itself. Notification.permission is
    // not consistently exposed in service-worker globals on mobile browsers.
    try { await self.registration.showNotification('Crazy_Batto', {
      body: payload.type === 'request' ? 'Du hast eine neue Kontaktanfrage.' : 'Du hast eine neue private Nachricht.',
      icon: '/assets/app-icon-192.png', badge: '/assets/app-icon-192.png',
      // WebKit requires a native notification for every real push event,
      // including foreground/previously-polled events. Repeat delivery is quiet.
      tag: 'cb-chat-' + payload.threadId, renotify: !alreadySeen && !foregroundShown, silent: alreadySeen || foregroundShown,
      data: { threadId: payload.threadId, recipientId: payload.recipientId },
    }); shown = true; } catch { /* Keep this event retryable after denied/failed display. */ }
  }
  if (shown && !alreadySeen) await chatStored('seen', [...seen.slice(-199), eventKey], true);
}
self.addEventListener('push', event => {
  let payload; try { payload = event.data?.json(); } catch { return; }
  event.waitUntil(serializeChat(() => notifyChat(payload, true)));
});
self.addEventListener('message', event => {
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  const message = event.data;
  if (message?.type === 'CHAT_BIND' && (message.userId === null || chatId(message.userId))) {
    event.waitUntil(serializeChat(async () => {
      const previous = await chatStored('binding');
      await chatStored('binding', { userId: message.userId, enabled: message.enabled === true }, true);
      if (previous?.userId !== message.userId || !message.enabled) {
        for (const notification of await self.registration.getNotifications()) if (notification.tag.startsWith('cb-chat-')) notification.close();
      }
    }));
  }
  if (message?.type === 'CHAT_ALERT') event.waitUntil(serializeChat(() => notifyChat(message.payload, false)));
});
self.addEventListener('notificationclick', event => {
  const data = event.notification.data; if (!chatId(data?.threadId) || !chatId(data?.recipientId)) return;
  event.notification.close();
  event.waitUntil((async () => {
    const binding = await chatStored('binding'); if (binding?.userId !== data.recipientId) return;
    const target = '/nachrichten.html?thread=' + encodeURIComponent(data.threadId);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === '/nachrichten.html');
    if (existing) { await existing.navigate(target); await existing.focus(); } else await self.clients.openWindow(target);
  })());
});
