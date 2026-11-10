import { randomUUID, randomBytes } from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { P, has, basePermissions, channelPermissions } from './permissions.mjs';
import { COMMUNITY_ACTIONS, COMMUNITY_BOT_ID, CID, REPORT_CATEGORIES, communityDefaults, validateSection, text, discordId, safeName, embedMessage, renderTemplate, avatarUrl, ephemeral } from './community-schema.mjs';
export { COMMUNITY_ACTIONS } from './community-schema.mjs';

const KEY = 'community_control_v3';
const FLAGS = { MANAGE_CHANNELS: 1n << 4n, MANAGE_ROLES: 1n << 28n, KICK: 1n << 1n, BAN: 1n << 2n, MUTE: 1n << 22n, MOVE: 1n << 24n };
const SEND = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS;
const MEMBER_ACCESS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ATTACH_FILES;
// A public rules button may only grant ordinary chat/voice participation rights.
// A positive list also rejects future Discord permissions until reviewed.
const RULE_MEMBER_PERMISSIONS = [0, 6, 9, 10, 11, 12, 14, 15, 16, 18, 20, 21, 25, 26, 31, 32, 35, 36, 37, 38, 39, 42, 45, 46, 49, 50]
  .reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);
const COMMANDS = [
  { name: 'melden', description: 'Ein Mitglied vertraulich mit Begründung melden', type: 1, options: [{ name: 'mitglied', description: 'Das betroffene Mitglied', type: 6, required: true }] },
  { name: 'Mitglied melden', type: 2 },
  { name: 'ticket', description: 'Ein privates Support-Ticket öffnen', type: 1 },
];
const safeError = error => error instanceof AppError ? error.message : 'Die Discord-Aktion konnte nicht abgeschlossen werden. Bitte im Control Center prüfen.';

export class CommunityControl {
  constructor(service, { now = Date.now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.service = service; this.config = service.config; this.store = service.accounts.store; this.now = now;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.pending = new Set(); this.stopping = false;
    this.runtime = { membersIntentAllowed: false, membersIntentRequired: true, memberIntentMessage: 'Mitgliederzugriff wird beim Verbinden geprüft.', lastError: null, lastCounterAt: null, memberCount: null };
    this.counterPending = false; this.tickRunning = false;
  }
  data() {
    const raw = this.store.setting(KEY);
    if (!raw) return { revision: 0, settings: communityDefaults(), commands: {}, publications: {}, publishAttempts: {}, limits: [], reports: [], tickets: [], forms: [], handled: [], joins: [], events: [] };
    let data; try { data = JSON.parse(raw); } catch { throw new AppError('storage', 'Die Community-Einstellungen können nicht gelesen werden.', 503); }
    assert(data && Number.isSafeInteger(data.revision) && data.settings && Array.isArray(data.reports) && Array.isArray(data.tickets), 'Die Community-Daten sind ungültig.', 'storage', 503);
    return { commands: {}, publications: {}, publishAttempts: {}, limits: [], forms: [], handled: [], joins: [], events: [], ...data };
  }
  mutate(fn) {
    return this.store.transaction(() => { const data = this.data(); const result = fn(data); this.store.setSetting(KEY, JSON.stringify(data)); return result; });
  }
  current(context) { if (context) this.service.accounts.assertCurrent(context, { admin: true }); }
  identity() { assert(this.config.clientId === COMMUNITY_BOT_ID && !!this.config.botToken && CID.test(this.config.discordGuildId), 'Die Community-Steuerung gehört zum vorhandenen Crazy_Batto-Bot.', 'unconfigured', 503); }
  async request(context, method, route, payload) {
    this.identity(); this.current(context);
    return this.service.discord.request(method, route, payload === undefined ? {} : { payload });
  }
  async authority(context, flag = 0n, channelId = '') {
    this.current(context); this.identity();
    const guildId = this.config.discordGuildId;
    const bot = await this.request(context, 'GET', '/users/@me');
    assert(bot?.bot === true && bot.id === COMMUNITY_BOT_ID, 'Der Zugang gehört zu einer anderen Discord-Anwendung.', 'unconfigured', 503);
    const guild = await this.request(context, 'GET', '/guilds/' + guildId + '?with_counts=true');
    assert(guild?.id === guildId && Array.isArray(guild.roles), 'Discord hat keinen gültigen Server geliefert.', 'network', 502);
    const member = await this.request(context, 'GET', '/guilds/' + guildId + '/members/' + bot.id);
    member.user = { ...(member.user || {}), id: bot.id };
    assert(Array.isArray(member.roles) && has(basePermissions(guild, member, this.now()), flag), 'Dem Bot fehlen die erforderlichen Serverrechte.', 'forbidden', 403);
    let channel;
    if (channelId) {
      discordId(channelId); channel = await this.request(context, 'GET', '/channels/' + channelId);
      assert(channel?.guild_id === guildId, 'Dieser Kanal gehört nicht zum konfigurierten Server.', 'forbidden', 403);
    }
    this.current(context); return { bot, guild, member, channel };
  }
  sendable(auth) { assert([0, 5].includes(auth.channel?.type) && has(channelPermissions(auth.guild, auth.member, auth.channel, this.now()), SEND), 'Der Bot benötigt in diesem Textkanal Lese-, Schreib- und Einbettungsrechte.', 'forbidden', 403); }
  staffRoles(auth, ids) {
    assert(ids.length > 0 && ids.every(id => id !== auth.guild.id && auth.guild.roles.some(role => role.id === id && !role.managed)), 'Bitte gültige Teamrollen auswählen.');
  }
  privateInbox(auth, ids) {
    this.sendable(auth); this.staffRoles(auth, ids);
    const outsider = { user: { id: '900000000000000026' }, roles: [] };
    assert(!has(channelPermissions(auth.guild, outsider, auth.channel), P.VIEW_CHANNEL), 'Der Meldeeingang muss für @everyone verborgen sein.', 'forbidden', 403);
    for (const role of auth.guild.roles) {
      const dedicatedBotRole = role.managed === true && role.tags?.bot_id === auth.bot.id;
      if (ids.includes(role.id) || dedicatedBotRole || has(BigInt(role.permissions || 0), P.ADMINISTRATOR)) continue;
      assert(!has(channelPermissions(auth.guild, { ...outsider, roles: [role.id] }, auth.channel), P.VIEW_CHANNEL), 'Der Meldeeingang ist für eine fremde Rolle sichtbar.', 'forbidden', 403);
    }
    assert(!(auth.channel.permission_overwrites || []).some(o => o.type === 1 && o.id !== auth.bot.id && has(BigInt(o.allow || 0), P.VIEW_CHANNEL)), 'Der Meldeeingang enthält zusätzliche persönliche Lesefreigaben.', 'forbidden', 403);
  }
  position(guild, member) { return Math.max(0, ...guild.roles.filter(role => member.roles.includes(role.id)).map(role => Number(role.position) || 0)); }
  async target(context, auth, userId) {
    discordId(userId); assert(userId !== auth.bot.id && userId !== auth.guild.owner_id, 'Der Serverbesitzer und der Bot können hier nicht moderiert werden.', 'forbidden', 403);
    const member = await this.request(context, 'GET', `/guilds/${auth.guild.id}/members/${userId}`);
    assert(member?.user?.id === userId && Array.isArray(member.roles), 'Dieses Mitglied ist nicht auf dem Server.', 'forbidden', 403);
    assert(this.position(auth.guild, auth.member) > this.position(auth.guild, member), 'Die Rolle des Bots muss über der Rolle dieses Mitglieds liegen.', 'forbidden', 403);
    return member;
  }
  roleAssignable(auth, roleId) {
    const role = auth.guild.roles.find(row => row.id === roleId);
    const permissions = role && /^\d+$/.test(String(role.permissions ?? '')) ? BigInt(role.permissions) : -1n;
    assert(role && !role.managed && role.id !== auth.guild.id && permissions >= 0n && (permissions & ~RULE_MEMBER_PERMISSIONS) === 0n && Number(role.position) < this.position(auth.guild, auth.member), 'Die Regelrolle darf ausschließlich normale Chat- und Sprachrechte enthalten und muss unterhalb des Bots liegen.', 'forbidden', 403);
  }
  state() {
    const d = this.data();
    return { revision: d.revision, settings: d.settings, reports: d.reports.slice(0, 200), tickets: d.tickets.slice(0, 200),
      runtime: { ...this.runtime, gateway: this.service.botGateway?.status() || null, commandsRegistered: COMMANDS.every(c => CID.test(d.commands[c.name] || '')), registeredCommands: Object.keys(d.commands), publishAttempts: d.publishAttempts, publications: Object.fromEntries(Object.entries(d.publications).map(([key, row]) => [key, { channelId: row.channelId, messageId: row.messageId, publishedAt: row.publishedAt, updatedAt: row.updatedAt }])) } };
  }
  async run(context, action, payload = {}) {
    assert(context, 'Eine gültige Administrator-Anmeldung ist erforderlich.', 'auth', 401);
    this.current(context); this.identity();
    assert(COMMUNITY_ACTIONS.includes(action), 'Unbekannte Community-Aktion.');
    assert(!payload.guildId || payload.guildId === this.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (action === 'community.state') return this.state();
    if (action === 'community.report.list') return { reports: this.data().reports.slice(0, 200) };
    if (action === 'community.ticket.list') return { tickets: this.data().tickets.slice(0, 200) };
    if (action === 'community.voice.list') return this.voiceList();
    if (action === 'community.save') return this.save(context, payload);
    if (action === 'community.publish') return this.publish(context, payload);
    if (action === 'community.register') return this.register(context);
    if (action === 'community.report.moderate') return this.moderate(context, payload);
    if (action === 'community.voice.control') return this.voiceControl(context, payload);
    if (action === 'community.ticket.close') return this.closeTicket(context, payload);
  }
  async save(context, payload) {
    const section = payload.section, settings = validateSection(section, payload.settings);
    assert(Number.isSafeInteger(payload.revision) && payload.revision === this.data().revision, 'Die Einstellungen wurden inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    if (settings.channelId) {
      const auth = await this.authority(context, section === 'counter' ? FLAGS.MANAGE_CHANNELS : section === 'rules' ? FLAGS.MANAGE_ROLES : 0n, settings.channelId);
      if (section !== 'counter') this.sendable(auth);
      if (section === 'rules' && settings.roleId) this.roleAssignable(auth, settings.roleId);
      if (section === 'reports' && settings.enabled) this.privateInbox(auth, settings.staffRoleIds);
      if (section === 'tickets' && settings.enabled) { this.staffRoles(auth, settings.staffRoleIds); assert(has(basePermissions(auth.guild, auth.member), FLAGS.MANAGE_CHANNELS), 'Dem Bot fehlt „Kanäle verwalten“.', 'forbidden', 403); }
      if (section === 'tickets' && settings.categoryId) {
        const category = await this.request(context, 'GET', '/channels/' + settings.categoryId);
        assert(category.guild_id === auth.guild.id && category.type === 4, 'Bitte eine Kategorie dieses Servers wählen.');
      }
    }
    this.current(context);
    this.mutate(d => { assert(d.revision === payload.revision, 'Die Einstellungen wurden inzwischen geändert.', 'conflict', 409); d.settings[section] = settings; d.revision++; });
    if (['welcome', 'counter'].includes(section)) {
      this.counterPending = true;
      const desired = await this.gatewayIntents();
      if (this.service.botGateway?.running && this.service.botGateway.lastIntents !== desired) this.service.botGateway.retry(0, { reset: true, problem: 'Aktualisierte Community-Berechtigungen werden beim nächsten erlaubten Verbindungsaufbau aktiv.' });
    }
    return this.state();
  }
  async register(context) {
    await this.authority(context);
    const ids = {};
    for (const command of COMMANDS) {
      const result = await this.request(context, 'POST', `/applications/${COMMUNITY_BOT_ID}/guilds/${this.config.discordGuildId}/commands`, command);
      assert(CID.test(result?.id || '') && result.name === command.name, 'Discord hat den Befehl nicht bestätigt.', 'uncertain', 502); ids[command.name] = result.id;
    }
    this.current(context); this.mutate(d => { d.commands = ids; }); return this.state();
  }
  validateMessage(payload) {
    assert((payload.content || '').length <= 2000 && Array.isArray(payload.embeds) && payload.embeds.length <= 10, 'Die Nachricht ist zu lang.');
    let total = 0;
    for (const block of payload.embeds) {
      assert((block.title || '').length <= 256 && (block.description || '').length <= 4096 && (block.footer?.text || '').length <= 2048 && (block.author?.name || '').length <= 256 && (block.fields || []).length <= 25, 'Die Einbettung überschreitet die Discord-Grenzen.');
      total += (block.title || '').length + (block.description || '').length + (block.footer?.text || '').length + (block.author?.name || '').length;
      for (const field of block.fields || []) { assert(field.name?.length >= 1 && field.name.length <= 256 && field.value?.length >= 1 && field.value.length <= 1024, 'Ein Feld der Einbettung ist zu lang.'); total += field.name.length + field.value.length; }
    }
    assert(total <= 6000, 'Die Einbettung darf insgesamt höchstens 6000 Textzeichen enthalten.');
    return payload;
  }
  async post(context, auth, payload) {
    this.sendable(auth); this.validateMessage(payload);
    payload.allowed_mentions ??= { parse: [] };
    payload.nonce = String(this.now()) + randomBytes(5).toString('hex'); payload.enforce_nonce = true;
    const message = await this.request(context, 'POST', '/channels/' + auth.channel.id + '/messages', payload);
    assert(CID.test(message?.id || '') && (!message.channel_id || message.channel_id === auth.channel.id), 'Discord hat die Nachricht nicht eindeutig bestätigt. Bitte vor erneutem Senden nachsehen.', 'uncertain', 502);
    return { id: message.id, url: `https://discord.com/channels/${auth.guild.id}/${auth.channel.id}/${message.id}` };
  }
  welcomeMessage(settings, user, guild) {
    const variables = { mention: `<@${user.id}>`, username: safeName(user.global_name || user.username), server: safeName(guild.name), memberCount: guild.approximate_member_count ?? guild.member_count ?? '' };
    const message = embedMessage(settings, variables); message.content = renderTemplate(settings.message, variables).slice(0, 2000);
    message.embeds[0].thumbnail = { url: avatarUrl(user) }; message.allowed_mentions.users = [user.id]; return message;
  }
  birthdayMessage(settings) {
    const message = embedMessage(settings), calendar = this.service.birthdays?.calendar();
    assert(calendar && Array.isArray(calendar.entries), 'Der Geburtstagskalender ist momentan nicht verfügbar.', 'unconfigured', 503);
    const lines = calendar.entries.slice(0, settings.limit).map(e => `${safeName(e.name)} · ${String(e.day).padStart(2, '0')}.${String(e.month).padStart(2, '0')}. · ${e.daysUntil === 0 ? 'heute 🎉' : 'in ' + e.daysUntil + ' Tagen'}`);
    message.embeds[0].description = (settings.description.slice(0, 1400) + '\n\n' + (lines.join('\n') || 'Noch keine freigegebenen Geburtstage.')).slice(0, 4000);
    const date = new Date(this.now()).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
    message.embeds[0].footer = { text: (settings.footer + ' · Aktualisiert: ' + date).slice(0, 2048) };
    message.components = [{ type: 1, components: [{ type: 2, style: 5, label: 'Registrieren & Geburtstag eintragen', url: 'https://crazybatto.de/registrierung.html' }, { type: 2, style: 5, label: 'Kalender öffnen', url: 'https://crazybatto.de/geburtstage.html' }] }];
    return this.validateMessage(message);
  }
  async publish(context, payload) {
    const section = payload.section;
    assert(Object.hasOwn(communityDefaults(), section), 'Unbekannter Community-Bereich.');
    const settings = this.data().settings[section];
    assert(settings, 'Unbekannter Community-Bereich.');
    if (section === 'counter') return this.updateCounter(context, true);
    if (['rules', 'reports', 'tickets'].includes(section)) assert(settings.enabled, 'Bitte den Bereich zuerst aktivieren.');
    const channelId = section === 'reports' ? discordId(payload.channelId) : discordId(settings.channelId);
    const auth = await this.authority(context, section === 'rules' ? FLAGS.MANAGE_ROLES : 0n, channelId);
    this.sendable(auth); let message = embedMessage(settings);
    if (section === 'welcome') {
      let user = auth.bot;
      if (payload.previewUserId) user = (await this.request(context, 'GET', `/guilds/${auth.guild.id}/members/${discordId(payload.previewUserId)}`)).user;
      message = this.welcomeMessage(settings, user, auth.guild);
    } else if (section === 'rules') {
      this.roleAssignable(auth, settings.roleId);
      message.components = [{ type: 1, components: [{ type: 2, style: 3, label: settings.yesLabel || 'Ja', custom_id: 'cb3:rules:yes' }, { type: 2, style: 2, label: settings.noLabel || 'Nein', custom_id: 'cb3:rules:no' }] }];
    } else if (section === 'reports') {
      const inbox = await this.authority(context, 0n, settings.channelId); this.privateInbox(inbox, settings.staffRoleIds);
      message.components = [{ type: 1, components: [{ type: 5, custom_id: 'cb3:report:select', placeholder: settings.buttonLabel || 'Mitglied auswählen', min_values: 1, max_values: 1 }] }];
    } else if (section === 'tickets') {
      message.components = [{ type: 1, components: [{ type: 2, style: 1, label: settings.buttonLabel || 'Ticket öffnen', custom_id: 'cb3:ticket:open' }] }];
    } else if (section === 'birthday') {
      message = this.birthdayMessage(settings);
    } else if (section === 'event') {
      assert(this.data().events.length < 200, 'Höchstens 200 gespeicherte Eventankündigungen.');
      assert(Number.isFinite(Date.parse(settings.startAt)) && Date.parse(settings.endAt) > Math.max(Date.parse(settings.startAt), this.now()), 'Das Event benötigt einen Start und ein späteres Ende in der Zukunft.');
      const start = Math.floor(Date.parse(settings.startAt) / 1000), end = Math.floor(Date.parse(settings.endAt) / 1000);
      message.embeds[0].fields = [{ name: 'Beginn', value: `<t:${start}:F>`, inline: true }, { name: 'Ende / Countdown', value: `<t:${end}:F> · <t:${end}:R>`, inline: true }];
      if (settings.location) message.embeds[0].fields.push({ name: 'Ort', value: settings.location });
    }
    this.validateMessage(message); this.current(context);
    this.mutate(d => { assert(!['sending', 'uncertain'].includes(d.publishAttempts[section]?.status), 'Die letzte Veröffentlichung ist noch ungeklärt. Bitte zuerst in Discord prüfen; sie wird nicht automatisch doppelt gesendet.', 'uncertain', 409); d.publishAttempts[section] = { status: 'sending', at: this.now(), channelId }; });
    let sent;
    try { sent = await this.post(context, auth, message); }
    catch (error) { this.mutate(d => { d.publishAttempts[section].status = error instanceof AppError && !['uncertain', 'network'].includes(error.kind) ? 'failed' : 'uncertain'; }); throw error; }
    this.mutate(d => {
      d.publishAttempts[section].status = 'published';
      d.publications[section] = { channelId, messageId: sent.id, publishedAt: this.now(), updatedAt: this.now(), roleId: settings.roleId || null };
      if (section === 'event') d.events.unshift({ id: randomUUID(), channelId, messageId: sent.id, endAt: settings.endAt, title: settings.title, status: 'active' });
    });
    return sent;
  }
  validPanel(data, section) {
    const d = this.data(), publication = d.publications[section];
    return d.settings[section]?.enabled && publication && data.message?.id === publication.messageId && data.channel_id === publication.channelId;
  }
  validReportFlow(form, data, current) {
    if (!current.settings.reports.enabled || form.actorId !== data.member?.user?.id || form.expiresAt <= this.now()) return false;
    // Forms opened before this upgrade had no guild/channel or category fields.
    // Their signed, actor-bound 15-minute submission remains valid and is labelled
    // as having no category, rather than inventing a choice for the member.
    if (!form.guildId) return form.kind === 'report' && !Object.hasOwn(form, 'category');
    if (form.guildId !== data.guild_id || form.channelId !== data.channel_id) return false;
    if (form.panel) { const panel = current.publications.reports; return panel?.channelId === form.panel.channelId && panel?.messageId === form.panel.messageId; }
    return !!form.command && current.commands[form.command.name] === form.command.id;
  }
  reportCategory(data, targetId) {
    const actorId = discordId(data.member?.user?.id); discordId(targetId); assert(actorId !== targetId, 'Du kannst dich nicht selbst melden.');
    const binding = { guildId: data.guild_id, channelId: discordId(data.channel_id), ...(data.type === 3 ? { panel: { channelId: data.channel_id, messageId: data.message.id } } : { command: { name: data.data.name, id: data.data.id } }) };
    this.userLimit(actorId, 'form'); const nonce = randomBytes(12).toString('hex');
    this.mutate(d => { d.forms = d.forms.filter(f => f.expiresAt > this.now()); assert(d.forms.length < 500, 'Zu viele offene Formulare. Bitte später erneut versuchen.', 'rate_limited', 429); d.forms.push({ nonce, actorId, targetId, kind: 'report-category', expiresAt: this.now() + 15 * 60_000, ...binding }); });
    const response = ephemeral('Ausgewähltes Mitglied: <@' + targetId + '>. Wähle jetzt die Art des Vorfalls. Danach beschreibst du den Grund.');
    response.data.components = [{ type: 1, components: [{ type: 3, custom_id: 'cb3:report:category:' + nonce, placeholder: 'Art des Vorfalls auswählen', min_values: 1, max_values: 1,
      options: Object.entries(REPORT_CATEGORIES).map(([value, label]) => ({ label, value })) }] }]; return response;
  }
  form(data, kind, targetId = '', selection = null) {
    const actorId = discordId(data.member?.user?.id); if (targetId) discordId(targetId);
    assert(['report','ticket'].includes(kind), 'Unbekanntes Formular.');
    if (kind === 'report') assert(selection && Object.hasOwn(REPORT_CATEGORIES, selection.category), 'Bitte zuerst die Art des Vorfalls auswählen.');
    else this.userLimit(actorId, 'form');
    const nonce = randomBytes(12).toString('hex');
    this.mutate(d => {
      d.forms = d.forms.filter(f => f.expiresAt > this.now()); let binding = {};
      if (kind === 'report') {
        const index = d.forms.findIndex(f => f.nonce === selection.nonce && f.kind === 'report-category' && f.targetId === targetId && this.validReportFlow(f, data, d));
        assert(index >= 0, 'Diese Auswahl ist abgelaufen, wurde bereits verwendet oder gehört zu einer anderen Person.', 'forbidden', 403);
        const pending = d.forms.splice(index, 1)[0]; binding = { guildId: pending.guildId, channelId: pending.channelId, panel: pending.panel, command: pending.command, expiresAt: pending.expiresAt, category: selection.category };
      }
      assert(d.forms.length < 500, 'Zu viele offene Formulare. Bitte später erneut versuchen.', 'rate_limited', 429);
      d.forms.push({ nonce, actorId, targetId, kind, expiresAt: this.now() + 15 * 60_000, ...binding });
    });
    const fields = kind === 'report' ? [
      { type: 4, custom_id: 'reason', label: 'Begründung (Pflicht)', style: 2, min_length: 10, max_length: 1000, required: true },
      { type: 4, custom_id: 'details', label: 'Kanal, Zeitpunkt oder Belege (optional)', style: 2, max_length: 1000, required: false },
    ] : [{ type: 4, custom_id: 'subject', label: 'Betreff', style: 1, min_length: 3, max_length: 80, required: true }, { type: 4, custom_id: 'reason', label: 'Wobei brauchst du Hilfe?', style: 2, min_length: 10, max_length: 1000, required: true }];
    return { type: 9, data: { custom_id: 'cb3:form:' + nonce, title: kind === 'report' ? 'Meldung · ' + REPORT_CATEGORIES[selection.category] : 'Privates Support-Ticket', components: fields.map(input => ({ type: 1, components: [input] })) } };
  }
  userLimit(actorId, kind) {
    this.mutate(d => { d.limits = d.limits.filter(row => row.at > this.now() - 600_000); assert(d.limits.filter(row => row.actorId === actorId && row.kind === kind).length < 5 && d.limits.length < 5000, 'Höchstens fünf Formulare oder Meldungen in zehn Minuten. Bitte später erneut versuchen.', 'rate_limited', 429); d.limits.push({ actorId, kind, at: this.now() }); });
  }
  defer(data, work) {
    assert(CID.test(data.id || '') && typeof data.token === 'string' && /^[A-Za-z0-9_.-]{20,512}$/.test(data.token), 'Ungültige Discord-Interaktion.');
    let accepted = false;
    this.mutate(d => { d.handled = d.handled.filter(r => r.at > this.now() - 86400_000); if (!d.handled.some(r => r.id === data.id)) { assert(d.handled.length < 5000 && this.pending.size < 100, 'Bitte später erneut versuchen.', 'rate_limited', 429); d.handled.push({ id: data.id, at: this.now() }); accepted = true; } });
    if (accepted) {
      const promise = new Promise(resolve => setImmediate(resolve)).then(async () => {
        let content;
        try { content = await work(); } catch (error) { content = safeError(error); this.runtime.lastError = content; }
        try { await this.request(null, 'PATCH', `/webhooks/${COMMUNITY_BOT_ID}/${data.token}/messages/@original`, { content, allowed_mentions: { parse: [] } }); } catch { this.runtime.lastError = 'Eine private Discord-Bestätigung konnte nicht zugestellt werden.'; }
      });
      this.track(promise);
    }
    return { type: 5, data: { flags: 64 } };
  }
  interaction(data) {
    const own = data?.data?.custom_id?.startsWith('cb3:') || COMMANDS.some(c => c.name === data?.data?.name);
    if (!own) return null;
    try {
      this.identity(); assert(data.guild_id === this.config.discordGuildId && CID.test(data.member?.user?.id || ''), 'Diese Aktion ist nur auf unserem Server verfügbar.', 'forbidden', 403);
      const d = this.data(), actorId = data.member.user.id, custom = data.data.custom_id || '';
      if (data.type === 2) {
        assert(d.commands[data.data.name] === data.data.id, 'Dieser Community-Befehl wurde noch nicht eingerichtet.', 'forbidden', 403);
        if (data.data.name === 'ticket') { assert(d.settings.tickets.enabled, 'Das Ticketsystem ist ausgeschaltet.'); return this.form(data, 'ticket'); }
        assert(d.settings.reports.enabled, 'Das Meldesystem ist ausgeschaltet.');
        const target = data.data.target_id || data.data.options?.find(o => o.name === 'mitglied')?.value;
        assert(target !== actorId, 'Du kannst dich nicht selbst melden.'); return this.reportCategory(data, discordId(target));
      }
      if (data.type === 3 && custom.startsWith('cb3:rules:')) {
        assert(this.validPanel(data, 'rules'), 'Diese Regelkarte ist nicht mehr aktiv.');
        if (custom === 'cb3:rules:no') return ephemeral('Du hast die Regeln nicht akzeptiert. Du wirst nicht entfernt und erhältst keine Mitgliedsrolle.');
        assert(custom === 'cb3:rules:yes', 'Unbekannte Regelaktion.');
        return this.defer(data, async () => {
          const current = this.data(); assert(current.settings.rules.enabled && this.validPanel(data, 'rules'), 'Die Regelkarte wurde inzwischen geändert.');
          const auth = await this.authority(null, FLAGS.MANAGE_ROLES); const roleId = current.publications.rules.roleId;
          assert(roleId === current.settings.rules.roleId, 'Bitte die aktualisierte Regelkarte verwenden.'); this.roleAssignable(auth, roleId);
          const member = await this.request(null, 'GET', `/guilds/${auth.guild.id}/members/${actorId}`); assert(member?.user?.id === actorId, 'Mitglied nicht gefunden.');
          assert(this.validPanel(data, 'rules') && this.data().settings.rules.roleId === roleId, 'Die Regelkarte wurde inzwischen geändert.');
          await this.request(null, 'PUT', `/guilds/${auth.guild.id}/members/${actorId}/roles/${roleId}`); return 'Danke! Du hast die Regeln akzeptiert und die Mitgliedsrolle erhalten.';
        });
      }
      if (data.type === 3 && custom === 'cb3:report:select') {
        assert(this.validPanel(data, 'reports'), 'Diese Meldekarte ist nicht mehr aktiv.'); assert(Array.isArray(data.data.values) && data.data.values.length === 1, 'Bitte genau ein Mitglied auswählen.'); const target = discordId(data.data.values[0]);
        assert(target !== actorId, 'Du kannst dich nicht selbst melden.'); return this.reportCategory(data, target);
      }
      if (data.type === 3 && /^cb3:report:category:[a-f0-9]{24}$/.test(custom)) {
        assert(data.data.component_type === 3 && Array.isArray(data.data.values) && data.data.values.length === 1 && Object.hasOwn(REPORT_CATEGORIES, data.data.values[0]), 'Bitte eine gültige Art des Vorfalls auswählen.');
        const pending = d.forms.find(f => f.nonce === custom.slice('cb3:report:category:'.length) && f.kind === 'report-category' && this.validReportFlow(f, data, d));
        assert(pending, 'Diese Auswahl ist abgelaufen, wurde bereits verwendet oder gehört zu einer anderen Person.', 'forbidden', 403);
        return this.form(data, 'report', pending.targetId, { nonce: pending.nonce, category: data.data.values[0] });
      }
      if (data.type === 3 && custom === 'cb3:ticket:open') { assert(this.validPanel(data, 'tickets'), 'Diese Ticketkarte ist nicht mehr aktiv.'); return this.form(data, 'ticket'); }
      if (data.type === 5 && /^cb3:form:[a-f0-9]{24}$/.test(custom)) {
        const form = d.forms.find(f => f.nonce === custom.slice(9) && f.actorId === actorId && f.expiresAt > this.now() && ['report','ticket'].includes(f.kind));
        assert(form, 'Dieses Formular ist abgelaufen oder gehört zu einer anderen Person.', 'forbidden', 403);
        if (form.kind === 'report') assert(this.validReportFlow(form, data, d) && (!Object.hasOwn(form, 'category') || Object.hasOwn(REPORT_CATEGORIES, form.category)), 'Diese Meldeauswahl ist nicht mehr gültig.', 'forbidden', 403);
        const entries = (data.data.components || []).flatMap(row => row.components || []), allowed = form.kind === 'report' ? ['reason','details'] : ['reason','subject'];
        assert(entries.length <= 2 && entries.every(c => allowed.includes(c.custom_id) && typeof c.value === 'string') && new Set(entries.map(c => c.custom_id)).size === entries.length, 'Das Formular enthält ungültige Angaben.');
        const fields = Object.fromEntries(entries.map(c => [c.custom_id, c.value]));
        const reason = text(fields.reason || '', 1000, 'Begründung', 10), details = text(fields.details || '', 1000, 'Zusatzangaben');
        const subject = form.kind === 'ticket' ? text(fields.subject || '', 80, 'Betreff', 3) : '';
        this.userLimit(actorId, 'submit');
        return this.defer(data, async () => {
          this.mutate(current => { const index = current.forms.findIndex(f => f.nonce === form.nonce && f.actorId === actorId && f.expiresAt > this.now() && (form.kind !== 'report' || this.validReportFlow(f, data, current))); assert(index >= 0, 'Dieses Formular wurde bereits abgesendet oder ist nicht mehr gültig.'); current.forms.splice(index, 1); });
          return form.kind === 'report' ? this.submitReport(data, form.targetId, reason, details, form.category ?? null) : this.openTicket(data, subject, reason);
        });
      }
      return ephemeral('Diese Community-Aktion wird nicht unterstützt.');
    } catch (error) { return ephemeral(safeError(error)); }
  }
  async submitReport(data, targetId, reason, details, category = null) {
    assert(category === null || Object.hasOwn(REPORT_CATEGORIES, category), 'Die Art des Vorfalls ist ungültig.');
    const settings = this.data().settings.reports; assert(settings.enabled, 'Das Meldesystem ist ausgeschaltet.');
    const auth = await this.authority(null, 0n, settings.channelId); this.privateInbox(auth, settings.staffRoleIds);
    const target = await this.request(null, 'GET', `/guilds/${auth.guild.id}/members/${targetId}`);
    assert(target?.user?.id === targetId, 'Das gemeldete Mitglied wurde nicht gefunden.');
    const record = { id: randomUUID(), targetId, targetName: safeName(target.user.global_name || target.user.username), reporterId: data.member.user.id, category, categoryLabel: category === null ? 'Nicht angegeben' : REPORT_CATEGORIES[category], reason, details, status: 'open', createdAt: this.now(), action: null, reviewReason: '' };
    this.mutate(d => { assert(d.settings.reports.enabled && d.settings.reports.channelId === settings.channelId && JSON.stringify(d.settings.reports.staffRoleIds) === JSON.stringify(settings.staffRoleIds), 'Der Meldeeingang wurde inzwischen geändert. Bitte neu beginnen.'); assert(d.reports.length < 1000, 'Der Meldeeingang ist voll. Bitte direkt das Team kontaktieren.', 'capacity', 503); d.reports.unshift(record); });
    try { await this.post(null, auth, { embeds: [{ title: 'Neue vertrauliche Meldung', color: 0xD4AF37, description: reason, fields: [{ name: 'Gemeldetes Mitglied', value: safeName(record.targetName) + ' · ' + targetId }, { name: 'Art des Vorfalls', value: record.categoryLabel }, { name: 'Meldende Person', value: record.reporterId }, { name: 'Zusatzangaben', value: details || 'Keine' }], footer: { text: 'Meldung ' + record.id } }], allowed_mentions: { parse: [] } }); }
    catch { this.mutate(d => { d.reports.find(r => r.id === record.id).notificationFailed = true; }); }
    return 'Deine Meldung wurde vertraulich gespeichert. Das Team kann sie im Control Center prüfen.';
  }
  async moderate(context, payload) {
    assert(payload.confirm === true && ['kick', 'ban'].includes(payload.operation), 'Bitte die Moderationsaktion ausdrücklich bestätigen.');
    const reason = text(payload.reason, 500, 'Moderationsgrund', 5);
    const report = this.data().reports.find(r => r.id === payload.reportId); assert(report && report.status === 'open', 'Diese Meldung ist nicht mehr offen.');
    const auth = await this.authority(context, payload.operation === 'kick' ? FLAGS.KICK : FLAGS.BAN); await this.target(context, auth, report.targetId);
    this.current(context); this.mutate(d => { const row = d.reports.find(r => r.id === report.id); assert(row.status === 'open', 'Diese Meldung wird bereits bearbeitet.', 'conflict', 409); row.status = 'processing'; row.reviewReason = reason; row.action = payload.operation; });
    try {
      await this.request(context, payload.operation === 'kick' ? 'DELETE' : 'PUT', `/guilds/${auth.guild.id}/${payload.operation === 'kick' ? 'members' : 'bans'}/${report.targetId}`, payload.operation === 'ban' ? { delete_message_seconds: 0 } : undefined);
      this.mutate(d => { const row = d.reports.find(r => r.id === report.id); row.status = 'resolved'; row.reviewedAt = this.now(); });
    } catch (error) { this.mutate(d => { d.reports.find(r => r.id === report.id).status = !(error instanceof AppError) || error.kind === 'uncertain' ? 'uncertain' : 'open'; }); throw error; }
    try { this.store.audit(context.user.id, 'community.' + payload.operation, report.targetId, { reportId: report.id }); } catch { /* The moderation succeeded; do not prompt a duplicate retry. */ }
    return { reports: this.data().reports.slice(0, 200) };
  }
  voiceList() { return { ready: this.service.botGateway?.status().ready === true, members: this.service.botGateway?.voiceMembers?.() || [] }; }
  async voiceControl(context, payload) {
    assert(payload.confirm === true && ['mute', 'unmute', 'disconnect'].includes(payload.operation), 'Bitte die Voice-Aktion ausdrücklich bestätigen.');
    text(payload.reason, 500, 'Begründung', 3); discordId(payload.userId);
    const voice = this.voiceList(); assert(voice.ready && voice.members.some(m => m.userId === payload.userId), 'Dieses Mitglied ist aktuell nicht im bekannten Sprachkanal.', 'conflict', 409);
    const auth = await this.authority(context, payload.operation === 'disconnect' ? FLAGS.MOVE : FLAGS.MUTE); await this.target(context, auth, payload.userId);
    await this.request(context, 'PATCH', `/guilds/${auth.guild.id}/members/${payload.userId}`, payload.operation === 'disconnect' ? { channel_id: null } : { mute: payload.operation === 'mute' });
    this.service.botGateway?.applyVoiceControl?.(payload.userId, payload.operation); return this.voiceList();
  }
  async openTicket(data, subject, reason) {
    const userId = data.member.user.id, settings = this.data().settings.tickets; assert(settings.enabled, 'Das Ticketsystem ist ausgeschaltet.');
    const existing = this.data().tickets.find(t => t.userId === userId && ['open', 'creating', 'uncertain'].includes(t.status));
    if (existing) return existing.channelId ? 'Dein offenes Ticket: <#' + existing.channelId + '>' : 'Deine Ticket-Erstellung wird bereits bearbeitet. Bitte das Team kontaktieren.';
    const auth = await this.authority(null, FLAGS.MANAGE_CHANNELS); this.staffRoles(auth, settings.staffRoleIds);
    if (settings.categoryId) { const category = await this.request(null, 'GET', '/channels/' + settings.categoryId); assert(category.guild_id === auth.guild.id && category.type === 4, 'Die Ticketkategorie ist nicht mehr gültig.'); }
    const record = { id: randomUUID(), userId, channelId: null, status: 'creating', createdAt: this.now(), closedAt: null };
    this.mutate(d => { assert(d.tickets.length < 1000, 'Der Ticketbereich ist voll.', 'capacity', 503); assert(!d.tickets.some(t => t.userId === userId && ['open', 'creating', 'uncertain'].includes(t.status)), 'Es existiert bereits ein Ticket.'); d.tickets.unshift(record); });
    const permissions = [
      { id: auth.guild.id, type: 0, deny: P.VIEW_CHANNEL.toString(), allow: '0' },
      { id: userId, type: 1, allow: MEMBER_ACCESS.toString(), deny: '0' },
      { id: auth.bot.id, type: 1, allow: (MEMBER_ACCESS | P.EMBED_LINKS | FLAGS.MANAGE_CHANNELS).toString(), deny: '0' },
      ...settings.staffRoleIds.map(id => ({ id, type: 0, allow: MEMBER_ACCESS.toString(), deny: '0' })),
    ];
    try {
      const channel = await this.request(null, 'POST', '/guilds/' + auth.guild.id + '/channels', { name: 'ticket-' + userId.slice(-6), type: 0, ...(settings.categoryId ? { parent_id: settings.categoryId } : {}), permission_overwrites: permissions, topic: 'Privates Ticket ' + record.id });
      assert(CID.test(channel?.id || '') && channel.guild_id === auth.guild.id, 'Discord hat das Ticket nicht bestätigt.', 'uncertain', 502);
      this.mutate(d => { Object.assign(d.tickets.find(t => t.id === record.id), { channelId: channel.id, status: 'open' }); });
      try { await this.request(null, 'POST', '/channels/' + channel.id + '/messages', { content: `<@${userId}>`, embeds: [{ title: subject, description: reason, color: 0xD4AF37 }], allowed_mentions: { parse: [], users: [userId] } }); } catch { /* The channel is real and must not be duplicated. */ }
      return 'Dein privates Ticket wurde erstellt: <#' + channel.id + '>';
    } catch (error) { this.mutate(d => { const row = d.tickets.find(t => t.id === record.id); if (row.status === 'creating') row.status = !(error instanceof AppError) || error.kind === 'uncertain' ? 'uncertain' : 'failed'; }); throw error; }
  }
  async closeTicket(context, payload) {
    assert(payload.confirm === true, 'Bitte das Schließen ausdrücklich bestätigen.'); text(payload.reason, 500, 'Begründung', 3);
    const ticket = this.data().tickets.find(t => t.id === payload.ticketId); assert(ticket?.status === 'open' && CID.test(ticket.channelId), 'Dieses Ticket ist nicht offen.');
    const auth = await this.authority(context, FLAGS.MANAGE_CHANNELS, ticket.channelId);
    assert(auth.channel.topic === 'Privates Ticket ' + ticket.id, 'Der Kanal entspricht nicht mehr diesem Ticket.', 'conflict', 409);
    const overwrite = { id: ticket.userId, type: 1, allow: (P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY).toString(), deny: (P.SEND_MESSAGES | (1n << 38n) | (1n << 35n) | (1n << 36n)).toString() };
    const permissions = (auth.channel.permission_overwrites || []).filter(row => !(row.type === 1 && row.id === ticket.userId)); permissions.push(overwrite);
    await this.request(context, 'PATCH', '/channels/' + ticket.channelId, { name: ('geschlossen-' + ticket.userId.slice(-6)).slice(0, 100), permission_overwrites: permissions });
    this.mutate(d => { const row = d.tickets.find(t => t.id === ticket.id); row.status = 'closed'; row.closedAt = this.now(); }); return { tickets: this.data().tickets.slice(0, 200) };
  }
  async gatewayIntents() {
    let intents = 129;
    const settings = this.data().settings;
    if (!settings.welcome.enabled && !settings.counter.enabled && !this.service.autoJoinRole?.requiredMembers()) { this.runtime.membersIntentRequired = false; return intents; }
    this.runtime.membersIntentRequired = true;
    try {
      const app = await this.request(null, 'GET', '/oauth2/applications/@me');
      this.runtime.membersIntentAllowed = app?.id === COMMUNITY_BOT_ID && Number.isSafeInteger(app.flags) && (app.flags & ((1 << 14) | (1 << 15))) !== 0;
      this.runtime.memberIntentMessage = this.runtime.membersIntentAllowed ? 'Mitgliederereignisse sind freigegeben.' : 'Server Members Intent muss im Discord Developer Portal freigegeben werden. Voice und Musik bleiben aktiv.';
      if (this.runtime.membersIntentAllowed) intents |= 2;
    } catch { this.runtime.membersIntentAllowed = false; this.runtime.memberIntentMessage = 'Mitgliederzugriff konnte nicht geprüft werden; Voice und Musik laufen ohne diesen Zusatz weiter.'; }
    return intents;
  }
  gatewayEvent(packet) {
    if (packet.op !== 0 || (packet.d?.guild_id !== this.config.discordGuildId && packet.d?.id !== this.config.discordGuildId)) return;
    if (['GUILD_CREATE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_REMOVE'].includes(packet.t)) this.counterPending = true;
    if (packet.t !== 'GUILD_MEMBER_ADD' || !this.data().settings.welcome.enabled || !CID.test(packet.d.user?.id || '') || packet.d.user.bot) return;
    const joinedAt = packet.d.joined_at; if (!Number.isFinite(Date.parse(joinedAt))) return;
    const key = packet.d.user.id + ':' + joinedAt; let claimed = false;
    this.mutate(d => { d.joins = d.joins.slice(-1000); if (!d.joins.includes(key)) { d.joins.push(key); claimed = true; } });
    if (claimed && this.pending.size < 100) this.track((async () => {
      const settings = this.data().settings.welcome; if (!settings.enabled) return;
      const auth = await this.authority(null, 0n, settings.channelId);
      if (!this.data().settings.welcome.enabled || this.data().settings.welcome.channelId !== settings.channelId) return;
      await this.post(null, auth, this.welcomeMessage(settings, packet.d.user, auth.guild));
    })().catch(() => { this.runtime.lastError = 'Eine automatische Begrüßung konnte nicht bestätigt werden. Sie wird nicht unkontrolliert doppelt gesendet.'; }));
  }
  async updateCounter(context, force = false) {
    const settings = this.data().settings.counter; assert(settings.enabled, 'Der Mitgliederzähler ist ausgeschaltet.');
    if (!force && this.runtime.lastCounterAt && this.now() - this.runtime.lastCounterAt < 600_000) return { deferred: true };
    const auth = await this.authority(context, FLAGS.MANAGE_CHANNELS, settings.channelId);
    const count = Number(auth.guild.member_count ?? auth.guild.approximate_member_count);
    assert(Number.isSafeInteger(count) && count >= 0, 'Discord hat keine gültige Mitgliederzahl geliefert.', 'network', 502);
    const name = settings.nameTemplate.replaceAll('{count}', String(count)); assert(name.length >= 1 && name.length <= 100, 'Der Zählername ist zu lang.');
    if (auth.channel.name !== name) await this.request(context, 'PATCH', '/channels/' + settings.channelId, { name });
    this.runtime.lastCounterAt = this.now(); this.runtime.memberCount = count; this.counterPending = false; return { count, name };
  }
  track(promise) { this.pending.add(promise); promise.finally(() => this.pending.delete(promise)).catch(() => {}); return promise; }
  start() { if (this.timer) return; this.stopping = false; this.timer = this.setTimer(() => this.track(this.tick().catch(() => { this.runtime.lastError = 'Ein automatischer Community-Schritt konnte nicht abgeschlossen werden.'; })), 60_000); this.timer?.unref?.(); }
  async tick() {
    if (this.tickRunning || this.stopping) return; this.tickRunning = true;
    try {
      if (this.data().settings.counter.enabled && (this.counterPending || !this.runtime.lastCounterAt || this.now() - this.runtime.lastCounterAt > 600_000)) {
        try { await this.updateCounter(null); } catch { this.runtime.lastError = 'Der Mitgliederzähler konnte noch nicht aktualisiert werden.'; }
      }
      const d = this.data(), birthday = d.publications.birthday;
      if (birthday && this.now() - (birthday.updatedAt || birthday.publishedAt) >= 6 * 3600_000) {
        try {
          const auth = await this.authority(null, 0n, birthday.channelId); this.sendable(auth);
          await this.request(null, 'PATCH', `/channels/${birthday.channelId}/messages/${birthday.messageId}`, this.birthdayMessage(d.settings.birthday));
          this.mutate(current => { if (current.publications.birthday?.messageId === birthday.messageId) current.publications.birthday.updatedAt = this.now(); });
        } catch { this.runtime.lastError = 'Der Geburtstagskalender in Discord konnte noch nicht aktualisiert werden.'; }
      }
      for (const event of this.data().events.filter(e => e.status === 'active' && Date.parse(e.endAt) <= this.now()).slice(0, 10)) {
        try {
          await this.authority(null, 0n, event.channelId);
          await this.request(null, 'PATCH', `/channels/${event.channelId}/messages/${event.messageId}`, { embeds: [{ title: (event.title + ' · beendet').slice(0, 256), description: 'Dieses Event ist abgelaufen. Ende: <t:' + Math.floor(Date.parse(event.endAt) / 1000) + ':F>', color: 0x777777 }], allowed_mentions: { parse: [] } });
          this.mutate(d => { const row = d.events.find(r => r.id === event.id); if (row) row.status = 'expired'; });
        } catch { this.runtime.lastError = 'Eine Eventankündigung konnte noch nicht als beendet markiert werden.'; }
      }
    } finally { this.tickRunning = false; }
  }
  async stop() { this.stopping = true; this.clearTimer(this.timer); this.timer = null; await Promise.allSettled([...this.pending]); }
}
