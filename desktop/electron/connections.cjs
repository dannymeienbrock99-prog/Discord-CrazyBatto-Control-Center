'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline, finished } = require('node:stream/promises');

const PROFILE_LIMIT = 100;
const ENTRY_LIMIT = 2000;
const FILE_LIMIT = 128 * 1024 * 1024;
class ConnectionError extends Error {}
const fail = message => { throw new ConnectionError(message); };
function text(value, limit, label, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) fail(`${label} ist ungültig.`);
  const result = value.trim();
  if (required && !result) fail(`${label} fehlt.`);
  return result;
}
function secret(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 4096 || /[\x00\r\n]/.test(value)) fail('Die Zugangsdaten sind ungültig.');
  return value;
}
function host(value) {
  let result = text(value, 253, 'Serveradresse').toLowerCase();
  if (result.startsWith('[') && result.endsWith(']')) result = result.slice(1, -1);
  if (net.isIP(result)) return result;
  if (!result.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail('Bitte nur den Hostnamen oder die IP-Adresse eingeben, ohne Protokoll und Pfad.');
  return result;
}
function port(value) {
  if (value == null || value === '') return 22;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) fail('Der Port ist ungültig.');
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) fail('Der Port muss zwischen 1 und 65535 liegen.');
  return result;
}
function baseUrl(value) {
  let url;
  try { url = new URL(text(value, 2048, 'Webadresse')); } catch { fail('Bitte eine gültige HTTPS-Webadresse eingeben.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('Die Webadresse muss HTTPS verwenden und darf keine Zugangsdaten oder URL-Parameter enthalten.');
  return url.href.replace(/\/$/, '');
}
function filename(value, windows = false) {
  const result = text(value, 255, 'Dateiname');
  if (result === '.' || result === '..' || /[\\/]/.test(result) || value !== result) fail('Der Dateiname ist ungültig.');
  if (windows && (/[<>:"|?*]/.test(result) || /[. ]$/.test(result) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(result))) fail('Dieser Dateiname kann unter Windows nicht gespeichert werden.');
  return result;
}
function remotePath(value) {
  const result = text(value, 4096, 'Serverpfad');
  if (!result.startsWith('/') || /\\/.test(result) || result.split('/').includes('..')) fail('Bitte einen absoluten Serverpfad ohne „..“ verwenden.');
  return path.posix.normalize(result);
}
function normalizeProfile(value, old) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Die Verbindung ist ungültig.');
  if (!['sftp', 'website', 'kori'].includes(value.kind)) fail('Bitte einen gültigen Verbindungstyp wählen.');
  const profile = { id: old?.id || randomUUID(), name: text(value.name, 100, 'Verbindungsname'), kind: value.kind,
    remember: value.remember === true, updatedAt: new Date().toISOString() };
  if (profile.kind === 'sftp') Object.assign(profile, { host: host(value.host), port: port(value.port), username: text(value.username, 128, 'Benutzername') });
  else Object.assign(profile, { baseUrl: baseUrl(value.baseUrl), username: text(value.username, profile.kind === 'website' ? 254 : 128, 'Benutzername', false) });
  return profile;
}
function destination(profile) {
  return JSON.stringify([profile.kind, profile.host || profile.baseUrl, profile.port || null, profile.username]);
}
function fingerprint(key) { return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`; }
function parseWinScpIni(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 2 * 1024 * 1024) fail('Die WinSCP-Datei ist zu groß oder ungültig.');
  const sessions = [];
  let current = null;
  const decode = value => { try { return decodeURIComponent(value); } catch { return value; } };
  for (const raw of input.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = /^Sessions\\/i.test(section[1]) ? { name: decode(section[1].slice(9)) } : null;
      if (current && current.name !== 'Default%20Settings' && current.name !== 'Default Settings') sessions.push(current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    // Deliberate allowlist: passwords, proxy credentials, keys and scripts are never imported.
    if (['HostName', 'PortNumber', 'UserName', 'FSProtocol'].includes(key)) current[key] = decode(line.slice(separator + 1));
  }
  const result = [];
  for (const session of sessions) {
    // WinSCP's stored enum: 0 = SCP, 1 = SFTP with SCP fallback, 2 = SFTP only.
    if (session.FSProtocol && !['1', '2'].includes(session.FSProtocol)) continue;
    try {
      const profile = normalizeProfile({ name: session.name, kind: 'sftp', host: session.HostName, port: session.PortNumber, username: session.UserName, remember: false });
      const { id, updatedAt, ...draft } = profile;
      result.push(draft);
      if (result.length >= PROFILE_LIMIT) break;
    } catch { /* Ignore incomplete or unsupported sessions. */ }
  }
  return result;
}

class ConnectionsService {
  constructor({ directory, safeStorage, dialog, getWindow = () => undefined, Client, operationTimeout = 30000 }) {
    this.directory = directory;
    this.crypto = safeStorage;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.Client = Client;
    this.operationTimeout = operationTimeout;
    this.file = path.join(directory, 'connections.json');
    this.memorySecrets = new Map();
    this.localRoots = new Set();
    this.localPath = null;
    this.active = null;
    fs.mkdirSync(directory, { recursive: true });
    this.data = { version: 1, profiles: [], secrets: {}, knownHosts: {} };
    if (fs.existsSync(this.file)) {
      try {
        if (fs.statSync(this.file).size > 1024 * 1024) throw new Error();
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.profiles) || data.profiles.length > PROFILE_LIMIT || !data.secrets || !data.knownHosts) throw new Error();
        this.data = data;
      } catch { fail('Die gespeicherten Verbindungen sind nicht lesbar. Die vorhandene Datei wurde nicht verändert.'); }
    }
  }
  persist(next = this.data) {
    const data = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(data) > 1024 * 1024) fail('Die gespeicherten Verbindungen sind zu groß.');
    try {
      fs.writeFileSync(`${this.file}.pending`, data, { mode: 0o600 });
      fs.renameSync(`${this.file}.pending`, this.file);
      this.data = next;
    } catch { fail('Die Verbindung konnte nicht lokal gespeichert werden.'); }
  }
  getProfile(id) {
    const profile = this.data.profiles.find(item => item.id === id);
    if (!profile) fail('Diese gespeicherte Verbindung wurde nicht gefunden.');
    return { ...profile };
  }
  getSecret(id) {
    this.getProfile(id);
    if (this.memorySecrets.has(id)) return { ...this.memorySecrets.get(id) };
    const saved = this.data.secrets[id];
    if (!saved) return {};
    if (!this.crypto?.isEncryptionAvailable()) fail('Windows kann die gespeicherten Zugangsdaten gerade nicht entschlüsseln.');
    try {
      const parsed = JSON.parse(this.crypto.decryptString(Buffer.from(saved.ciphertext, 'base64')));
      return { password: secret(parsed.password), accessKey: secret(parsed.accessKey) };
    } catch { fail('Die gespeicherten Zugangsdaten sind nicht lesbar. Bitte erneut eingeben.'); }
  }
  metadata(profile) {
    const saved = this.data.secrets[profile.id];
    const memory = this.memorySecrets.get(profile.id);
    return { ...profile, hasPassword: Boolean(memory?.password || saved?.hasPassword), hasAccessKey: Boolean(memory?.accessKey || saved?.hasAccessKey), secretSaved: Boolean(saved), fingerprint: profile.kind === 'sftp' ? this.data.knownHosts[this.hostId(profile)] || null : null };
  }
  hostId(profile) { return `[${profile.host}]:${profile.port}`; }
  async save(payload) {
    const old = payload.id ? this.getProfile(payload.id) : null;
    if (!old && this.data.profiles.length >= PROFILE_LIMIT) fail('Es können höchstens 100 Verbindungen gespeichert werden.');
    const profile = normalizeProfile(payload, old);
    const same = old && destination(old) === destination(profile);
    const providedPassword = profile.kind === 'website' ? '' : secret(payload.password);
    const providedAccessKey = secret(payload.accessKey);
    let previous = {};
    if (same && !payload.clearSecrets) {
      try { previous = this.getSecret(old.id); }
      catch (error) { if (!providedPassword && !providedAccessKey) throw error; }
    }
    const credentials = { password: profile.kind === 'website' ? '' : providedPassword || previous.password || '', accessKey: providedAccessKey || previous.accessKey || '' };
    const next = { ...this.data, profiles: this.data.profiles.filter(item => item.id !== profile.id), secrets: { ...this.data.secrets } };
    next.profiles.push(profile);
    delete next.secrets[profile.id];
    if (profile.remember && (credentials.password || credentials.accessKey)) {
      if (!this.crypto?.isEncryptionAvailable()) fail('Windows kann die Zugangsdaten gerade nicht verschlüsseln. Deaktiviere „Zugangsdaten merken“.');
      try { next.secrets[profile.id] = { ciphertext: this.crypto.encryptString(JSON.stringify(credentials)).toString('base64'), hasPassword: Boolean(credentials.password), hasAccessKey: Boolean(credentials.accessKey) }; }
      catch { fail('Die Zugangsdaten konnten nicht verschlüsselt werden.'); }
    }
    this.persist(next);
    this.memorySecrets.delete(profile.id);
    if (!profile.remember && (credentials.password || credentials.accessKey)) this.memorySecrets.set(profile.id, credentials);
    if (old && !same && this.active?.profileId === old.id) await this.disconnect();
    return this.metadata(profile);
  }
  async delete(id) {
    this.getProfile(id);
    if (this.active?.profileId === id) await this.disconnect();
    const next = { ...this.data, profiles: this.data.profiles.filter(item => item.id !== id), secrets: { ...this.data.secrets } };
    delete next.secrets[id];
    this.persist(next);
    this.memorySecrets.delete(id);
    return { deleted: true };
  }
  clearSecret(id) {
    const profile = this.getProfile(id);
    const next = { ...this.data, secrets: { ...this.data.secrets } };
    delete next.secrets[id];
    this.persist(next);
    this.memorySecrets.delete(id);
    return this.metadata(profile);
  }
  async native(method, options) {
    if (!this.dialog?.[method]) fail('Der Windows-Dateidialog ist nicht verfügbar.');
    const window = this.getWindow();
    return window ? this.dialog[method](window, options) : this.dialog[method](options);
  }
  state() { return { connected: Boolean(this.active), profileId: this.active?.profileId || null, path: this.active?.path || '/' }; }
  async timed(promise, client, timeout = this.operationTimeout) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => {
        try { client?.client?.destroy(); } catch {}
        if (this.active?.client === client) this.active = null;
        reject(new ConnectionError('Der Server antwortet nicht rechtzeitig. Bitte erneut verbinden.'));
      }, timeout); })]);
    } finally { clearTimeout(timer); }
  }
  async disconnect() {
    const active = this.active;
    this.active = null;
    if (active) {
      try { await this.timed(active.client.end(), active.client, 3000); } catch { try { active.client.client?.destroy(); } catch {} }
    }
    return this.state();
  }
  async connect(payload) {
    const profile = this.getProfile(payload.profileId);
    if (profile.kind !== 'sftp') fail('Bitte eine SFTP-Verbindung auswählen.');
    const password = secret(payload.password) || this.getSecret(profile.id).password;
    if (!password) fail('Bitte das SFTP-Passwort eingeben und die Verbindung speichern.');
    await this.disconnect();
    const Client = this.Client || require('ssh2-sftp-client');
    const client = new Client('CrazyBatto');
    let verificationError = null;
    let connecting = true;
    const identity = this.hostId(profile);
    const verify = async key => {
      if (!Buffer.isBuffer(key)) return false;
      const presented = fingerprint(key);
      const known = this.data.knownHosts[identity];
      if (known) {
        if (known === presented) return true;
        verificationError = 'Der SSH-Fingerabdruck hat sich geändert. Verbindung abgebrochen. Prüfe den neuen Schlüssel mit deinem Serveranbieter.';
        return false;
      }
      const result = await this.native('showMessageBox', { type: 'warning', title: 'SSH-Server erstmals verbinden', message: `Ist dieser SSH-Schlüssel für ${profile.host}:${profile.port} korrekt?`, detail: `Fingerabdruck: ${presented}\n\nVergleiche ihn mit den Angaben deines Serveranbieters. Nur nach Bestätigung wird er gespeichert.`, buttons: ['Abbrechen', 'Schlüssel vertrauen'], defaultId: 0, cancelId: 0, noLink: true });
      if (!connecting || result.response !== 1) { verificationError = 'Die SSH-Verbindung wurde abgebrochen. Der Schlüssel wurde nicht gespeichert.'; return false; }
      this.persist({ ...this.data, knownHosts: { ...this.data.knownHosts, [identity]: presented } });
      return true;
    };
    try {
      await this.timed(client.connect({ host: profile.host, port: profile.port, username: profile.username, password, readyTimeout: 120000, keepaliveInterval: 15000, keepaliveCountMax: 3, retries: 0,
        hostVerifier: (key, callback) => { verify(key).then(callback, () => { verificationError = 'Der SSH-Schlüssel konnte nicht überprüft werden.'; callback(false); }); } }), client, 125000);
      connecting = false;
      const home = remotePath(await this.timed(client.realPath('.'), client));
      this.active = { client, profileId: profile.id, path: home };
      client.client?.on?.('close', () => { if (this.active?.client === client) this.active = null; });
      return this.state();
    } catch (error) {
      connecting = false;
      try { client.client?.destroy(); } catch {}
      if (verificationError) fail(verificationError);
      if (error instanceof ConnectionError) throw error;
      fail('Die SFTP-Verbindung ist fehlgeschlagen. Prüfe Server, Port, Benutzername und Passwort.');
    }
  }
  client() {
    if (!this.active) fail('Bitte zuerst eine SFTP-Verbindung herstellen.');
    return this.active.client;
  }
  async remoteList(payload) {
    const client = this.client();
    const directory = remotePath(payload.path || this.active.path);
    const listing = await this.timed(client.list(directory), client);
    const entries = [];
    for (const entry of listing.slice(0, ENTRY_LIMIT)) {
      try { filename(entry.name); } catch { continue; }
      if (!['d', '-', 'l'].includes(entry.type)) continue;
      entries.push({ name: entry.name, type: entry.type === 'd' ? 'directory' : entry.type === 'l' ? 'link' : 'file', size: Math.max(0, Number(entry.size) || 0), modifiedAt: Number(entry.modifyTime) || null });
    }
    this.active.path = directory;
    return { ...this.state(), entries: sortEntries(entries), truncated: listing.length > ENTRY_LIMIT };
  }
  async chooseLocalFolder() {
    const result = await this.native('showOpenDialog', { title: 'Lokalen Ordner auswählen', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const root = await fsp.realpath(result.filePaths[0]);
    if (!(await fsp.stat(root)).isDirectory()) fail('Bitte einen lokalen Ordner auswählen.');
    this.localRoots.add(root);
    return this.localList({ path: root });
  }
  async allowedLocal(value) {
    if (typeof value !== 'string' || value.length > 32767 || value.includes('\0') || !path.isAbsolute(value)) fail('Bitte zuerst einen lokalen Ordner auswählen.');
    const resolved = await fsp.realpath(value);
    const root = [...this.localRoots].find(item => {
      const relative = path.relative(item, resolved);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    if (!root) fail('Dieser lokale Pfad liegt außerhalb der von dir ausgewählten Ordner.');
    return { resolved, root };
  }
  async localList(payload) {
    const { resolved, root } = await this.allowedLocal(payload.path || this.localPath);
    const entries = [];
    let truncated = false;
    const directory = await fsp.opendir(resolved);
    for await (const item of directory) {
      if (entries.length >= ENTRY_LIMIT) { truncated = true; break; }
      let stat;
      try { stat = await fsp.lstat(path.join(resolved, item.name)); } catch { continue; }
      entries.push({ name: item.name, type: item.isSymbolicLink() ? 'link' : item.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs, path: path.join(resolved, item.name) });
    }
    this.localPath = resolved;
    return { path: resolved, root, entries: sortEntries(entries), truncated };
  }
  async confirmOverwrite(name) {
    const result = await this.native('showMessageBox', { type: 'warning', title: 'Datei überschreiben?', message: `„${name}“ existiert bereits.`, detail: 'Beim Überschreiben wird der bisherige Dateiinhalt ersetzt.', buttons: ['Abbrechen', 'Überschreiben'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  }
  async upload(payload) {
    const client = this.client();
    const directory = remotePath(payload.remotePath || this.active.path);
    let local;
    if (payload.localPath) local = (await this.allowedLocal(payload.localPath)).resolved;
    else {
      const result = await this.native('showOpenDialog', { title: 'Datei zum Hochladen auswählen', properties: ['openFile'] });
      if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
      local = await fsp.realpath(result.filePaths[0]);
    }
    const stat = await fsp.stat(local);
    if (!stat.isFile()) fail('Es können nur einzelne Dateien hochgeladen werden.');
    if (stat.size > FILE_LIMIT) fail('Eine Datei darf höchstens 128 MB groß sein.');
    const name = filename(path.basename(local));
    const target = path.posix.join(directory, name);
    const existing = await this.timed(client.exists(target), client);
    if (existing === 'd' || existing === 'l') fail('Das Ziel ist ein Ordner oder eine Verknüpfung und wird nicht überschrieben.');
    if (existing && !await this.confirmOverwrite(name)) return { canceled: true };
    // Exclusive creation prevents accidentally overwriting a file created after the existence check.
    await this.timed(client.put(stat.size ? local : Buffer.alloc(0), target, { readStreamOptions: { start: 0, end: Math.max(0, stat.size - 1) }, writeStreamOptions: { flags: existing ? 'w' : 'wx' } }), client, 120000);
    return { completed: true, name, path: target };
  }
  async download(payload) {
    const client = this.client();
    const remote = remotePath(payload.remotePath);
    const name = filename(path.posix.basename(remote), true);
    const stat = await this.timed(client.stat(remote), client);
    if (!stat.isFile) fail('Es können nur einzelne Dateien heruntergeladen werden.');
    if (stat.size > FILE_LIMIT) fail('Eine Datei darf höchstens 128 MB groß sein.');
    let target;
    if (payload.localDirectory) {
      const { resolved } = await this.allowedLocal(payload.localDirectory);
      if (!(await fsp.stat(resolved)).isDirectory()) fail('Bitte einen lokalen Zielordner wählen.');
      target = path.join(resolved, name);
    } else {
      const result = await this.native('showSaveDialog', { title: 'Datei herunterladen', defaultPath: name });
      if (result.canceled || !result.filePath) return { canceled: true };
      target = result.filePath;
    }
    let existing = false;
    try {
      const localStat = await fsp.lstat(target);
      if (!localStat.isFile() || localStat.isSymbolicLink()) fail('Das Ziel ist keine normale Datei und wird nicht überschrieben.');
      existing = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && !await this.confirmOverwrite(path.basename(target))) return { canceled: true };
    const temporary = path.join(path.dirname(target), `.crazybatto-${randomUUID()}.partial`);
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > FILE_LIMIT) callback(new ConnectionError('Die heruntergeladene Datei überschreitet 128 MB.'));
      else callback(null, chunk);
    } });
    const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    try {
      const writing = pipeline(limiter, output);
      await this.timed(Promise.all([client.get(remote, limiter), writing]), client, 120000);
      // Rename replaces the directory entry without following a destination symlink.
      // EXCL protects a new destination if another process creates it during the transfer.
      if (existing) await fsp.rename(temporary, target);
      else await fsp.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
      return { completed: true, name, path: target };
    } finally {
      limiter.destroy();
      output.destroy();
      await finished(output).catch(() => {});
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async mkdir(payload) {
    const client = this.client();
    const parent = remotePath(payload.parent || this.active.path);
    const name = filename(payload.name);
    const target = path.posix.join(parent, name);
    if (await this.timed(client.exists(target), client)) fail('Dieser Name ist auf dem Server bereits vorhanden.');
    await this.timed(client.mkdir(target, false), client);
    return { completed: true, name, path: target };
  }
  async run(action, payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('Die Anfrage ist ungültig.');
    try {
      switch (action) {
        case 'connections.list': return this.data.profiles.map(profile => this.metadata(profile));
        case 'connections.save': return await this.save(payload);
        case 'connections.delete': return await this.delete(payload.id);
        case 'connections.clearSecret': return this.clearSecret(payload.id);
        case 'files.state': return this.state();
        case 'files.connect': return await this.connect(payload);
        case 'files.disconnect': return await this.disconnect();
        case 'files.list': return await this.remoteList(payload);
        case 'files.chooseLocalFolder': return await this.chooseLocalFolder();
        case 'files.localList': return await this.localList(payload);
        case 'files.upload': return await this.upload(payload);
        case 'files.download': return await this.download(payload);
        case 'files.mkdir': return await this.mkdir(payload);
        default: fail('Diese Verbindungsaktion ist nicht freigegeben.');
      }
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      // SSH and operating-system errors can embed credentials and server-controlled strings.
      fail('Die Aktion ist fehlgeschlagen. Prüfe die Verbindung, den Pfad und deine Zugriffsrechte.');
    }
  }
}
function sortEntries(entries) {
  return entries.sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'de', { numeric: true }));
}

module.exports = { ConnectionsService, parseWinScpIni, fingerprint, remotePath, filename, FILE_LIMIT, ENTRY_LIMIT };
