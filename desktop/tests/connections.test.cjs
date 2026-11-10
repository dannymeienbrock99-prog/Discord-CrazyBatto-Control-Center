'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { ConnectionsService, parseWinScpIni, fingerprint, remotePath, filename, FILE_LIMIT, ENTRY_LIMIT } = require('../electron/connections.cjs');

const PASSWORD = 'test-only-password-never-a-real-secret';
const ACCESS_KEY = 'test-only-session-never-a-real-token';
const HOST_KEY = Buffer.from('test SSH public host key');
const profileDraft = (extra = {}) => ({ name: 'Mein Server', kind: 'sftp', host: 'sftp.example.test', port: 22, username: 'batto', remember: true, ...extra });
function cryptoMock() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(data) {
      const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crazybatto-connections-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prompts = [], clients = [];
  const dialog = {
    showMessageBox: async (...args) => { prompts.push(args.at(-1)); return { response: options.trust === false ? 0 : 1 }; },
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true }),
    ...options.dialog
  };
  class MockClient {
    constructor() {
      clients.push(this);
      this.client = new EventEmitter();
      this.client.destroy = () => { this.destroyed = true; this.client.emit('close'); };
      this.key = options.key || HOST_KEY;
      this.listing = [{ name: 'hello.txt', type: '-', size: 5, modifyTime: 1700000000000 }, { name: 'public', type: 'd', size: 0 }];
      this.calls = [];
    }
    async connect(config) {
      this.config = config;
      const accepted = await new Promise(resolve => config.hostVerifier(this.key, resolve));
      this.verified = accepted;
      if (!accepted) throw new Error('Host rejected');
      if (options.connectError) throw new Error(options.connectError);
    }
    async realPath() { return '/srv/example'; }
    async end() { this.ended = true; this.client.emit('close'); }
    async list(value) { this.calls.push(['list', value]); return this.listing; }
    async exists(value) { this.calls.push(['exists', value]); return this.existing || false; }
    async put(local, remote, opts) { this.calls.push(['put', local, remote, opts]); }
    async stat() { return { isFile: true, size: this.fileSize || 5 }; }
    async get(remote, stream) { this.calls.push(['get', remote]); stream.end(Buffer.from('hello')); }
    async mkdir(value, recursive) { this.calls.push(['mkdir', value, recursive]); }
  }
  const safeStorage = options.safeStorage || cryptoMock();
  const service = new ConnectionsService({ directory, safeStorage, dialog, Client: MockClient, operationTimeout: 1000 });
  return { service, directory, safeStorage, dialog, prompts, clients };
}
async function connect(fixture, extra = {}) {
  const profile = await fixture.service.run('connections.save', profileDraft({ password: PASSWORD, ...extra }));
  await fixture.service.run('files.connect', { profileId: profile.id });
  return profile;
}

test('saved credentials are encrypted, remain internal and survive an app restart', async t => {
  const f = setup(t);
  const saved = await f.service.run('connections.save', profileDraft({ password: PASSWORD, accessKey: ACCESS_KEY }));
  const metadata = await f.service.run('connections.list');
  const disk = fs.readFileSync(path.join(f.directory, 'connections.json'), 'utf8');
  for (const output of [JSON.stringify(saved), JSON.stringify(metadata), disk]) {
    assert.ok(!output.includes(PASSWORD));
    assert.ok(!output.includes(ACCESS_KEY));
  }
  assert.equal(saved.secretSaved, true);
  assert.equal(saved.hasPassword, true);
  const restarted = new ConnectionsService({ directory: f.directory, safeStorage: f.safeStorage, dialog: f.dialog });
  assert.equal(restarted.getSecret(saved.id).password, PASSWORD);
  assert.equal(restarted.getSecret(saved.id).accessKey, ACCESS_KEY);
  assert.equal(restarted.getProfile(saved.id).password, undefined);
});

test('nonremembered credentials exist only for this app session', async t => {
  const f = setup(t);
  const saved = await f.service.run('connections.save', profileDraft({ password: PASSWORD, remember: false }));
  assert.equal(saved.secretSaved, false);
  assert.equal(saved.hasPassword, true);
  assert.equal(f.service.getSecret(saved.id).password, PASSWORD);
  const restarted = new ConnectionsService({ directory: f.directory, safeStorage: f.safeStorage });
  assert.deepEqual(restarted.getSecret(saved.id), {});
  assert.equal(JSON.parse(fs.readFileSync(f.service.file)).secrets[saved.id], undefined);
});

test('saving blank credentials preserves them only for the exact same destination and user', async t => {
  const f = setup(t);
  let saved = await f.service.run('connections.save', profileDraft({ password: PASSWORD }));
  saved = await f.service.run('connections.save', { ...saved, name: 'Neuer Name', password: '' });
  assert.equal(f.service.getSecret(saved.id).password, PASSWORD);
  for (const change of [{ host: 'other.example.test' }, { port: 2222 }, { username: 'other' }]) {
    saved = await f.service.run('connections.save', { ...saved, password: PASSWORD });
    saved = await f.service.run('connections.save', { ...saved, ...change, password: '' });
    assert.deepEqual(f.service.getSecret(saved.id), {});
    assert.equal(saved.hasPassword, false);
  }
});

test('website session tokens can be retained and cleared without saving account passwords', async t => {
  const f = setup(t);
  const saved = await f.service.run('connections.save', { name: 'Meine Webseite', kind: 'website', baseUrl: 'https://example.test', username: 'admin@example.test', password: PASSWORD, accessKey: ACCESS_KEY, remember: true });
  assert.equal(saved.hasPassword, false);
  assert.equal(saved.hasAccessKey, true);
  assert.equal(f.service.getSecret(saved.id).password, '');
  const cleared = await f.service.run('connections.clearSecret', { id: saved.id });
  assert.equal(cleared.hasAccessKey, false);
  assert.deepEqual(f.service.getSecret(saved.id), {});
  assert.equal((await f.service.run('connections.list')).length, 1);
});

test('moving a website connection to a different URL drops its stored token', async t => {
  const f = setup(t);
  const saved = await f.service.run('connections.save', { name: 'Webseite', kind: 'website', baseUrl: 'https://example.test/admin', username: 'admin', accessKey: ACCESS_KEY, remember: true });
  const changed = await f.service.run('connections.save', { ...saved, baseUrl: 'https://elsewhere.test/admin' });
  assert.equal(changed.hasAccessKey, false);
  assert.deepEqual(f.service.getSecret(saved.id), {});
});

test('a new credential can replace unreadable old ciphertext, and long website emails remain supported', async t => {
  const f = setup(t);
  const username = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.test`;
  let saved = await f.service.run('connections.save', { name: 'Webseite', kind: 'website', baseUrl: 'https://example.test', username, accessKey: ACCESS_KEY, remember: true });
  f.service.data.secrets[saved.id].ciphertext = Buffer.from('unreadable').toString('base64');
  await assert.rejects(f.service.run('connections.save', { ...saved }), /nicht lesbar/);
  saved = await f.service.run('connections.save', { ...saved, accessKey: 'fresh-test-session' });
  assert.equal(f.service.getSecret(saved.id).accessKey, 'fresh-test-session');
  assert.equal(saved.username, username);
});

test('unavailable OS encryption does not save plaintext or a partial profile', async t => {
  const f = setup(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(f.service.run('connections.save', profileDraft({ password: PASSWORD })), /verschlüsseln/);
  assert.deepEqual(await f.service.run('connections.list'), []);
  assert.equal(fs.existsSync(f.service.file), false);
});

test('first server key requires confirmation, then the pinned key needs no repeated dialog', async t => {
  const f = setup(t);
  const saved = await connect(f);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].defaultId, 0);
  assert.match(f.prompts[0].detail, /SHA256:/);
  assert.equal((await f.service.run('connections.list'))[0].fingerprint, fingerprint(HOST_KEY));
  await f.service.run('files.disconnect');
  await f.service.run('files.connect', { profileId: saved.id });
  assert.equal(f.prompts.length, 1);
  assert.equal(f.clients[1].config.password, PASSWORD);
  assert.equal(f.clients[1].config.agent, undefined);
  assert.equal(f.clients[1].config.privateKey, undefined);
});

test('declining a new host key rejects the connection and does not pin it', async t => {
  const f = setup(t, { trust: false });
  const saved = await f.service.run('connections.save', profileDraft({ password: PASSWORD }));
  await assert.rejects(f.service.run('files.connect', { profileId: saved.id }), /abgebrochen/);
  assert.equal(f.service.state().connected, false);
  assert.deepEqual(f.service.data.knownHosts, {});
  assert.equal(f.clients[0].verified, false);
});

test('changed host key is refused without offering an automatic replacement', async t => {
  const f = setup(t);
  const saved = await connect(f);
  await f.service.run('files.disconnect');
  f.service.data.knownHosts[f.service.hostId(saved)] = fingerprint(Buffer.from('other server key'));
  await assert.rejects(f.service.run('files.connect', { profileId: saved.id }), /geändert/);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.clients[1].verified, false);
});

test('deleting or changing an active profile disconnects it and removes credentials', async t => {
  const f = setup(t);
  const saved = await connect(f);
  await f.service.run('connections.save', { ...saved, host: 'different.example.test' });
  assert.equal(f.clients[0].ended, true);
  assert.equal(f.service.state().connected, false);
  assert.deepEqual(f.service.getSecret(saved.id), {});
  await f.service.run('connections.delete', { id: saved.id });
  assert.deepEqual(await f.service.run('connections.list'), []);
  assert.throws(() => f.service.getSecret(saved.id), /nicht gefunden/);
});

test('server and OS failures never expose upstream secret-bearing messages', async t => {
  const f = setup(t, { connectError: `Authentication failed password=${PASSWORD}` });
  const saved = await f.service.run('connections.save', profileDraft({ password: PASSWORD }));
  await assert.rejects(f.service.run('files.connect', { profileId: saved.id }), error => !error.message.includes(PASSWORD) && /fehlgeschlagen/.test(error.message));
  f.service.active = { client: { list: async () => { throw new Error(`secret ${ACCESS_KEY}`); } }, profileId: saved.id, path: '/' };
  await assert.rejects(f.service.run('files.list'), error => !error.message.includes(ACCESS_KEY));
});

test('profiles, remote paths and Windows download filenames reject unsafe inputs', async t => {
  const f = setup(t);
  for (const badHost of ['https://example.test', 'name@host', 'host/path', 'host\nvalue', '-bad.test']) await assert.rejects(f.service.run('connections.save', profileDraft({ host: badHost })));
  for (const badPort of [0, -1, 65536, '22;cmd', 22.5]) await assert.rejects(f.service.run('connections.save', profileDraft({ port: badPort })));
  for (const bad of ['../secret', '/srv/../secret', 'C:\\Windows', '/bad\0path']) assert.throws(() => remotePath(bad));
  for (const bad of ['../file', 'folder/file', 'a\\b', '.', '..', 'a\0b']) assert.throws(() => filename(bad));
  for (const bad of ['CON', 'COM1.txt', 'bad:name', 'file.', 'file ']) assert.throws(() => filename(bad, true));
  assert.equal(remotePath('/srv/example//files'), '/srv/example/files');
  assert.equal(filename('äöü.json', true), 'äöü.json');
});

test('WinSCP import reads only safe SFTP metadata and ignores passwords, keys and commands', () => {
  const ini = `[Sessions\\Mein%20Server]\nHostName=example.test\nPortNumber=2222\nUserName=batto\nFSProtocol=2\nPassword=${PASSWORD}\nPasswordPlain=${PASSWORD}\nPublicKeyFile=C:\\secret.key\nProxyPassword=${ACCESS_KEY}\nPostLoginCommands=rm -rf /\n[Sessions\\Fallback]\nHostName=fallback.test\nUserName=user\nFSProtocol=1\n[Sessions\\FTP]\nHostName=ftp.test\nUserName=user\nFSProtocol=5\n[Sessions\\SCP]\nHostName=scp.test\nUserName=user\nFSProtocol=0\n`;
  const sessions = parseWinScpIni(ini);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], { name: 'Mein Server', kind: 'sftp', host: 'example.test', port: 2222, username: 'batto', remember: false });
  assert.ok(!JSON.stringify(sessions).includes(PASSWORD));
  assert.ok(!JSON.stringify(sessions).includes(ACCESS_KEY));
  assert.ok(!JSON.stringify(sessions).includes('PostLogin'));
});

test('remote listing is bounded, sorted, and never fetches file contents', async t => {
  const f = setup(t);
  await connect(f);
  const client = f.clients[0];
  client.listing.push({ name: '../../escape', type: '-', size: 3 });
  const listing = await f.service.run('files.list');
  assert.equal(listing.entries[0].name, 'public');
  assert.equal(listing.entries.length, 2);
  assert.deepEqual(client.calls, [['list', '/srv/example']]);
  client.listing = Array.from({ length: ENTRY_LIMIT + 1 }, (_, i) => ({ name: `file${i}.txt`, type: '-', size: 1 }));
  const bounded = await f.service.run('files.list');
  assert.equal(bounded.entries.length, ENTRY_LIMIT);
  assert.equal(bounded.truncated, true);
});

test('local access is confined to an explicitly selected root, including sibling path rejection', async t => {
  const f = setup(t);
  const root = path.join(f.directory, 'chosen'), sibling = path.join(f.directory, 'chosen-other');
  fs.mkdirSync(root); fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hello');
  await assert.rejects(f.service.run('files.localList', { path: root }), /außerhalb/);
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  const listing = await f.service.run('files.chooseLocalFolder');
  assert.equal(listing.root, await fs.promises.realpath(root));
  assert.equal(listing.entries[0].name, 'hello.txt');
  await assert.rejects(f.service.run('files.localList', { path: sibling }), /außerhalb/);
  await assert.rejects(f.service.run('files.localList', { path: f.directory }), /außerhalb/);
});

test('upload uses safe basename and exclusive create; overwrite needs separate native consent', async t => {
  const f = setup(t);
  await connect(f);
  const local = path.join(f.directory, 'hello.txt');
  fs.writeFileSync(local, 'hello');
  f.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [local] });
  const uploaded = await f.service.run('files.upload', { remotePath: '/public' });
  assert.equal(uploaded.path, '/public/hello.txt');
  assert.equal(f.clients[0].calls.at(-1)[3].writeStreamOptions.flags, 'wx');
  f.clients[0].existing = '-';
  f.dialog.showMessageBox = async () => ({ response: 0 });
  const before = f.clients[0].calls.filter(call => call[0] === 'put').length;
  assert.deepEqual(await f.service.run('files.upload', { remotePath: '/public' }), { canceled: true });
  assert.equal(f.clients[0].calls.filter(call => call[0] === 'put').length, before);
  f.dialog.showMessageBox = async () => ({ response: 1 });
  await f.service.run('files.upload', { remotePath: '/public' });
  assert.equal(f.clients[0].calls.at(-1)[3].writeStreamOptions.flags, 'w');
  f.clients[0].existing = 'l';
  await assert.rejects(f.service.run('files.upload', { remotePath: '/public' }), /Verknüpfung/);
});

test('download is saved through a temporary file and canceled overwrites leave original content intact', async t => {
  const f = setup(t);
  await connect(f);
  const target = path.join(f.directory, 'download.txt');
  f.dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  assert.equal((await f.service.run('files.download', { remotePath: '/public/download.txt' })).completed, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  fs.writeFileSync(target, 'original');
  f.dialog.showMessageBox = async () => ({ response: 0 });
  assert.deepEqual(await f.service.run('files.download', { remotePath: '/public/download.txt' }), { canceled: true });
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
  f.dialog.showMessageBox = async () => ({ response: 1 });
  await f.service.run('files.download', { remotePath: '/public/download.txt' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.partial')), false);
  f.clients[0].fileSize = FILE_LIMIT + 1;
  await assert.rejects(f.service.run('files.download', { remotePath: '/large.txt' }), /128 MB/);
});

test('mkdir only creates a single validated directory and no shell/delete actions are exposed', async t => {
  const f = setup(t);
  await connect(f);
  await f.service.run('files.mkdir', { parent: '/public', name: 'uploads' });
  assert.deepEqual(f.clients[0].calls.at(-1), ['mkdir', '/public/uploads', false]);
  await assert.rejects(f.service.run('files.mkdir', { parent: '/public', name: '../escape' }));
  await assert.rejects(f.service.run('files.delete', { remotePath: '/public/file' }), /nicht freigegeben/);
  await assert.rejects(f.service.run('files.exec', { command: 'whoami' }), /nicht freigegeben/);
});

test('an unresponsive operation destroys the connection and returns a safe timeout', async t => {
  const f = setup(t);
  await connect(f);
  f.service.operationTimeout = 10;
  f.clients[0].list = () => new Promise(() => {});
  await assert.rejects(f.service.run('files.list'), /nicht rechtzeitig/);
  assert.equal(f.clients[0].destroyed, true);
  assert.equal(f.service.state().connected, false);
});
