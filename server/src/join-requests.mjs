import { AppError, assert } from './errors.mjs';
import { basePermissions, has } from './permissions.mjs';

// Official BotToken REST operations, currently published in Discord's API preview:
// https://github.com/discord/discord-api-spec/blob/main/specs/openapi.json
export const JOIN_REQUEST_ACTIONS = Object.freeze(['joinrequests.list', 'joinrequests.review']);
const BOT_ID = process.env.DISCORD_CLIENT_ID || '900000000000000002', ID = /^\d{17,20}$/;
const STATUSES = ['STARTED', 'SUBMITTED', 'APPROVED', 'REJECTED'];
const KICK_MEMBERS = 1n << 1n, RECORDS_KEY = 'native_join_request_reviews_v1';
const PREVIEW = 'Discord stellt diese Bot-Schnittstelle als API-Vorschau bereit.';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const snowflake = value => typeof value === 'string' && ID.test(value);
const validDate = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

class RemoteFailure extends AppError {}

export class JoinRequests {
  constructor(service, { now = Date.now } = {}) {
    this.service = service; this.now = now; this.store = service.accounts.store;
    this.queue = Promise.resolve(); this.pending = 0; this.seen = new Map();
  }
  ensure(context) {
    assert(context && typeof this.service.accounts?.assertCurrent === 'function', 'Bitte mit einem Administrator-Konto anmelden.', 'auth', 401);
    this.service.accounts.assertCurrent(context, { admin: true });
  }
  identity() {
    const config = this.service.config;
    assert(config.clientId === BOT_ID && typeof config.botToken === 'string' && !!config.botToken && snowflake(config.discordGuildId), 'Die Beitrittsverwaltung benötigt den vorhandenen Crazy_Batto-Bot und seinen festgelegten Server.', 'unconfigured', 503);
    return config.discordGuildId;
  }
  clean(value, max) {
    const token = this.service.config.botToken;
    return (typeof value === 'string' ? value : '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').split(token || '\0').join('[entfernt]').slice(0, max);
  }
  async request(context, method, route, payload) {
    this.ensure(context); this.identity();
    try { return await this.service.discord.request(method, route, payload === undefined ? {} : { payload }); }
    catch (error) {
      // Never surface remote bodies, URLs or client errors that might contain a token.
      if (error?.status === 429) throw new RemoteFailure('rate_limited', 'Discord begrenzt die Bewerbungsabfragen. Bitte kurz warten.', 429, Math.min(Math.max(Number(error.retryAfterMs) || 5000, 1000), 3600_000));
      if (error?.status === 401) throw new RemoteFailure('bot_auth', 'Discord hat den Bot-Zugang für die Bewerbungsverwaltung abgelehnt.', 503);
      if (error?.status === 403) throw new RemoteFailure('forbidden', 'Discord erlaubt diesem Bot die Bewerbungsverwaltung nicht. Serverrechte und Verfügbarkeit der API-Vorschau prüfen.', 403);
      if ([400, 404, 405].includes(error?.status)) throw new RemoteFailure('unavailable', 'Discord hat diese Bewerbungsfunktion nicht bestätigt. Prüfe den nativen Modus „Apply to Join“ und die Verfügbarkeit der API-Vorschau.', 503);
      throw new RemoteFailure(method === 'PATCH' ? 'uncertain' : 'network', method === 'PATCH' ? 'Discord hat die Entscheidung nicht eindeutig bestätigt. Bitte zuerst direkt in Discord prüfen; nicht erneut absenden.' : 'Die Discord-Bewerbungsverwaltung ist momentan nicht erreichbar.', 502);
    }
  }
  async authority(context) {
    const guildId = this.identity(); this.ensure(context);
    const bot = await this.request(context, 'GET', '/users/@me');
    assert(bot?.id === BOT_ID && bot.bot === true, 'Der konfigurierte Zugang gehört nicht zum erwarteten Crazy_Batto-Bot.', 'identity_mismatch', 503);
    const guild = await this.request(context, 'GET', '/guilds/' + guildId);
    assert(guild?.id === guildId && Array.isArray(guild.roles), 'Der konfigurierte Discord-Server konnte nicht bestätigt werden.', 'guild_mismatch', 503);
    const member = await this.request(context, 'GET', `/guilds/${guildId}/members/${BOT_ID}`);
    assert(member?.user?.id === BOT_ID && Array.isArray(member.roles), 'Die Bot-Mitgliedschaft konnte nicht bestätigt werden.', 'identity_mismatch', 503);
    if (!has(basePermissions(guild, member, this.now()), KICK_MEMBERS)) throw new RemoteFailure('forbidden', 'Dem Bot fehlt das Serverrecht „Mitglieder kicken“, das für diese Bewerbungsprüfung benötigt wird.', 403);
    if (!Array.isArray(guild.features) || !guild.features.includes('MEMBER_VERIFICATION_MANUAL_APPROVAL')) throw new RemoteFailure('mode_disabled', 'Aktiviere zuerst die native Bewerbungsfreigabe „Apply to Join“ in Discord unter Servereinstellungen → Zugriff. Die App schaltet diesen Modus nicht selbst ein.', 503);
    this.ensure(context); return guildId;
  }
  parameters(action, payload) {
    assert(object(payload), 'Die Bewerbungsdaten müssen ein Objekt sein.');
    const allowed = action === 'joinrequests.list' ? ['guildId', 'status', 'limit', 'before', 'after'] : ['guildId', 'requestId', 'action', 'rejectionReason', 'confirm'];
    assert(Object.keys(payload).every(key => allowed.includes(key)), 'Die Bewerbungsanfrage enthält unbekannte Felder.');
    const guildId = this.identity();
    assert(payload.guildId === undefined || payload.guildId === guildId, 'Dieser Antrag gehört nicht zum festgelegten Discord-Server.', 'forbidden', 403);
    if (action === 'joinrequests.list') {
      const status = payload.status ?? 'SUBMITTED', limit = payload.limit ?? 50;
      assert(['SUBMITTED', 'APPROVED', 'REJECTED'].includes(status), 'Bitte einen gültigen Bewerbungsstatus wählen.');
      assert(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'Es können 1 bis 100 Bewerbungen pro Seite geladen werden.');
      for (const key of ['before', 'after']) assert(payload[key] === undefined || snowflake(payload[key]), 'Ungültiger Seitencursor.');
      assert(!(payload.before && payload.after), 'Bitte nur einen Seitencursor verwenden.');
      return { status, limit, before: payload.before || null, after: payload.after || null };
    }
    assert(snowflake(payload.requestId) && payload.confirm === true && ['APPROVED', 'REJECTED'].includes(payload.action), 'Bitte eine gültige Bewerbung und die Entscheidung ausdrücklich bestätigen.');
    assert(payload.rejectionReason === undefined || (typeof payload.rejectionReason === 'string' && payload.rejectionReason.length <= 160 && !/[\u0000-\u001f\u007f]/.test(payload.rejectionReason)), 'Der Ablehnungsgrund darf höchstens 160 Zeichen enthalten.');
    assert(payload.action === 'REJECTED' || !payload.rejectionReason, 'Ein Ablehnungsgrund gehört nur zu einer Ablehnung.');
    return { requestId: payload.requestId, action: payload.action, rejectionReason: payload.rejectionReason?.trim() || '' };
  }
  normalize(raw, guildId) {
    assert(object(raw) && snowflake(raw.id) && raw.guild_id === guildId && snowflake(raw.user_id) && validDate(raw.created_at) && (raw.reviewed_at === null || validDate(raw.reviewed_at)) && (raw.application_status === null || STATUSES.includes(raw.application_status)) && (raw.rejection_reason === null || typeof raw.rejection_reason === 'string'), 'Discord hat einen unvollständigen oder fremden Beitrittsantrag geliefert.', 'protocol', 502);
    assert(raw.user == null || (object(raw.user) && raw.user.id === raw.user_id), 'Die Person im Beitrittsantrag konnte nicht eindeutig bestätigt werden.', 'protocol', 502);
    assert(raw.form_responses == null || Array.isArray(raw.form_responses), 'Discord hat keine lesbaren Bewerbungsantworten geliefert.', 'protocol', 502);
    const user = raw.user || {}, avatar = user.avatar;
    const avatarUrl = typeof avatar === 'string' && /^(?:a_)?[a-f0-9]{32}$/i.test(avatar)
      ? `https://cdn.discordapp.com/avatars/${raw.user_id}/${avatar}.${avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(raw.user_id) >> 22n) % 6n)}.png`;
    const answers = (raw.form_responses || []).slice(0, 25).map((field, index) => {
      if (!object(field)) return { label: 'Frage ' + (index + 1), value: 'Antwortformat nicht verfügbar' };
      let value = 'Keine Antwort';
      if (['TEXT_INPUT', 'PARAGRAPH'].includes(field.field_type) && typeof field.response === 'string') value = field.response;
      else if (field.field_type === 'MULTIPLE_CHOICE' && Array.isArray(field.choices) && Number.isInteger(field.response) && field.response >= 0 && field.response < field.choices.length && typeof field.choices[field.response] === 'string') value = field.choices[field.response];
      else if (field.field_type === 'TERMS' && typeof field.response === 'boolean') value = field.response ? 'Zugestimmt' : 'Nicht zugestimmt';
      else if (!['TEXT_INPUT', 'PARAGRAPH', 'MULTIPLE_CHOICE', 'TERMS'].includes(field.field_type)) value = 'Antwortformat nicht verfügbar';
      return { label: this.clean(field.label, 256) || 'Frage ' + (index + 1), value: this.clean(value, 2000) };
    });
    return { id: raw.id, userId: raw.user_id, user: { id: raw.user_id, username: this.clean(user.username, 100) || raw.user_id, globalName: this.clean(user.global_name, 100), avatarUrl },
      createdAt: new Date(raw.created_at).toISOString(), reviewedAt: raw.reviewed_at ? new Date(raw.reviewed_at).toISOString() : null, status: raw.application_status || 'UNKNOWN', rejectionReason: this.clean(raw.rejection_reason, 160), answers,
      answersTruncated: (raw.form_responses?.length || 0) > 25 };
  }
  async page(context, guildId, params) {
    const query = new URLSearchParams({ status: params.status, limit: String(params.limit) });
    if (params.before) query.set('before', params.before); if (params.after) query.set('after', params.after);
    const result = await this.request(context, 'GET', `/guilds/${guildId}/requests?${query}`); this.ensure(context);
    assert(object(result) && Array.isArray(result.guild_join_requests), 'Discord liefert die Bewerbungsanzahl, aber keine auswertbare Liste. Dies ist keine Bestätigung, dass keine Anträge vorliegen. Rechte und API-Vorschau prüfen.', 'unavailable', 503);
    assert(result.guild_join_requests.length <= params.limit, 'Discord hat eine unerwartet große Bewerbungsseite geliefert.', 'protocol', 502);
    assert(result.total === undefined || (Number.isSafeInteger(result.total) && result.total >= 0), 'Discord hat keine gültige Bewerbungsanzahl geliefert.', 'protocol', 502);
    const requests = result.guild_join_requests.map(row => this.normalize(row, guildId));
    assert(result.total === undefined || result.total >= requests.length, 'Discord hat eine widersprüchliche Bewerbungsanzahl geliefert.', 'protocol', 502);
    assert(new Set(requests.map(row => row.id)).size === requests.length, 'Discord hat doppelte Bewerbungen in einer Seite geliefert.', 'protocol', 502);
    assert(requests.every(row => (!params.before || BigInt(row.id) < BigInt(params.before)) && (!params.after || BigInt(row.id) > BigInt(params.after))), 'Discord hat den Seitencursor nicht bestätigt. Bitte die Liste neu laden.', 'protocol', 502);
    const ids = requests.map(row => BigInt(row.id)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0), total = result.total ?? null;
    // Snowflake bounds work independently of response ordering. A full page
    // with no total is inconclusive, so expose cursors without claiming a count.
    const hasMore = requests.length < params.limit || (!params.before && !params.after && total === requests.length) ? false : total === null || params.before || params.after ? null : total > requests.length;
    for (const row of requests) { this.seen.delete(row.id); this.seen.set(row.id, { at: this.now(), params: { ...params } }); }
    while (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value);
    return { available: true, preview: true, guildId, status: params.status, requests, total,
      pagination: { ...params, nextBefore: ids.length && hasMore !== false ? String(ids[0]) : null, nextAfter: ids.length && hasMore !== false ? String(ids.at(-1)) : null, hasMore }, message: PREVIEW };
  }
  unavailable(guildId, params, error) {
    const messages = new Set(['mode_disabled', 'forbidden', 'unavailable', 'protocol', 'network', 'bot_auth', 'rate_limited']);
    return { available: false, preview: true, guildId, status: params.status, requests: null, total: null,
      pagination: { ...params, nextBefore: null, nextAfter: null, hasMore: null },
      code: messages.has(error?.kind) ? error.kind : 'unavailable',
      message: error instanceof AppError && messages.has(error.kind) ? error.message : 'Die native Discord-Bewerbungsverwaltung ist derzeit nicht verfügbar.',
      ...(error?.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) };
  }
  records() {
    let rows; try { rows = JSON.parse(this.store.setting(RECORDS_KEY) || '[]'); } catch { throw new AppError('storage', 'Das Entscheidungsprotokoll kann nicht gelesen werden.', 503); }
    assert(Array.isArray(rows), 'Das Entscheidungsprotokoll ist ungültig.', 'storage', 503); return rows;
  }
  record(requestId, change) {
    this.store.transaction(() => {
      const rows = this.records(), existing = rows.find(row => row.requestId === requestId);
      if (existing) Object.assign(existing, change); else rows.push({ requestId, ...change });
      const pending = rows.filter(row => ['sending', 'uncertain'].includes(row.state));
      assert(pending.length <= 1000, 'Zu viele ungeklärte Bewerbungsentscheidungen. Bitte direkt in Discord prüfen.', 'capacity', 503);
      this.store.setSetting(RECORDS_KEY, JSON.stringify([...pending, ...rows.filter(row => !['sending', 'uncertain'].includes(row.state)).slice(-1000)]));
    });
  }
  async findSubmitted(context, guildId, requestId) {
    const cached = this.seen.get(requestId);
    if (cached?.params.status === 'SUBMITTED' && this.now() - cached.at < 300_000) {
      const knownPage = await this.page(context, guildId, cached.params);
      const target = knownPage.requests.find(row => row.id === requestId); if (target) return target;
    }
    let before = null;
    for (let index = 0; index < 5; index++) {
      const page = await this.page(context, guildId, { status: 'SUBMITTED', limit: 100, before, after: null });
      const target = page.requests.find(row => row.id === requestId); if (target) return target;
      if (page.pagination.hasMore === false || !page.pagination.nextBefore) break;
      assert(page.pagination.nextBefore !== before, 'Discord hat keine weitere Bewerbungsseite bestätigt.', 'protocol', 502); before = page.pagination.nextBefore;
    }
    throw new AppError('conflict', 'Dieser Antrag ist nicht mehr in der geprüften offenen Liste. Bitte neu laden oder direkt in Discord prüfen.', 409);
  }
  async review(context, guildId, params) {
    const previous = this.records().find(row => row.requestId === params.requestId);
    assert(!previous || previous.state === 'failed', previous?.state === 'resolved' ? 'Dieser Antrag wurde bereits geprüft. Bitte die Liste neu laden.' : 'Die letzte Entscheidung zu diesem Antrag ist noch ungeklärt. Bitte direkt in Discord prüfen; nicht erneut absenden.', 'conflict', 409);
    const target = await this.findSubmitted(context, guildId, params.requestId);
    assert(target.status === 'SUBMITTED', 'Dieser Antrag wartet nicht mehr auf eine Entscheidung.', 'conflict', 409);
    this.ensure(context);
    this.record(params.requestId, { state: 'sending', action: params.action, userId: target.userId, actorId: context.user.id, at: this.now() });
    let response;
    try {
      const raw = await this.request(context, 'PATCH', `/guilds/${guildId}/requests/${params.requestId}`, { action: params.action, ...(params.action === 'REJECTED' && params.rejectionReason ? { rejection_reason: params.rejectionReason } : {}) });
      response = this.normalize(raw, guildId);
      assert(response.id === target.id && response.userId === target.userId && response.status === params.action, 'Discord hat die Bewerbungsentscheidung nicht eindeutig bestätigt. Bitte direkt in Discord prüfen.', 'uncertain', 502);
    } catch (error) {
      const definitive = error instanceof AppError && ['forbidden', 'bot_auth', 'rate_limited', 'auth', 'unavailable'].includes(error.kind);
      this.record(params.requestId, { state: definitive ? 'failed' : 'uncertain', at: this.now() });
      if (error instanceof RemoteFailure || (error instanceof AppError && definitive)) throw error;
      throw new AppError('uncertain', 'Discord hat die Entscheidung nicht eindeutig bestätigt. Bitte zuerst direkt in Discord prüfen; nicht erneut absenden.', 502);
    }
    // Record failure after a confirmed Discord mutation must not invite a retry.
    try { this.record(params.requestId, { state: 'resolved', at: this.now() }); } catch { /* Existing sending reservation still prevents duplicate reviews. */ }
    try { this.store.audit(context.user.id, 'joinrequests.' + params.action.toLowerCase(), params.requestId, { guildId, userId: target.userId }); } catch { /* The remote action is already complete. */ }
    return { available: true, preview: true, guildId, request: response, message: params.action === 'APPROVED' ? 'Discord hat die Bewerbung angenommen.' : 'Discord hat die Bewerbung abgelehnt.' };
  }
  async run(context, action, payload = {}) {
    this.ensure(context); assert(JOIN_REQUEST_ACTIONS.includes(action), 'Diese Bewerbungsaktion ist nicht freigegeben.');
    const params = this.parameters(action, payload);
    assert(this.pending < 20, 'Die Bewerbungsverwaltung ist beschäftigt. Bitte kurz warten.', 'rate_limited', 429); this.pending++;
    const task = this.queue.then(async () => {
      this.ensure(context); const guildId = this.identity();
      if (action === 'joinrequests.list') {
        try { await this.authority(context); return await this.page(context, guildId, params); }
        catch (error) { this.ensure(context); if (['identity_mismatch', 'guild_mismatch', 'unconfigured'].includes(error?.kind)) throw error; return this.unavailable(guildId, params, error); }
      }
      await this.authority(context); return this.review(context, guildId, params);
    });
    this.queue = task.catch(() => {}).finally(() => { this.pending--; }); return task;
  }
}
