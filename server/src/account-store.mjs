import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// Separate from modstempel.json: existing Discord records are never migrated or
// silently interpreted as email registrations or administrator grants.
export class AccountStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.filename = path.join(dataDir, 'account.sqlite');
    this.db = new DatabaseSync(this.filename);
    fs.chmodSync(this.filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0,
        can_upload INTEGER NOT NULL DEFAULT 0, suspended INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, verified_at INTEGER);
      CREATE INDEX IF NOT EXISTS accounts_email ON accounts(email COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS account_sessions (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL CHECK(kind IN ('browser','native')), csrf TEXT NOT NULL,
        tokens TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS account_sessions_user ON account_sessions(user_id);
      CREATE TABLE IF NOT EXISTS app_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), app_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
        note TEXT NOT NULL, created_at INTEGER NOT NULL, reviewed_at INTEGER, reason TEXT NOT NULL DEFAULT '',
        UNIQUE(user_id,app_id));
      CREATE TABLE IF NOT EXISTS account_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_images (
        id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
        size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        created_by TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup_slots (
        slot TEXT PRIMARY KEY, revision INTEGER NOT NULL, images TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS upload_grants (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id),
        session_hash TEXT NOT NULL REFERENCES account_sessions(hash) ON DELETE CASCADE,
        generation TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS music_tracks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL,
        duration REAL NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
        mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
        uploaded_by TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_audit (
        id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT,
        details TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version=1;`);
  }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, target, details = {}, now = Date.now()) {
    this.run('INSERT INTO account_audit VALUES (?,?,?,?,?,?)', randomUUID(), actor || null, action, target || null, JSON.stringify(details), now);
  }
  setting(key) { return this.get('SELECT value FROM account_settings WHERE key=?', key)?.value; }
  setSetting(key, value) { this.run('INSERT INTO account_settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)); }
  close() { this.db.close(); }
}

export function accountView(row) {
  return row && { id: row.id, name: row.name, email: row.email, confirmed: !!row.confirmed,
    isAdmin: !!row.is_admin, canUpload: !!row.can_upload, suspended: !!row.suspended };
}
export function requestView(row) {
  return row && { id: row.id, appId: row.app_id, status: row.status, note: row.note,
    createdAt: row.created_at, reviewedAt: row.reviewed_at, reason: row.reason };
}
export function trackView(row) {
  return row && { id: row.id, title: row.title, artist: row.artist, duration: row.duration,
    filename: row.filename, size: row.size, mimeType: row.mime_type,
    uploadedBy: row.uploaded_by, url: '/api/music/tracks/' + row.id + '/stream' };
}
