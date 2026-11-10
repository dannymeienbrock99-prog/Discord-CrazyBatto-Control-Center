import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, assert, safeMessage } from './errors.mjs';
import { Vault, randomToken, sha256, equalHash } from './store.mjs';
import { AccountStore, accountView, requestView, trackView } from './account-store.mjs';
import { SUITE_APP_ID, SuiteLicenseAccess } from './suite-license.mjs';
import { SupabaseIdentity } from './account-identity.mjs';
import { PcStorageClient } from './pc-storage.mjs';
import { ImageStorageClient } from './image-storage.mjs';
import { SetupGallery, GALLERY_LIMITS } from './setup-gallery.mjs';
import { ProductCatalog } from './product-catalog.mjs';
import { Community } from './community.mjs';
import { birthDate } from './member-profile.mjs';
import { MemberProfile } from './member-profile.mjs';
import { Playlists } from './playlists.mjs';
import { Training } from './training.mjs';
import { Spotify } from './spotify.mjs';
import { VisitorStats } from './visitor-stats.mjs';

const scrypt = promisify(crypto.scrypt);
const COOKIE = '__Host-cb_account';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_UPLOAD = 80 * 1024 * 1024;
const APPS = [{ id: 'discord-app', name: 'Crazy_Batto Discord App' }, { id: SUITE_APP_ID, name: 'Batto 3-in-1 für Windows' }];
const cleanText = (value, maximum = 120) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum);
const cookie = (token = '', maxAge = 0) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function readCookie(header) {
  const values = String(header || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
  if (!values.length) return null;
  assert(values.length === 1 && TOKEN.test(values[0].slice(COOKIE.length + 1)), 'Die Anmeldung ist ungültig. Bitte erneut anmelden.', 'auth', 401);
  return values[0].slice(COOKIE.length + 1);
}
async function jsonBody(req, maximum = 16 * 1024) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'Bitte JSON senden.', 'validation', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; assert(size <= maximum, 'Die Anfrage ist zu groß.', 'validation', 413); chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('validation', 'Die Anfrage enthält kein gültiges JSON.', 400); }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Die Anfrage muss ein JSON-Objekt enthalten.');
  return value;
}
function fieldHeader(req, name, limit) {
  let value;
  try { value = decodeURIComponent(req.headers[name] || ''); } catch { throw new AppError('validation', 'Die Dateiangaben sind ungültig.', 400); }
  assert(value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value), 'Die Dateiangaben sind zu lang oder ungültig.');
  return value.trim();
}

export class AccountService {
  constructor(config, { identity, storage, imageStorage, store, now = Date.now, fetchImpl = fetch, botStatus } = {}) {
    this.config = config; this.now = now;
    this.store = store || new AccountStore(config.dataDir);
    // Optional aggregate analytics must never prevent account/page startup.
    try { this.visitorStats = new VisitorStats(this.store, { now, trustProxy: config.trustProxy }); }
    catch { this.visitorStats = null; }
    this.identity = identity || new SupabaseIdentity({ url: config.accountSupabaseUrl, key: config.accountSupabaseKey, fetchImpl, now });
    this.storage = storage || new PcStorageClient({ url: config.musicStorageUrl, token: config.musicStorageToken, fetchImpl });
    this.imageStorage = imageStorage || new ImageStorageClient(config, { fetchImpl });
    this.gallery = new SetupGallery(this.store, this.imageStorage, { now,
      additionalReferences: (id, options) => this.products?.hasImage(id, options) || (!options?.publicOnly && this.pcSupport?.hasImage(id)) || false });
    this.products = new ProductCatalog(this.store, this.gallery, { now });
    this.community = new Community(this);
    this.memberProfile = new MemberProfile(this); this.playlists = new Playlists(this);
    this.training = new Training(this);
    this.vault = new Vault(config.encryptionKey);
    this.suiteLicense = new SuiteLicenseAccess(this);
    this.spotify = new Spotify(this, { fetchImpl });
    this.refreshes = new Map(); this.limits = new Map(); this.uploads = new Set();
    this.botStatus = botStatus || (() => ({ configured: !!config.configured, message: config.configured ? 'Discord-Verbindung konfiguriert; noch kein Versandtest durchgeführt.' : 'Der Discord-Bot benötigt noch seine Server-Zugangsdaten.' }));
  }
  close() { this.visitorStats?.close(); this.community?.push?.close(); this.store.close(); }
  status() {
    return { configured: !!this.identity.configured && Buffer.isBuffer(this.config.encryptionKey) && this.config.encryptionKey.length === 32 && /^https:\/\//.test(this.config.publicOrigin || ''),
      storageConfigured: !!this.storage.configured };
  }
  configured() { assert(this.status().configured, 'Die E-Mail-Anmeldung wird noch eingerichtet. Bitte später erneut versuchen.', 'unconfigured', 503); }
  limit(key, max, window = 60_000) {
    const now = this.now();
    if (this.limits.size > 2000) for (const [name, entry] of this.limits) if (entry.until <= now) this.limits.delete(name);
    assert(this.limits.size < 20_000 || this.limits.has(key), 'Zu viele Anfragen. Bitte später erneut versuchen.', 'rate_limited', 429);
    let entry = this.limits.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + window }; this.limits.set(key, entry); }
    assert(++entry.count <= max, 'Zu viele Versuche. Bitte später erneut versuchen.', 'rate_limited', 429);
  }
  origin(req, native = false) {
    const origin = req.headers.origin;
    if (native) {
      assert(!origin && !req.headers.cookie && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'none'), 'Diese Anmeldung ist nur für die native App vorgesehen.', 'origin', 403);
    } else assert(origin === this.config.publicOrigin, 'Die Anfrage muss von dieser Website kommen.', 'origin', 403);
  }
  normalizeTokens(raw) {
    assert(typeof raw?.access_token === 'string' && raw.access_token.length >= 16 && typeof raw.refresh_token === 'string' && raw.refresh_token.length >= 8,
      'Der Anmeldedienst hat keine gültige Sitzung geliefert.', 'auth', 401);
    const seconds = Number(raw.expires_in);
    assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 86400, 'Die Anmeldedauer ist ungültig.', 'auth', 401);
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: this.now() + seconds * 1000 };
  }
  identityUser(raw, confirmed = true) {
    assert(UUID.test(raw?.id || '') && validEmail(raw?.email) && !raw?.is_anonymous, 'Es wurde kein gültiges E-Mail-Konto bestätigt.', 'auth', 401);
    if (confirmed) assert(!!raw.email_confirmed_at, 'Bitte zuerst deine E-Mail-Adresse bestätigen.', 'email_unconfirmed', 403);
    assert(!raw.banned_until || Date.parse(raw.banned_until) <= this.now(), 'Dieses Konto wurde gesperrt.', 'suspended', 403);
    return { id: raw.id, email: raw.email.trim().toLowerCase(), name: cleanText(raw.user_metadata?.name || raw.user_metadata?.full_name || raw.email.split('@')[0], 80), confirmed: !!raw.email_confirmed_at };
  }
  mirror(user, verified) {
    const existing = this.store.get('SELECT * FROM accounts WHERE id=?', user.id);
    // Unauthenticated signup responses never update an existing name, email or
    // any role. Supabase may deliberately return an obfuscated duplicate user.
    if (existing && !verified) return existing;
    this.store.run(`INSERT INTO accounts (id,email,name,confirmed,created_at,verified_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name,confirmed=excluded.confirmed,verified_at=excluded.verified_at`,
      user.id, user.email, user.name, Number(user.confirmed && verified), this.now(), verified ? this.now() : null);
    this.controlMembers?.observe(user.id);
    return this.store.get('SELECT * FROM accounts WHERE id=?', user.id);
  }
  sessionView(context) { return { user: context.user, approval: this.controlMembers?.status(context.user.id) || null, profileComplete: this.memberProfile.complete(context.user.id), csrfToken: context.csrfToken, requests: this.store.all('SELECT * FROM app_requests WHERE user_id=? ORDER BY created_at DESC', context.user.id).map(requestView) }; }
  async verifySession(hash, expectedKind) {
    this.configured();
    let session = this.store.get('SELECT * FROM account_sessions WHERE hash=?', hash);
    assert(session && session.expires_at > this.now() && session.kind === expectedKind, 'Bitte mit E-Mail und Passwort anmelden.', 'auth', 401);
    let row = this.store.get('SELECT * FROM accounts WHERE id=?', session.user_id);
    assert(row && !row.suspended, 'Dieses Konto wurde gesperrt.', 'suspended', 403);
    let tokens;
    try { tokens = this.vault.open(JSON.parse(session.tokens)); } catch { throw new AppError('auth', 'Diese Anmeldung kann nicht mehr gelesen werden. Bitte erneut anmelden.', 401); }
    if (tokens.expiresAt <= this.now() + 30_000) {
      if (!this.refreshes.has(hash)) this.refreshes.set(hash, (async () => {
        const refreshed = this.normalizeTokens(await this.identity.refresh(tokens.refreshToken));
        assert(this.store.get('SELECT hash FROM account_sessions WHERE hash=?', hash), 'Diese Anmeldung wurde beendet.', 'auth', 401);
        this.store.run('UPDATE account_sessions SET tokens=? WHERE hash=?', JSON.stringify(this.vault.seal(refreshed)), hash);
        return refreshed;
      })().finally(() => this.refreshes.delete(hash)));
      try { tokens = await this.refreshes.get(hash); }
      catch (error) { if (error.status === 401 || error.status === 403) this.store.run('DELETE FROM account_sessions WHERE hash=?', hash); throw error; }
    }
    let raw;
    try { raw = await this.identity.user(tokens.accessToken); }
    catch (error) { if (error.status === 401 || error.status === 403) this.store.run('DELETE FROM account_sessions WHERE hash=?', hash); throw error; }
    const verified = this.identityUser(raw);
    assert(verified.id === session.user_id, 'Die Kontoidentität stimmt nicht mit der Anmeldung überein.', 'auth', 401);
    row = this.mirror(verified, true);
    session = this.store.get('SELECT * FROM account_sessions WHERE hash=?', hash);
    assert(session && session.expires_at > this.now(), 'Diese Anmeldung wurde beendet.', 'auth', 401);
    assert(!row.suspended, 'Dieses Konto wurde gesperrt.', 'suspended', 403);
    return { user: accountView(row), session, csrfToken: session.csrf };
  }
  async authenticateRequest(req, { mutation = false, requireAdmin = false, requireApp = null, allowPending = false } = {}) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization || '');
    if (req.headers.authorization) assert(bearer, 'Die App-Anmeldung ist ungültig.', 'auth', 401);
    const token = bearer ? bearer[1] : readCookie(req.headers.cookie);
    assert(token, 'Bitte mit E-Mail und Passwort anmelden.', 'auth', 401);
    if (bearer) this.origin(req, true);
    const context = await this.verifySession(sha256(token), bearer ? 'native' : 'browser');
    if (mutation && !bearer) {
      this.origin(req);
      const supplied = req.headers['x-csrf-token'];
      assert(typeof supplied === 'string' && equalHash(sha256(supplied), sha256(context.csrfToken)), 'Bitte die Seite neu laden und erneut versuchen.', 'csrf', 403);
    }
    if (requireAdmin) assert(context.user.isAdmin, 'Nur Administratoren dürfen diesen Bereich öffnen.', 'forbidden', 403);
    if (!allowPending) this.controlMembers?.assertApproved(context);
    if (requireApp) this.appAllowed(context.user, requireApp);
    return context;
  }
  async authorizeNativeApp(token, appId = 'discord-app') {
    assert(typeof token === 'string' && TOKEN.test(token), 'Bitte zuerst mit E-Mail und Passwort in der App anmelden.', 'auth', 401);
    const context = await this.verifySession(sha256(token), 'native'); this.controlMembers?.assertApproved(context); this.appAllowed(context.user, appId); return context;
  }
  assertCurrent(context, { admin = false } = {}) {
    const session = this.store.get('SELECT * FROM account_sessions WHERE hash=?', context?.session?.hash || '');
    assert(session && session.expires_at > this.now() && session.user_id === context?.user?.id, 'Die Anmeldung wurde beendet. Bitte erneut anmelden.', 'auth', 401);
    const user = accountView(this.store.get('SELECT * FROM accounts WHERE id=?', session.user_id));
    assert(user?.confirmed && !user.suspended, 'Dieses Konto ist gesperrt oder nicht bestätigt.', 'suspended', 403);
    if (admin) assert(user.isAdmin, 'Die Administratorfreigabe wurde zurückgenommen.', 'forbidden', 403);
    this.controlMembers?.assertApproved({ user });
    return user;
  }
  assertNativeAuthorization(context, appId = 'discord-app') {
    const session = this.store.get('SELECT * FROM account_sessions WHERE hash=?', context?.session?.hash || '');
    assert(session && session.kind === 'native' && session.expires_at > this.now() && session.user_id === context?.user?.id, 'Die App-Anmeldung wurde beendet. Bitte erneut anmelden.', 'auth', 401);
    const user = accountView(this.store.get('SELECT * FROM accounts WHERE id=?', session.user_id));
    assert(user?.confirmed && !user.suspended, 'Dieses Konto ist gesperrt oder nicht bestätigt.', 'suspended', 403);
    this.appAllowed(user, appId);
    return { ...user, approved: true };
  }
  authorizeAdmin(req) { return this.authenticateRequest(req, { mutation: !['GET', 'HEAD'].includes(req.method), requireAdmin: true }); }
  appAllowed(user, appId) {
    this.controlMembers?.assertApproved({ user });
    assert(APPS.some(app => app.id === appId), 'Diese App ist nicht vorhanden.', 'not_found', 404);
    if (appId === SUITE_APP_ID) { this.suiteLicense.requirePersonalApproval(user); return; }
    assert(user.isAdmin || this.store.get("SELECT id FROM app_requests WHERE user_id=? AND app_id=? AND status='approved'", user.id, appId), 'Deine Anfrage für diese App wurde noch nicht freigegeben.', 'app_access', 403);
  }
  uploadAllowed(user) { assert(!user.suspended && user.confirmed && user.canUpload, 'Du benötigst die persönliche Freigabe zum Musikhochladen.', 'upload_forbidden', 403); }
  async storageStatus() {
    if (!this.storage.configured) return { configured: false, online: false, message: 'Der Musikspeicher ist noch nicht eingerichtet. Uploads und Wiedergabe stehen nach der Einrichtung zur Verfügung.' };
    const offline = { configured: true, online: false, message: 'Der Musikspeicher ist offline. Uploads und Wiedergabe sind derzeit nicht verfügbar. Bitte die Speicherverbindung prüfen.' };
    try {
      const value = await this.storage.health();
      return value.online === true ? { configured: true, online: true, message: 'Musikspeicher verbunden.' } : offline;
    } catch { return offline; }
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://local.invalid'), route = url.pathname;
    if (!/^\/api\/(?:account|admin|music|setup|products|community|training|spotify)(?:\/|$)/.test(route)) return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Cookie, Authorization');
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const sendImage = ({ bytes, mimeType }) => { res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes); };
    try {
      const forwarded = this.config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
      const remote = forwarded || req.socket?.remoteAddress || 'unknown';
      this.limit('api:' + remote, 300);
      if (route.startsWith('/api/community/') || route === '/api/admin/community' || route.startsWith('/api/admin/community/')) return await this.community.handle(req, res);
      if (route === '/api/training' || route.startsWith('/api/training/') || route === '/api/admin/training' || route.startsWith('/api/admin/training/')) return await this.training.handle(req, res);
      if (route === '/api/spotify' || route.startsWith('/api/spotify/') || route === '/api/admin/spotify' || route.startsWith('/api/admin/spotify/')) return await this.spotify.handle(req, res);
      if (req.method === 'GET' && route === '/api/account/apps') { send({ apps: APPS }); return true; }
      if (req.method === 'GET' && route === '/api/products') { send(this.products.view()); return true; }
      if (req.method === 'GET' && route === '/api/setup/slots') {
        const storage = await this.imageStorage.status();
        send({ slots: this.gallery.slots(), storage, limits: GALLERY_LIMITS }); return true;
      }
      const galleryImage = /^\/api\/setup\/images\/(gallery_[a-f0-9]{64})$/.exec(route);
      if (galleryImage && ['GET', 'HEAD'].includes(req.method)) { sendImage(await this.gallery.read(galleryImage[1])); return true; }
      if (req.method === 'GET' && route === '/api/music/playlists') { send({ playlists: this.playlists.list() }); return true; }
      if (req.method === 'GET' && route === '/api/music/tracks') {
        send({ tracks: this.store.all('SELECT * FROM music_tracks ORDER BY created_at,id').map(trackView), storage: await this.storageStatus() }); return true;
      }
      const streamMatch = /^\/api\/music\/tracks\/([0-9a-f-]{36})\/stream$/.exec(route);
      if (streamMatch && ['GET', 'HEAD'].includes(req.method)) {
        const track = this.store.get('SELECT * FROM music_tracks WHERE id=?', streamMatch[1]);
        assert(track, 'Dieser Titel ist nicht vorhanden.', 'not_found', 404);
        await this.stream(req, res, track); return true;
      }
      if (route === '/api/account/logout' && req.method === 'POST') {
        // Local revocation must still work during an identity-provider outage.
        const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization || '');
        if (req.headers.authorization) assert(bearer, 'Die App-Anmeldung ist ungültig.', 'auth', 401);
        this.origin(req, !!bearer);
        const token = bearer?.[1] || readCookie(req.headers.cookie);
        const session = token && this.store.get('SELECT * FROM account_sessions WHERE hash=?', sha256(token));
        if (session) {
          assert(session.kind === (bearer ? 'native' : 'browser'), 'Diese Anmeldung gehört zu einem anderen Zugang.', 'auth', 401);
          if (!bearer) assert(typeof req.headers['x-csrf-token'] === 'string' && equalHash(sha256(req.headers['x-csrf-token']), sha256(session.csrf)), 'Bitte die Seite neu laden und erneut versuchen.', 'csrf', 403);
          this.store.run('DELETE FROM account_sessions WHERE hash=?', session.hash);
          try { const tokens = this.vault.open(JSON.parse(session.tokens)); await this.identity.logout(tokens.accessToken).catch(() => {}); } catch { /* Already revoked locally. */ }
        }
        if (!bearer) res.setHeader('Set-Cookie', cookie());
        send({ ok: true }); return true;
      }
      this.configured();
      if (req.method === 'POST' && ['/api/account/register', '/api/account/login'].includes(route)) {
        this.limit('login:' + remote, 12, 10 * 60_000);
        const body = await jsonBody(req), native = body.native === true;
        if (native) assert(req.headers['x-client-type'] === 'native', 'Die native Anmeldung benötigt eine App-Anfrage.', 'origin', 403);
        this.origin(req, native);
        const email = String(body.email || '').trim().toLowerCase();
        assert(validEmail(email) && typeof body.password === 'string' && body.password.length >= 8 && body.password.length <= 128, 'Bitte eine gültige E-Mail und ein Passwort mit 8 bis 128 Zeichen eingeben.');
        this.limit('email:' + sha256(email), 12, 10 * 60_000);
        if (route.endsWith('/register')) {
          this.limit('register:' + remote, 4, 60 * 60_000);
          const name = cleanText(body.name, 80); assert(name.length >= 2, 'Bitte deinen Namen mit mindestens zwei Zeichen eingeben.');
          const birthday = birthDate(body.birthDate, this.now());
          assert(typeof body.birthdayShared === 'boolean', 'Bitte die Sichtbarkeit deines Geburtstags auswählen.');
          const raw = await this.identity.register({ name, email, password: body.password, redirectTo: this.config.publicOrigin + '/registrierung.html?confirmed=1' });
          if (raw?.id && raw?.identities?.length) {
            const user = this.identityUser(raw, false);
            // A duplicate signup must never change another member's private profile.
            const existing = this.store.get('SELECT id FROM accounts WHERE id=?', user.id);
            this.mirror(user, false);
            if (!existing) this.birthdays?.saveInitialProfile(user.id, birthday, body.birthdayShared);
          }
          send({ message: 'Wenn diese Adresse registriert werden kann, erhältst du eine Bestätigungs-E-Mail. Öffne den Link und melde dich danach hier an.' }, 201); return true;
        }
        const tokens = this.normalizeTokens(await this.identity.login({ email, password: body.password }));
        let row;
        try { row = this.mirror(this.identityUser(await this.identity.user(tokens.accessToken)), true); assert(!row.suspended, 'Dieses Konto wurde gesperrt.', 'suspended', 403); }
        catch (error) { await this.identity.logout(tokens.accessToken).catch(() => {}); throw error; }
        const token = randomToken(48), hash = sha256(token), csrf = randomToken(), now = this.now();
        const lifetime = native ? 30 * 86400_000 : 7 * 86400_000;
        this.store.transaction(() => {
          this.store.run('DELETE FROM account_sessions WHERE expires_at<=?', now);
          // Bound per-account devices without breaking unrelated accounts.
          const old = this.store.all('SELECT hash FROM account_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 19', row.id);
          for (const item of old) this.store.run('DELETE FROM account_sessions WHERE hash=?', item.hash);
          this.store.run('INSERT INTO account_sessions VALUES (?,?,?,?,?,?,?)', hash, row.id, native ? 'native' : 'browser', csrf, JSON.stringify(this.vault.seal(tokens)), now + lifetime, now);
        });
        const context = { user: accountView(row), csrfToken: csrf };
        if (!native) res.setHeader('Set-Cookie', cookie(token, lifetime / 1000));
        send({ ...this.sessionView(context), expiresAt: now + lifetime, ...(native ? { token } : {}) }); return true;
      }
      if (route === '/api/account/session' && req.method === 'GET') {
        if (!req.headers.authorization && !readCookie(req.headers.cookie)) { send({ user: null }); return true; }
        const context = await this.authenticateRequest(req, { allowPending: true }); send(this.sessionView(context)); return true;
      }
      const mutation = !['GET', 'HEAD'].includes(req.method);
      const context = await this.authenticateRequest(req, { mutation, requireAdmin: route.startsWith('/api/admin/') });
      if (route === '/api/account/profile' && req.method === 'GET') { send({ profile: this.memberProfile.view(context.user.id) }); return true; }
      if (route === '/api/account/profile' && req.method === 'PUT') { send({ profile: this.memberProfile.save(context, await jsonBody(req)) }); return true; }
      if (route === '/api/account/profile/avatar') {
        if (['GET', 'HEAD'].includes(req.method)) { sendImage(await this.memberProfile.read(context)); return true; }
        if (req.method === 'PUT') { send({ profile: await this.memberProfile.upload(context, req) }); return true; }
        if (req.method === 'DELETE') { send({ profile: this.memberProfile.remove(context) }); return true; }
      }
      const playlistMatch = /^\/api\/music\/playlists\/([0-9a-f-]{36})$/.exec(route);
      if (route === '/api/music/playlists' && req.method === 'POST') { send({ playlist: this.playlists.save(context, await jsonBody(req, 32 * 1024)) }, 201); return true; }
      if (playlistMatch && req.method === 'PUT') { send({ playlist: this.playlists.save(context, await jsonBody(req, 32 * 1024), playlistMatch[1]) }); return true; }
      if (playlistMatch && req.method === 'DELETE') { send(this.playlists.remove(context, playlistMatch[1])); return true; }

      const { user, session } = context;
      if (route === '/api/admin/products' && req.method === 'GET') {
        this.assertCurrent(context, { admin: true }); send(this.products.view({ admin: true })); return true;
      }
      if (route === '/api/admin/products' && req.method === 'PUT') {
        this.limit('products-update:' + user.id, 30);
        send(await this.products.save(await jsonBody(req, 2 * 1024 * 1024), () => this.assertCurrent(context, { admin: true }))); return true;
      }
      if (route === '/api/admin/visitor-stats' && req.method === 'GET') {
        this.assertCurrent(context, { admin: true });
        const days = url.searchParams.getAll('days');
        assert(days.length <= 1 && (!days.length || /^(7|30|90)$/.test(days[0])), 'Bitte 7, 30 oder 90 Tage auswählen.');
        assert(this.visitorStats, 'Die Aufrufstatistik ist momentan nicht verfügbar.', 'unavailable', 503);
        send(this.visitorStats.report(days.length ? Number(days[0]) : 30)); return true;
      }
      if (route === '/api/admin/setup/images' && req.method === 'GET') { send({ images: this.gallery.images() }); return true; }
      if (route === '/api/admin/setup/images' && req.method === 'POST') {
        this.limit('gallery-upload:' + user.id, 30);
        send(await this.gallery.upload(req, () => this.assertCurrent(context, { admin: true })), 201); return true;
      }
      const gallerySlot = /^\/api\/admin\/setup\/slots\/([a-z-]+)$/.exec(route);
      if (gallerySlot && req.method === 'PATCH') {
        const body = await jsonBody(req, 64 * 1024);
        send(await this.gallery.update(gallerySlot[1], body, () => this.assertCurrent(context, { admin: true }))); return true;
      }
      const adminGalleryImage = /^\/api\/admin\/setup\/images\/(gallery_[a-f0-9]{64})$/.exec(route);
      if (adminGalleryImage && ['GET', 'HEAD'].includes(req.method)) {
        const image = await this.gallery.read(adminGalleryImage[1], { publicOnly: false });
        this.assertCurrent(context, { admin: true }); sendImage(image); return true;
      }
      if (adminGalleryImage && req.method === 'DELETE') {
        send(await this.gallery.remove(adminGalleryImage[1], () => {
          const current = this.assertCurrent(context, { admin: true });
          // This callback runs inside the queue shared with Community uploads,
          // before and after the NAS request. Identical bytes may be shared.
          assert(!this.community.hasImage(adminGalleryImage[1]) && !this.memberProfile.hasImage(adminGalleryImage[1]) && !this.gamingSetups?.hasImage(adminGalleryImage[1]) && !this.pcSupport?.hasImage(adminGalleryImage[1]), 'Dieses Bild wird in einem Profil, Gaming-Setup oder einer PC-Anfrage verwendet und darf hier nicht entfernt werden.', 'conflict', 409);
          return current;
        })); return true;
      }
      if (route === '/api/account/license/batto-3-in-1') {
        assert(req.method === 'POST', 'Bitte die Lizenz über dein Konto anfordern.', 'method', 405);
        const body = await jsonBody(req); assert(Object.keys(body).length === 0, 'Für den Lizenzabruf sind keine weiteren Angaben nötig.');
        this.limit('suite-license:' + user.id, 6, 60_000);
        res.setHeader('Cache-Control', 'private, no-store, max-age=0');
        res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0');
        send(this.suiteLicense.reveal(context)); return true;
      }
      if (route === '/api/account/requests' && req.method === 'POST') {
        if (!context.user.isAdmin) this.memberProfile.require(context.user.id);
        const body = await jsonBody(req); assert(APPS.some(app => app.id === body.appId), 'Diese App ist nicht vorhanden.', 'not_found', 404);
        this.assertCurrent(context);
        let entry = this.store.get('SELECT * FROM app_requests WHERE user_id=? AND app_id=?', user.id, body.appId);
        if (!entry || !['pending', 'approved'].includes(entry.status)) {
          this.limit('request:' + user.id, 10, 60 * 60_000);
          const id = entry?.id || crypto.randomUUID();
          this.store.transaction(() => {
            this.store.run(`INSERT INTO app_requests (id,user_id,app_id,status,note,created_at) VALUES (?,?,?,'pending',?,?)
              ON CONFLICT(user_id,app_id) DO UPDATE SET status='pending',note=excluded.note,created_at=excluded.created_at,reviewed_at=NULL,reason=''`, id, user.id, body.appId, cleanText(body.note, 1000), this.now());
            this.store.audit(user.id, 'app.requested', id, { appId: body.appId }, this.now());
          });
          entry = this.store.get('SELECT * FROM app_requests WHERE id=?', id);
        }
        send({ request: requestView(entry) }); return true;
      }
      if (route === '/api/admin/overview' && req.method === 'GET') {
        const users = this.store.all('SELECT * FROM accounts ORDER BY created_at DESC').map(row => ({ ...accountView(row), createdAt: row.created_at }));
        const requests = this.store.all('SELECT r.*, a.name AS user_name, a.email FROM app_requests r JOIN accounts a ON a.id=r.user_id ORDER BY r.created_at DESC').map(row => ({ ...requestView(row), userId: row.user_id, userName: row.user_name, email: row.email, ...(row.app_id === SUITE_APP_ID ? { canDecide: this.suiteLicense.canDecide(user) } : {}) }));
        send({ users, requests, settings: { uploadPasswordSet: !!this.store.setting('upload_password') }, storage: await this.storageStatus(), bot: this.botStatus(), counts: { users: users.length, pending: requests.filter(r => r.status === 'pending').length, uploaders: users.filter(u => u.canUpload && !u.suspended).length } }); return true;
      }
      const userMatch = /^\/api\/admin\/users\/([0-9a-f-]{36})$/.exec(route);
      if (userMatch && req.method === 'PATCH') {
        const body = await jsonBody(req), target = this.store.get('SELECT * FROM accounts WHERE id=?', userMatch[1]);
        this.assertCurrent(context, { admin: true });
        assert(target, 'Dieses Konto ist nicht vorhanden.', 'not_found', 404);
        assert(Object.keys(body).length > 0 && Object.keys(body).every(key => ['canUpload', 'suspended'].includes(key) && typeof body[key] === 'boolean'), 'Nur Upload-Freigabe und Kontosperre dürfen hier geändert werden.');
        assert(!(target.id === user.id && body.suspended === true), 'Du kannst dein eigenes Administratorkonto nicht sperren.');
        assert(!(body.canUpload === true && !target.confirmed), 'Bitte zuerst die E-Mail-Bestätigung des Kontos abwarten.');
        this.store.transaction(() => {
          this.store.run('UPDATE accounts SET can_upload=?,suspended=? WHERE id=?', Number(body.canUpload ?? !!target.can_upload), Number(body.suspended ?? !!target.suspended), target.id);
          this.store.run('DELETE FROM upload_grants WHERE user_id=?', target.id);
          if (body.suspended === true) this.store.run('DELETE FROM account_sessions WHERE user_id=?', target.id);
          this.store.audit(user.id, 'account.permissions', target.id, body, this.now());
        });
        send({ user: accountView(this.store.get('SELECT * FROM accounts WHERE id=?', target.id)) }); return true;
      }
      const decisionMatch = /^\/api\/admin\/requests\/([0-9a-f-]{36})\/decision$/.exec(route);
      if (decisionMatch && req.method === 'POST') {
        const body = await jsonBody(req), entry = this.store.get('SELECT * FROM app_requests WHERE id=?', decisionMatch[1]);
        this.assertCurrent(context, { admin: true });
        assert(entry, 'Diese Anfrage ist nicht vorhanden.', 'not_found', 404);
        if (entry.app_id === SUITE_APP_ID) this.suiteLicense.requireOperator(context);
        assert(['approved', 'rejected', 'revoked'].includes(body.decision), 'Diese Entscheidung ist ungültig.');
        const owner = this.store.get('SELECT * FROM accounts WHERE id=?', entry.user_id);
        if (body.decision === 'approved') assert(owner.confirmed && !owner.suspended, 'Dieses Konto ist noch nicht bestätigt oder wurde gesperrt.');
        assert(entry.status === body.decision
          || (body.decision === 'approved' && ['pending', 'rejected', 'revoked'].includes(entry.status))
          || (entry.status === 'pending' && body.decision === 'rejected')
          || (entry.status === 'approved' && body.decision === 'revoked'), 'Die Anfrage wurde inzwischen geändert. Bitte die Übersicht neu laden.', 'conflict', 409);
        const reviewedAt = this.now();
        this.store.transaction(() => {
          this.store.run('UPDATE app_requests SET status=?,reason=?,reviewed_at=? WHERE id=?', body.decision, cleanText(body.reason, 1000), reviewedAt, entry.id);
          this.store.audit(user.id, 'app.' + body.decision, entry.id, { appId: entry.app_id }, reviewedAt);
        });
        send({ request: requestView(this.store.get('SELECT * FROM app_requests WHERE id=?', entry.id)) }); return true;
      }
      if (route === '/api/admin/upload-password' && req.method === 'PUT') {
        const body = await jsonBody(req); assert(typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 128, 'Das Upload-Kennwort benötigt 12 bis 128 Zeichen.');
        const salt = crypto.randomBytes(32).toString('hex');
        const hash = (await scrypt(body.password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
        // Recheck administrator status after the asynchronous password hash.
        await this.authenticateRequest(req, { mutation: true, requireAdmin: true });
        this.store.transaction(() => {
          this.store.setSetting('upload_password', JSON.stringify({ salt, hash })); this.store.setSetting('upload_generation', randomToken());
          this.store.run('DELETE FROM upload_grants'); this.store.audit(user.id, 'music.password_changed', null, {}, this.now());
        });
        send({ ok: true }); return true;
      }
      if (route === '/api/music/unlock' && req.method === 'POST') {
        this.uploadAllowed(user); this.limit('unlock:' + user.id, 6, 10 * 60_000);
        const body = await jsonBody(req), stored = this.store.setting('upload_password');
        assert(stored, 'Der Administrator muss zuerst ein Upload-Kennwort festlegen.', 'unconfigured', 503);
        assert(typeof body.password === 'string' && body.password.length <= 128, 'Das Upload-Kennwort ist ungültig.', 'upload_password', 403);
        const record = JSON.parse(stored), candidate = await scrypt(body.password, record.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        assert(crypto.timingSafeEqual(candidate, Buffer.from(record.hash, 'hex')), 'Das Upload-Kennwort ist falsch.', 'upload_password', 403);
        this.uploadAllowed((await this.authenticateRequest(req, { mutation: true })).user);
        assert(this.store.setting('upload_password') === stored, 'Das Upload-Kennwort wurde geändert. Bitte erneut eingeben.', 'upload_password', 403);
        const token = randomToken(), expiresAt = this.now() + 5 * 60_000;
        this.store.run('DELETE FROM upload_grants WHERE user_id=? OR expires_at<=?', user.id, this.now());
        this.store.run('INSERT INTO upload_grants VALUES (?,?,?,?,?)', sha256(token), user.id, session.hash, this.store.setting('upload_generation'), expiresAt);
        send({ uploadToken: token, expiresAt }); return true;
      }
      if (route === '/api/music/tracks' && req.method === 'POST') {
        send({ track: await this.upload(req, context) }, 201); return true;
      }
      const trackMatch = /^\/api\/music\/tracks\/([0-9a-f-]{36})$/.exec(route);
      if (trackMatch && ['DELETE', 'PATCH'].includes(req.method)) {
        const track = this.store.get('SELECT * FROM music_tracks WHERE id=?', trackMatch[1]);
        assert(track, 'Dieser Titel ist nicht vorhanden.', 'not_found', 404);
        assert(user.isAdmin || (user.canUpload && track.uploaded_by === user.id), 'Du darfst diesen Titel nicht ändern.', 'forbidden', 403);
        if (req.method === 'PATCH') {
          const body = await jsonBody(req);
          const latestUser = this.assertCurrent(context);
          assert(latestUser.isAdmin || (latestUser.canUpload && track.uploaded_by === latestUser.id), 'Die Bearbeitungsfreigabe wurde zurückgenommen.', 'forbidden', 403);
          assert(Object.keys(body).length && Object.keys(body).every(key => ['title', 'artist'].includes(key) && typeof body[key] === 'string'), 'Nur Titel und Künstler können geändert werden.');
          const title = cleanText(body.title ?? track.title), artist = cleanText(body.artist ?? track.artist); assert(title, 'Bitte einen Titel eingeben.');
          this.store.transaction(() => { this.store.run('UPDATE music_tracks SET title=?,artist=? WHERE id=?', title, artist, track.id); this.store.audit(user.id, 'music.updated', track.id, {}, this.now()); });
          send({ track: trackView(this.store.get('SELECT * FROM music_tracks WHERE id=?', track.id)) }); return true;
        }
        const latestUser = this.assertCurrent(context);
        assert(latestUser.isAdmin || (latestUser.canUpload && track.uploaded_by === latestUser.id), 'Die Bearbeitungsfreigabe wurde zurückgenommen.', 'forbidden', 403);
        await this.storage.remove(track.id);
        try {
          const afterRemove = this.assertCurrent(context);
          assert(afterRemove.isAdmin || (afterRemove.canUpload && track.uploaded_by === afterRemove.id), 'Die Bearbeitungsfreigabe wurde zurückgenommen.', 'forbidden', 403);
        } catch (error) {
          // File removal is reversible in the PC quarantine; keep an explicit
          // repair record if a concurrent revocation prevents metadata commit.
          this.store.audit(user.id, 'music.quarantined_pending_metadata', track.id, {}, this.now());
          throw error;
        }
        this.store.transaction(() => { this.store.run('DELETE FROM music_tracks WHERE id=?', track.id); this.store.audit(user.id, 'music.removed', track.id, {}, this.now()); });
        send({ ok: true }); return true;
      }
      if (route === '/api/account/download/discord-app' && ['GET', 'HEAD'].includes(req.method)) {
        this.appAllowed(user, 'discord-app'); await this.download(req, res); return true;
      }
      if ((route === '/api/account/download/music-remote' && ['GET', 'HEAD'].includes(req.method))
          || (route === '/api/account/download/music-remote/metadata' && req.method === 'GET')) {
        this.appAllowed(user, 'discord-app');
        this.limit('music-apk:' + user.id, 20);
        const apk = await this.readMusicRemoteApk();
        this.appAllowed(this.assertCurrent(context), 'discord-app');
        if (route.endsWith('/metadata')) { send(apk.metadata); return true; }
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Length', apk.bytes.length);
        res.setHeader('Content-Disposition', 'attachment; filename="' + apk.metadata.filename + '"');
        res.setHeader('X-Content-SHA256', apk.metadata.sha256);
        res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : apk.bytes); return true;
      }
      throw new AppError('not_found', 'Diese Funktion ist nicht vorhanden.', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const known = error instanceof AppError;
      const storageError = error?.name === 'PcStorageError';
      const status = known ? error.status : storageError ? (error.status || error.statusCode || 503) : 500;
      send({ error: { code: known ? error.kind : storageError ? error.code : 'server_error', message: known || storageError ? safeMessage(error.message) : 'Die Anfrage konnte nicht abgeschlossen werden. Bitte später erneut versuchen.' } }, status);
      return true;
    }
  }
  async upload(req, context) {
    this.uploadAllowed(context.user);
    const supplied = req.headers['x-upload-token'];
    assert(typeof supplied === 'string' && TOKEN.test(supplied), 'Bitte zuerst das Upload-Kennwort eingeben.', 'upload_password', 403);
    const grant = this.store.get('SELECT * FROM upload_grants WHERE hash=?', sha256(supplied));
    assert(grant && grant.user_id === context.user.id && grant.session_hash === context.session.hash && grant.expires_at > this.now() && grant.generation === this.store.setting('upload_generation'), 'Die Upload-Freigabe ist abgelaufen. Bitte das Kennwort erneut eingeben.', 'upload_password', 403);
    const filename = fieldHeader(req, 'x-file-name', 180), title = fieldHeader(req, 'x-track-title', 120), artist = fieldHeader(req, 'x-track-artist', 120);
    const mimeType = String(req.headers['content-type'] || '').toLowerCase();
    assert(filename && !/[\\/]/.test(filename) && /\.(mp3|mp4)$/i.test(filename), 'Nur MP3- und MP4-Dateien sind erlaubt.', 'file_type', 415);
    assert((/\.mp3$/i.test(filename) && mimeType === 'audio/mpeg') || (/\.mp4$/i.test(filename) && ['audio/mp4', 'video/mp4'].includes(mimeType)), 'Dateiendung und Dateityp müssen MP3 oder MP4 entsprechen.', 'file_type', 415);
    assert(title, 'Bitte einen Musiktitel eingeben.');
    const length = req.headers['content-length'];
    assert(typeof length === 'string' && /^\d+$/.test(length), 'Die Dateigröße fehlt.', 'validation', 411);
    const size = Number(length); assert(Number.isSafeInteger(size) && size > 0 && size <= MAX_UPLOAD, 'Die Musikdatei darf höchstens 80 MiB groß sein.', 'file_size', 413);
    assert(!this.uploads.has(context.user.id) && this.uploads.size < 3, 'Es laufen bereits Uploads. Bitte kurz warten.', 'rate_limited', 429);
    this.store.run('DELETE FROM upload_grants WHERE hash=?', grant.hash); // Single use, even on a failed upload.
    const id = crypto.randomUUID(); let transferred = 0, stored = false;
    const bounded = new Transform({ transform(chunk, encoding, callback) {
      transferred += chunk.length;
      if (transferred > size || transferred > MAX_UPLOAD) callback(new AppError('file_size', 'Die Dateigröße stimmt nicht.', 413));
      else callback(null, chunk);
    }, flush(callback) { callback(transferred === size ? null : new AppError('file_size', 'Die Datei wurde nicht vollständig übertragen.', 400)); } });
    const onAbort = () => bounded.destroy(new AppError('upload_aborted', 'Der Upload wurde abgebrochen.', 400));
    req.once('aborted', onAbort); req.once('error', onAbort); this.uploads.add(context.user.id);
    try {
      req.pipe(bounded);
      const result = await this.storage.upload(bounded, { id, filename, size, mimeType }); stored = true;
      assert(transferred === size && result.id === id && result.size === size && ['audio/mpeg', 'audio/mp4', 'video/mp4'].includes(result.mimeType) && Number.isFinite(result.duration) && result.duration > 0 && /^[a-f0-9]{64}$/.test(result.sha256), 'Der Musikspeicher hat die Musikdatei nicht gültig bestätigt.', 'storage_invalid', 502);
      const fresh = await this.authenticateRequest(req, { mutation: true }); this.uploadAllowed(fresh.user);
      assert(grant.generation === this.store.setting('upload_generation'), 'Die Upload-Freigabe wurde während der Übertragung zurückgenommen.', 'upload_forbidden', 403);
      this.store.transaction(() => {
        this.store.run('INSERT INTO music_tracks VALUES (?,?,?,?,?,?,?,?,?,?)', id, title, artist, result.duration, filename, size, result.mimeType, result.sha256, fresh.user.id, this.now());
        this.store.audit(fresh.user.id, 'music.uploaded', id, { size }, this.now());
      });
      return trackView(this.store.get('SELECT * FROM music_tracks WHERE id=?', id));
    } catch (error) {
      if (stored) {
        try { await this.storage.remove(id); }
        catch { this.store.audit(context.user.id, 'music.cleanup_required', id, {}, this.now()); }
      }
      throw error;
    } finally { req.unpipe(bounded); bounded.destroy(); req.off('aborted', onAbort); req.off('error', onAbort); this.uploads.delete(context.user.id); }
  }
  async stream(req, res, track) {
    const range = req.headers.range;
    if (range) assert(/^bytes=\d*-\d*$/.test(range) && range !== 'bytes=-' && range.length < 80, 'Dieser Wiedergabebereich ist ungültig.', 'range', 416);
    const response = await this.storage.stream(track.id, { range, method: req.method });
    if (response.status === 416) { await response.body?.cancel(); res.writeHead(416, { 'Content-Range': response.headers.get('content-range') || 'bytes */' + track.size }); res.end(); return; }
    if (response.status === 404) { await response.body?.cancel(); throw new AppError('not_found', 'Diese Musikdatei fehlt auf dem Musikspeicher.', 404); }
    if (response.status !== 200 && response.status !== 206) { await response.body?.cancel(); throw new AppError('storage_offline', 'Der Musikspeicher ist für die Wiedergabe nicht verfügbar.', 503); }
    res.setHeader('Content-Type', track.mime_type); res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) if (response.headers.has(name)) res.setHeader(name, response.headers.get(name));
    res.writeHead(response.status);
    if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); return; }
    const readable = Readable.fromWeb(response.body);
    const onClose = () => readable.destroy(); res.once('close', onClose);
    try { await pipeline(readable, res); } finally { res.off('close', onClose); }
  }
  async readMusicRemoteApk() {
    let file;
    const metadata = this.config.musicRemoteApk;
    try {
      assert(this.config.musicRemoteApkPath && metadata, 'Die separate Musik-App ist noch nicht bereitgestellt.', 'unconfigured', 503);
      file = await fs.promises.open(this.config.musicRemoteApkPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await file.stat();
      assert(stat.isFile() && stat.size > 0 && stat.size <= 80 * 1024 * 1024, 'Die Musik-App-Datei ist nicht verfügbar.', 'unconfigured', 503);
      // The release file is mounted read-only; still fail closed if its bytes differ.
      const bytes = await file.readFile();
      assert(bytes.length === stat.size && crypto.createHash('sha256').update(bytes).digest('hex') === metadata.sha256,
        'Die Musik-App-Datei stimmt nicht mit der freigegebenen Version überein.', 'unconfigured', 503);
      return { bytes, metadata: { ...metadata, bytes: bytes.length, minimumAndroid: '8.0', downloadUrl: '/api/account/download/music-remote' } };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('unconfigured', 'Die separate Musik-App ist noch nicht bereitgestellt.', 503);
    } finally { await file?.close(); }
  }
  async download(req, res) {
    let file;
    try {
      file = await fs.promises.open(this.config.apkPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = await file.stat(); assert(stat.isFile() && stat.size > 0, 'Die App-Datei ist noch nicht bereitgestellt.', 'unconfigured', 503);
      res.setHeader('Content-Type', 'application/vnd.android.package-archive'); res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'attachment; filename="Crazy_Batto-App.apk"');
      res.writeHead(200);
      if (req.method === 'HEAD') { res.end(); return; }
      await pipeline(file.createReadStream({ autoClose: false }), res);
    } catch (error) { if (error instanceof AppError || res.headersSent) throw error; throw new AppError('unconfigured', 'Die App-Datei ist noch nicht bereitgestellt.', 503); }
    finally { await file?.close(); }
  }
}
