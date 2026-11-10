import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import webpush from 'web-push';
import { AppError, assert } from './errors.mjs';
import { Vault, sha256 } from './store.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_DEVICES = 10, MAX_AGE = 24 * 3600_000, KEY_SETTING = 'chat_push_vapid_v1';
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com', 'web.push.apple.com']);

export function pushEndpoint(value) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\s\\]/.test(value), 'Der Benachrichtigungsdienst ist ungültig.');
  let url;
  try { url = new URL(value); } catch { throw new AppError('validation', 'Der Benachrichtigungsdienst ist ungültig.'); }
  const host = url.hostname;
  const allowed = PUSH_HOSTS.has(host) || /^[a-z0-9-]+\.push\.apple\.com$/.test(host) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !net.isIP(host) && allowed && url.pathname !== '/', 'Dieser Browser-Benachrichtigungsdienst wird nicht unterstützt.');
  return url.href;
}
function keyBytes(value, length) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'Die Geräteanmeldung ist ungültig.');
  const bytes = Buffer.from(value, 'base64url');
  assert(bytes.length === length && bytes.toString('base64url') === value, 'Die Geräteanmeldung ist ungültig.');
  return bytes;
}
export function pushSubscription(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['endpoint', 'expirationTime', 'keys'].includes(k)), 'Die Geräteanmeldung ist ungültig.');
  const endpoint = pushEndpoint(value.endpoint), keys = value.keys;
  assert(keys && typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length === 2 && Object.hasOwn(keys, 'auth') && Object.hasOwn(keys, 'p256dh'), 'Die Geräteanmeldung ist ungültig.');
  const publicKey = keyBytes(keys.p256dh, 65); keyBytes(keys.auth, 16);
  try { crypto.ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed'); }
  catch { throw new AppError('validation', 'Der Geräteschlüssel ist ungültig.'); }
  assert(value.expirationTime == null || Number.isSafeInteger(value.expirationTime) && value.expirationTime > 0, 'Das Ablaufdatum der Geräteanmeldung ist ungültig.');
  return { endpoint, expirationTime: value.expirationTime ?? null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

// Pin each request to a public DNS answer. No redirects, proxies, credentials,
// arbitrary endpoints or response bodies are used by the transport.
function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168)) && !(a === 198 && (b === 18 || b === 19));
  }
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address);
}
function publicLookup(host, options, callback) {
  dns.lookup(host, { all: true, verbatim: true }, (error, answers) => {
    if (error) return callback(error);
    const eligible = answers.filter(answer => publicAddress(answer.address));
    if (!eligible.length || eligible.length !== answers.length) return callback(new Error('Push address unavailable'));
    if (options?.all) callback(null, eligible);
    else callback(null, eligible[0].address, eligible[0].family);
  });
}
export async function sendPush(subscription, payload, options, signal) {
  const target = pushEndpoint(subscription.endpoint);
  const details = webpush.generateRequestDetails(subscription, payload, options);
  return new Promise((resolve, reject) => {
    let timer;
    const request = https.request(target, { method: 'POST', headers: details.headers, agent: false, lookup: publicLookup, signal }, response => {
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) request.destroy(new Error('Push response too large')); });
      response.on('error', reject);
      response.on('end', () => {
        clearTimeout(timer);
        const statusCode = response.statusCode || 0;
        if (statusCode >= 200 && statusCode < 300) resolve({ statusCode });
        else { const error = new Error('Push service unavailable'); error.statusCode = statusCode; error.retryAfter = response.headers['retry-after']; reject(error); }
      });
    });
    request.on('error', error => { clearTimeout(timer); reject(error); });
    timer = setTimeout(() => request.destroy(new Error('Push delivery timeout')), 12_000);
    timer.unref?.();
    request.end(details.body);
  });
}
async function body(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte JSON senden.', 'validation', 415);
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; assert(length <= 8192, 'Die Anfrage ist zu groß.', 'validation', 413); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('validation', 'Die Anfrage enthält kein gültiges JSON.'); }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Die Angaben sind ungültig.');
  return value;
}

export class ChatPush {
  constructor(accounts, { transport = sendPush, autoStart = true } = {}) {
    this.accounts = accounts; this.store = accounts.store; this.now = accounts.now; this.transport = transport;
    this.vault = new Vault(accounts.config.encryptionKey); this.closed = false; this.running = false; this.timer = null; this.autoStart = autoStart;
    this.enabled = Buffer.isBuffer(accounts.config.encryptionKey) && accounts.config.encryptionKey.length === 32 && /^https:\/\//.test(accounts.config.publicOrigin || '');
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      subscription TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_push_subscriptions_user ON chat_push_subscriptions(user_id);
      CREATE TABLE IF NOT EXISTS chat_push_outbox (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('message','request')),
        thread_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        subscription_id TEXT NOT NULL REFERENCES chat_push_subscriptions(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_status INTEGER, UNIQUE(event_id,type,subscription_id));
      CREATE INDEX IF NOT EXISTS chat_push_outbox_due ON chat_push_outbox(next_attempt_at,created_at);`);
    if (autoStart && this.enabled) this.schedule(10_000);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.timer = null; this.aborter?.abort(); }
  keys() {
    assert(this.enabled, 'Benachrichtigungen werden gerade eingerichtet.', 'unconfigured', 503);
    let saved = this.store.setting(KEY_SETTING);
    if (!saved) {
      const keys = webpush.generateVAPIDKeys();
      const encrypted = JSON.stringify(this.vault.seal({ purpose: KEY_SETTING, ...keys }));
      this.store.run('INSERT OR IGNORE INTO account_settings(key,value) VALUES (?,?)', KEY_SETTING, encrypted);
      saved = this.store.setting(KEY_SETTING);
    }
    try {
      const value = this.vault.open(JSON.parse(saved));
      if (value.purpose !== KEY_SETTING) throw new Error();
      const ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(keyBytes(value.privateKey, 32));
      if (ecdh.getPublicKey().toString('base64url') !== value.publicKey) throw new Error();
      return { publicKey: value.publicKey, privateKey: value.privateKey };
    } catch { throw new AppError('unconfigured', 'Die Benachrichtigungsanmeldung ist momentan nicht verfügbar.', 503); }
  }
  decrypt(row) {
    const value = this.vault.open(JSON.parse(row.subscription));
    assert(value.purpose === 'chat-push-device-v1' && value.userId === row.user_id && value.id === row.id, 'Die Geräteanmeldung ist ungültig.', 'unconfigured', 503);
    const subscription = pushSubscription(value.subscription);
    assert(sha256(subscription.endpoint) === row.id, 'Die Geräteanmeldung ist ungültig.', 'unconfigured', 503);
    return subscription;
  }
  status(userId) {
    return { enabled: this.enabled, publicKey: this.enabled ? this.keys().publicKey : null,
      registeredDevices: this.store.get('SELECT COUNT(*) AS n FROM chat_push_subscriptions WHERE user_id=?', userId).n };
  }
  register(userId, input) {
    const subscription = pushSubscription(input), id = sha256(subscription.endpoint), now = this.now();
    assert(!subscription.expirationTime || subscription.expirationTime > now, 'Die Geräteanmeldung ist abgelaufen. Bitte erneut aktivieren.');
    this.keys();
    this.store.transaction(() => {
      const old = this.store.get('SELECT * FROM chat_push_subscriptions WHERE id=?', id);
      if (old && old.user_id !== userId) {
        const previous = this.decrypt(old);
        assert(previous.keys.auth === subscription.keys.auth && previous.keys.p256dh === subscription.keys.p256dh, 'Dieses Gerät ist noch mit einem anderen Konto verbunden. Bitte die Browser-Benachrichtigung zurücksetzen.', 'conflict', 409);
      }
      if (!old || old.user_id !== userId) {
        const count = this.store.get('SELECT COUNT(*) AS n FROM chat_push_subscriptions WHERE user_id=?', userId).n;
        assert(count < MAX_DEVICES, 'Höchstens zehn Geräte können Benachrichtigungen empfangen. Deaktiviere zuerst ein anderes Gerät.', 'conflict', 409);
      }
      if (old && old.user_id !== userId) this.store.run('DELETE FROM chat_push_outbox WHERE subscription_id=?', id);
      const encrypted = JSON.stringify(this.vault.seal({ purpose: 'chat-push-device-v1', userId, id, subscription }));
      this.store.run(`INSERT INTO chat_push_subscriptions(id,user_id,subscription,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,subscription=excluded.subscription,updated_at=excluded.updated_at`, id, userId, encrypted, now, now);
    });
    return this.status(userId);
  }
  remove(userId, endpoint) {
    const id = sha256(pushEndpoint(endpoint));
    this.store.run('DELETE FROM chat_push_subscriptions WHERE id=? AND user_id=?', id, userId);
    return { ok: true, ...this.status(userId) };
  }
  async handle(req, res, context) {
    if (new URL(req.url, 'http://push.invalid').pathname !== '/api/community/push') return false;
    assert(['GET', 'POST', 'DELETE'].includes(req.method), 'Diese Anfrage ist nicht erlaubt.', 'method', 405);
    const actor = this.accounts.assertCurrent(context);
    let result;
    if (req.method === 'GET') result = this.status(actor.id);
    else {
      this.accounts.limit('chat-push:' + actor.id, 60, 3600_000);
      const value = await body(req); this.accounts.assertCurrent(context);
      assert(Object.keys(value).length === 1 && Object.hasOwn(value, req.method === 'POST' ? 'subscription' : 'endpoint'), 'Die Angaben sind unvollständig oder ungültig.');
      result = req.method === 'POST' ? this.register(actor.id, value.subscription) : this.remove(actor.id, value.endpoint);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return true;
  }
  enqueue({ type, threadId, recipientId, eventId }) {
    if (!this.enabled || this.closed) return;
    assert(['message', 'request'].includes(type) && [threadId, recipientId, eventId].every(id => UUID.test(id)), 'Die Benachrichtigung ist ungültig.');
    const now = this.now();
    this.store.run('DELETE FROM chat_push_outbox WHERE created_at<?', now - MAX_AGE);
    for (const device of this.store.all('SELECT id FROM chat_push_subscriptions WHERE user_id=?', recipientId)) {
      this.store.run(`INSERT OR IGNORE INTO chat_push_outbox(id,event_id,type,thread_id,recipient_id,subscription_id,created_at,next_attempt_at)
        VALUES (?,?,?,?,?,?,?,?)`, crypto.randomUUID(), eventId, type, threadId, recipientId, device.id, now, now);
    }
    // Bound retained events per recipient; newer notifications remain useful.
    this.store.run('DELETE FROM chat_push_outbox WHERE recipient_id=? AND id IN (SELECT id FROM chat_push_outbox WHERE recipient_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 1000)', recipientId, recipientId);
    if (this.autoStart) queueMicrotask(() => this.schedule(0));
  }
  schedule(delay) {
    if (this.closed || !this.enabled || this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.drain().catch(() => {}); }, delay);
    this.timer.unref?.();
  }
  eligible(row) {
    const community = this.accounts.community;
    if (!community) return false;
    try {
      const thread = community.thread(row.thread_id, row.recipient_id);
      const view = community.threadView(thread, row.recipient_id);
      return community.chatParticipantsActive(thread) && !view.adminBlocked && (row.type === 'request'
        ? thread.status === 'pending' && thread.recipient_id === row.recipient_id
        : thread.status === 'approved');
    } catch { return false; }
  }
  async drain() {
    if (this.closed || this.running || !this.enabled) return;
    this.running = true;
    let retry = 15_000;
    try {
      this.store.run('DELETE FROM chat_push_outbox WHERE created_at<?', this.now() - MAX_AGE);
      const pending = this.store.all(`SELECT o.*,s.subscription,s.user_id FROM chat_push_outbox o JOIN chat_push_subscriptions s ON s.id=o.subscription_id
        WHERE o.next_attempt_at<=? ORDER BY o.created_at,o.id LIMIT 12`, this.now());
      for (const row of pending) {
        if (this.closed) break;
        if (row.user_id !== row.recipient_id || !this.eligible(row)) { this.store.run('DELETE FROM chat_push_outbox WHERE id=?', row.id); continue; }
        const device = this.store.get('SELECT * FROM chat_push_subscriptions WHERE id=? AND user_id=?', row.subscription_id, row.recipient_id);
        if (!device) { this.store.run('DELETE FROM chat_push_outbox WHERE id=?', row.id); continue; }
        try {
          const subscription = this.decrypt(device);
          if (subscription.expirationTime && subscription.expirationTime <= this.now()) { this.store.run('DELETE FROM chat_push_subscriptions WHERE id=?', device.id); continue; }
          const payload = JSON.stringify({ type: row.type, eventId: row.event_id, threadId: row.thread_id, recipientId: row.recipient_id,
            url: '/nachrichten.html?thread=' + row.thread_id, title: 'Crazy_Batto',
            body: row.type === 'request' ? 'Du hast eine neue Kontaktanfrage.' : 'Du hast eine neue private Nachricht.', tag: 'cb-chat-' + row.thread_id });
          const options = { vapidDetails: { subject: new URL('/kontakt.html', this.accounts.config.publicOrigin).href, ...this.keys() },
            TTL: 86400, urgency: 'high', contentEncoding: 'aes128gcm', topic: sha256(row.thread_id).slice(0, 32) };
          this.aborter = new AbortController();
          await this.transport(subscription, payload, options, this.aborter.signal);
          if (this.closed) break;
          this.store.run('DELETE FROM chat_push_outbox WHERE id=?', row.id);
        } catch (error) {
          if (this.closed) break;
          const status = Number(error.statusCode) || 0;
          if (status === 404 || status === 410) this.store.run('DELETE FROM chat_push_subscriptions WHERE id=? AND user_id=?', row.subscription_id, row.recipient_id);
          else if (status >= 300 && status < 400 || status === 400 || status === 413 || row.attempts >= 11) this.store.run('DELETE FROM chat_push_outbox WHERE id=?', row.id);
          else {
            const header = /^\d+$/.test(String(error.retryAfter || '')) ? Math.min(3600_000, Number(error.retryAfter) * 1000) : 0;
            const delay = Math.max(header, Math.min(3600_000, 15_000 * 2 ** Math.min(row.attempts, 8)));
            this.store.run('UPDATE chat_push_outbox SET attempts=attempts+1,last_status=?,next_attempt_at=? WHERE id=?', status, this.now() + delay, row.id);
          }
        } finally { this.aborter = null; }
      }
      if (pending.length === 12) retry = 500;
    } finally { this.running = false; if (!this.closed && this.autoStart) this.schedule(retry); }
  }
}
