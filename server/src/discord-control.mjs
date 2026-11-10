import { AdminService } from './discord-control-lib/service.cjs';
import { DiscordClient, DiscordError } from './discord-control-lib/discord-client.cjs';
import { object, id } from './discord-control-lib/validation.cjs';
import { COMMUNITY_ACTIONS } from './community-schema.mjs';
import { CROWN_ACTIONS } from './admin-crowns.mjs';
import { DEVICE_ROLE_ACTIONS } from './device-roles.mjs';
import { GAMING_SETUP_ACTIONS } from './gaming-setups.mjs';
import { SETUP_PANEL_ACTIONS } from './setup-panel.mjs';
import { JOIN_ROLE_ACTIONS } from './join-role.mjs';
import { EXTRA_ACTIONS } from './control-extras.mjs';
import { AppError, safeMessage } from './errors.mjs';

export const EXPECTED_BOT_ID = process.env.DISCORD_CLIENT_ID || '900000000000000002';
export const PREFIX = '/api/admin/discord-control';
export const ACTIONS = Object.freeze([
  'guild.load', 'message.send', 'guild.update', 'channel.create', 'channel.update',
  'role.create', 'role.update', 'bot.profile', 'event.create', 'log.list',
  ...COMMUNITY_ACTIONS, 'tiktok.state', 'tiktok.save', 'tiktok.check',
  ...CROWN_ACTIONS, ...DEVICE_ROLE_ACTIONS, ...GAMING_SETUP_ACTIONS, ...SETUP_PANEL_ACTIONS, ...JOIN_ROLE_ACTIONS, ...EXTRA_ACTIONS, 'joinrequests.list', 'joinrequests.review',
]);
const ACTION_SET = new Set(ACTIONS);
const MAX_BODY = 24 * 1024 * 1024;
const MUTATIONS = new Set(ACTIONS.filter(action => !['guild.load', 'log.list'].includes(action)));
const FORBIDDEN_KEYS = /^(?:__proto__|prototype|constructor|token|botToken|accessToken|refreshToken|authorization|password|secret|clientSecret|config|headers|method|path|baseUrl)$/i;

class ControlError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ControlError(status, code, message); };

function rejectSecretFields(value, depth = 0) {
  if (depth > 12) fail(400, 'validation', 'Die Eingaben sind zu tief verschachtelt.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail(400, 'validation', 'Diese Anfrage enthält ein nicht erlaubtes Feld.');
    rejectSecretFields(child, depth + 1);
  }
}

function sanitize(value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[entfernt]') : value;
  if (Array.isArray(value)) return value.map(item => sanitize(item, token));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.test(key)).map(([key, item]) => [key, sanitize(item, token)]));
}

// Uses the existing private account database. No token is read from or written to
// this facade, and no global bot settings or account rows are replaced.
export class AccountStorageFacade {
  constructor(store) { this.store = store; }
  read(key, fallback) {
    if (key !== 'logs') return fallback;
    try {
      const raw = this.store.setting('discord_control_logs');
      if (!raw) return fallback;
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.slice(0, 200) : fallback;
    } catch { fail(503, 'storage', 'Das Verwaltungsprotokoll ist momentan nicht verfügbar.'); }
  }
  write(key, value) {
    if (key !== 'logs') fail(400, 'unsupported', 'Dieser Speicherbereich ist nicht freigegeben.');
    this.store.setSetting('discord_control_logs', JSON.stringify(value.slice(0, 200)));
  }
  hasToken() { return false; }
  readToken() { return null; }
  saveToken() { fail(400, 'unsupported', 'Bot-Zugangsdaten werden ausschließlich auf dem Server verwaltet.'); }
  deleteToken() { fail(400, 'unsupported', 'Bot-Zugangsdaten werden ausschließlich auf dem Server verwaltet.'); }
}

async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'content_type', 'Die Anfrage muss JSON enthalten.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) fail(413, 'too_large', 'Die Anfrage ist zu groß.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) fail(413, 'too_large', 'Die Anfrage ist zu groß.');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid_json', 'Die Anfrage enthält kein gültiges JSON.'); }
}

function safeFailure(error) {
  if (error instanceof ControlError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof AppError) return { status: error.status, code: error.kind, message: safeMessage(error.message) };
  if (error instanceof DiscordError) {
    const status = [400, 401, 403, 404, 429].includes(error.status) ? error.status : 502;
    // DiscordError text is generated locally; never use the remote response body.
    return { status, code: 'discord', message: error.message };
  }
  if (error?.status === 401) return { status: 401, code: 'auth', message: 'Bitte erneut mit deinem Webseitenkonto anmelden.' };
  if (error?.status === 403) return { status: 403, code: 'forbidden', message: 'Eine gültige Administrator-Anmeldung und bei Browserzugriff der Seitenschutz sind erforderlich.' };
  if (error?.status === 429) return { status: 429, code: 'rate_limit', message: 'Bitte etwas warten, bevor du weitere Anfragen sendest.' };
  return { status: 500, code: 'internal', message: 'Die Discord-Verwaltung konnte die Anfrage nicht abschließen.' };
}

export class DiscordControl {
  constructor(service, { Client = DiscordClient } = {}) {
    this.service = service;
    this.Client = Client;
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  configuredGuild() {
    const config = this.service.config;
    if (config.clientId !== EXPECTED_BOT_ID) fail(503, 'identity_mismatch', 'Diese Erweiterung gehört ausschließlich zum vorhandenen Crazy_Batto-Bot. Die Anwendungs-ID stimmt nicht überein.');
    if (!config.botToken || typeof config.botToken !== 'string') fail(503, 'unconfigured', 'Der vorhandene Bot ist auf dem Server noch nicht eingerichtet.');
    try { return id(config.discordGuildId, 'Server-ID'); }
    catch { fail(503, 'unconfigured', 'Der Discord-Server ist auf der Webseite noch nicht eingerichtet.'); }
  }
  assertCurrent(context) {
    if (!this.service.accounts || typeof this.service.accounts.assertCurrent !== 'function') fail(503, 'unconfigured', 'Die Webseiten-Anmeldung ist nicht verfügbar.');
    this.service.accounts.assertCurrent(context, { admin: true });
  }
  capabilities() {
    const guildId = this.configuredGuild();
    return {
      ok: true, version: 1, mode: 'website', expectedBotId: EXPECTED_BOT_ID, guildId,
      actions: [...ACTIONS], maxRequestBytes: MAX_BODY, botTokenRequiredOnPc: false,
      modules: { embeds: true, serverDesign: true, channels: true, roles: true, botProfile: true, scheduledEvents: true,
        community: true, tiktokLive: true, adminCrowns: true, joinRequests: true, deviceRoles: true, gamingSetups: true, setupPanel: true, autoJoinRole: true, controlExtras: true, voiceHistory: true, autoModeration: true, voiceMessages: true, historicalKoriRuntime: false },
    };
  }
  enqueue(task) {
    if (this.pending >= 20) fail(429, 'busy', 'Die Verwaltung bearbeitet bereits mehrere Anfragen. Bitte kurz warten.');
    this.pending++;
    const result = this.queue.then(task);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  async admin(context) {
    const guildId = this.configuredGuild();
    const token = this.service.config.botToken;
    const BaseClient = this.Client;
    const ensure = () => this.assertCurrent(context);
    // perform runs after the Discord client's rate-limit queue: a session revoked
    // while waiting cannot issue its next Discord request.
    class AuthorizedClient extends BaseClient {
      constructor(value) { super(value, { beforeRequest: ensure }); }
      async perform(...args) { ensure(); return super.perform(...args); }
    }
    const client = new AuthorizedClient(token);
    ensure();
    const bot = await client.request('GET', '/users/@me');
    if (bot?.bot !== true || bot.id !== EXPECTED_BOT_ID) fail(503, 'identity_mismatch', 'Der konfigurierte Zugang gehört nicht zum erwarteten Crazy_Batto-Bot. Es wurde nichts geändert.');
    const guild = await client.request('GET', `/guilds/${guildId}`);
    if (guild?.id !== guildId) fail(503, 'guild_mismatch', 'Der konfigurierte Discord-Server konnte nicht bestätigt werden.');
    ensure();
    const admin = new AdminService(new AccountStorageFacade(this.service.accounts.store));
    admin.client = client;
    admin.bot = { id: bot.id, username: bot.username, discriminator: bot.discriminator, avatar: bot.avatar, bot: true, global_name: bot.global_name };
    admin.guilds = [{ id: guild.id, name: guild.name, icon: guild.icon }];
    return admin;
  }
  async execute(context, action, rawPayload) {
    if (!ACTION_SET.has(action)) fail(400, 'unsupported', 'Diese Aktion ist für die Webseiten-Verbindung nicht freigegeben.');
    let payload;
    try { payload = object(rawPayload ?? {}); } catch { fail(400, 'validation', 'Die Aktionsdaten müssen ein Objekt sein.'); }
    rejectSecretFields(payload);
    const guildId = this.configuredGuild();
    if (payload.guildId !== undefined && payload.guildId !== guildId) fail(403, 'guild_mismatch', 'Diese Anfrage gehört nicht zum konfigurierten Discord-Server.');
    this.assertCurrent(context);
    if (action.startsWith('extras.')) {
      if (!this.service.controlExtras) fail(503, 'unconfigured', 'Die Zusatzfunktionen sind noch nicht verfügbar.');
      return sanitize(await this.service.controlExtras.run(context, action, payload), this.service.config.botToken);
    }
    if (action.startsWith('setup.panel.') || action.startsWith('joinrole.')) {
      const module = action.startsWith('joinrole.') ? this.service.autoJoinRole : this.service.setupPanel;
      if (!module) fail(503, 'unconfigured', 'Dieser Community-Bereich ist noch nicht verfügbar.');
      return sanitize(await module.run(context, action, payload), this.service.config.botToken);
    }
    if (action.startsWith('roles.') || action.startsWith('setup.')) {
      const module = action.startsWith('roles.') ? this.service.deviceRoles : this.service.gamingSetups;
      if (!module) fail(503, 'unconfigured', 'Dieser Community-Bereich ist noch nicht verfügbar.');
      return sanitize(await module.run(context, action, payload), this.service.config.botToken);
    }
    if (/^(community|tiktok|admincrown|joinrequests)\./.test(action)) {
      const module = action.startsWith('community.') ? this.service.communityControl : action.startsWith('tiktok.') ? this.service.tiktokLive : action.startsWith('admincrown.') ? this.service.adminCrowns : this.service.joinRequests;
      if (!module) fail(503, 'unconfigured', 'Dieser Community-Bereich ist noch nicht verfügbar.');
      return sanitize(await module.run(context, action, payload), this.service.config.botToken);
    }
    // These are the only target guilds this instance ever knows about. The shared
    // AdminService checks channel membership, parents and roles before mutation.
    const admin = await this.admin(context);
    let result;
    try { result = await admin.run(action, { ...payload, guildId }); }
    catch (error) {
      if (error instanceof ControlError || error instanceof DiscordError || error?.status) throw error;
      fail(400, 'validation', 'Die Eingaben wurden nicht übernommen. Bitte Namen, IDs, Farben, Bildformate und Zeitangaben prüfen.');
    }
    // Audit metadata only: never store content, images or authentication values.
    if (MUTATIONS.has(action)) {
      try { this.service.accounts.store.audit(context.user.id, 'discord.control.' + action, guildId, { botId: EXPECTED_BOT_ID }); }
      catch { /* A Discord mutation already succeeded. Do not invite duplicate retries. */ }
    }
    // Authorization was rechecked immediately before the Discord mutation. Once
    // Discord accepted it, do not turn that success into a failure/retry prompt
    // if the session is revoked during the in-flight response.
    if (!MUTATIONS.has(action)) this.assertCurrent(context);
    return sanitize(result, this.service.config.botToken);
  }
  async handle(req, res) {
    const pathname = new URL(req.url, 'http://discord-control.local').pathname;
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) return false;
    const send = (value, status = 200) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie, Authorization' });
      res.end(JSON.stringify(sanitize(value, this.service.config.botToken)));
    };
    try {
      // Authentication happens even for unknown paths, before reading bodies,
      // checking configuration or making network calls.
      const context = await this.service.accounts.authenticateRequest(req, { mutation: req.method === 'POST', requireAdmin: true });
      this.assertCurrent(context);
      this.service.accounts.limit?.('discord-control:' + context.user.id, 120, 60_000);
      if (req.method === 'GET' && pathname === PREFIX + '/capabilities') send(this.capabilities());
      else if (req.method === 'GET' && pathname === PREFIX + '/state') {
        const state = await this.enqueue(async () => {
          const admin = await this.admin(context);
          return { ...admin.state(), remembered: false, mode: 'website', expectedBotId: EXPECTED_BOT_ID };
        });
        this.assertCurrent(context);
        send({ ok: true, state, guildId: this.configuredGuild() });
      } else if (req.method === 'POST' && pathname === PREFIX + '/action') {
        const body = await jsonBody(req);
        try { object(body); } catch { fail(400, 'validation', 'Die Anfrage muss ein Objekt sein.'); }
        if (Object.keys(body).some(key => !['action', 'payload'].includes(key))) fail(400, 'validation', 'Diese Anfrage enthält ein nicht erlaubtes Feld.');
        if (typeof body.action !== 'string' || !ACTION_SET.has(body.action)) fail(400, 'unsupported', 'Diese Aktion ist für die Webseiten-Verbindung nicht freigegeben.');
        this.assertCurrent(context);
        const result = await this.enqueue(() => this.execute(context, body.action, body.payload));
        send({ ok: true, result });
      } else if ([PREFIX + '/capabilities', PREFIX + '/state', PREFIX + '/action'].includes(pathname)) fail(405, 'method', 'Diese HTTP-Methode ist hier nicht erlaubt.');
      else fail(404, 'not_found', 'Dieser Verwaltungsendpunkt ist nicht vorhanden.');
    } catch (error) {
      const safe = safeFailure(error);
      send({ ok: false, error: { code: safe.code, message: safe.message } }, safe.status);
    }
    return true;
  }
}
