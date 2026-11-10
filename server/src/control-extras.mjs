import { createHash, randomUUID } from 'node:crypto';
import { AppError, assert, safeMessage } from './errors.mjs';
import { COMMUNITY_BOT_ID as BOT, CID } from './community-schema.mjs';
import { P, has, channelPermissions } from './permissions.mjs';
import { AUDIO_MAX_BYTES, AUDIO_MAX_SECONDS, decodeAudio, prepareVoiceAudio } from './control-audio.mjs';

export const EXTRA_ACTIONS = Object.freeze(['extras.state', 'extras.automod.list', 'extras.automod.save', 'extras.audio.send']);
const KEY = 'control_extras_v1', VOICE_PERMISSION = 1n << 46n;
const MAX_HISTORY = 500, MAX_ACTIVE = 2000;
const fields = ['name', 'enabled', 'keywords', 'allowList', 'exemptRoleIds', 'exemptChannelIds', 'alertChannelId', 'blockMessage'];
const clean = (value, max = 100) => String(value || '').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, max);
const displayName = (member, fallback) => clean(member?.nick || member?.user?.global_name || member?.user?.username || fallback);
const exact = (value, allowed) => assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'Diese Anfrage enthält unbekannte Felder.');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const revision = rules => digest(canonical([...rules].sort((a, b) => a.id.localeCompare(b.id))));
const failure = error => error instanceof AppError ? safeMessage(error.message) : 'Discord hat den Vorgang nicht eindeutig bestätigt. Bitte den Status prüfen.';
const definite = error => error instanceof AppError && error.kind !== 'uncertain' && [400, 401, 403, 404, 413, 429].includes(error.status);

function text(value, max, label, required = false) {
  assert(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0) && clean(value, max) === value, `${label} ist ungültig oder zu lang.`);
  return value.trim();
}
function strings(value, maxCount, maxLength, label) {
  assert(Array.isArray(value) && value.length <= maxCount, `${label}: zu viele Einträge.`);
  const result = value.map(item => text(item, maxLength, label, true));
  assert(new Set(result).size === result.length, `${label} enthält doppelte Einträge.`); return result;
}
function ids(value, count, label) {
  const result = strings(value, count, 20, label);
  assert(result.every(item => CID.test(item)), `${label} enthält ungültige Discord-IDs.`); return result;
}
function settings(value) {
  exact(value, fields); assert(fields.every(key => Object.hasOwn(value, key)), 'Bitte alle Filtereinstellungen angeben.');
  assert(typeof value.enabled === 'boolean', 'Bitte den Aktivierungszustand angeben.');
  const keywords = strings(value.keywords, 100, 60, 'Filterwörter'); assert(keywords.length, 'Bitte mindestens ein Filterwort angeben.');
  assert(value.alertChannelId === '' || CID.test(value.alertChannelId), 'Der Alarmkanal ist ungültig.');
  return { name: text(value.name, 100, 'Regelname', true), enabled: value.enabled, keywords,
    allowList: strings(value.allowList, 100, 60, 'Erlaubte Wörter'), exemptRoleIds: ids(value.exemptRoleIds, 20, 'Ausgenommene Rollen'),
    exemptChannelIds: ids(value.exemptChannelIds, 50, 'Ausgenommene Kanäle'), alertChannelId: value.alertChannelId, blockMessage: text(value.blockMessage, 150, 'Blockierungshinweis') };
}
function editable(rule) {
  const metadata = rule.trigger_metadata || {};
  return rule.creator_id === BOT && rule.trigger_type === 1 && rule.event_type === 1 &&
    Object.keys(metadata).every(key => ['keyword_filter', 'allow_list', 'regex_patterns'].includes(key)) && !(metadata.regex_patterns || []).length &&
    (metadata.keyword_filter || []).length <= 100 && (metadata.allow_list || []).length <= 100 &&
    Array.isArray(rule.actions) && rule.actions.filter(action => action.type === 1).length === 1 && rule.actions.filter(action => action.type === 2).length <= 1 &&
    rule.actions.every(action => [1, 2].includes(action.type) && Object.keys(action.metadata || {}).every(key => key === (action.type === 1 ? 'custom_message' : 'channel_id')));
}
function summary(rule) {
  const canEdit = editable(rule);
  return { id: rule.id, name: clean(rule.name), enabled: rule.enabled === true, editable: canEdit,
    settings: canEdit ? { name: rule.name, enabled: rule.enabled, keywords: rule.trigger_metadata.keyword_filter || [], allowList: rule.trigger_metadata.allow_list || [],
      exemptRoleIds: rule.exempt_roles || [], exemptChannelIds: rule.exempt_channels || [], alertChannelId: rule.actions.find(action => action.type === 2)?.metadata?.channel_id || '',
      blockMessage: rule.actions.find(action => action.type === 1)?.metadata?.custom_message || '' } : null };
}

export class ControlExtras {
  constructor(service, { now = Date.now, prepareAudio = prepareVoiceAudio } = {}) {
    this.service = service; this.store = service.accounts.store; this.community = service.communityControl; this.now = now; this.prepareAudio = prepareAudio;
    this.queue = Promise.resolve(); this.pending = 0; this.connected = false; this.channels = new Map(); this.seenSequence = new Set(); this.membersAllowed = false;
    const data = this.data(); let changed = false;
    for (const row of data.active) { this.closeSession(data, row, row.lastSeenAt, false, 'restart'); changed = true; }
    data.active = [];
    for (const attempt of data.audioAttempts) if (attempt.status === 'sending') { attempt.status = 'uncertain'; attempt.error = 'Der Server wurde während des Versands neu gestartet. Bitte den Zielkanal prüfen.'; changed = true; }
    if (data.automodAttempt?.status === 'sending') { data.automodAttempt.status = 'uncertain'; changed = true; }
    if (changed) this.write(data);
  }
  data() {
    const raw = this.store.setting(KEY);
    if (!raw) return { version: 1, trackingStartedAt: this.now(), active: [], voiceHistory: [], memberHistory: [], audioAttempts: [], automodAttempt: null };
    try {
      const data = JSON.parse(raw);
      assert(data.version === 1 && Number.isFinite(data.trackingStartedAt) && ['active', 'voiceHistory', 'memberHistory', 'audioAttempts'].every(key => Array.isArray(data[key])), 'Ungültiger Verlauf.');
      assert(data.active.length <= MAX_ACTIVE && data.voiceHistory.length <= MAX_HISTORY && data.memberHistory.length <= MAX_HISTORY && data.audioAttempts.length <= 50, 'Ungültiger Verlauf.');
      for (const row of data.active) assert(CID.test(row.userId) && CID.test(row.channelId) && Number.isFinite(row.observedSince) && Number.isFinite(row.lastSeenAt), 'Ungültiger Sprachverlauf.');
      return data;
    } catch { throw new AppError('storage', 'Der gespeicherte Verlauf konnte nicht sicher gelesen werden.', 503); }
  }
  write(data) { this.store.setSetting(KEY, JSON.stringify(data)); }
  mutate(callback) { return this.store.transaction(() => { const data = this.data(); const result = callback(data); this.write(data); return result; }); }
  current(context) { assert(context, 'Eine Administrator-Anmeldung ist erforderlich.', 'auth', 401); this.community.current(context); this.community.identity(); }
  start() {
    if (this.timer) return;
    this.mutate(() => {});
    this.timer = setInterval(() => { try { if (this.connected && this.data().active.length) this.mutate(data => { for (const row of data.active) row.lastSeenAt = this.now(); }); } catch { this.connected = false; } }, 15_000);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; this.connectionState('stopped'); return this.queue; }
  closeSession(data, row, end, endKnown, reason) {
    const endedAt = Math.max(row.observedSince, end);
    data.voiceHistory.unshift({ id: randomUUID(), userId: row.userId, name: row.name, channelId: row.channelId, channelName: row.channelName,
      startedAt: row.observedSince, endedAt, seconds: Math.floor((endedAt - row.observedSince) / 1000), startKnown: row.startKnown, endKnown, reason });
    data.voiceHistory = data.voiceHistory.slice(0, MAX_HISTORY);
  }
  connectionState(phase) {
    if (phase === 'online' || phase === 'resumed') {
      this.connected = true;
      if (phase === 'resumed') this.snapshot(this.service.botGateway?.voiceMembers?.() || []);
      return;
    }
    this.connected = false;
    if (!this.data().active.length) return;
    this.mutate(data => { for (const row of data.active) this.closeSession(data, row, row.lastSeenAt, false, 'connection_gap'); data.active = []; });
  }
  snapshot(members) {
    const now = this.now();
    this.mutate(data => {
      for (const row of data.active) this.closeSession(data, row, row.lastSeenAt, false, 'snapshot');
      data.active = members.filter(row => CID.test(row.userId) && CID.test(row.channelId)).slice(0, MAX_ACTIVE).map(row => ({ userId: row.userId, name: clean(row.name || row.userId),
        channelId: row.channelId, channelName: this.channels.get(row.channelId) || row.channelId, observedSince: now, lastSeenAt: now, startKnown: false, bot: !!row.bot }));
    });
  }
  gatewayEvent(packet) {
    if (packet?.op !== 0) return;
    if (packet.t === 'READY') { this.seenSequence.clear(); return; }
    const event = packet.d;
    if (!event || (event.guild_id !== this.service.config.discordGuildId && event.id !== this.service.config.discordGuildId)) return;
    if (Number.isSafeInteger(packet.s)) {
      if (this.seenSequence.has(packet.s)) return;
      this.seenSequence.add(packet.s); if (this.seenSequence.size > 3000) this.seenSequence.delete(this.seenSequence.values().next().value);
    }
    if (packet.t === 'GUILD_CREATE') {
      this.connected = true;
      this.channels = new Map((event.channels || []).filter(row => CID.test(row.id)).map(row => [row.id, clean(row.name)]));
      const members = new Map((event.members || []).map(member => [member.user?.id, member]));
      this.snapshot((event.voice_states || []).map(row => ({ userId: row.user_id, channelId: row.channel_id, name: displayName(row.member || members.get(row.user_id), row.user_id), bot: !!(row.member || members.get(row.user_id))?.user?.bot })));
    } else if (packet.t === 'GUILD_DELETE') this.connectionState('unavailable');
    else if (['CHANNEL_CREATE', 'CHANNEL_UPDATE'].includes(packet.t) && CID.test(event.id)) this.channels.set(event.id, clean(event.name));
    else if (packet.t === 'VOICE_STATE_UPDATE' && this.connected && CID.test(event.user_id) && (!event.channel_id || CID.test(event.channel_id))) {
      this.mutate(data => {
        const old = data.active.find(row => row.userId === event.user_id), now = this.now();
        if (old?.channelId === event.channel_id) { old.lastSeenAt = now; old.name = displayName(event.member, old.name); return; }
        if (old) this.closeSession(data, old, now, true, event.channel_id ? 'moved' : 'left');
        data.active = data.active.filter(row => row.userId !== event.user_id);
        if (event.channel_id && data.active.length < MAX_ACTIVE) data.active.push({ userId: event.user_id, name: displayName(event.member, old?.name || event.user_id), channelId: event.channel_id,
          channelName: this.channels.get(event.channel_id) || event.channel_id, observedSince: now, lastSeenAt: now, startKnown: true, bot: !!event.member?.user?.bot });
      });
    } else if (['GUILD_MEMBER_ADD', 'GUILD_MEMBER_REMOVE'].includes(packet.t) && CID.test(event.user?.id)) {
      this.mutate(data => { data.memberHistory.unshift({ id: randomUUID(), userId: event.user.id, name: displayName(event, event.user.id), type: packet.t === 'GUILD_MEMBER_ADD' ? 'join' : 'remove',
        at: this.now(), reason: packet.t === 'GUILD_MEMBER_ADD' ? 'joined' : 'left_or_removed' }); data.memberHistory = data.memberHistory.slice(0, MAX_HISTORY); });
    }
  }
  async gatewayIntents() {
    const existing = await this.community.gatewayIntents();
    if (existing & 2) { this.membersAllowed = true; return existing; }
    try {
      const app = await this.community.request(null, 'GET', '/oauth2/applications/@me');
      this.membersAllowed = app?.id === BOT && Number.isSafeInteger(app.flags) && !!(app.flags & ((1 << 14) | (1 << 15)));
    } catch { this.membersAllowed = false; }
    return this.membersAllowed ? existing | 2 : existing;
  }
  state(context) {
    this.current(context); const data = this.data(), gateway = this.service.botGateway?.status?.() || { ready: false, message: 'Die Discord-Verbindung ist nicht verfügbar.' };
    const attempts = data.audioAttempts, last = attempts.at(-1);
    return { gateway: { ...gateway, membersEnabled: !!(this.service.botGateway?.lastIntents & 2) && !gateway.membersIntentRejected }, trackingStartedAt: data.trackingStartedAt,
      voiceMembers: data.active.map(({ lastSeenAt, ...row }) => ({ ...row, elapsedSeconds: Math.max(0, Math.floor(((this.connected ? this.now() : lastSeenAt) - row.observedSince) / 1000)) })),
      voiceHistory: data.voiceHistory, memberHistory: data.memberHistory,
      audio: { maxBytes: AUDIO_MAX_BYTES, maxSeconds: AUDIO_MAX_SECONDS, lastAttempt: last ? this.audioPublic(last) : null } };
  }
  audioPublic(attempt) { const { fingerprint, nonce, ...result } = attempt; return result; }
  async run(context, action, payload = {}) {
    this.current(context); assert(EXTRA_ACTIONS.includes(action), 'Unbekannte Zusatzfunktion.');
    exact(payload, action === 'extras.audio.send' ? ['guildId', 'channelId', 'name', 'mime', 'dataBase64', 'requestId', 'confirm'] : action === 'extras.automod.save' ? ['guildId', 'expectedRevision', 'ruleId', 'settings', 'confirm'] : ['guildId']);
    assert(payload.guildId === this.service.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (action === 'extras.state') return this.state(context);
    if (action === 'extras.automod.list') return this.listRules(context);
    assert(payload.confirm === true, 'Bitte die Aktion bestätigen.');
    assert(this.pending < 3, 'Bitte warten, bis der laufende Vorgang abgeschlossen ist.', 'busy', 429);
    const input = structuredClone(payload); this.pending++;
    const task = this.queue.then(() => { this.current(context); return action === 'extras.audio.send' ? this.sendAudio(context, input) : this.saveRule(context, input); });
    this.queue = task.catch(() => {}).finally(() => { this.pending--; }); return task;
  }
  async rawRules(context) {
    const rules = await this.community.request(context, 'GET', `/guilds/${this.service.config.discordGuildId}/auto-moderation/rules`);
    this.current(context);
    assert(Array.isArray(rules) && rules.length <= 100 && rules.every(rule => CID.test(rule?.id) && rule.guild_id === this.service.config.discordGuildId), 'Discord hat ungültige Filterregeln geliefert.', 'discord', 502);
    return rules;
  }
  async listRules(context) {
    await this.community.authority(context, P.MANAGE_GUILD);
    const rules = await this.rawRules(context); this.current(context);
    return { revision: revision(rules), rules: rules.map(summary) };
  }
  async saveRule(context, input) {
    assert(typeof input.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(input.expectedRevision), 'Bitte die Filterregeln zuerst neu laden.');
    assert(input.ruleId === '' || CID.test(input.ruleId), 'Die Filterregel ist ungültig.');
    const value = settings(input.settings), guildId = this.service.config.discordGuildId;
    let auth = await this.community.authority(context, P.MANAGE_GUILD);
    const roles = new Set(auth.guild.roles.map(role => role.id));
    assert(value.exemptRoleIds.every(role => roles.has(role)), 'Eine ausgenommene Rolle gehört nicht zu diesem Server.');
    const channels = await this.community.request(context, 'GET', `/guilds/${guildId}/channels`);
    assert(Array.isArray(channels), 'Die Kanäle konnten nicht geprüft werden.', 'discord', 502);
    const channelMap = new Map(channels.filter(channel => channel.guild_id === guildId).map(channel => [channel.id, channel]));
    assert(value.exemptChannelIds.every(channel => channelMap.has(channel)), 'Ein ausgenommener Kanal gehört nicht zu diesem Server.');
    if (value.alertChannelId) {
      const channel = channelMap.get(value.alertChannelId);
      assert(channel && [0, 5].includes(channel.type) && has(channelPermissions(auth.guild, auth.member, channel, this.now()), P.VIEW_CHANNEL | P.SEND_MESSAGES), 'Der Bot kann im Alarmkanal keine Meldungen senden.', 'forbidden', 403);
    }
    const rules = await this.rawRules(context);
    assert(revision(rules) === input.expectedRevision, 'Die Filterregeln wurden inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    const target = rules.find(rule => rule.id === input.ruleId);
    if (input.ruleId) assert(target && editable(target), 'Diese Regel kann hier nicht bearbeitet werden. Bitte die Discord-Servereinstellungen verwenden.', 'forbidden', 403);
    else assert(rules.filter(rule => rule.trigger_type === 1).length < 6, 'Discord erlaubt höchstens sechs eigene Wortfilter. Bitte eine bestehende Regel bearbeiten.');
    const previous = this.data().automodAttempt;
    if (!input.ruleId && previous && ['sending', 'uncertain'].includes(previous.status)) {
      const observed = rules.filter(rule => !previous.previousIds.includes(rule.id) && editable(rule) && canonical(summary(rule).settings) === canonical(previous.settings));
      assert(observed.length === 1, 'Die letzte Regelerstellung ist unklar. Bitte zuerst die Discord-Servereinstellungen prüfen. Es wird keine zweite Regel erstellt.', 'uncertain', 409);
      this.mutate(data => { data.automodAttempt.status = 'saved'; data.automodAttempt.ruleId = observed[0].id; });
      assert(canonical(value) === canonical(previous.settings), 'Die vorherige Regelerstellung wurde jetzt bestätigt. Bitte die Regeln neu laden und die nächste Änderung erneut prüfen.', 'conflict', 409);
      return { revision: revision(rules), rules: rules.map(summary) };
    }
    // Recheck authority after all reads; no queued network operation can outlive admin revocation.
    auth = await this.community.authority(context, P.MANAGE_GUILD, value.alertChannelId);
    if (value.alertChannelId) assert([0, 5].includes(auth.channel.type) && has(channelPermissions(auth.guild, auth.member, auth.channel, this.now()), P.VIEW_CHANNEL | P.SEND_MESSAGES), 'Der Bot hat keinen Zugriff mehr auf den Alarmkanal.', 'forbidden', 403);
    const latest = await this.rawRules(context);
    assert(revision(latest) === input.expectedRevision, 'Die Filterregeln wurden inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    this.current(context);
    const body = { name: value.name, event_type: 1, trigger_metadata: { keyword_filter: value.keywords, allow_list: value.allowList, regex_patterns: [] },
      actions: [{ type: 1, metadata: value.blockMessage ? { custom_message: value.blockMessage } : {} }, ...(value.alertChannelId ? [{ type: 2, metadata: { channel_id: value.alertChannelId } }] : [])],
      enabled: value.enabled, exempt_roles: value.exemptRoleIds, exempt_channels: value.exemptChannelIds };
    if (!input.ruleId) body.trigger_type = 1;
    if (!input.ruleId) this.mutate(data => { data.automodAttempt = { status: 'sending', ruleId: '', settings: value, previousIds: rules.map(rule => rule.id), at: this.now() }; });
    try {
      this.current(context);
      const saved = await this.community.request(context, input.ruleId ? 'PATCH' : 'POST', `/guilds/${guildId}/auto-moderation/rules${input.ruleId ? '/' + input.ruleId : ''}`, body);
      assert(CID.test(saved?.id) && saved.guild_id === guildId && saved.creator_id === BOT && (!input.ruleId || saved.id === input.ruleId), 'Discord hat die Filterregel nicht eindeutig bestätigt.', 'uncertain', 502);
      if (!input.ruleId) this.mutate(data => { data.automodAttempt.status = 'saved'; data.automodAttempt.ruleId = saved.id; });
    } catch (error) { if (!input.ruleId) this.mutate(data => { data.automodAttempt.status = definite(error) ? 'failed' : 'uncertain'; }); throw error; }
    return this.listRules(context);
  }
  canSendAudio(auth) {
    assert([0, 5].includes(auth.channel.type), 'Bitte einen Textkanal für die Sprachnachricht auswählen.');
    assert(has(channelPermissions(auth.guild, auth.member, auth.channel, this.now()), P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | VOICE_PERMISSION), 'Der Bot benötigt im Zielkanal Kanalzugriff, Nachrichten senden, Dateien anhängen und Sprachnachrichten senden.', 'forbidden', 403);
  }
  async sendAudio(context, input) {
    assert(CID.test(input.channelId) && typeof input.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.requestId), 'Kanal oder Versandkennung sind ungültig.');
    const decoded = decodeAudio(input), fingerprint = digest(input.channelId + ':' + digest(decoded.bytes));
    const existing = this.data().audioAttempts.find(attempt => attempt.requestId === input.requestId);
    if (existing) {
      assert(existing.fingerprint === fingerprint, 'Diese Versandkennung gehört zu einer anderen Aufnahme.', 'conflict', 409);
      if (existing.status === 'sent') { const auth = await this.community.authority(context, 0n, input.channelId); this.canSendAudio(auth); this.current(context); return this.audioPublic(existing); }
      assert(!['sending', 'uncertain'].includes(existing.status), 'Der vorherige Versand ist unklar. Bitte zuerst den Discord-Kanal prüfen; dieselbe Aufnahme wird nicht erneut gesendet.', 'uncertain', 409);
    }
    let auth = await this.community.authority(context, 0n, input.channelId); this.canSendAudio(auth);
    const prepared = await this.prepareAudio(input);
    assert(Buffer.isBuffer(prepared.bytes) && prepared.bytes.length <= AUDIO_MAX_BYTES && prepared.mime === 'audio/ogg' && prepared.durationSeconds > 0 && prepared.durationSeconds <= AUDIO_MAX_SECONDS && typeof prepared.waveform === 'string' && Buffer.from(prepared.waveform, 'base64').length <= 256, 'Die Audioverarbeitung hat ungültige Daten geliefert.', 'audio', 502);
    auth = await this.community.authority(context, 0n, input.channelId); this.canSendAudio(auth); this.current(context);
    const nonce = digest(input.requestId).slice(0, 24), attempt = { requestId: input.requestId, fingerprint, nonce, status: 'sending', channelId: input.channelId, name: clean(input.name, 180), at: this.now(), durationSeconds: prepared.durationSeconds, bytes: prepared.bytes.length, error: '' };
    this.mutate(data => {
      // Keep unresolved attempts durably, even when many completed clips are sent later.
      data.audioAttempts = data.audioAttempts.filter(row => row.requestId !== input.requestId);
      while (data.audioAttempts.length >= 50) {
        const index = data.audioAttempts.findIndex(row => !['sending', 'uncertain'].includes(row.status));
        assert(index >= 0, 'Zu viele unklare Sendungen. Bitte den Versandstatus prüfen.', 'conflict', 409); data.audioAttempts.splice(index, 1);
      }
      data.audioAttempts.push(attempt);
    });
    try {
      this.current(context);
      const sent = await this.service.discord.request('POST', `/channels/${input.channelId}/messages`, { payload: {
        flags: 1 << 13, nonce, enforce_nonce: true, allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        attachments: [{ id: '0', filename: 'voice-message.ogg', duration_secs: prepared.durationSeconds, waveform: prepared.waveform }]
      }, imageBytes: prepared.bytes, imageMeta: { mime: 'audio/ogg', name: 'voice-message.ogg' } });
      assert(CID.test(sent?.id) && sent.channel_id === input.channelId && sent.author?.id === BOT && sent.author?.bot === true && !sent.webhook_id && (sent.flags & (1 << 13)), 'Discord hat die Sprachnachricht nicht eindeutig bestätigt.', 'uncertain', 502);
      this.mutate(data => { const row = data.audioAttempts.find(item => item.requestId === input.requestId); Object.assign(row, { status: 'sent', messageId: sent.id, url: `https://discord.com/channels/${this.service.config.discordGuildId}/${input.channelId}/${sent.id}` }); });
    } catch (error) {
      this.mutate(data => { const row = data.audioAttempts.find(item => item.requestId === input.requestId); row.status = definite(error) ? 'failed' : 'uncertain'; row.error = failure(error); }); throw error;
    }
    this.current(context); return this.audioPublic(this.data().audioAttempts.find(row => row.requestId === input.requestId));
  }
}
