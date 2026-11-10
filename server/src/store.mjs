import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const emptyAccess = () => ({ version: 1, registrations: {}, audit: [], revision: 0, lastChangedAt: null });
const emptyDatabase = () => ({ version: 2, users: {}, sessions: {}, logins: {}, guildSettings: {}, operations: {}, access: emptyAccess(), portalSessions: {}, portalLogins: {} });
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(pid === process.pid ? '/proc/self/stat' : '/proc/' + pid + '/stat', 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + startTicks;
  } catch { return null; }
}

export function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
export function equalHash(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
    && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export class Vault {
  constructor(key) { this.key = key; }
  seal(value) {
    if (!this.key || this.key.length !== 32) throw new Error('Verschlüsselungsschlüssel fehlt.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
  }
  open(value) {
    if (!this.key || value?.v !== 1) throw new Error('Gespeicherte Anmeldung kann nicht gelesen werden.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.body, 'base64')), decipher.final()]).toString('utf8'));
  }
}

export function atomicWrite(filename, bytes) {
  const temp = filename + '.tmp-' + randomToken(8);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
    fs.chmodSync(filename, 0o600);
    // Windows cannot fsync directory handles; the file itself is flushed above.
    // Linux production retains the extra directory durability barrier.
    if (process.platform !== 'win32') {
      const dir = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export class Store {
  constructor(dataDir, { lock = true } = {}) {
    this.dataDir = dataDir;
    this.filename = path.join(dataDir, 'modstempel.json');
    this.lockPath = path.join(dataDir, 'server.lock');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true, mode: 0o700 });
    if (lock) this.acquireLock();
    try {
      this.data = fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename, 'utf8')) : emptyDatabase();
      if (this.data?.version !== 2 || ['users', 'sessions', 'logins', 'guildSettings', 'operations'].some(key => !this.data[key] || Array.isArray(this.data[key]) || typeof this.data[key] !== 'object')) throw new Error('Ungültige Datenbankstruktur.');
      // Additive migration: an existing 2.0 account is deliberately unregistered.
      // Never infer approval or ownership from previously authenticated accounts.
      if (this.data.access === undefined) this.data.access = emptyAccess();
      if (this.data.portalSessions === undefined) this.data.portalSessions = {};
      if (this.data.portalLogins === undefined) this.data.portalLogins = {};
      const access = this.data.access;
      if (!isRecord(access) || access.version !== 1 || !isRecord(access.registrations) || !Array.isArray(access.audit) || !Number.isSafeInteger(access.revision) || access.revision < 0 || !isRecord(this.data.portalSessions) || !isRecord(this.data.portalLogins)) throw new Error('Ungültige Freigabedatenbank.');
      for (const [id, entry] of Object.entries(access.registrations)) {
        if (!/^\d{17,20}$/.test(id) || !isRecord(entry) || entry.userId !== id || !['pending', 'approved', 'rejected', 'revoked'].includes(entry.status) || !Number.isSafeInteger(entry.version) || entry.version < 1) throw new Error('Ungültiger Freigabeeintrag.');
      }
      this.transaction(draft => {
        for (const record of Object.values(draft.operations)) {
          for (const phase of record.phases || []) {
            if (phase.status === 'sending') {
              phase.status = 'uncertain';
              record.status = 'uncertain';
              record.stage = phase.stage;
              record.error = 'Die Verbindung wurde während der Übertragung beendet. Bitte zuerst in Discord prüfen; die Zustellung ist unklar.';
            }
          }
        }
      });
    } catch (error) { this.close(); throw error; }
  }
  acquireLock() {
    try {
      const fd = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) })); fs.closeSync(fd);
      this.ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let entry;
      try { entry = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { throw new Error('Server-Sperrdatei ist ungültig; Zustand vor erneutem Start prüfen.'); }
      const pid = entry.pid;
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Server-Sperrdatei ist ungültig; Zustand vor erneutem Start prüfen.');
      // Linux container restarts commonly reuse PID 1. Its process-start identity
      // distinguishes a stale file from a second live instance with the same PID.
      const identity = processIdentity(pid);
      if (entry.identity && identity && entry.identity !== identity) { fs.unlinkSync(this.lockPath); return this.acquireLock(); }
      try { process.kill(pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { fs.unlinkSync(this.lockPath); return this.acquireLock(); }
        throw probe;
      }
      throw new Error('Diese Datenbank wird bereits von einem Server verwendet. Nur eine Instanz starten.');
    }
  }
  transaction(change) {
    const draft = structuredClone(this.data);
    const result = change(draft);
    atomicWrite(this.filename, Buffer.from(JSON.stringify(draft)));
    this.data = draft;
    return result;
  }
  imagePath(ref) {
    if (!/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(ref)) throw new Error('Ungültiger Bildverweis.');
    return path.join(this.dataDir, 'images', ref);
  }
  writeImage(ref, bytes) { atomicWrite(this.imagePath(ref), bytes); }
  readImage(ref) { return fs.readFileSync(this.imagePath(ref)); }
  close() {
    if (this.ownsLock) { try { fs.unlinkSync(this.lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } this.ownsLock = false; }
  }
}
