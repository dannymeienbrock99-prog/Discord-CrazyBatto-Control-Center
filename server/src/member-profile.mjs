import { AppError, assert } from './errors.mjs';
import { inspectImageBytes } from './payloads.mjs';
import { sha256 } from './store.mjs';

export function birthDate(value, now = Date.now()) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Bitte Tag, Monat und Jahr vollständig angeben.');
  const date = new Date(value + 'T12:00:00Z');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(now));
  assert(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value <= today && Number(value.slice(0, 4)) >= 1900,
    'Bitte ein gültiges Geburtsdatum eingeben, das nicht in der Zukunft liegt.');
  return value;
}

export class MemberProfile {
  constructor(accounts) {
    this.accounts = accounts; this.store = accounts.store;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS member_profiles (
      user_id TEXT PRIMARY KEY REFERENCES accounts(id), birth_date TEXT,
      avatar_id TEXT, avatar_type TEXT, avatar_size INTEGER, avatar_width INTEGER, avatar_height INTEGER,
      updated_at INTEGER NOT NULL);`);
    this.uploads = new Set();
  }
  row(id) { return this.store.get('SELECT * FROM member_profiles WHERE user_id=?', id); }
  complete(id) { return !!this.row(id)?.birth_date; }
  view(id) {
    const row = this.row(id);
    return { birthDate: row?.birth_date || '', complete: !!row?.birth_date,
      avatarUrl: row?.avatar_id ? '/api/account/profile/avatar?v=' + row.avatar_id : null };
  }
  hasImage(id) { return !!this.store.get('SELECT 1 FROM member_profiles WHERE avatar_id=?', id); }
  require(id) { assert(this.complete(id), 'Bitte ergänze zuerst dein Geburtsdatum in deinem Profil.', 'profile_incomplete', 403); }
  save(context, body) {
    assert(body && Object.keys(body).length === 1 && Object.hasOwn(body, 'birthDate'), 'Bitte nur das Geburtsdatum senden.');
    const value = birthDate(body.birthDate, this.accounts.now());
    const user = this.accounts.assertCurrent(context);
    this.store.run(`INSERT INTO member_profiles(user_id,birth_date,updated_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET birth_date=excluded.birth_date,updated_at=excluded.updated_at`, user.id, value, this.accounts.now());
    return this.view(user.id);
  }
  async upload(context, req) {
    const user = this.accounts.assertCurrent(context);
    assert(!this.uploads.has(user.id) && this.uploads.size < 4, 'Ein Profilbild wird bereits verarbeitet. Bitte kurz warten.', 'rate_limited', 429);
    const mimeType = String(req.headers['content-type'] || '').split(';')[0];
    assert(['image/jpeg','image/png','image/webp'].includes(mimeType) && !req.headers['content-encoding'], 'Bitte JPG, PNG oder WebP verwenden.', 'validation', 415);
    this.uploads.add(user.id);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; assert(size <= 2 * 1024 * 1024, 'Das Profilbild darf höchstens 2 MB groß sein.', 'validation', 413); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), dimensions = inspectImageBytes(bytes, mimeType);
      assert(dimensions.width <= 4096 && dimensions.height <= 4096 && dimensions.width * dimensions.height <= 16_000_000, 'Das Profilbild ist zu groß.');
      const id = 'gallery_' + sha256(bytes);
      // Shares the existing NAS image storage and deletion lock; no public birthday or VPS image copy.
      await this.accounts.gallery.exclusive(async () => {
        await this.accounts.imageStorage.put(id, bytes, { mimeType, ...dimensions });
        this.accounts.assertCurrent(context);
        this.store.run(`INSERT INTO member_profiles(user_id,avatar_id,avatar_type,avatar_size,avatar_width,avatar_height,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET avatar_id=excluded.avatar_id,avatar_type=excluded.avatar_type,avatar_size=excluded.avatar_size,
          avatar_width=excluded.avatar_width,avatar_height=excluded.avatar_height,updated_at=excluded.updated_at`, user.id, id, mimeType, size, dimensions.width, dimensions.height, this.accounts.now());
      });
      return this.view(user.id);
    } finally { this.uploads.delete(user.id); }
  }
  async read(context) {
    const user = this.accounts.assertCurrent(context), row = this.row(user.id);
    assert(row?.avatar_id, 'Du hast noch kein Profilbild.', 'not_found', 404);
    const bytes = await this.accounts.imageStorage.read(row.avatar_id, { mimeType: row.avatar_type, size: row.avatar_size, width: row.avatar_width, height: row.avatar_height });
    this.accounts.assertCurrent(context);
    return { bytes, mimeType: row.avatar_type };
  }
  remove(context) {
    const user = this.accounts.assertCurrent(context);
    this.store.run('UPDATE member_profiles SET avatar_id=NULL,avatar_type=NULL,avatar_size=NULL,avatar_width=NULL,avatar_height=NULL,updated_at=? WHERE user_id=?', this.accounts.now(), user.id);
    return this.view(user.id);
  }
}
