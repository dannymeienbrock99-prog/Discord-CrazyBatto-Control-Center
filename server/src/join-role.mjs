import { AppError, assert, safeMessage } from './errors.mjs';
import { has, basePermissions } from './permissions.mjs';
import { CID, discordId } from './community-schema.mjs';

export const JOIN_ROLE_ACTIONS = Object.freeze(['joinrole.state', 'joinrole.save']);
const KEY = 'control_join_role_v1', MANAGE_ROLES = 1n << 28n;
const FRESH_JOIN = 5 * 60_000, RETENTION = 7 * 86400_000, ACTIVE_LIMIT = 250;
const ACTIVE = new Set(['waiting', 'queued', 'assigning']);
const STATES = new Set([...ACTIVE, 'assigned', 'already_present', 'failed', 'uncertain', 'cancelled', 'departed', 'expired']);
const normalize = name => String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const teamName = name => /(?:^|\s)(?:king|könig|admin\w*|moderator\w*|mod|staff|team|owner|besitzer)(?:\s|$)/u.test(normalize(name));
const message = error => error instanceof AppError ? safeMessage(error.message) : 'Discord konnte den Vorgang nicht eindeutig bestätigen.';
function fields(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'Bitte vollständige und gültige Beitrittsrollen-Einstellungen senden.');
}

export class JoinRole {
  constructor(service, { now, setTimer = setInterval, clearTimer = clearInterval } = {}) {
    this.service = service; this.community = service.communityControl; this.store = service.accounts.store;
    this.now = now || (() => this.community.now()); this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.adminQueue = Promise.resolve(); this.deliveryQueue = Promise.resolve(); this.pending = new Set(); this.scheduled = new Set();
    this.timer = null; this.stopping = false; this.ticking = false;
    this.intentCheck = null; this.lastIntentCheckAt = -Infinity; this.lastRejectedRecoveryAt = -Infinity;
  }
  data() {
    const raw = this.store.setting(KEY);
    if (!raw) return { revision: 0, settings: { enabled: false, roleId: '' }, activatedAt: null, records: [], lastAttemptAt: null, lastSuccessAt: null, lastError: null };
    let value; try { value = JSON.parse(raw); } catch { throw new AppError('storage', 'Die Beitrittsrollen-Einstellungen können nicht gelesen werden.', 503); }
    assert(value && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.settings && typeof value.settings.enabled === 'boolean' && typeof value.settings.roleId === 'string'
      && (!value.settings.roleId || CID.test(value.settings.roleId)) && (!value.settings.enabled || (CID.test(value.settings.roleId) && Number.isFinite(value.activatedAt)))
      && Array.isArray(value.records) && value.records.length <= 1000 && value.records.every(row => row && CID.test(row.userId || '') && CID.test(row.roleId || '') && Number.isFinite(row.joinedAt) && Number.isSafeInteger(row.revision) && STATES.has(row.status) && row.key === `${row.userId}:${row.joinedAt}`),
    'Die gespeicherten Beitrittsrollen-Daten sind ungültig.', 'storage', 503);
    return value;
  }
  mutate(fn) { return this.store.transaction(() => { const value = this.data(); const result = fn(value); this.store.setSetting(KEY, JSON.stringify(value)); return result; }); }
  current(context) { assert(context, 'Bitte mit einem Administratorkonto anmelden.', 'auth', 401); this.community.current(context); this.community.identity(); }
  requiredMembers() { return this.data().settings.enabled; }
  protectedRoles() {
    const settings = this.community.data().settings, devices = this.service.deviceRoles?.data()?.mapping || {};
    return new Set([devices.king, devices.moderator, this.service.guildSettings?.(this.service.config.discordGuildId)?.moderatorRoleId,
      settings.rules?.roleId, ...(settings.reports?.staffRoleIds || []), ...(settings.tickets?.staffRoleIds || [])].filter(Boolean));
  }
  eligible(auth, role) {
    if (!role || role.id === auth.guild.id || role.managed) return 'Die Rolle muss eine frei vergebbare Serverrolle sein.';
    if (this.protectedRoles().has(role.id) || teamName(role.name)) return 'Teamrollen und die separate Regel-Mitgliedsrolle sind für diese Automatik gesperrt.';
    if (!has(basePermissions(auth.guild, auth.member, this.now()), MANAGE_ROLES)) return 'Dem Bot fehlt „Rollen verwalten“.';
    if (Number(role.position) >= this.community.position(auth.guild, auth.member)) return 'Die Botrolle muss oberhalb dieser Rolle stehen.';
    try { this.community.roleAssignable(auth, role.id); } catch { return 'Die Rolle darf ausschließlich normale Chat- und Sprachrechte enthalten.'; }
    return '';
  }
  gatewayReady() { const gateway = this.service.botGateway; return gateway?.status().ready === true && (gateway.lastIntents & 2) !== 0 && gateway.membersIntentRejected !== true; }
  runtime(value) {
    const gateway = this.service.botGateway, status = gateway?.status(), allowed = this.community.runtime?.membersIntentAllowed === true;
    const active = this.gatewayReady(); let phase = 'disabled', text = 'Die automatische Beitrittsrolle ist ausgeschaltet.';
    if (value.settings.enabled) {
      if (gateway?.membersIntentRejected || !allowed) { phase = 'intent_required'; text = 'Server Members Intent muss für den Bot freigegeben sein. Es werden derzeit keine Beitrittsrollen vergeben.'; }
      else if (!status?.ready || !active) { phase = 'connecting'; text = 'Die Mitglieder-Verbindung wird vorbereitet. Bereits vorhandene Mitglieder werden nicht nachträglich bearbeitet.'; }
      else if (value.lastError) { phase = 'attention'; text = 'Die Automatik ist eingeschaltet. Mindestens ein Vorgang benötigt deine Prüfung.'; }
      else { phase = 'ready'; text = 'Neue Mitglieder erhalten die Rolle erst nach bestätigter Discord-Beitrittsprüfung.'; }
    }
    return { phase, message: text, membersIntentRequired: value.settings.enabled, membersIntentAllowed: allowed, membersIntentActive: active,
      waitingCount: value.records.filter(row => row.status === 'waiting').length, queuedCount: value.records.filter(row => ['queued', 'assigning'].includes(row.status)).length,
      lastAttemptAt: value.lastAttemptAt, lastSuccessAt: value.lastSuccessAt, lastError: value.lastError,
      recent: value.records.slice(-20).reverse().map(({ userId, joinedAt, roleId, status, updatedAt, message }) => ({ userId, joinedAt, roleId, status, updatedAt, message })) };
  }
  async refreshIntents({ force = false, recoverRejected = false } = {}) {
    if (this.intentCheck) return this.intentCheck;
    if (this.stopping || (!force && this.now() - this.lastIntentCheckAt < 60_000)) return;
    this.lastIntentCheckAt = this.now();
    const revision = this.data().revision, wasAllowed = this.community.runtime?.membersIntentAllowed === true;
    const task = (async () => {
      const desired = await this.community.gatewayIntents(), gateway = this.service.botGateway;
      if (this.stopping || this.data().revision !== revision || !gateway?.running) return;
      const newlyAllowed = !wasAllowed && this.community.runtime?.membersIntentAllowed === true;
      let recovered = false;
      if (desired === 131 && gateway.membersIntentRejected && (newlyAllowed || (recoverRejected && this.now() - this.lastRejectedRecoveryAt >= 300_000))) {
        gateway.membersIntentRejected = false; this.lastRejectedRecoveryAt = this.now(); recovered = true;
      }
      if ((gateway.lastIntents !== desired || recovered) && !gateway.membersIntentRejected) gateway.retry(0, { reset: true, problem: 'Die Beitrittsrolle wartet auf die aktualisierte Mitglieder-Verbindung.' });
    })();
    this.intentCheck = task;
    try { await task; } finally { if (this.intentCheck === task) this.intentCheck = null; }
  }
  async state(context, auth, checkIntents = true) {
    this.current(context);
    if (checkIntents && this.requiredMembers()) await this.refreshIntents({ force: true, recoverRejected: true });
    auth ||= await this.community.authority(context);
    const value = this.data(), roles = auth.guild.roles.map(role => { const reason = this.eligible(auth, role); return { id: role.id, name: role.name, eligible: !reason, reason }; });
    const runtime = this.runtime(value), selected = roles.find(role => role.id === value.settings.roleId);
    runtime.roleEligible = selected?.eligible === true; runtime.roleReason = selected?.reason || (value.settings.roleId && !selected ? 'Die gespeicherte Rolle ist nicht mehr vorhanden.' : '');
    if (value.settings.enabled && !runtime.roleEligible && ['ready', 'attention'].includes(runtime.phase)) { runtime.phase = 'attention'; runtime.message = runtime.roleReason; }
    this.current(context); return { revision: value.revision, settings: { ...value.settings }, roles, runtime };
  }
  async run(context, action, payload = {}) {
    this.current(context); assert(JOIN_ROLE_ACTIONS.includes(action), 'Unbekannte Beitrittsrollen-Aktion.');
    assert(!payload.guildId || payload.guildId === this.service.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (action === 'joinrole.state') { fields(payload, ['guildId'], []); return this.state(context); }
    fields(payload, ['guildId', 'expectedRevision', 'settings', 'confirm'], ['expectedRevision', 'settings', 'confirm']);
    fields(payload.settings, ['enabled', 'roleId']);
    assert(payload.confirm === true && typeof payload.settings.enabled === 'boolean', 'Bitte die Änderung ausdrücklich bestätigen.');
    const settings = { enabled: payload.settings.enabled, roleId: discordId(payload.settings.roleId, true) };
    assert(!settings.enabled || !!settings.roleId, 'Bitte eine Beitrittsrolle auswählen.');
    const task = this.adminQueue.then(async () => {
      this.current(context); const before = this.data();
      assert(Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision === before.revision, 'Die Beitrittsrolle wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      const auth = await this.community.authority(context, settings.enabled ? MANAGE_ROLES : 0n);
      if (settings.enabled) { const reason = this.eligible(auth, auth.guild.roles.find(role => role.id === settings.roleId)); assert(!reason, reason, 'forbidden', 403); }
      this.current(context);
      this.mutate(value => {
        assert(value.revision === before.revision, 'Die Beitrittsrolle wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
        value.revision++; value.settings = settings; value.activatedAt = settings.enabled ? this.now() : null; value.lastError = null;
        for (const row of value.records) if (ACTIVE.has(row.status)) {
          row.status = row.status === 'assigning' ? 'uncertain' : 'cancelled'; row.updatedAt = this.now();
          row.message = row.status === 'uncertain' ? 'Die Einstellung wurde während der Übertragung geändert. Bitte die Rolle in Discord prüfen.' : 'Durch geänderte Einstellungen beendet.';
        }
        this.prune(value);
      });
      try {
        await this.refreshIntents({ force: true });
      } catch { this.mutate(value => { value.lastError = 'Der Mitgliederzugriff konnte noch nicht geprüft werden.'; }); }
      return this.state(context, auth, false);
    });
    this.adminQueue = task.catch(() => {}); return task;
  }
  prune(value) {
    for (const row of value.records) if (ACTIVE.has(row.status) && this.now() - row.joinedAt > RETENTION) { row.status = 'expired'; row.updatedAt = this.now(); row.message = 'Die Beitrittsprüfung wurde nicht rechtzeitig bestätigt.'; }
    const active = value.records.filter(row => ACTIVE.has(row.status)), terminal = value.records.filter(row => !ACTIVE.has(row.status) && this.now() - row.updatedAt < RETENTION).slice(-750);
    value.records = [...active, ...terminal].sort((a, b) => a.updatedAt - b.updatedAt).slice(-1000);
  }
  row(key) { return this.data().records.find(row => row.key === key); }
  isCurrent(row) { const value = this.data(); return !this.stopping && value.settings.enabled && value.revision === row.revision && value.settings.roleId === row.roleId && ACTIVE.has(this.row(row.key)?.status); }
  record(row, status, text, extra = {}) {
    this.mutate(value => {
      const target = value.records.find(item => item.key === row.key);
      if (!target || target.revision !== row.revision || !ACTIVE.has(target.status)) return;
      Object.assign(target, { status, message: text, updatedAt: this.now(), ...extra });
      if (['assigned', 'already_present'].includes(status)) { value.lastSuccessAt = this.now(); value.lastError = null; }
      if (['failed', 'uncertain'].includes(status)) value.lastError = text;
    });
  }
  gatewayEvent(packet) {
    if (this.stopping || packet?.op !== 0 || packet.d?.guild_id !== this.service.config.discordGuildId) return;
    const member = packet.d, userId = member.user?.id; if (!CID.test(userId || '')) return;
    if (packet.t === 'GUILD_MEMBER_REMOVE') {
      this.mutate(value => { for (const row of value.records) if (row.userId === userId && ACTIVE.has(row.status)) { row.status = 'departed'; row.updatedAt = this.now(); row.message = 'Das Mitglied hat den Server wieder verlassen.'; } }); return;
    }
    if (!['GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE'].includes(packet.t) || member.user.bot) return;
    const value = this.data(); if (!value.settings.enabled) return;
    const joinedAt = Date.parse(member.joined_at), key = `${userId}:${joinedAt}`;
    if (!Number.isFinite(joinedAt) || joinedAt > this.now() + 5000) return;
    if (packet.t === 'GUILD_MEMBER_UPDATE') {
      const row = value.records.find(item => item.key === key);
      if (member.pending !== false || !row || row.status !== 'waiting' || !this.isCurrent(row)) return;
      this.record(row, 'queued', 'Die Discord-Beitrittsprüfung wird vor der Zuweisung erneut geprüft.', { nextAttemptAt: this.now() });
    } else {
      // Discord can also emit ADD for existing members. Never turn it into a backfill.
      if (joinedAt < value.activatedAt || this.now() - joinedAt > FRESH_JOIN || value.records.some(row => row.key === key)) return;
      this.mutate(data => {
        this.prune(data);
        if (!data.settings.enabled || data.revision !== value.revision || data.records.some(row => row.key === key)) return;
        if (data.records.filter(row => ACTIVE.has(row.status)).length >= ACTIVE_LIMIT) { data.lastError = 'Zu viele offene Beitritte. Weitere automatische Zuweisungen wurden nicht begonnen.'; return; }
        data.records.push({ key, userId, joinedAt, roleId: data.settings.roleId, revision: data.revision,
          status: member.pending === false ? 'queued' : 'waiting', attempts: 0, nextAttemptAt: this.now(), updatedAt: this.now(),
          message: member.pending === false ? 'Neuer Beitritt erkannt; Discord-Mitgliedschaft wird geprüft.' : 'Wartet auf die bestätigte Discord-Beitrittsprüfung.' });
      });
    }
    const row = this.row(key); if (row?.status === 'queued') return this.schedule(key);
  }
  schedule(key) {
    if (this.stopping || this.scheduled.has(key)) return;
    this.scheduled.add(key);
    const task = this.deliveryQueue.then(() => this.process(key)).catch(error => { try { const row = this.row(key); if (row) this.record(row, 'failed', message(error)); } catch { /* Storage failure must not initiate another role write. */ } });
    this.deliveryQueue = task; this.pending.add(task);
    task.finally(() => { this.pending.delete(task); this.scheduled.delete(key); }).catch(() => {}); return task;
  }
  memberAllowed(row, member, auth) {
    assert(member?.user?.id === row.userId && Array.isArray(member.roles) && !member.user.bot && member.user.id !== auth.guild.owner_id, 'Dieses Mitglied ist nicht für die automatische Beitrittsrolle geeignet.', 'forbidden', 403);
    assert(Date.parse(member.joined_at) === row.joinedAt, 'Der bekannte Beitritt passt nicht mehr zum aktuellen Mitglied.', 'departed', 409);
    assert(this.community.position(auth.guild, member) < this.community.position(auth.guild, auth.member), 'Das Mitglied steht in der Rollenliste auf oder über dem Bot.', 'forbidden', 403);
  }
  async process(key) {
    const row = this.row(key); if (!row || !this.isCurrent(row) || !this.gatewayReady() || !['queued', 'waiting'].includes(row.status)) return;
    if (this.now() - row.joinedAt > RETENTION) { this.record(row, 'expired', 'Der bekannte Beitritt ist zu alt für eine automatische Zuweisung.'); return; }
    let dispatched = false, putFinished = false;
    try {
      let auth = await this.community.authority(null, MANAGE_ROLES);
      let reason = this.eligible(auth, auth.guild.roles.find(role => role.id === row.roleId)); assert(!reason, reason, 'forbidden', 403);
      const route = `/guilds/${auth.guild.id}/members/${row.userId}`;
      let member = await this.community.request(null, 'GET', route); if (!this.isCurrent(row)) return;
      this.memberAllowed(row, member, auth);
      if (member.pending !== false) { this.record(row, 'waiting', 'Wartet auf die bestätigte Discord-Beitrittsprüfung.', { nextAttemptAt: this.now() + 300_000 }); return; }
      if (member.roles.includes(row.roleId)) { this.record(row, 'already_present', 'Die Rolle ist bereits vorhanden; es wurde nichts verändert.'); return; }
      // Re-read role permissions and membership immediately before the sole role mutation.
      auth = await this.community.authority(null, MANAGE_ROLES); if (!this.isCurrent(row)) return;
      reason = this.eligible(auth, auth.guild.roles.find(role => role.id === row.roleId)); assert(!reason, reason, 'forbidden', 403);
      member = await this.community.request(null, 'GET', route); if (!this.isCurrent(row)) return;
      this.memberAllowed(row, member, auth);
      if (member.pending !== false) { this.record(row, 'waiting', 'Die Beitrittsprüfung ist noch nicht eindeutig abgeschlossen.', { nextAttemptAt: this.now() + 300_000 }); return; }
      if (member.roles.includes(row.roleId)) { this.record(row, 'already_present', 'Die Rolle ist bereits vorhanden; es wurde nichts verändert.'); return; }
      // Configured team roles can change independently of the join-role settings.
      reason = this.eligible(auth, auth.guild.roles.find(role => role.id === row.roleId)); assert(!reason, reason, 'forbidden', 403);
      if (!this.isCurrent(row)) return;
      this.mutate(value => { const target = value.records.find(item => item.key === key); target.status = 'assigning'; target.attempts++; target.updatedAt = this.now(); target.message = 'Rolle wird an Discord übertragen.'; value.lastAttemptAt = this.now(); });
      dispatched = true;
      await this.community.request(null, 'PUT', `${route}/roles/${row.roleId}`);
      putFinished = true;
      const verified = await this.community.request(null, 'GET', route); if (!this.isCurrent(row)) return;
      assert(verified?.user?.id === row.userId && !verified.user.bot && Date.parse(verified.joined_at) === row.joinedAt && verified.pending === false && Array.isArray(verified.roles) && verified.roles.includes(row.roleId), 'Discord hat die Rollenvergabe nicht eindeutig bestätigt. Bitte das Mitglied direkt in Discord prüfen.', 'uncertain', 502);
      this.record(row, 'assigned', 'Discord hat die Beitrittsrolle bestätigt.');
    } catch (error) {
      if (!this.isCurrent(row)) return;
      if (error?.status === 404 || error?.kind === 'departed') { this.record(row, 'departed', 'Das Mitglied ist nicht mehr unter diesem Beitritt auf dem Server.'); return; }
      const definite = error instanceof AppError && ['forbidden', 'auth', 'permanent', 'rate_limited', 'network'].includes(error.kind);
      if (dispatched && (putFinished || !definite)) { this.record(row, 'uncertain', 'Discord hat die Rollenvergabe nicht eindeutig bestätigt. Bitte direkt in Discord prüfen; es erfolgt keine blinde Wiederholung.'); return; }
      const latest = this.row(key), attempts = (latest?.attempts || 0) + (dispatched ? 0 : 1);
      if (error instanceof AppError && ['network', 'rate_limited'].includes(error.kind) && attempts < 3) {
        this.record(row, 'queued', message(error), { attempts, nextAttemptAt: this.now() + Math.max(30_000, Math.min(error.retryAfterMs || 60_000, 7 * 86400_000)) });
      } else this.record(row, 'failed', message(error), { attempts });
    }
  }
  async tick() {
    if (this.stopping || this.ticking) return; this.ticking = true;
    try {
      this.mutate(value => this.prune(value));
      if (!this.requiredMembers()) return;
      await this.refreshIntents();
      if (!this.gatewayReady()) return;
      const records = this.data().records.filter(row => ['queued', 'waiting'].includes(row.status) && (row.nextAttemptAt || 0) <= this.now()).slice(0, 5);
      for (const row of records) { if (this.stopping) break; await this.schedule(row.key); }
    } finally { this.ticking = false; }
  }
  start() {
    if (this.timer) return; this.stopping = false;
    this.mutate(value => { for (const row of value.records) if (row.status === 'assigning') { row.status = 'uncertain'; row.updatedAt = this.now(); row.message = 'Beim Neustart war eine Rollenvergabe noch unbestätigt. Bitte direkt in Discord prüfen.'; value.lastError = row.message; } this.prune(value); });
    const tick = () => { const promise = this.tick().catch(() => {}); this.pending.add(promise); promise.finally(() => this.pending.delete(promise)).catch(() => {}); };
    this.timer = this.setTimer(tick, 30_000); this.timer?.unref?.(); tick();
  }
  async stop() { this.stopping = true; this.clearTimer(this.timer); this.timer = null; await Promise.allSettled([...this.pending]); }
}
