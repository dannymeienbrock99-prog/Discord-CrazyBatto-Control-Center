import { createHash } from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { randomToken, sha256 } from './store.mjs';
import { SPOTIFY_CONTROL_SCOPE, spotifyControlUrl, spotifyPlayer, spotifyControl } from './spotify-control.mjs';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const PROFILE_URL = 'https://api.spotify.com/v1/me';
const PLAY_URL = 'https://api.spotify.com/v1/me/player/play';
const SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state'];
const STATE = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_ID = /^[a-f0-9]{32}$/i;
const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{16,8192}$/.test(value);
const safeText = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';

function fields(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key)), 'Die Spotify-Angaben sind unvollständig oder enthalten unbekannte Felder.');
}
async function body(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'],
    'Bitte unkomprimierte JSON-Daten senden.', 'validation', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 16 * 1024, 'Die Anfrage ist zu groß.', 'validation', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('validation', 'Die Spotify-Anfrage enthält kein gültiges JSON.', 400); }
}
function revision(value) { assert(Number.isSafeInteger(value) && value >= 0, 'Der Spotify-Versionsstand ist ungültig.'); }
function mediaUri(value) {
  assert(typeof value === 'string' && value.length <= 1024 && !/[\s\\]/.test(value), 'Bitte einen Spotify-Link oder eine Spotify-URI angeben.');
  let match = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(value);
  if (!match) {
    let url; try { url = new URL(value); } catch { throw new AppError('validation', 'Der Spotify-Link ist ungültig.'); }
    assert(url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.port && !url.username && !url.password && !url.hash,
      'Erlaubt sind ausschließlich Links von open.spotify.com.');
    match = /^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    assert([...url.searchParams.keys()].every(key => key === 'si') && url.searchParams.getAll('si').length <= 1,
      'Der Spotify-Link enthält nicht unterstützte Zusatzangaben.');
  }
  assert(match, 'Bitte einen Spotify-Titel, ein Album oder eine Playlist wählen.');
  return { type: match[1], uri: 'spotify:' + match[1] + ':' + match[2] };
}

// All persisted credentials use the application's existing AES-GCM Vault. Each
// account owns a separate grant; application credentials never authorize playback.
export class Spotify {
  constructor(accounts, { fetchImpl = fetch } = {}) {
    this.accounts = accounts; this.store = accounts.store; this.vault = accounts.vault;
    this.config = accounts.config; this.now = accounts.now; this.fetch = fetchImpl;
    this.refreshes = new Map();
    this.store.transaction(() => this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS spotify_application (
        id INTEGER PRIMARY KEY CHECK(id=1), client_id TEXT NOT NULL, secret TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>0), updated_by TEXT NOT NULL REFERENCES accounts(id), updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spotify_user_state (
        user_id TEXT PRIMARY KEY REFERENCES accounts(id), generation INTEGER NOT NULL CHECK(generation>0));
      CREATE TABLE IF NOT EXISTS spotify_logins (
        state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        session_hash TEXT NOT NULL REFERENCES account_sessions(hash) ON DELETE CASCADE,
        generation INTEGER NOT NULL, config_revision INTEGER NOT NULL, verifier TEXT NOT NULL,
        redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS spotify_logins_user ON spotify_logins(user_id);
      CREATE TABLE IF NOT EXISTS spotify_connections (
        user_id TEXT PRIMARY KEY REFERENCES accounts(id), generation INTEGER NOT NULL,
        config_revision INTEGER NOT NULL, tokens TEXT NOT NULL, expires_at INTEGER NOT NULL, connected_at INTEGER NOT NULL);
    `));
  }
  app() { return this.store.get('SELECT * FROM spotify_application WHERE id=1'); }
  previewOnly() { return this.config.spotifyPreviewOnly === true; }
  requireLive() {
    assert(!this.previewOnly(), 'In dieser lokalen Vorschau werden keine echten Spotify-Zugangsdaten gespeichert oder Spotify-Verbindungen hergestellt.', 'spotify_preview', 503);
  }
  redirectUri() {
    try {
      const origin = new URL(this.config.publicOrigin);
      if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
      return origin.origin + '/api/spotify/callback';
    } catch { return null; }
  }
  keyReady() { return Buffer.isBuffer(this.config.encryptionKey) && this.config.encryptionKey.length === 32; }
  adminView() {
    const app = this.app(), redirectUri = this.redirectUri();
    return { clientId: app?.client_id || '', secretConfigured: !!app?.secret,
      configured: !!app?.secret && CLIENT_ID.test(app.client_id) && this.keyReady() && !!redirectUri,
      redirectUri, revision: app?.revision || 0, previewOnly: this.previewOnly() };
  }
  configured() {
    this.requireLive();
    assert(this.adminView().configured, 'Spotify muss zuerst mit App-Zugangsdaten und einer gültigen Rücksprungadresse eingerichtet werden.', 'spotify_unconfigured', 503);
    return this.app();
  }
  seal(value) {
    assert(this.keyReady(), 'Die sichere Spotify-Speicherung ist noch nicht eingerichtet.', 'spotify_unconfigured', 503);
    return JSON.stringify(this.vault.seal(value));
  }
  open(value) {
    try { return this.vault.open(JSON.parse(value)); }
    catch { throw new AppError('spotify_storage', 'Die gespeicherte Spotify-Verbindung kann nicht gelesen werden. Bitte die Einrichtung prüfen und erneut verbinden.', 503); }
  }
  assertApp(expected) {
    const app = this.configured();
    assert(app.revision === expected, 'Die Spotify-Einrichtung wurde geändert. Bitte die Seite neu laden und erneut verbinden.', 'spotify_changed', 409);
    return app;
  }
  generation(id) { return this.store.get('SELECT generation FROM spotify_user_state WHERE user_id=?', id)?.generation || 0; }
  invalidateUser(id) {
    const next = this.generation(id) + 1;
    assert(Number.isSafeInteger(next), 'Die Spotify-Verbindung kann nicht weiter geändert werden.', 'spotify_changed', 409);
    this.store.run(`INSERT INTO spotify_user_state(user_id,generation) VALUES (?,?)
      ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation`, id, next);
    this.store.run('DELETE FROM spotify_logins WHERE user_id=?', id);
    this.store.run('DELETE FROM spotify_connections WHERE user_id=?', id);
    return next;
  }
  assertGrant(userId, configRevision, generation) {
    const account = this.store.get('SELECT confirmed,suspended FROM accounts WHERE id=?', userId);
    assert(account?.confirmed && !account.suspended, 'Dieses Konto ist gesperrt oder nicht bestätigt.', 'suspended', 403);
    this.assertApp(configRevision);
    assert(this.generation(userId) === generation, 'Die Spotify-Verbindung wurde beendet oder erneuert.', 'spotify_disconnected', 409);
  }
  assertBinding(context, configRevision, generation) {
    const user = this.accounts.assertCurrent(context); this.assertGrant(user.id, configRevision, generation);
    return user;
  }
  save(context, value) {
    this.requireLive(); fields(value, ['clientId', 'clientSecret', 'expectedRevision'], ['clientId', 'expectedRevision']); revision(value.expectedRevision);
    assert(typeof value.clientId === 'string' && CLIENT_ID.test(value.clientId.trim()), 'Bitte eine gültige Spotify Client ID mit 32 Zeichen eintragen.');
    const clientId = value.clientId.trim();
    assert(value.clientSecret === undefined || typeof value.clientSecret === 'string', 'Das Spotify Client Secret ist ungültig.');
    const supplied = value.clientSecret?.trim() || '';
    assert(!supplied || /^[\x21-\x7e]{16,512}$/.test(supplied), 'Das Spotify Client Secret ist ungültig.');
    const admin = this.accounts.assertCurrent(context, { admin: true });
    this.accounts.limit('spotify:settings:' + admin.id, 10);
    return this.store.transaction(() => {
      this.accounts.assertCurrent(context, { admin: true });
      const old = this.app();
      assert((old?.revision || 0) === value.expectedRevision, 'Die Spotify-Einstellungen wurden inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      assert(supplied || (old?.client_id === clientId && old?.secret), 'Für diese Client ID muss ein Client Secret hinterlegt werden.');
      if (!supplied && old?.client_id === clientId) return this.adminView();
      const next = (old?.revision || 0) + 1; revision(next);
      const secret = this.seal({ clientSecret: supplied });
      this.store.run(`INSERT INTO spotify_application(id,client_id,secret,revision,updated_by,updated_at) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,secret=excluded.secret,revision=excluded.revision,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at`, clientId, secret, next, admin.id, this.now());
      this.store.run('DELETE FROM spotify_connections'); this.store.run('DELETE FROM spotify_logins');
      this.store.audit(admin.id, 'spotify.settings_changed', null, { revision: next }, this.now());
      return this.adminView();
    });
  }
  async request(url, options = {}) {
    this.requireLive();
    // Only fixed Spotify endpoints are allowed. User URLs never become fetch targets.
    const allowed = url === TOKEN_URL || url === PROFILE_URL || spotifyControlUrl(url);
    assert(allowed, 'Die Spotify-Anfrage ist ungültig.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await this.fetch(url, { ...options, redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', ...options.headers } });
      let size = 0; const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length; if (size > 128 * 1024) throw new Error('Oversized Spotify response.'); chunks.push(Buffer.from(chunk));
      }
      let data = null;
      if (size) { try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* No provider text is returned to clients. */ } }
      if (!response.ok) {
        let error;
        if (response.status === 429) error = new AppError('spotify_rate_limited', 'Spotify begrenzt gerade die Anfragen. Bitte etwas warten und erneut versuchen.', 429);
        else if (data?.error === 'invalid_grant') error = new AppError('spotify_reconnect', 'Die Spotify-Freigabe ist abgelaufen oder ungültig. Bitte Spotify erneut verbinden.', 409);
        else if (url === TOKEN_URL && [400, 401].includes(response.status)) error = new AppError('spotify_credentials', 'Spotify hat die Zugangsdaten oder die Verbindung nicht bestätigt. Bitte die Einrichtung prüfen.', 400);
        else if (response.status === 401) error = new AppError('spotify_reconnect', 'Die Spotify-Freigabe ist abgelaufen oder ungültig. Bitte Spotify erneut verbinden.', 409);
        else if (response.status === 403) error = new AppError('spotify_forbidden', 'Spotify erlaubt diese Aktion nicht. Bitte Spotify Premium und die Freigabe deines Kontos in der Spotify-App prüfen.', 403);
        else if (response.status === 404 && url.startsWith(PLAY_URL)) error = new AppError('spotify_device', 'Das Spotify-Wiedergabegerät ist noch nicht erreichbar. Bitte den Player aktivieren und erneut versuchen.', 409);
        else error = new AppError('spotify_unavailable', 'Spotify konnte die Anfrage gerade nicht abschließen. Bitte später erneut versuchen.', 503);
        error.spotifyInvalidGrant = data?.error === 'invalid_grant';
        throw error;
      }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('spotify_unavailable', 'Die Verbindung zu Spotify ist gerade nicht verfügbar. Bitte später erneut versuchen.', 503);
    } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  tokenData(value, previous = null) {
    assert(value && validToken(value.access_token) && String(value.token_type).toLowerCase() === 'bearer' &&
      Number.isSafeInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 86400,
    'Spotify hat keine gültige Anmeldung bestätigt.', 'spotify_response', 503);
    const refreshToken = value.refresh_token === undefined ? previous?.refreshToken : value.refresh_token;
    assert(validToken(refreshToken), 'Spotify hat keine erneuerbare Anmeldung bestätigt. Bitte erneut verbinden.', 'spotify_response', 503);
    const scope = typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : previous?.scope || [];
    assert(SCOPES.every(item => scope.includes(item)), 'Bitte alle angeforderten Spotify-Berechtigungen erlauben.', 'spotify_scope', 403);
    return { accessToken: value.access_token, refreshToken, scope, expiresAt: this.now() + value.expires_in * 1000 };
  }
  async check(context, value) {
    this.requireLive(); fields(value, ['expectedRevision']); revision(value.expectedRevision);
    const admin = this.accounts.assertCurrent(context, { admin: true }), app = this.assertApp(value.expectedRevision);
    this.accounts.limit('spotify:check:' + admin.id, 3);
    const secret = this.open(app.secret)?.clientSecret;
    assert(typeof secret === 'string' && /^[\x21-\x7e]{16,512}$/.test(secret), 'Die Spotify-App-Zugangsdaten müssen erneut hinterlegt werden.', 'spotify_storage', 503);
    const response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(app.client_id + ':' + secret).toString('base64') }, body: new URLSearchParams({ grant_type: 'client_credentials' }).toString() });
    this.accounts.assertCurrent(context, { admin: true }); this.assertApp(app.revision);
    assert(validToken(response.data?.access_token) && String(response.data?.token_type).toLowerCase() === 'bearer',
      'Spotify hat die App-Zugangsdaten nicht bestätigt.', 'spotify_response', 503);
    // Discard the application token: it is never stored or used for any user.
    const checkedAt = this.now();
    this.store.audit(admin.id, 'spotify.credentials_checked', null, { revision: app.revision }, checkedAt);
    return { ok: true, checkedAt, revision: app.revision,
      message: 'Spotify hat die App-Zugangsdaten bestätigt. Die persönliche Spotify-Verbindung und Wiedergabe werden separat eingerichtet.' };
  }
  status(context) {
    const user = this.accounts.assertCurrent(context), app = this.adminView();
    const row = this.store.get('SELECT * FROM spotify_connections WHERE user_id=?', user.id);
    const connected = app.configured && !!row && row.config_revision === app.revision && row.generation === this.generation(user.id);
    const grant = connected ? this.open(row.tokens) : null;
    return { configured: app.configured, connected, spotifyUser: grant?.profile || null,
      controllerReady: connected && Array.isArray(grant?.scope) && grant.scope.includes(SPOTIFY_CONTROL_SCOPE),
      reconnectRequired: connected && !grant?.scope?.includes(SPOTIFY_CONTROL_SCOPE),
      expiresAt: connected ? row.expires_at : null, previewOnly: this.previewOnly() };
  }
  connect(context, value) {
    this.requireLive(); fields(value, []);
    const user = this.accounts.assertCurrent(context), app = this.configured();
    assert(context.session.kind === 'browser', 'Bitte Spotify auf der Website mit deinem angemeldeten Browser verbinden.', 'spotify_browser', 403);
    this.accounts.limit('spotify:connect:' + user.id, 10, 10 * 60_000);
    const state = randomToken(), verifier = randomToken(64), redirectUri = this.redirectUri(), expiresAt = this.now() + 10 * 60_000;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.store.transaction(() => {
      this.accounts.assertCurrent(context); this.assertApp(app.revision);
      this.store.run('DELETE FROM spotify_logins WHERE expires_at<=?', this.now());
      const generation = this.invalidateUser(user.id);
      this.store.run('INSERT INTO spotify_logins VALUES (?,?,?,?,?,?,?,?)', sha256(state), user.id, context.session.hash,
        generation, app.revision, this.seal({ verifier }), redirectUri, expiresAt);
    });
    const params = new URLSearchParams({ client_id: app.client_id, response_type: 'code', redirect_uri: redirectUri,
      scope: [...SCOPES,SPOTIFY_CONTROL_SCOPE].join(' '), state, code_challenge_method: 'S256', code_challenge: challenge, show_dialog: 'true' });
    return { authorizationUrl: 'https://accounts.spotify.com/authorize?' + params.toString(), expiresAt };
  }
  async callback(req, res, url) {
    // No raw provider errors or callback parameters are echoed into a page or log.
    res.setHeader('Referrer-Policy', 'no-referrer'); let outcome = 'error';
    try {
      this.requireLive();
      const context = await this.accounts.authenticateRequest(req), user = this.accounts.assertCurrent(context);
      assert(context.session.kind === 'browser', 'Ungültige Spotify-Browseranmeldung.', 'spotify_state', 400);
      assert(url.searchParams.getAll('state').length === 1 && STATE.test(url.searchParams.get('state') || ''), 'Ungültige Spotify-Anmeldung.', 'spotify_state', 400);
      const login = this.store.transaction(() => {
        const row = this.store.get('SELECT * FROM spotify_logins WHERE state_hash=?', sha256(url.searchParams.get('state')));
        assert(row && row.user_id === user.id && row.session_hash === context.session.hash && row.expires_at > this.now(), 'Die Spotify-Anmeldung ist abgelaufen.', 'spotify_state', 400);
        this.assertBinding(context, row.config_revision, row.generation);
        this.store.run('DELETE FROM spotify_logins WHERE state_hash=?', row.state_hash); return row;
      });
      assert(!url.searchParams.has('error') && url.searchParams.getAll('code').length === 1,
        'Die Spotify-Verbindung wurde nicht bestätigt.', 'spotify_state', 400);
      const code = url.searchParams.get('code');
      assert(typeof code === 'string' && /^[\x21-\x7e]{8,4096}$/.test(code), 'Ungültige Spotify-Bestätigung.', 'spotify_state', 400);
      const app = this.assertApp(login.config_revision), verifier = this.open(login.verifier)?.verifier;
      assert(typeof verifier === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(verifier), 'Ungültige Spotify-Anmeldung.', 'spotify_state', 400);
      const response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: app.client_id, code,
          redirect_uri: login.redirect_uri, code_verifier: verifier }).toString() });
      this.assertBinding(context, login.config_revision, login.generation);
      const grant = this.tokenData(response.data);
      const profileResponse = await this.request(PROFILE_URL, { headers: { Authorization: 'Bearer ' + grant.accessToken } });
      this.assertBinding(context, login.config_revision, login.generation);
      const raw = profileResponse.data, id = safeText(raw?.id, 256);
      assert(id && typeof raw?.id === 'string' && raw.id.length <= 256, 'Spotify hat kein gültiges Benutzerkonto bestätigt.', 'spotify_response', 503);
      grant.profile = { id, displayName: safeText(raw.display_name, 128) || id,
        product: ['premium', 'free', 'open'].includes(raw.product) ? raw.product : null };
      this.store.transaction(() => {
        this.assertBinding(context, login.config_revision, login.generation);
        this.store.run(`INSERT INTO spotify_connections(user_id,generation,config_revision,tokens,expires_at,connected_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,config_revision=excluded.config_revision,
          tokens=excluded.tokens,expires_at=excluded.expires_at,connected_at=excluded.connected_at`,
        user.id, login.generation, login.config_revision, this.seal(grant), grant.expiresAt, this.now());
        this.store.audit(user.id, 'spotify.connected', null, { revision: login.config_revision }, this.now());
      });
      outcome = 'connected';
    } catch { /* Fixed local redirect even for revoked sessions, rejected consent or provider failures. */ }
    res.writeHead(303, { Location: '/media-player.html?spotify=' + outcome }); res.end(); return true;
  }
  async refresh(context, row) {
    this.assertBinding(context, row.config_revision, row.generation);
    const app = this.assertApp(row.config_revision), previous = this.open(row.tokens);
    assert(validToken(previous.refreshToken), 'Bitte Spotify erneut verbinden.', 'spotify_reconnect', 409);
    let response;
    try {
      response = await this.request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: app.client_id, refresh_token: previous.refreshToken }).toString() });
    } catch (error) {
      if (error.spotifyInvalidGrant) this.store.run('DELETE FROM spotify_connections WHERE user_id=? AND generation=? AND config_revision=?', row.user_id, row.generation, row.config_revision);
      throw error;
    }
    // A refresh is shared across this account's sessions. Preserve a rotated
    // refresh token if its initiating session logged out in flight; each caller
    // still rechecks its own session before any access token leaves the server.
    this.assertGrant(row.user_id, row.config_revision, row.generation);
    const grant = { ...this.tokenData(response.data, previous), profile: previous.profile };
    const updated = this.store.run('UPDATE spotify_connections SET tokens=?,expires_at=? WHERE user_id=? AND generation=? AND config_revision=?',
      this.seal(grant), grant.expiresAt, row.user_id, row.generation, row.config_revision);
    assert(Number(updated.changes) === 1, 'Die Spotify-Verbindung wurde beendet.', 'spotify_disconnected', 409);
  }
  async access(context) {
    const user = this.accounts.assertCurrent(context), app = this.configured();
    let row = this.store.get('SELECT * FROM spotify_connections WHERE user_id=?', user.id);
    assert(row && row.config_revision === app.revision && row.generation === this.generation(user.id), 'Bitte dein Spotify-Konto zuerst verbinden.', 'spotify_disconnected', 409);
    if (row.expires_at <= this.now() + 60_000) {
      const key = user.id + ':' + row.config_revision + ':' + row.generation;
      if (!this.refreshes.has(key)) {
        const work = this.refresh(context, row); this.refreshes.set(key, work);
        work.finally(() => { if (this.refreshes.get(key) === work) this.refreshes.delete(key); }).catch(() => {});
      }
      await this.refreshes.get(key);
      this.assertBinding(context, row.config_revision, row.generation);
      row = this.store.get('SELECT * FROM spotify_connections WHERE user_id=?', user.id);
    }
    assert(row, 'Die Spotify-Verbindung wurde beendet.', 'spotify_disconnected', 409);
    this.assertBinding(context, row.config_revision, row.generation);
    const grant = this.open(row.tokens);
    assert(validToken(grant.accessToken) && row.expires_at > this.now(), 'Bitte Spotify erneut verbinden.', 'spotify_reconnect', 409);
    return { accessToken: grant.accessToken, expiresAt: row.expires_at, generation: row.generation, configRevision: row.config_revision };
  }
  disconnect(context, value) {
    fields(value, []); const user = this.accounts.assertCurrent(context);
    this.store.transaction(() => {
      this.accounts.assertCurrent(context); this.invalidateUser(user.id);
      this.store.audit(user.id, 'spotify.disconnected', null, {}, this.now());
    });
    return { ok: true };
  }
  async play(context, value) {
    this.requireLive(); fields(value, ['uri', 'deviceId']);
    const media = mediaUri(value.uri);
    assert(typeof value.deviceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.deviceId), 'Bitte zuerst das Spotify-Wiedergabegerät verbinden.');
    const user = this.accounts.assertCurrent(context); this.accounts.limit('spotify:play:' + user.id, 30);
    const token = await this.access(context);
    this.assertBinding(context, token.configRevision, token.generation);
    await this.request(PLAY_URL + '?device_id=' + encodeURIComponent(value.deviceId), { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token.accessToken },
      body: JSON.stringify(media.type === 'track' ? { uris: [media.uri] } : { context_uri: media.uri }) });
    this.assertBinding(context, token.configRevision, token.generation);
    return { ok: true };
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://local.invalid'), route = url.pathname;
    if (req.method === 'GET' && route === '/api/spotify/callback') return await this.callback(req, res, url);
    const admin = route === '/api/admin/spotify' || route.startsWith('/api/admin/spotify/');
    const mutation = !['GET', 'HEAD'].includes(req.method);
    const context = await this.accounts.authenticateRequest(req, { mutation, requireAdmin: admin });
    const send = value => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); return true; };
    if (mutation && route !== '/api/spotify/disconnect') this.requireLive();
    if (route === '/api/admin/spotify') {
      if (req.method === 'GET') { this.accounts.assertCurrent(context, { admin: true }); return send(this.adminView()); }
      if (req.method === 'PUT') return send(this.save(context, await body(req)));
    }
    if (req.method === 'POST' && route === '/api/admin/spotify/check-credentials') return send(await this.check(context, await body(req)));
    if (req.method === 'GET' && route === '/api/spotify/status') return send(this.status(context));
    if (req.method === 'GET' && route === '/api/spotify/player') return send(await spotifyPlayer(this,context));
    if (req.method === 'POST' && route === '/api/spotify/control') return send(await spotifyControl(this,context,await body(req)));
    if (req.method === 'POST' && route === '/api/spotify/connect') return send(this.connect(context, await body(req)));
    if (req.method === 'POST' && route === '/api/spotify/disconnect') return send(this.disconnect(context, await body(req)));
    if (req.method === 'POST' && route === '/api/spotify/play') return send(await this.play(context, await body(req)));
    if (req.method === 'POST' && route === '/api/spotify/token') {
      fields(await body(req), []); const user = this.accounts.assertCurrent(context);
      this.accounts.limit('spotify:token:' + user.id, 60);
      const token = await this.access(context); this.assertBinding(context, token.configRevision, token.generation);
      return send({ accessToken: token.accessToken, expiresAt: token.expiresAt });
    }
    throw new AppError('not_found', 'Diese Spotify-Funktion ist nicht vorhanden.', 404);
  }
}
