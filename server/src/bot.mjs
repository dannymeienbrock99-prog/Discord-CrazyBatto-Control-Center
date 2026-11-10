import crypto from 'node:crypto';
import { AppError, assert, safeMessage } from './errors.mjs';
import { readBody, parseJson } from './multipart.mjs';

export const BOT_COMMANDS = Object.freeze([
  { name: 'geburtstage', description: 'Gemeinsamer Geburtstagskalender von Crazy_Batto', type: 1 },
  { name: 'batto', description: 'Crazy_Batto Webseite und App öffnen', type: 1 },
  { name: 'musik', description: 'Musik aus der Crazy_Batto Bibliothek im Sprachkanal abspielen', type: 1, options: [
    { type: 3, name: 'aktion', description: 'Player öffnen oder Musik steuern', choices: [
      { name: 'Webplayer öffnen', value: 'player' }, { name: 'Abspielen', value: 'play' },
      { name: 'Pause', value: 'pause' }, { name: 'Fortsetzen', value: 'fortsetzen' },
      { name: 'Nächster Titel', value: 'weiter' }, { name: 'Stoppen', value: 'stop' }, { name: 'Warteschlange', value: 'liste' }] },
    { type: 3, name: 'playlist', description: 'Playlist-Name aus dem Webplayer, sonst alle Titel', max_length: 80 },
    { type: 4, name: 'nummer', description: 'Startnummer des Titels', min_value: 1, max_value: 500 }
  ] },
  { name: 'zugang', description: 'Mit E-Mail registrieren und App-Zugang beantragen', type: 1 },
]);

export class BotService {
  constructor(service, { now = Date.now } = {}) {
    this.service = service; this.config = service.config; this.now = now;
    this.check = null; this.registering = false;
  }
  settings() {
    const raw = this.service.accounts.store.setting('bot_settings');
    if (!raw) return { enabled: false, commandIds: {}, registeredAt: null };
    try { return JSON.parse(raw); } catch { throw new AppError('unconfigured', 'Die Bot-Einstellungen konnten nicht gelesen werden.', 503); }
  }
  status() {
    const configured = !!this.config.botToken && /^\d{17,20}$/.test(this.config.clientId) && /^[a-f\d]{64}$/i.test(this.config.discordPublicKey) && /^\d{17,20}$/.test(this.config.discordGuildId) && !!this.config.publicOrigin;
    const settings = this.settings();
    return { configured, enabled: settings.enabled === true, guildId: this.config.discordGuildId,
      registeredAt: settings.registeredAt, commands: BOT_COMMANDS.map(c => '/' + c.name),
      music: this.service.musicBot?.status() || { configured: false }, connection: this.check, presence: this.service.botGateway?.status() || null,
      endpoint: this.config.publicOrigin ? this.config.publicOrigin + '/discord/interactions' : null,
      message: !configured ? 'Bot-Zugangsdaten und öffentlicher Discord-Prüfschlüssel müssen auf dem Server ergänzt werden.'
        : settings.enabled && settings.registeredAt ? 'Die Community-Befehle sind eingerichtet und eingeschaltet.'
        : settings.registeredAt ? 'Die Community-Befehle sind eingerichtet und derzeit ausgeschaltet.'
        : 'Konfiguration vorhanden. Verbindung prüfen und Befehle einrichten.' };
  }
  ready() { assert(this.status().configured, this.status().message, 'unconfigured', 503); }
  async verifyConnection() {
    this.ready();
    const app = await this.service.discord.request('GET', '/oauth2/applications/@me');
    assert(app?.id === this.config.clientId, 'Bot-Token und Anwendungs-ID gehören nicht zusammen.', 'unconfigured', 503);
    const guild = await this.service.discord.request('GET', '/guilds/' + this.config.discordGuildId);
    assert(guild?.id === this.config.discordGuildId, 'Der Bot ist auf diesem Discord-Server nicht erreichbar.', 'unconfigured', 503);
    this.check = { online: true, name: String(guild.name || '').slice(0, 100), checkedAt: this.now() };
    return this.status();
  }
  async register(req) {
    assert(!this.registering, 'Die Befehle werden bereits eingerichtet.', 'conflict', 409);
    this.registering = true;
    try {
      await this.verifyConnection();
      const ids = {};
      // Per-name upserts preserve unrelated commands already owned by this bot.
      for (const command of BOT_COMMANDS) {
        await this.service.accounts.authorizeAdmin(req);
        const result = await this.service.discord.request('POST', '/applications/' + this.config.clientId + '/guilds/' + this.config.discordGuildId + '/commands', { payload: command });
        assert(/^\d{17,20}$/.test(result?.id || '') && result.name === command.name, 'Discord hat die Einrichtung nicht bestätigt. Bitte Status prüfen.', 'uncertain', 502);
        ids[command.name] = result.id;
      }
      const auth = await this.service.accounts.authorizeAdmin(req);
      this.service.accounts.store.transaction(() => {
        this.service.accounts.store.setSetting('bot_settings', JSON.stringify({ ...this.settings(), commandIds: ids, registeredAt: this.now() }));
        this.service.accounts.store.audit(auth.user.id, 'bot.commands', this.config.discordGuildId, { names: BOT_COMMANDS.map(c => c.name) });
      });
      return this.status();
    } finally { this.registering = false; }
  }
  interaction(bytes, headers) {
    const signature = headers['x-signature-ed25519'], timestamp = headers['x-signature-timestamp'];
    assert(/^[a-f\d]{64}$/i.test(this.config.discordPublicKey || ''), 'Discord-Prüfschlüssel fehlt.', 'unconfigured', 503);
    assert(typeof timestamp === 'string' && /^\d{10}$/.test(timestamp) && Math.abs(this.now() / 1000 - Number(timestamp)) <= 300 && typeof signature === 'string' && /^[a-f\d]{128}$/i.test(signature), 'Ungültige Discord-Signatur.', 'signature', 401);
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(this.config.discordPublicKey, 'hex')]), format: 'der', type: 'spki' });
    assert(crypto.verify(null, Buffer.concat([Buffer.from(timestamp), bytes]), key, Buffer.from(signature, 'hex')), 'Ungültige Discord-Signatur.', 'signature', 401);
    const data = parseJson(bytes);
    assert(data.application_id === this.config.clientId, 'Falsche Discord-Anwendung.', 'forbidden', 403);
    if (data.type === 1) return { type: 1 };
    const devices = this.service.deviceRoles?.interaction(data);
    if (devices) return devices;
    const community = this.service.communityControl?.interaction(data);
    if (community) return community;
    assert(data.type === 2 && data.data?.type === 1, 'Dieser Discord-Befehl wird nicht unterstützt.', 'validation', 400);
    const settings = this.settings(), name = data.data.name;
    let content = 'Dieser Bot-Bereich ist derzeit ausgeschaltet.';
    if (settings.enabled && data.guild_id === this.config.discordGuildId && settings.commandIds[name] === data.data.id && BOT_COMMANDS.some(command => command.name === name)) {
      if (name === 'musik' && data.data.options?.some(option => option.name === 'aktion' && option.value !== 'player')) {
        assert(this.service.musicBot, 'Der Musikbot ist noch nicht eingerichtet.', 'unconfigured', 503);
        assert(/^\d{17,20}$/.test(data.id || '') && typeof data.token === 'string' && /^[A-Za-z0-9_.-]{20,512}$/.test(data.token), 'Ungültiger Musikbefehl.');
        setImmediate(() => this.service.musicBot.accept(data));
        return { type: 5, data: { flags: 64 } };
      }
      if (name === 'geburtstage') {
        const calendar = this.service.birthdays?.calendar();
        const entries = (calendar?.entries || []).slice(0, 12);
        const safeName = name => String(name).replace(/[@<>*_~`|\\]/g, '').slice(0, 80);
        const lines = entries.map(entry => safeName(entry.name) + ' · ' + String(entry.day).padStart(2, '0') + '.' + String(entry.month).padStart(2, '0') + '. · ' + (entry.daysUntil === 0 ? 'heute 🎉' : 'in ' + entry.daysUntil + ' Tagen'));
        content = '**Geburtstagskalender**\n' + (lines.length ? lines.join('\n') : 'Noch keine freigegebenen Geburtstage.') + '\n\nAlle Geburtstage und deinen Eintrag verwalten: ' + this.config.publicOrigin + '/geburtstage.html';
        return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
      }
      const links = { batto: ['Crazy_Batto Webseite', '/'], musik: ['Musikplayer öffnen', '/media-player.html'], zugang: ['Mit Name, E-Mail und Passwort registrieren und Zugang beantragen', '/registrierung.html'] };
      content = links[name][0] + ': ' + this.config.publicOrigin + links[name][1];
    }
    return { type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } };
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://local.invalid').pathname;
    if (route !== '/discord/interactions' && !route.startsWith('/api/admin/bot')) return false;
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (route === '/discord/interactions') {
        assert(req.method === 'POST', 'Nur Discord-POST-Anfragen sind zulässig.', 'validation', 405);
        send(this.interaction(await readBody(req, 64 * 1024), req.headers)); return true;
      }
      const auth = await this.service.accounts.authorizeAdmin(req);
      this.service.accounts.limit('bot:' + auth.user.id, 20);
      if (req.method === 'GET' && route === '/api/admin/bot') { send(this.status()); return true; }
      if (req.method === 'POST' && route === '/api/admin/bot/check') { send(await this.verifyConnection()); return true; }
      if (req.method === 'POST' && route === '/api/admin/bot/commands') { send(await this.register(req)); return true; }
      if (req.method === 'PUT' && route === '/api/admin/bot') {
        const body = parseJson(await readBody(req, 4096));
        assert(typeof body.enabled === 'boolean', 'Bitte den Bot-Bereich ein- oder ausschalten.');
        if (body.enabled) { this.ready(); assert(BOT_COMMANDS.every(command => /^\d{17,20}$/.test(this.settings().commandIds[command.name] || '')), 'Bitte zuerst die Bot-Befehle einrichten.', 'unconfigured', 503); }
        const current = await this.service.accounts.authorizeAdmin(req);
        this.service.accounts.store.transaction(() => {
          this.service.accounts.store.setSetting('bot_settings', JSON.stringify({ ...this.settings(), enabled: body.enabled }));
          this.service.accounts.store.audit(current.user.id, 'bot.enabled', this.config.discordGuildId, { enabled: body.enabled });
        });
        if (!body.enabled) this.service.musicBot?.stop();
        send(this.status()); return true;
      }
      throw new AppError('not_found', 'Diese Bot-Aktion ist nicht vorhanden.', 404);
    } catch (error) {
      if (route.endsWith('/check')) this.check = { online: false, checkedAt: this.now() };
      send({ error: { code: error instanceof AppError ? error.kind : 'network', message: error instanceof AppError ? safeMessage(error.message) : 'Die Bot-Aktion konnte nicht abgeschlossen werden.' } }, error instanceof AppError ? error.status : 500);
      return true;
    }
  }
}
