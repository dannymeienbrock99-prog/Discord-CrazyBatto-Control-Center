import fs from 'node:fs';
import { AppError, assert } from './errors.mjs';
import { validId } from './payloads.mjs';

const STATUSES = ['pending', 'approved', 'rejected', 'revoked'];
const decisionStatus = { approve: 'approved', reject: 'rejected', revoke: 'revoked' };
const transitions = { pending: ['approve', 'reject'], approved: ['revoke'], rejected: ['approve'], revoked: ['approve'] };
function textField(value, label) {
  assert(value === undefined || typeof value === 'string', label + ' muss Text enthalten.');
  const valueText = (value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  assert(valueText.length <= 500, label + ' darf höchstens 500 Zeichen enthalten.');
  return valueText;
}

export class Access {
  constructor(config, store, { now = Date.now } = {}) { this.config = config; this.store = store; this.now = now; }
  configured() {
    assert(this.config.accessConfigured && validId(this.config.ownerDiscordId), 'Die Betreiberfreigabe ist auf diesem Server noch nicht eingerichtet.', 'unconfigured', 503);
  }
  state(userId, data = this.store.data) {
    this.configured();
    assert(validId(userId), 'Bitte mit Discord anmelden.', 'auth', 401);
    const isOwner = userId === this.config.ownerDiscordId;
    const row = !isOwner && data.access.registrations[userId];
    const status = isOwner ? 'approved' : row?.status || 'unregistered';
    return { status, isOwner, canUseApp: status === 'approved', version: row?.version || 0,
      requestedAt: row?.requestedAt || null, updatedAt: row?.updatedAt || null,
      reviewedAt: row?.reviewedAt || null, reason: row?.reason || '' };
  }
  deny(access) {
    const messages = {
      unregistered: 'Registriere dich zuerst auf der Website der Crazy_Batto Discord App und beantrage den Zugang.',
      pending: 'Deine Registrierung wartet noch auf die Freigabe des Betreibers.',
      rejected: 'Deine Registrierung wurde abgelehnt. Bei Rückfragen wende dich an den Betreiber.',
      revoked: 'Dein Zugang wurde vom Betreiber gesperrt.'
    };
    const error = new AppError('access', messages[access.status] || 'Der Zugang ist nicht freigegeben.', 403);
    error.access = access; throw error;
  }
  requireApprovedUser(userId) {
    const access = this.state(userId);
    if (!access.canUseApp) this.deny(access);
    return access;
  }
  requireCurrentAppSession(session) {
    const current = session && this.store.data.sessions[session.hash];
    assert(current && current.userId === session.userId && current.expiresAt > this.now(), 'Die App-Anmeldung ist nicht mehr gültig. Bitte erneut mit Discord anmelden.', 'auth', 401);
  }
  requireApp(session) { this.requireCurrentAppSession(session); return this.requireApprovedUser(session.userId); }
  requireOwner(session) {
    this.configured(); this.requireCurrentAppSession(session);
    assert(session.userId === this.config.ownerDiscordId, 'Nur das konfigurierte Betreiberkonto darf diese Verwaltung verwenden.', 'forbidden', 403);
  }
  registration(row, data = this.store.data) {
    return { userId: row.userId, user: data.users[row.userId]?.user || row.user,
      status: row.status, version: row.version, note: row.note, reason: row.reason,
      requestedAt: row.requestedAt, updatedAt: row.updatedAt,
      reviewedAt: row.reviewedAt, reviewedBy: row.reviewedBy };
  }
  audit(draft, { actorId, userId, action, fromStatus, toStatus, fromVersion, toVersion, reason = '' }) {
    assert(draft.access.audit.length < 1_000_000, 'Das Freigabeprotokoll ist voll. Bitte den Serverbetreiber kontaktieren.', 'unconfigured', 503);
    const revision = ++draft.access.revision, at = this.now();
    draft.access.lastChangedAt = at;
    draft.access.audit.push({ revision, at, actorId, userId, action, fromStatus, toStatus, fromVersion, toVersion, reason });
  }
  register(userId, { note } = {}) {
    const access = this.state(userId), normalizedNote = textField(note, 'Die Nachricht');
    assert(this.store.data.users[userId]?.user, 'Die Discord-Identität konnte nicht bestätigt werden.', 'auth', 401);
    if (access.isOwner || access.status !== 'unregistered') return { ok: true, access };
    this.store.transaction(draft => {
      if (draft.access.registrations[userId]) return;
      assert(Object.keys(draft.access.registrations).length < 100_000, 'Der Registrierungsspeicher ist voll. Bitte den Betreiber kontaktieren.', 'unconfigured', 503);
      const now = this.now();
      draft.access.registrations[userId] = { userId, user: draft.users[userId].user, status: 'pending', version: 1,
        note: normalizedNote, reason: '', requestedAt: now, updatedAt: now, reviewedAt: null, reviewedBy: null };
      this.audit(draft, { actorId: userId, userId, action: 'register', fromStatus: 'unregistered', toStatus: 'pending', fromVersion: 0, toVersion: 1 });
    });
    return { ok: true, access: this.state(userId) };
  }
  counts(data = this.store.data) {
    const result = { pending: 0, approved: 0, rejected: 0, revoked: 0 };
    for (const row of Object.values(data.access.registrations)) if (row.userId !== this.config.ownerDiscordId && STATUSES.includes(row.status)) result[row.status]++;
    return result;
  }
  summary(session) {
    this.requireOwner(session);
    const counts = this.counts();
    let latestPendingAt = null;
    for (const row of Object.values(this.store.data.access.registrations)) if (row.userId !== this.config.ownerDiscordId && row.status === 'pending') latestPendingAt = Math.max(latestPendingAt || 0, row.requestedAt);
    return { ok: true, revision: this.store.data.access.revision, lastChangedAt: this.store.data.access.lastChangedAt,
      pendingCount: counts.pending, counts, latestPendingAt };
  }
  list(session, { status = 'all', limit = 100, offset = 0 } = {}) {
    this.requireOwner(session);
    assert(status === 'all' || STATUSES.includes(status), 'Dieser Registrierungsfilter ist ungültig.');
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200 && Number.isSafeInteger(offset) && offset >= 0, 'Die Seitenauswahl ist ungültig.');
    const rows = Object.values(this.store.data.access.registrations)
      .filter(row => row.userId !== this.config.ownerDiscordId && (status === 'all' || row.status === status))
      .sort((a, b) => b.requestedAt - a.requestedAt || a.userId.localeCompare(b.userId));
    return { ok: true, revision: this.store.data.access.revision, counts: this.counts(), total: rows.length,
      nextOffset: offset + limit < rows.length ? offset + limit : null,
      registrations: rows.slice(offset, offset + limit).map(row => this.registration(row)) };
  }
  decide(session, userId, { decision, expectedVersion, reason } = {}) {
    this.requireOwner(session);
    assert(validId(userId), 'Die Konto-ID ist ungültig.');
    assert(userId !== this.config.ownerDiscordId, 'Das Betreiberkonto wird ausschließlich über die Serverkonfiguration festgelegt.', 'forbidden', 403);
    assert(Object.hasOwn(decisionStatus, decision), 'Die Freigabeentscheidung ist ungültig.');
    assert(Number.isSafeInteger(expectedVersion) && expectedVersion >= 1, 'Die Version der angezeigten Anfrage fehlt.');
    const normalizedReason = textField(reason, 'Die Begründung');
    this.store.transaction(draft => {
      // Check again inside the same synchronous commit that writes the decision.
      this.requireOwner(session);
      const row = draft.access.registrations[userId];
      assert(row, 'Diese Registrierung ist nicht vorhanden.', 'not_found', 404);
      assert(row.version === expectedVersion, 'Diese Anfrage wurde inzwischen geändert. Bitte die Liste neu laden.', 'conflict', 409);
      assert(transitions[row.status]?.includes(decision), 'Diese Entscheidung passt nicht zum aktuellen Freigabestatus. Bitte die Liste neu laden.', 'conflict', 409);
      const fromStatus = row.status, fromVersion = row.version;
      row.status = decisionStatus[decision]; row.version++;
      row.reason = normalizedReason; row.updatedAt = this.now(); row.reviewedAt = this.now(); row.reviewedBy = session.userId;
      this.audit(draft, { actorId: session.userId, userId, action: decision, fromStatus, toStatus: row.status, fromVersion, toVersion: row.version, reason: normalizedReason });
    });
    return { ok: true, revision: this.store.data.access.revision, registration: this.registration(this.store.data.access.registrations[userId]) };
  }
  downloadInfo(userId = null) {
    let available = false;
    if (userId && this.config.accessConfigured && this.state(userId).canUseApp) {
      try { const stat = fs.lstatSync(this.config.apkPath); available = stat.isFile() && stat.size > 0; } catch { /* The private release has not been installed yet. */ }
    }
    return { available, url: '/portal/download', filename: this.config.apkFilename, version: this.config.apkVersion };
  }
}
