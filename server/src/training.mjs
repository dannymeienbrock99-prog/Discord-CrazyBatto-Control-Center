import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const COURSES = new Set(['creator', 'moderator']);
const STATUSES = new Set(['pending', 'accepted', 'rejected']);
const NOTICE = 'Deine Angaben sind nur für dich und Administratoren sichtbar. Die Anmeldung wird hier geprüft; es werden keine Nachrichten an TikTok, Discord oder andere externe Dienste versendet.';
export const TRAINING_LIMITS = Object.freeze({ name: 80, ageMin: 1, ageMax: 120, tiktokName: 100, discordName: 100 });

function fields(value, expected) {
  assert(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)),
  'Die Angaben sind unvollständig oder enthalten unbekannte Felder.');
}
function text(value, maximum, label, minimum = 1) {
  assert(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value), `${label} ist ungültig oder zu lang.`);
  const result = value.trim();
  assert(result.length >= minimum, `Bitte das Feld „${label}“ vollständig ausfüllen.`);
  return result;
}
async function body(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'],
    'Bitte unkomprimierte JSON-Daten senden.', 'validation', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; assert(size <= 16 * 1024, 'Die Anfrage ist zu groß.', 'validation', 413); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('validation', 'Die Anfrage enthält kein gültiges JSON.', 400); }
}
function view(row) {
  return { id: row.id, course: row.course, name: row.name, age: row.age, tiktokName: row.tiktok_name,
    discordName: row.discord_name, status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, reviewedAt: row.reviewed_at };
}

// Additive schema in the existing private account database. Training records do
// not grant application, team, upload or Discord permissions.
export class Training {
  constructor(accounts) {
    this.accounts = accounts; this.store = accounts.store; this.now = accounts.now;
    this.store.transaction(() => this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS training_registrations (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        course TEXT NOT NULL CHECK(course IN ('creator','moderator')),
        name TEXT NOT NULL, age INTEGER NOT NULL CHECK(typeof(age)='integer' AND age BETWEEN 1 AND 120),
        tiktok_name TEXT NOT NULL, discord_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        reviewed_at INTEGER, reviewed_by TEXT REFERENCES accounts(id));
      CREATE UNIQUE INDEX IF NOT EXISTS training_active_course
        ON training_registrations(user_id,course) WHERE status IN ('pending','accepted');
      CREATE INDEX IF NOT EXISTS training_user_created ON training_registrations(user_id,created_at,id);
      CREATE INDEX IF NOT EXISTS training_created ON training_registrations(created_at,id);
    `));
  }
  list(userId) {
    return this.store.all('SELECT * FROM training_registrations WHERE user_id=? ORDER BY created_at DESC,id DESC', userId).map(view);
  }
  adminList() {
    return this.store.all(`SELECT t.*,a.name AS account_name,a.email AS account_email,
      a.confirmed AS account_confirmed,a.suspended AS account_suspended
      FROM training_registrations t JOIN accounts a ON a.id=t.user_id
      ORDER BY t.created_at DESC,t.id DESC`).map(row => ({ ...view(row), user: {
      id: row.user_id, name: row.account_name, email: row.account_email,
      confirmed: !!row.account_confirmed, suspended: !!row.account_suspended
    } }));
  }
  ensureAvailable(userId, course, exceptId = '') {
    assert(!this.store.get(`SELECT id FROM training_registrations
      WHERE user_id=? AND course=? AND status IN ('pending','accepted') AND id<>?`, userId, course, exceptId),
    'Für diesen Kurs gibt es bereits eine offene oder angenommene Anmeldung.', 'training_duplicate', 409);
  }
  register(context, value) {
    fields(value, ['course', 'name', 'age', 'tiktokName', 'discordName']);
    assert(COURSES.has(value.course), 'Bitte Live-Creator oder Moderator auswählen.');
    const name = text(value.name, TRAINING_LIMITS.name, 'Name', 2);
    assert(Number.isSafeInteger(value.age) && value.age >= TRAINING_LIMITS.ageMin && value.age <= TRAINING_LIMITS.ageMax,
      'Bitte dein Alter als ganze Zahl zwischen 1 und 120 eingeben.');
    const tiktokName = text(value.tiktokName, TRAINING_LIMITS.tiktokName, 'TikTok-Name');
    const discordName = text(value.discordName, TRAINING_LIMITS.discordName, 'Discord-Name');
    const user = this.accounts.assertCurrent(context);
    this.accounts.limit('training:register:' + user.id, 10, 60 * 60 * 1000);
    return this.store.transaction(() => {
      this.accounts.assertCurrent(context);
      this.ensureAvailable(user.id, value.course);
      const id = randomUUID(), now = this.now();
      this.store.run(`INSERT INTO training_registrations
        (id,user_id,course,name,age,tiktok_name,discord_name,status,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',0,?,?)`, id, user.id, value.course, name, value.age, tiktokName, discordName, now, now);
      // The audit records the operation, never the applicant's age or handles.
      this.store.audit(user.id, 'training.registered', id, { course: value.course, status: 'pending' }, now);
      return view(this.store.get('SELECT * FROM training_registrations WHERE id=?', id));
    });
  }
  decide(context, id, value) {
    fields(value, ['status', 'expectedRevision']);
    assert(STATUSES.has(value.status), 'Bitte einen gültigen Anmeldestatus auswählen.');
    assert(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0, 'Der Versionsstand der Anmeldung ist ungültig.');
    const admin = this.accounts.assertCurrent(context, { admin: true });
    this.accounts.limit('training:review:' + admin.id, 100);
    return this.store.transaction(() => {
      this.accounts.assertCurrent(context, { admin: true });
      const row = this.store.get('SELECT * FROM training_registrations WHERE id=?', id);
      assert(row, 'Diese Schulungsanmeldung wurde nicht gefunden.', 'not_found', 404);
      assert(row.revision === value.expectedRevision, 'Diese Anmeldung wurde inzwischen geändert. Bitte die Liste neu laden.', 'conflict', 409);
      if (row.status === value.status) return view(row);
      if (value.status !== 'rejected') {
        const target = this.store.get('SELECT confirmed,suspended FROM accounts WHERE id=?', row.user_id);
        assert(target?.confirmed && !target.suspended, 'Das Konto muss bestätigt und entsperrt sein, bevor die Anmeldung geöffnet oder angenommen werden kann.', 'forbidden', 403);
        this.ensureAvailable(row.user_id, row.course, row.id);
      }
      assert(Number.isSafeInteger(row.revision + 1), 'Der Versionsstand kann nicht weiter geändert werden.', 'conflict', 409);
      const now = this.now(), pending = value.status === 'pending';
      this.store.run(`UPDATE training_registrations SET status=?,revision=revision+1,updated_at=?,reviewed_at=?,reviewed_by=? WHERE id=?`,
        value.status, now, pending ? null : now, pending ? null : admin.id, id);
      this.store.audit(admin.id, 'training.status_changed', id, { course: row.course, before: row.status, after: value.status }, now);
      return view(this.store.get('SELECT * FROM training_registrations WHERE id=?', id));
    });
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://local.invalid').pathname;
    const adminRoute = route === '/api/admin/training' || route.startsWith('/api/admin/training/');
    const context = await this.accounts.authenticateRequest(req, { mutation: !['GET', 'HEAD'].includes(req.method), requireAdmin: adminRoute });
    const send = (value, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && route === '/api/training') {
      const user = this.accounts.assertCurrent(context);
      send({ user: { id: user.id, name: user.name, email: user.email, isAdmin: user.isAdmin },
        registrations: this.list(user.id), notice: NOTICE, limits: TRAINING_LIMITS }); return true;
    }
    if (req.method === 'POST' && route === '/api/training/registrations') {
      send({ registration: this.register(context, await body(req)) }, 201); return true;
    }
    if (req.method === 'GET' && route === '/api/admin/training') {
      this.accounts.assertCurrent(context, { admin: true });
      send({ registrations: this.adminList(), notice: NOTICE, limits: TRAINING_LIMITS }); return true;
    }
    const entry = /^\/api\/admin\/training\/registrations\/([^/]+)$/.exec(route);
    if (req.method === 'PATCH' && entry && UUID.test(entry[1])) {
      send({ registration: this.decide(context, entry[1], await body(req)) }); return true;
    }
    throw new AppError('not_found', 'Diese Schulungsfunktion ist nicht vorhanden.', 404);
  }
}
