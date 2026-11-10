import { AppError, assert, safeMessage } from './errors.mjs';
import { randomToken, sha256 } from './store.mjs';
import { readBody, parseJson } from './multipart.mjs';
import { musicTrack } from './music-bot.mjs';
import { validId } from './payloads.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = ['join', 'play', 'queue', 'pause', 'resume', 'next', 'previous', 'stop', 'volume'];
const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);

// The remote has its own email-bound Discord connection. Discord credentials,
// device verifiers and app-session tokens never reach the browser/WebView.
export class MusicRemote {
  constructor(service) {
    this.service = service; this.accounts = service.accounts; this.store = this.accounts.store;
    this.vault = this.accounts.vault; this.now = service.now;
    this.storageValue = null; this.storageUntil = 0; this.storagePending = null;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS music_remote_links (
        user_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        discord_user_id TEXT NOT NULL, session_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL, linked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS music_remote_logins (
        session_hash TEXT PRIMARY KEY REFERENCES account_sessions(hash) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        login_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS music_remote_logins_user ON music_remote_logins(user_id);
    `);
  }
  current(auth, { approved = true } = {}) {
    const user = this.accounts.assertCurrent(auth);
    if (approved) this.accounts.appAllowed(user, 'discord-app');
    return user;
  }
  linked(userId) {
    const row = this.store.get('SELECT * FROM music_remote_links WHERE user_id=?', userId);
    if (!row || row.expires_at <= this.now()) return null;
    try {
      const session = this.service.auth.session(this.vault.open(JSON.parse(row.session_token)));
      if (session.userId !== row.discord_user_id) return null;
      return { row, session };
    } catch { return null; }
  }
  discordView(link) {
    return link ? { linked: true, user: { id: link.session.user.id, username: link.session.user.username, displayName: link.session.user.displayName }, expiresAt: link.session.expiresAt }
      : { linked: false, user: null, expiresAt: null };
  }
  pendingLink(auth) {
    const row = this.store.get('SELECT * FROM music_remote_logins WHERE session_hash=? AND user_id=?', auth.session.hash, auth.user.id);
    if (!row) return null;
    const login = this.service.store.data.logins[row.login_id];
    if (row.expires_at <= this.now() || !login || ['cancelled', 'failed'].includes(login.status)) {
      this.cancelLogin(auth); return null;
    }
    return { authorizePath: '/oauth/start/' + row.login_id, displayCode: login.displayCode,
      expiresAt: row.expires_at, intervalMs: 3000, status: login.status === 'pending' ? 'pending' : 'authorized' };
  }
  cancelLogin(auth) {
    const row = this.store.get('SELECT * FROM music_remote_logins WHERE session_hash=?', auth.session.hash);
    if (!row) return;
    try { this.service.auth.cancel(row.login_id, this.vault.open(JSON.parse(row.verifier))); } catch { /* An expired login is already unusable. */ }
    this.store.run('DELETE FROM music_remote_logins WHERE session_hash=?', auth.session.hash);
  }
  startLink(auth) {
    this.current(auth); this.cancelLogin(auth);
    this.store.run('DELETE FROM music_remote_logins WHERE expires_at<=?', this.now());
    const verifier = randomToken(48), start = this.service.auth.start(sha256(verifier));
    this.store.run('INSERT INTO music_remote_logins VALUES (?,?,?,?,?)', auth.session.hash, auth.user.id, start.loginId,
      JSON.stringify(this.vault.seal(verifier)), start.expiresAt);
    return { ok: true, authorizePath: start.authorizePath, displayCode: start.displayCode, expiresAt: start.expiresAt, intervalMs: start.intervalMs };
  }
  pollLink(auth) {
    this.current(auth);
    const pending = this.store.get('SELECT * FROM music_remote_logins WHERE session_hash=? AND user_id=?', auth.session.hash, auth.user.id);
    if (!pending) {
      const link = this.linked(auth.user.id);
      assert(link, 'Bitte die Discord-Verbindung erneut starten.', 'link_expired', 409);
      return { ok: true, status: 'authorized', discord: this.discordView(link) };
    }
    assert(pending.expires_at > this.now(), 'Die Discord-Verbindung ist abgelaufen. Bitte erneut starten.', 'link_expired', 409);
    const result = this.service.auth.poll(pending.login_id, this.vault.open(JSON.parse(pending.verifier)));
    if (result.status !== 'authorized') return { ok: true, status: 'pending', intervalMs: result.intervalMs || 3000 };
    this.current(auth);
    const previous = this.linked(auth.user.id);
    const token = JSON.stringify(this.vault.seal(result.sessionToken));
    this.store.transaction(() => {
      this.store.run(`INSERT INTO music_remote_links VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
        discord_user_id=excluded.discord_user_id,session_token=excluded.session_token,expires_at=excluded.expires_at,linked_at=excluded.linked_at`,
      auth.user.id, result.user.id, token, result.expiresAt, this.now());
      this.store.run('DELETE FROM music_remote_logins WHERE session_hash=?', auth.session.hash);
      this.store.audit(auth.user.id, 'music-remote.link', result.user.id);
    });
    if (previous && previous.session.hash !== sha256(result.sessionToken)) this.service.auth.logout(previous.session);
    return { ok: true, status: 'authorized', discord: this.discordView(this.linked(auth.user.id)) };
  }
  unlink(auth) {
    this.current(auth, { approved: false });
    const pending = this.store.all('SELECT * FROM music_remote_logins WHERE user_id=?', auth.user.id);
    for (const row of pending) {
      try { this.service.auth.cancel(row.login_id, this.vault.open(JSON.parse(row.verifier))); } catch { /* Expired or cancelled already. */ }
    }
    this.store.run('DELETE FROM music_remote_logins WHERE user_id=?', auth.user.id);
    const link = this.linked(auth.user.id);
    this.store.run('DELETE FROM music_remote_links WHERE user_id=?', auth.user.id);
    if (link) this.service.auth.logout(link.session);
    this.store.audit(auth.user.id, 'music-remote.unlink', link?.session.userId);
    return { ok: true, discord: this.discordView(null) };
  }
  async storageStatus() {
    if (this.storageValue && this.storageUntil > this.now()) return this.storageValue;
    if (!this.storagePending) this.storagePending = this.accounts.storageStatus().then(value => {
      this.storageValue = value; this.storageUntil = this.now() + 15_000; return value;
    }).finally(() => { this.storagePending = null; });
    return this.storagePending;
  }
  async view(auth) {
    const user = this.current(auth, { approved: false });
    let approved = true;
    try { this.accounts.appAllowed(user, 'discord-app'); } catch { approved = false; }
    let link = this.linked(user.id);
    const bot = this.service.musicBot;
    let status = bot.status(), gateway = this.service.botGateway.status(), voiceContext = null;
    let guild = { id: this.service.config.discordGuildId || null, name: this.service.botAdmin.check?.name || null, singleGuild: true };
    let voice = { channels: [], channel: null, permissions: { canControl: false, reason: 'Bitte dein Discord-Konto verbinden.', voiceChannelId: null } };
    const storage = approved ? await this.storageStatus() : { configured: !!this.accounts.storage.configured, online: false, message: 'Bitte zuerst den App-Zugang freigeben lassen.' };
    if (approved && link && status.configured && gateway.ready) {
      try {
        const context = await bot.voiceContext(link.session.userId); voiceContext = context;
        guild = { id: context.guild.id, name: clean(context.guild.name), singleGuild: true };
        voice = bot.voiceView(context, link.session.userId);
      } catch (error) {
        voice.permissions.reason = error instanceof AppError && !['auth', 'not_found'].includes(error.kind) ? safeMessage(error.message)
          : 'Dein Discord-Konto oder der Bot hat keinen Zugriff auf den eingerichteten Server. Bitte Mitgliedschaft und Bot-Rechte prüfen.';
      }
    }
    // Storage/Discord reads yield. An unlink, relink or playback command may
    // finish meanwhile; never overwrite its result with the earlier snapshot.
    const latestLink = this.linked(user.id);
    if (latestLink?.session.hash !== link?.session.hash) {
      link = latestLink; voiceContext = null;
      voice = { channels: [], channel: null, permissions: { canControl: false, reason: 'Die Discord-Verbindung wurde geändert. Bitte die Anzeige aktualisieren.', voiceChannelId: null } };
    } else if (voiceContext) voice = bot.voiceView(voiceContext, link.session.userId);
    status = bot.status(); gateway = this.service.botGateway.status();
    const reason = !approved ? 'Dein Zugang zur Discord-App muss zuerst vom Betreiber freigegeben werden.'
      : !link ? 'Bitte dein Discord-Konto verbinden.'
      : !status.configured ? 'Die Musikwiedergabe muss zuerst auf dem Server eingerichtet werden.'
      : !status.enabled ? 'Der Musikbot ist im Adminbereich ausgeschaltet.'
      : !gateway.ready ? gateway.message : voice.permissions.reason;
    const all = approved ? this.accounts.playlists.tracks('all') : [];
    const tracks = all.slice(0, 2000).map(musicTrack), ids = new Set(tracks.map(track => track.id));
    const playlists = [{ id: 'all', name: 'Alle Titel', trackIds: tracks.map(track => track.id), count: all.length },
      ...(approved ? this.accounts.playlists.list().map(item => ({ id: item.id, name: clean(item.name), trackIds: item.trackIds.filter(id => ids.has(id)), count: item.trackIds.length })) : [])];
    this.current(auth, { approved });
    return { ok: true, csrfToken: auth.csrfToken, user: { id: user.id, name: user.name }, approved,
      discord: this.discordView(link), link: this.pendingLink(auth), guild, bot: { ...status, gateway },
      permissions: { ...voice.permissions, canControl: !reason, reason: reason || null },
      channel: voice.channel, channels: voice.channels,
      library: { tracks, playlists, truncated: all.length > tracks.length }, queue: approved ? bot.queueView() : [], storage };
  }
  validateControl(body) {
    assert(body && typeof body === 'object' && !Array.isArray(body) && ACTIONS.includes(body.action), 'Bitte eine gültige Musikaktion auswählen.');
    const fields = ['action', 'channelId', ...(['play', 'queue'].includes(body.action) ? ['playlistId', 'trackId'] : body.action === 'volume' ? ['volume'] : [])];
    assert(Object.keys(body).every(key => fields.includes(key)), 'Die Musikaktion enthält unbekannte Angaben.');
    if (body.channelId !== undefined) assert(validId(body.channelId), 'Bitte einen gültigen Sprachkanal auswählen.');
    if (body.playlistId !== undefined) assert(body.playlistId === 'all' || UUID.test(body.playlistId), 'Diese Playlist ist ungültig.');
    if (body.trackId !== undefined) assert(typeof body.trackId === 'string' && UUID.test(body.trackId), 'Dieser Musiktitel ist ungültig.');
    if (body.action === 'volume') assert(Number.isInteger(body.volume) && body.volume >= 0 && body.volume <= 100, 'Bitte eine Lautstärke zwischen 0 und 100 wählen.');
    return body;
  }
  async control(auth, body) {
    this.current(auth); this.validateControl(body);
    const link = this.linked(auth.user.id);
    assert(link, 'Bitte zuerst dein Discord-Konto verbinden.', 'discord_link', 403);
    const authorize = () => {
      this.current(auth);
      const current = this.linked(auth.user.id);
      assert(current && current.session.hash === link.session.hash, 'Die Discord-Verbindung wurde beendet oder gewechselt. Bitte neu laden.', 'discord_link', 403);
    };
    const message = await this.service.musicBot.enqueue(() => this.service.musicBot.control(link.session.userId, body, authorize));
    authorize();
    return { ok: true, message, bot: this.service.musicBot.status(), queue: this.service.musicBot.queueView() };
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://local.invalid').pathname;
    if (route !== '/api/music-remote' && !route.startsWith('/api/music-remote/')) return false;
    const send = (body, status = 200) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Cookie, Authorization');
    try {
      const forwarded = this.service.config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
      const remote = forwarded || req.socket?.remoteAddress || 'unknown';
      this.accounts.limit('music-remote-ip:' + remote, 180);
      const mutation = !['GET', 'HEAD'].includes(req.method);
      const auth = await this.accounts.authenticateRequest(req, { mutation });
      this.accounts.limit('music-remote-user:' + auth.user.id, 90);
      if (route === '/api/music-remote' && req.method === 'GET') { send(await this.view(auth)); return true; }
      if (route === '/api/music-remote/link' && req.method === 'DELETE') { send(this.unlink(auth)); return true; }
      assert(req.method === 'POST', 'Diese Musikaktion unterstützt die angegebene Methode nicht.', 'validation', 405);
      assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte unkomprimierte JSON-Daten senden.', 'validation', 415);
      const body = parseJson(await readBody(req, 4096));
      if (route === '/api/music-remote/control') {
        this.accounts.limit('music-remote-control:' + auth.user.id, 30); send(await this.control(auth, body)); return true;
      }
      assert(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0, 'Diese Verbindung benötigt keine weiteren Angaben.');
      if (route === '/api/music-remote/link/start') {
        this.accounts.limit('music-remote-link:' + auth.user.id, 8, 10 * 60_000); send(this.startLink(auth)); return true;
      }
      if (route === '/api/music-remote/link/poll') { send(this.pollLink(auth)); return true; }
      if (route === '/api/music-remote/link/cancel') { this.current(auth, { approved: false }); this.cancelLogin(auth); send({ ok: true }); return true; }
      throw new AppError('not_found', 'Diese Musikfunktion ist nicht vorhanden.', 404);
    } catch (error) {
      send({ ok: false, error: { code: error instanceof AppError ? error.kind : 'network', message: error instanceof AppError ? safeMessage(error.message) : 'Die Musiksteuerung ist gerade nicht erreichbar. Bitte erneut versuchen.' } }, error instanceof AppError ? error.status : 500);
      return true;
    }
  }
}
