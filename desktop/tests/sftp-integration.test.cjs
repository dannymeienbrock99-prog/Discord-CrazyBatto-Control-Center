'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { Server, utils } = require('ssh2');
const SftpClient = require('ssh2-sftp-client');
const { ConnectionsService, fingerprint } = require('../electron/connections.cjs');
const { STATUS_CODE, flagsToString } = utils.sftp;

// A small real SFTP fixture. It only listens on loopback, requires invented test
// credentials, and confines every operation to the freshly-created test directory.
function serveTestDirectory(channel, root) {
  let nextHandle = 1;
  const handles = new Map();
  const diskPath = remote => {
    const normalized = path.posix.normalize(remote === '.' ? '/' : remote);
    if (!normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').includes('..')) throw new Error('Invalid test path');
    const destination = path.resolve(root, `.${normalized}`);
    const relative = path.relative(root, destination);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path outside test directory');
    return destination;
  };
  const attrs = stat => ({ mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
  const entry = (filename, fullPath) => {
    const stat = fs.statSync(fullPath);
    return { filename, longname: `${stat.isDirectory() ? 'd' : '-'}rwxr-xr-x 1 test test ${stat.size} Jan 01 2026 ${filename}`, attrs: attrs(stat) };
  };
  const on = (event, handler) => channel.on(event, (id, ...args) => {
    try { handler(id, ...args); }
    catch (error) { channel.status(id, error.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE); }
  });
  const addHandle = (id, value) => {
    const number = nextHandle++;
    handles.set(number, value);
    const handle = Buffer.alloc(4); handle.writeUInt32BE(number);
    channel.handle(id, handle);
  };
  const getHandle = handle => {
    if (handle.length !== 4 || !handles.has(handle.readUInt32BE())) throw new Error('Unknown test handle');
    return handles.get(handle.readUInt32BE());
  };
  on('REALPATH', (id, value) => { diskPath(value); channel.name(id, [{ filename: value === '.' ? '/' : path.posix.normalize(value), longname: '', attrs: {} }]); });
  on('STAT', (id, value) => channel.attrs(id, attrs(fs.statSync(diskPath(value)))));
  on('LSTAT', (id, value) => channel.attrs(id, attrs(fs.lstatSync(diskPath(value)))));
  on('FSTAT', (id, handle) => channel.attrs(id, attrs(fs.fstatSync(getHandle(handle).fd))));
  on('OPENDIR', (id, value) => {
    const directory = diskPath(value);
    addHandle(id, { entries: fs.readdirSync(directory).map(name => entry(name, path.join(directory, name))), sent: false });
  });
  on('READDIR', (id, handle) => {
    const directory = getHandle(handle);
    if (directory.sent || !directory.entries.length) channel.status(id, STATUS_CODE.EOF);
    else { directory.sent = true; channel.name(id, directory.entries); }
  });
  on('OPEN', (id, value, flags) => addHandle(id, { fd: fs.openSync(diskPath(value), flagsToString(flags)) }));
  on('READ', (id, handle, offset, length) => {
    const buffer = Buffer.alloc(Math.min(length, 32768));
    const count = fs.readSync(getHandle(handle).fd, buffer, 0, buffer.length, offset);
    if (count) channel.data(id, buffer.subarray(0, count)); else channel.status(id, STATUS_CODE.EOF);
  });
  on('WRITE', (id, handle, offset, data) => {
    fs.writeSync(getHandle(handle).fd, data, 0, data.length, offset);
    channel.status(id, STATUS_CODE.OK);
  });
  on('CLOSE', (id, handle) => {
    const value = getHandle(handle);
    if (value.fd !== undefined) fs.closeSync(value.fd);
    handles.delete(handle.readUInt32BE());
    channel.status(id, STATUS_CODE.OK);
  });
  on('MKDIR', (id, value) => { fs.mkdirSync(diskPath(value)); channel.status(id, STATUS_CODE.OK); });
  channel.on('close', () => {
    for (const value of handles.values()) { if (value.fd !== undefined) { try { fs.closeSync(value.fd); } catch {} } }
    handles.clear();
  });
}

test('real loopback SFTP verifies host trust, lists, creates folders and transfers identical bytes both ways', { timeout: 25000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crazybatto-sftp-protocol-'));
  const remoteRoot = path.join(root, 'remote');
  const localRoot = path.join(root, 'local');
  const downloads = path.join(localRoot, 'downloads');
  fs.mkdirSync(remoteRoot); fs.mkdirSync(localRoot); fs.mkdirSync(downloads);
  fs.mkdirSync(path.join(remoteRoot, 'inbox'));
  fs.writeFileSync(path.join(remoteRoot, 'server.txt'), 'Only a local SFTP test fixture.');
  const uploadPath = path.join(localRoot, 'roundtrip.bin');
  const payload = randomBytes(256 * 1024 + 37); // Multiple SFTP packets, including a short last chunk.
  fs.writeFileSync(uploadPath, payload);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const expectedFingerprint = fingerprint(utils.parseKey(privateKey).getPublicSSH());
  const sockets = new Set();
  const errors = [];
  let authenticated = 0;
  const server = new Server({ hostKeys: [privateKey] }, client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', error => errors.push(error));
    client.on('authentication', context => {
      if (context.method === 'password' && context.username === 'fixture-user' && context.password === 'fixture-password-not-a-real-secret') { authenticated++; context.accept(); }
      else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => serveTestDirectory(acceptSftp(), remoteRoot));
    }));
  });
  let service;
  let listening = false;
  t.after(async () => {
    if (service) await service.run('files.disconnect');
    for (const client of sockets) client.destroy();
    if (listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  listening = true;
  assert.equal(server.address().address, '127.0.0.1');
  const prompts = [];
  let approveOverwrite = true;
  class FixtureClient extends SftpClient {
    async connect(config) {
      try { return await super.connect(config); }
      catch (error) { t.diagnostic(`Loopback handshake failed: ${error.code || ''} ${error.message}`); throw error; }
    }
  }
  service = new ConnectionsService({
    directory: path.join(root, 'app-data'),
    safeStorage: { isEncryptionAvailable: () => false },
    // Actual installed transport; this subclass only adds diagnostics for fixture failures.
    Client: FixtureClient,
    dialog: {
      showMessageBox: async options => { prompts.push(options); return { response: options.title === 'Datei überschreiben?' ? Number(approveOverwrite) : 1 }; },
      showOpenDialog: async () => ({ canceled: false, filePaths: [localRoot] }),
      showSaveDialog: async () => { throw new Error('Download should use the selected local folder.'); }
    }
  });
  const profile = await service.run('connections.save', { name: 'Loopback protocol fixture', kind: 'sftp', host: '127.0.0.1', port: server.address().port, username: 'fixture-user', password: 'fixture-password-not-a-real-secret', remember: false });
  const connected = await service.run('files.connect', { profileId: profile.id });
  assert.equal(connected.connected, true);
  assert.equal(connected.path, '/');
  assert.equal(authenticated, 1);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].detail.includes(expectedFingerprint));
  assert.equal((await service.run('connections.list'))[0].fingerprint, expectedFingerprint);
  const listing = await service.run('files.list', { path: '/' });
  assert.deepEqual(listing.entries.map(item => [item.name, item.type]), [['inbox', 'directory'], ['server.txt', 'file']]);
  await service.run('files.chooseLocalFolder');
  const uploaded = await service.run('files.upload', { remotePath: '/inbox', localPath: uploadPath });
  assert.equal(uploaded.completed, true);
  assert.deepEqual(fs.readFileSync(path.join(remoteRoot, 'inbox', 'roundtrip.bin')), payload);
  const downloaded = await service.run('files.download', { remotePath: '/inbox/roundtrip.bin', localDirectory: downloads });
  assert.equal(downloaded.completed, true);
  assert.deepEqual(fs.readFileSync(path.join(downloads, 'roundtrip.bin')), payload);
  assert.equal(fs.readdirSync(downloads).some(name => name.endsWith('.partial')), false);
  await service.run('files.mkdir', { parent: '/', name: 'new-folder' });
  assert.equal(fs.statSync(path.join(remoteRoot, 'new-folder')).isDirectory(), true);
  approveOverwrite = false;
  fs.writeFileSync(uploadPath, 'changed locally');
  assert.deepEqual(await service.run('files.upload', { remotePath: '/inbox', localPath: uploadPath }), { canceled: true });
  assert.deepEqual(fs.readFileSync(path.join(remoteRoot, 'inbox', 'roundtrip.bin')), payload);
  approveOverwrite = true;
  await service.run('files.upload', { remotePath: '/inbox', localPath: uploadPath });
  assert.equal(fs.readFileSync(path.join(remoteRoot, 'inbox', 'roundtrip.bin'), 'utf8'), 'changed locally');
  await service.run('files.download', { remotePath: '/inbox/roundtrip.bin', localDirectory: downloads });
  assert.equal(fs.readFileSync(path.join(downloads, 'roundtrip.bin'), 'utf8'), 'changed locally');
  assert.equal(prompts.filter(item => item.title === 'Datei überschreiben?').length, 3);
  await service.run('files.disconnect');
  assert.equal(service.state().connected, false);
  await service.run('files.connect', { profileId: profile.id });
  assert.equal(authenticated, 2);
  assert.equal(prompts.filter(item => item.title === 'SSH-Server erstmals verbinden').length, 1);
  assert.equal(errors.length, 0);
});
