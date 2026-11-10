import { AppError, assert, safeMessage } from './errors.mjs';
import { Auth } from './auth.mjs';
import { Access } from './access.mjs';
import { Portal } from './portal.mjs';
import { Site } from './site.mjs';
import { P, has, basePermissions, channelPermissions, channelCapabilities, canConfigure, INSTALL_PERMISSIONS } from './permissions.mjs';
import { CATEGORIES, validId, validOperationId, normalizeOperation, validateImageBytes, operationPhases, buildPayload, messageUrl, eventUrl, summarizePoll } from './payloads.mjs';
import { sha256 } from './store.mjs';
import { ImageStorageClient, imageStorageId } from './image-storage.mjs';

const safeLabel = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
const idError = () => new AppError('not_found', 'Dieser Auftrag ist für dein Konto nicht vorhanden.', 404);

export class Service {
  constructor(config, store, discord, { now = Date.now, imageStorage = new ImageStorageClient(config) } = {}) {
    this.config = config; this.store = store; this.discord = discord; this.now = now;
    this.auth = new Auth(config, store, discord, { now });
    this.access = new Access(config, store, { now });
    this.portal = new Portal(config, store, this.auth, this.access, { now });
    this.imageStorage = imageStorage;
    this.site = new Site(config, store, this.access, { now, imageStorage });
    this.running = new Map(); this.inDoubt = new Set(); this.botInfo = null;
  }
  health() { return { ok: true, app: 'Modstempel', displayName: 'Crazy_Batto Discord App', apiVersion: 2, appVersion: '2.2.0', accessControl: true, siteContent: true, configured: this.config.configured && this.config.accessConfigured, ...(!this.config.configured || !this.config.accessConfigured ? { message: 'Discord-Anmeldung, Bot-Verbindung und Betreiberfreigabe sind noch nicht vollständig auf dem Server eingerichtet.' } : {}) }; }
  async bot() {
    if (this.botInfo) return this.botInfo;
    const result = await this.discord.request('GET', '/users/@me');
    assert(validId(result?.id) && result.bot === true, 'Der konfigurierte Discord-Zugang gehört nicht zu einem Bot.', 'unconfigured', 503);
    this.botInfo = { id: result.id };
    return this.botInfo;
  }
  async currentGuilds(userId) {
    const rows = await this.auth.userRequest(userId, '/users/@me/guilds?limit=200');
    assert(Array.isArray(rows), 'Discord hat keine gültige Serverliste geliefert.', 'network', 502);
    return rows.filter(row => validId(row?.id) && typeof row.name === 'string');
  }
  async botGuildIds() {
    const ids = new Set(); let after = '';
    for (let page = 0; page < 50; page++) {
      const rows = await this.discord.request('GET', '/users/@me/guilds?limit=200' + (after ? '&after=' + after : ''));
      assert(Array.isArray(rows), 'Die Bot-Serverliste konnte nicht gelesen werden.', 'network', 502);
      for (const row of rows) if (validId(row?.id)) ids.add(row.id);
      if (rows.length < 200) return ids;
      const next = rows.filter(row => validId(row?.id)).map(row => row.id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1).at(-1);
      assert(next && next !== after, 'Die Bot-Serverliste konnte nicht vollständig gelesen werden.', 'network', 502);
      after = next;
    }
    throw new AppError('unconfigured', 'Dieser Server unterstützt höchstens 10.000 Bot-Server. Bitte den Betreiber kontaktieren.', 503);
  }
  async guilds(session) {
    this.access.requireApp(session);
    // Both lists are independent. Avoid serial network waits in the picker.
    const [rows, bots] = await Promise.all([this.currentGuilds(session.userId), this.botGuildIds().catch(error => {
      if (!(error instanceof AppError) || !['auth', 'forbidden'].includes(error.kind)) throw error;
      return new Set();
    })]);
    this.access.requireApp(session);
    return { ok: true, user: session.user, guilds: rows.map(guild => ({
      id: guild.id, name: safeLabel(guild.name),
      ...(/^(?:a_)?[a-f0-9]{32}$/.test(guild.icon || '') ? { iconUrl: 'https://cdn.discordapp.com/icons/' + guild.id + '/' + guild.icon + '.png?size=128' } : {}),
      canConfigure: guild.owner === true || /^\d+$/.test(guild.permissions || '') && has(BigInt(guild.permissions), P.MANAGE_GUILD | 0n) || /^\d+$/.test(guild.permissions || '') && has(BigInt(guild.permissions), P.ADMINISTRATOR),
      botReady: bots.has(guild.id)
    })) };
  }
  async context(userId, guildId, { allowMissingBot = false } = {}) {
    this.access.requireApprovedUser(userId);
    assert(validId(guildId), 'Der Server ist ungültig.');
    // Independent reads run together. No cached member or permission data is
    // used to authorize a mutation, and membership must succeed first.
    const [rawMember, initial] = await Promise.all([
      this.auth.userRequest(userId, '/users/@me/guilds/' + guildId + '/member'),
      Promise.allSettled([this.discord.request('GET', '/guilds/' + guildId), this.bot()])
    ]);
    assert(rawMember && Array.isArray(rawMember.roles) && (!rawMember.user || rawMember.user.id === userId), 'Deine Servermitgliedschaft konnte nicht bestätigt werden.', 'forbidden', 403);
    const member = { ...rawMember, user: { ...(rawMember.user || {}), id: userId } };
    let guild, bot;
    try {
      if (initial[0].status === 'rejected') throw initial[0].reason;
      if (initial[1].status === 'rejected') throw initial[1].reason;
      guild = initial[0].value; bot = initial[1].value;
    } catch (error) {
      if (!allowMissingBot || !(error instanceof AppError) || !['not_found', 'forbidden', 'auth', 'unconfigured'].includes(error.kind)) throw error;
      const partial = (await this.currentGuilds(userId)).find(row => row.id === guildId);
      assert(partial, 'Du bist nicht mehr Mitglied dieses Servers.', 'forbidden', 403);
      const timeout = Date.parse(member.communication_disabled_until || '');
      const manager = !member.pending && !(Number.isFinite(timeout) && timeout > this.now()) && (partial.owner === true || /^\d+$/.test(partial.permissions || '') && has(BigInt(partial.permissions), P.MANAGE_GUILD) || /^\d+$/.test(partial.permissions || '') && has(BigInt(partial.permissions), P.ADMINISTRATOR));
      this.access.requireApprovedUser(userId);
      return { guild: { id: guildId, name: safeLabel(partial.name), roles: [] }, member, botReady: false, channels: [], canConfigure: !!manager };
    }
    assert(guild?.id === guildId && Array.isArray(guild.roles), 'Discord hat ungültige Serverdaten geliefert.', 'network', 502);
    const results = await Promise.allSettled([
      this.discord.request('GET', '/guilds/' + guildId + '/members/' + bot.id),
      this.discord.request('GET', '/guilds/' + guildId + '/channels')
    ]);
    if (results[0].status === 'rejected') throw results[0].reason;
    if (results[1].status === 'rejected') throw results[1].reason;
    const botMember = results[0].value, channels = results[1].value;
    assert(botMember && Array.isArray(botMember.roles) && (!botMember.user || botMember.user.id === bot.id) && Array.isArray(channels), 'Die Bot- oder Kanaldaten konnten nicht bestätigt werden.', 'network', 502);
    this.access.requireApprovedUser(userId);
    return { guild, member, botMember: { ...botMember, user: { ...(botMember.user || {}), id: bot.id } }, channels: channels.filter(channel => channel?.guild_id === guildId && validId(channel.id)), botReady: true, canConfigure: canConfigure(guild, member, this.now()) };
  }
  installUrl(guildId) {
    const url = new URL('https://discord.com/oauth2/authorize');
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, scope: 'bot applications.commands', permissions: INSTALL_PERMISSIONS, integration_type: '0', guild_id: guildId, disable_guild_select: 'true' })) url.searchParams.set(key, value);
    return url.toString();
  }
  async setup(session, guildId) {
    this.access.requireApp(session);
    const context = await this.context(session.userId, guildId, { allowMissingBot: true });
    this.access.requireApp(session);
    return this.setupView(context, guildId);
  }
  guildSettings(guildId) {
    const saved = this.store.data.guildSettings[guildId] || {};
    const moderatorRoleId = saved.moderatorRoleId || null;
    const settingsRevision = saved.settingsRevision ?? 0;
    assert(Number.isSafeInteger(settingsRevision) && settingsRevision >= 0, 'Die gespeicherte Server-Einrichtung ist ungültig.', 'unconfigured', 503);
    const categorySettings = {};
    for (const category of CATEGORIES) {
      const policy = saved.categorySettings?.[category] || { channelId: null, mentionMode: category === 'modstempel' && moderatorRoleId ? 'role' : 'none', roleId: category === 'modstempel' ? moderatorRoleId : null };
      assert(policy && (policy.channelId === null || validId(policy.channelId)) && ['none', 'role', 'everyone'].includes(policy.mentionMode)
        && (policy.mentionMode === 'role' ? validId(policy.roleId) && policy.roleId !== guildId : policy.roleId === null), 'Die gespeicherten Kanal- und Rollenziele sind ungültig.', 'unconfigured', 503);
      categorySettings[category] = { channelId: policy.channelId, mentionMode: policy.mentionMode, roleId: policy.roleId };
    }
    return { moderatorRoleId, settingsRevision, categorySettings };
  }
  setupView(context, guildId) {
    const settings = this.guildSettings(guildId), { moderatorRoleId, categorySettings } = settings;
    if (!context.botReady) return { ok: true, guild: { id: guildId, name: context.guild.name }, botReady: false, canConfigure: context.canConfigure, ...settings, roles: [], channels: [], canCreateEvents: false, ...(context.canConfigure ? { installUrl: this.installUrl(guildId) } : {}) };
    const channels = context.channels.filter(channel => [0, 5].includes(channel.type) && has(channelPermissions(context.guild, context.member, channel, this.now()), P.VIEW_CHANNEL)).sort((a, b) => (a.position || 0) - (b.position || 0)).map(channel => {
      const cap = channelCapabilities(context, channel, moderatorRoleId, this.now(), categorySettings);
      return { id: channel.id, name: safeLabel(channel.name), type: channel.type, capabilities: cap.capabilities, reasons: cap.reasons, ...(cap.reason ? { reason: cap.reason } : {}) };
    });
    return {
      ok: true, guild: { id: guildId, name: safeLabel(context.guild.name) }, botReady: true, canConfigure: context.canConfigure, ...settings,
      roles: context.guild.roles.filter(role => validId(role.id) && role.id !== guildId).map(role => ({ id: role.id, name: safeLabel(role.name), color: Number.isInteger(role.colors?.primary_color) ? role.colors.primary_color : Number.isInteger(role.color) ? role.color : 0, mentionable: role.mentionable === true })),
      channels, canCreateEvents: has(basePermissions(context.guild, context.member, this.now()), P.CREATE_EVENTS) && has(basePermissions(context.guild, context.botMember, this.now()), P.CREATE_EVENTS),
      ...(context.canConfigure ? { installUrl: this.installUrl(guildId) } : {})
    };
  }
  async setModeratorRole(session, guildId, roleId) {
    this.access.requireApp(session);
    const context = await this.context(session.userId, guildId);
    this.access.requireApp(session);
    assert(context.canConfigure, 'Nur Serververwalter dürfen die Moderatorrolle festlegen.', 'forbidden', 403);
    assert(validId(roleId) && roleId !== guildId && context.guild.roles.some(role => role.id === roleId), 'Diese Moderatorrolle gehört nicht zu diesem Server.');
    const before = this.guildSettings(guildId);
    if (before.moderatorRoleId !== roleId) {
      assert(before.settingsRevision < Number.MAX_SAFE_INTEGER, 'Die Einstellungsrevision kann nicht weiter erhöht werden.', 'unconfigured', 503);
      const categorySettings = before.categorySettings;
      if ((categorySettings.modstempel.mentionMode === 'role' && categorySettings.modstempel.roleId === before.moderatorRoleId) || !before.moderatorRoleId) categorySettings.modstempel = { ...categorySettings.modstempel, mentionMode: 'role', roleId };
      this.access.requireApp(session);
      this.store.transaction(draft => { draft.guildSettings[guildId] = { ...(draft.guildSettings[guildId] || {}), moderatorRoleId: roleId, categorySettings, settingsRevision: before.settingsRevision + 1, changedBy: session.userId, changedAt: this.now() }; });
    }
    return this.setupView(context, guildId);
  }
  async setGuildSettings(session, guildId, raw) {
    this.access.requireApp(session);
    assert(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key => ['expectedRevision', 'moderatorRoleId', 'categorySettings'].includes(key)), 'Die Server-Einrichtung ist ungültig.');
    assert(Number.isSafeInteger(raw.expectedRevision) && raw.expectedRevision >= 0 && raw.expectedRevision < Number.MAX_SAFE_INTEGER, 'Bitte die aktuelle Version der Server-Einrichtung verwenden.');
    const context = await this.context(session.userId, guildId);
    this.access.requireApp(session);
    assert(context.canConfigure, 'Nur Discord-Serververwalter dürfen Rollen und Zielkanäle festlegen.', 'forbidden', 403);
    assert(raw.expectedRevision === this.guildSettings(guildId).settingsRevision, 'Die Server-Einrichtung wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    const roleExists = id => validId(id) && id !== guildId && context.guild.roles.some(role => role.id === id);
    assert(raw.moderatorRoleId === null || roleExists(raw.moderatorRoleId), 'Bitte eine gültige Dienstrolle dieses Servers wählen.');
    assert(raw.categorySettings && typeof raw.categorySettings === 'object' && !Array.isArray(raw.categorySettings) && Object.keys(raw.categorySettings).length === CATEGORIES.length && CATEGORIES.every(category => Object.hasOwn(raw.categorySettings, category)), 'Für jede Beitragsart muss eine Zielregel angegeben werden.');
    const categorySettings = {};
    for (const category of CATEGORIES) {
      const policy = raw.categorySettings[category];
      assert(policy && typeof policy === 'object' && !Array.isArray(policy) && Object.keys(policy).every(key => ['channelId', 'mentionMode', 'roleId'].includes(key)), 'Eine Zielregel ist ungültig.');
      assert(['none', 'role', 'everyone'].includes(policy.mentionMode), 'Bitte keine Erwähnung, eine Rolle oder @everyone wählen.');
      assert(policy.mentionMode === 'role' ? roleExists(policy.roleId) : policy.roleId === null, 'Die Erwähnungsrolle ist ungültig.');
      const channel = context.channels.find(item => item.id === policy.channelId && [0, 5].includes(item.type));
      assert(policy.channelId === null || channel && has(channelPermissions(context.guild, context.member, channel, this.now()), P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS) && has(channelPermissions(context.guild, context.botMember, channel, this.now()), P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS), 'Der Zielkanal ist nicht beschreibbar. Bitte deine und die Bot-Rechte prüfen.');
      categorySettings[category] = { channelId: policy.channelId, mentionMode: policy.mentionMode, roleId: policy.roleId };
    }
    this.access.requireApp(session);
    this.store.transaction(draft => {
      draft.guildSettings[guildId] = { ...(draft.guildSettings[guildId] || {}), moderatorRoleId: raw.moderatorRoleId,
        categorySettings, settingsRevision: raw.expectedRevision + 1, changedBy: session.userId, changedAt: this.now() };
    });
    return this.setupView(context, guildId);
  }
  async install(session, guildId) {
    this.access.requireApp(session);
    const context = await this.context(session.userId, guildId, { allowMissingBot: true });
    this.access.requireApp(session);
    assert(context.canConfigure, 'Nur Serververwalter können den Bot hinzufügen.', 'forbidden', 403);
    return { ok: true, url: this.installUrl(guildId) };
  }
  async scheduledEvents(session, guildId) {
    this.access.requireApp(session);
    const context = await this.context(session.userId, guildId);
    const events = await this.discord.request('GET', '/guilds/' + guildId + '/scheduled-events');
    assert(Array.isArray(events), 'Die Discord-Events konnten nicht gelesen werden.', 'network', 502);
    const visible = events.filter(event => {
      if (!validId(event?.id) || event.guild_id !== guildId) return false;
      if (event.entity_type === 3) return true;
      const channel = context.channels.find(item => item.id === event.channel_id);
      return channel && has(channelPermissions(context.guild, context.member, channel, this.now()), P.VIEW_CHANNEL) && has(channelPermissions(context.guild, context.botMember, channel, this.now()), P.VIEW_CHANNEL);
    });
    this.access.requireApp(session);
    return { ok: true, events: visible.map(event => ({ id: event.id, name: safeLabel(event.name), description: String(event.description || '').slice(0, 1000), startsAt: Date.parse(event.scheduled_start_time) || null, endsAt: Date.parse(event.scheduled_end_time) || null, location: String(event.entity_metadata?.location || context.channels.find(channel => channel.id === event.channel_id)?.name || '').slice(0, 100), url: eventUrl(guildId, event.id), status: event.status })).sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0)) };
  }
  async authorizeOperation(session, op, { first = false, phase = null } = {}) {
    this.access.requireApp(session);
    assert(op.actorId === session.userId, 'Der Auftrag gehört zu einem anderen Discord-Konto.', 'forbidden', 403);
    const context = await this.context(session.userId, op.guildId);
    this.access.requireApp(session);
    if (op.sendBefore != null) assert(op.sendBefore > this.now(), 'Das Versandfenster dieses Auftrags ist abgelaufen. Bitte einen neuen Auftrag erstellen.');
    if (op.type === 'scheduled_event') {
      assert(op.data.startsAt > this.now(), 'Der Beginn des Events muss in der Zukunft liegen.');
      assert(has(basePermissions(context.guild, context.member, this.now()), P.CREATE_EVENTS) && has(basePermissions(context.guild, context.botMember, this.now()), P.CREATE_EVENTS), 'Dir oder dem Bot fehlt das Recht „Events erstellen“.', 'forbidden', 403);
      return context;
    }
    const channel = context.channels.find(item => item.id === op.channelId && item.guild_id === op.guildId && [0, 5].includes(item.type));
    assert(channel, 'Der gewählte Textkanal ist nicht mehr verfügbar.', 'forbidden', 403);
    const delivery = this.assertDeliveryCurrent(op, { first });
    if (op.category === 'modstempel') {
      assert(this.store.data.guildSettings[op.guildId]?.moderatorRoleId === op.moderatorRoleId, 'Die bestätigte Dienstrolle stimmt nicht mehr mit der Server-Einrichtung überein. Bitte das Ziel erneut auswählen.', 'conflict', 409);
      assert(context.guild.roles.some(role => role.id === op.moderatorRoleId && role.id !== op.guildId), 'Die gespeicherte Moderatorrolle ist nicht mehr vorhanden.', 'forbidden', 403);
      if (op.type === 'stamp') assert(context.canConfigure || context.member.roles.includes(op.moderatorRoleId), 'Stempeln dürfen nur Mitglieder der Moderatorrolle oder Serververwalter.', 'forbidden', 403);
    }
    const cap = channelCapabilities(context, channel, op.moderatorRoleId, this.now(), { [op.category]: delivery });
    assert(cap.capabilities[op.category], cap.reasons[op.category] || 'Dir oder dem Bot fehlen Rechte im gewählten Kanal.', 'forbidden', 403);
    if (op.image && phase !== 'poll') assert(has(cap.userPermissions, P.ATTACH_FILES) && has(cap.botPermissions, P.ATTACH_FILES), 'Dir oder dem Bot fehlt das Recht „Dateien anhängen“ im gewählten Kanal.', 'forbidden', 403);
    return context;
  }
  assertDeliveryCurrent(op, { first = false } = {}) {
    if (op.type === 'scheduled_event') return null;
    const settings = this.guildSettings(op.guildId);
    if (op.category === 'modstempel') assert(settings.moderatorRoleId === op.moderatorRoleId, 'Die Dienstrolle wurde seit diesem Auftrag geändert. Bitte das Ziel neu auswählen.', 'conflict', 409);
    const current = settings.categorySettings[op.category], expected = op.deliveryPolicy;
    const confirmedStampPolicy = op.type === 'stamp' && expected && expected.channelId === current.channelId && expected.mentionMode === current.mentionMode && expected.roleId === current.roleId && expected.moderatorRoleId === settings.moderatorRoleId;
    if (expected) assert(confirmedStampPolicy, 'Kanal, Erwähnung oder Dienstrolle wurden seit Dienstbeginn geändert. Bitte das Ziel neu bestätigen.', 'conflict', 409);
    if (first && op.deliveryRevision != null) assert(op.deliveryRevision === settings.settingsRevision || confirmedStampPolicy, 'Die Server-Einrichtung wurde seit deiner Vorschau geändert. Bitte das Ziel neu auswählen.', 'conflict', 409);
    if (op.delivery) {
      const policy = current;
      assert(policy.channelId === op.delivery.channelId && policy.mentionMode === op.delivery.mentionMode && policy.roleId === op.delivery.roleId,
        'Kanal oder Erwähnung wurden seit diesem Auftrag geändert. Bitte einen neuen Auftrag erstellen.', 'conflict', 409);
      return op.delivery;
    }
    // Already persisted legacy operations retain their explicit original ping.
    // A new server policy stops them instead of silently changing the message.
    assert(!this.store.data.guildSettings[op.guildId]?.categorySettings, 'Für diesen älteren Auftrag wurde die Server-Einrichtung geändert. Bitte einen neuen Auftrag erstellen.', 'conflict', 409);
    return { channelId: null, mentionMode: op.category === 'modstempel' ? 'role' : 'everyone', roleId: op.category === 'modstempel' ? op.moderatorRoleId : null };
  }
  owned(session, id) {
    if (!validOperationId(id)) throw idError();
    const record = this.store.data.operations[id];
    if (!record || record.operation.actorId !== session.userId) throw idError();
    this.access.requireApp(session);
    return record;
  }
  result(record) {
    const op = record.operation;
    const result = { id: op.id, type: op.type, status: this.inDoubt.has(op.id) ? 'uncertain' : record.status, stage: record.stage };
    if (record.error || this.inDoubt.has(op.id)) result.error = this.inDoubt.has(op.id) ? 'Die Discord-Bestätigung konnte nicht dauerhaft gespeichert werden. Bitte zuerst in Discord prüfen.' : record.error;
    if (record.nextAttemptAt > this.now()) result.retryAfterMs = record.nextAttemptAt - this.now();
    if (op.channelId) result.channelId = op.channelId;
    const image = record.phases.find(phase => phase.stage === 'image' && phase.status === 'sent');
    if (image) { result.imageMessageId = image.messageId; result.imageChannelId = op.channelId; if (image.imageUrl) result.imageUrl = image.imageUrl; }
    const message = record.phases.find(phase => ['poll', 'message'].includes(phase.stage) && phase.status === 'sent');
    if (message) { result.messageId = message.messageId; result.url = messageUrl(op.guildId, op.channelId, message.messageId); if (message.imageUrl) result.imageUrl = message.imageUrl; if (message.poll) result.poll = message.poll; }
    const event = record.phases.find(phase => phase.stage === 'event' && phase.status === 'sent');
    if (event) { result.eventId = event.eventId; result.url = eventUrl(op.guildId, event.eventId); }
    return result;
  }
  operationStatus(session, id) { return { ok: true, operation: this.result(this.owned(session, id)) }; }
  async accept(session, raw, image = null) {
    this.access.requireApp(session);
    const op = normalizeOperation(raw);
    assert(op.actorId === session.userId, 'Der Auftrag gehört zu einem anderen Discord-Konto.', 'forbidden', 403);
    const fingerprint = sha256(JSON.stringify(op));
    const existing = this.store.data.operations[op.id];
    if (existing) {
      this.owned(session, op.id);
      assert(existing.fingerprint === fingerprint, 'Diese Auftrags-ID ist bereits mit anderen Angaben gespeichert.', 'validation', 409);
      if (image) { assert(op.image, 'Dieser Auftrag enthält kein Bild.'); validateImageBytes(op.image, image.bytes, image.contentType); }
      if (existing.status === 'pending' && !this.inDoubt.has(op.id)) return this.run(session, op.id);
      if (this.running.has(op.id)) return this.running.get(op.id);
      return this.operationStatus(session, op.id);
    }
    if (op.type !== 'scheduled_event') op.delivery = { ...this.guildSettings(op.guildId).categorySettings[op.category] };
    assert(!image || op.image, 'Der Auftrag enthält keine Bildangaben.');
    if (op.image) { assert(image, 'Das gewählte Bild muss zusammen mit dem Auftrag hochgeladen werden.'); validateImageBytes(op.image, image.bytes, image.contentType); }
    await this.authorizeOperation(session, op, { first: true });
    this.access.requireApp(session);
    // Recheck after asynchronous rights reads, before creating a second record.
    if (this.store.data.operations[op.id]) return this.accept(session, raw, image);
    let imageStorage;
    if (op.image) {
      const id = imageStorageId('app', op.image.ref.slice(0, 64));
      await this.imageStorage.put(id, image.bytes, { mimeType: op.image.mime, width: op.image.width, height: op.image.height });
      imageStorage = { backend: 'nas', id };
      this.access.requireApp(session);
      if (this.store.data.operations[op.id]) return this.accept(session, raw, image);
    }
    this.store.transaction(draft => {
      assert(Object.keys(draft.operations).length < 100_000, 'Der Auftragsspeicher ist voll. Bitte den Serverbetreiber kontaktieren.', 'unconfigured', 503);
      const phases = operationPhases(op).map(stage => ({ stage, status: 'pending', attempts: 0 }));
      this.access.requireApp(session);
      this.assertDeliveryCurrent(op, { first: true });
      draft.operations[op.id] = { operation: op, actor: session.user, fingerprint, ...(imageStorage ? { imageStorage } : {}), acceptedAt: this.now(), status: 'pending', stage: phases[0].stage, error: '', nextAttemptAt: 0, phases };
    });
    return this.run(session, op.id);
  }
  async retry(session, id, acknowledgeUncertain) {
    this.access.requireApp(session);
    assert(typeof acknowledgeUncertain === 'boolean', 'Die Bestätigung für die Wiederholung fehlt.');
    const record = this.owned(session, id);
    if (this.running.has(id)) return this.running.get(id);
    if (record.status === 'sent' || record.status === 'skipped') return this.operationStatus(session, id);
    const uncertain = record.status === 'uncertain' || record.status === 'sending' || this.inDoubt.has(id);
    assert(!uncertain || acknowledgeUncertain, 'Bitte zuerst in Discord prüfen und die unklare Zustellung ausdrücklich bestätigen.', 'uncertain', 409);
    if (record.nextAttemptAt > this.now()) return this.operationStatus(session, id);
    this.store.transaction(draft => {
      const current = draft.operations[id];
      for (const phase of current.phases) if (phase.status !== 'sent') phase.status = 'pending';
      current.status = 'pending'; current.error = ''; current.nextAttemptAt = 0;
    });
    this.inDoubt.delete(id);
    return this.run(session, id);
  }
  async run(session, id) {
    if (this.running.has(id)) return this.running.get(id);
    const running = this.perform(session, id);
    this.running.set(id, running);
    try { return await running; } finally { this.running.delete(id); }
  }
  async perform(session, id) {
    let record = this.owned(session, id);
    if (record.status !== 'pending' || record.nextAttemptAt > this.now() || this.inDoubt.has(id)) return this.operationStatus(session, id);
    const op = record.operation;
    for (let index = 0; index < record.phases.length; index++) {
      record = this.owned(session, id);
      if (record.phases[index].status === 'sent') continue;
      const stage = record.phases[index].stage;
      let started = false;
      try {
        await this.authorizeOperation(session, op, { phase: stage });
        const imagePhase = record.phases.find(phase => phase.stage === 'image' && phase.status === 'sent');
        const payload = buildPayload(op, stage, record.actor || session.user, { imageMessageId: imagePhase?.messageId });
        const attach = op.image && stage !== 'poll';
        let bytes;
        if (attach) {
          if (record.imageStorage) {
            assert(record.imageStorage.backend === 'nas' && record.imageStorage.id === imageStorageId('app', op.image.ref.slice(0, 64)), 'Der gespeicherte Bildverweis ist ungültig.', 'permanent', 400);
            bytes = await this.imageStorage.read(record.imageStorage.id, { mimeType: op.image.mime, width: op.image.width, height: op.image.height, size: op.image.size });
          } else {
            // Old queued operations retain their original local bytes until an
            // explicit migration. New uploads are never written here.
            try { bytes = this.store.readImage(op.image.ref); }
            catch { throw new AppError('permanent', 'Das gespeicherte Bild ist nicht mehr verfügbar. Bitte einen neuen Auftrag mit Bild erstellen.', 400); }
          }
          validateImageBytes(op.image, bytes, op.image.mime);
        }
        // No await may separate this fresh gate from the durable send marker.
        this.access.requireApp(session);
        this.assertDeliveryCurrent(op);
        this.store.transaction(draft => {
          const current = draft.operations[id]; current.phases[index].status = 'sending'; current.phases[index].attempts++;
          current.status = 'sending'; current.stage = stage; current.error = ''; current.nextAttemptAt = 0;
        });
        started = true;
        const response = await this.discord.request('POST', stage === 'event' ? '/guilds/' + op.guildId + '/scheduled-events' : '/channels/' + op.channelId + '/messages', { payload, ...(attach ? { imageBytes: bytes, imageMeta: op.image } : {}) });
        assert(validId(response?.id) && (stage === 'event' ? response.guild_id === op.guildId : response.channel_id === op.channelId), 'Discord hat keine eindeutige Bestätigung für das gewählte Ziel geliefert. Bitte zuerst in Discord prüfen.', 'uncertain', 502);
        const imageUrl = Array.isArray(response.attachments) ? response.attachments.map(attachment => attachment?.url).find(url => typeof url === 'string' && /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url) && url.length <= 3000) : null;
        this.store.transaction(draft => {
          const current = draft.operations[id], phase = current.phases[index]; phase.status = 'sent'; phase.confirmedAt = this.now();
          if (stage === 'event') phase.eventId = response.id;
          else { phase.messageId = response.id; if (imageUrl) phase.imageUrl = imageUrl; if (response.poll) phase.poll = summarizePoll(response.poll, this.now()); }
          const next = current.phases.find(item => item.status !== 'sent'); current.status = next ? 'pending' : 'sent'; current.stage = next?.stage || stage;
        });
      } catch (error) {
        let kind = error instanceof AppError ? error.kind : started ? 'uncertain' : 'network';
        if (kind === 'not_found') kind = 'permanent';
        const status = kind === 'uncertain' ? 'uncertain' : ['network', 'rate_limited'].includes(kind) ? 'pending' : 'failed';
        const message = error instanceof AppError ? safeMessage(error.message) : started ? 'Die Discord-Bestätigung konnte nicht dauerhaft gespeichert werden. Bitte zuerst in Discord prüfen.' : 'Der Server konnte den Auftrag nicht vorbereiten. Bitte später erneut versuchen.';
        try {
          this.store.transaction(draft => {
            const current = draft.operations[id]; current.phases[index].status = status; current.status = status; current.stage = stage; current.error = message;
            current.nextAttemptAt = status === 'pending' ? this.now() + (error.retryAfterMs || 5000) : 0;
          });
        } catch {
          if (started) this.inDoubt.add(id);
          else throw new AppError('network', 'Der Auftrag konnte nicht dauerhaft gespeichert werden. Bitte später erneut versuchen.', 503, 5000);
        }
        return this.operationStatus(session, id);
      }
    }
    return this.operationStatus(session, id);
  }
  async pollResults(session, id) {
    const record = this.owned(session, id), op = record.operation;
    const phase = record.phases.find(item => item.stage === 'poll' && item.status === 'sent');
    assert(op.data.poll && phase?.messageId, 'Für diesen Auftrag ist noch keine bestätigte Umfrage vorhanden.', 'not_found', 404);
    const context = await this.context(session.userId, op.guildId);
    const channel = context.channels.find(item => item.id === op.channelId);
    assert(channel && has(channelPermissions(context.guild, context.member, channel, this.now()), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY) && has(channelPermissions(context.guild, context.botMember, channel, this.now()), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY), 'Dir oder dem Bot fehlen Leserechte für die ursprüngliche Umfrage.', 'forbidden', 403);
    const message = await this.discord.request('GET', '/channels/' + op.channelId + '/messages/' + phase.messageId);
    assert(message?.id === phase.messageId && message.channel_id === op.channelId, 'Die ursprüngliche Umfrage konnte nicht eindeutig gelesen werden.', 'network', 502);
    const poll = summarizePoll(message.poll, this.now(), phase.poll);
    assert(poll, 'Discord hat noch keine lesbaren Umfragedaten geliefert.', 'network', 502);
    this.access.requireApp(session);
    this.store.transaction(draft => { draft.operations[id].phases.find(item => item.stage === 'poll').poll = poll; });
    return { ok: true, poll };
  }
}
