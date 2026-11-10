'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ThemesService, validateSettings, generateTheme, PRESETS, OWNED_THEME_FILE } = require('../electron/themes.cjs');
const settings = (patch = {}) => ({ ...PRESETS[0].settings, ...patch });

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cb-theme-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private-settings'), appDataDirectory = path.join(root, 'app-data');
  const themes = path.join(appDataDirectory, 'BetterDiscord', 'themes');
  if (!options.absent) await fs.mkdir(themes, { recursive: true });
  const dialogs = [], state = { result: { canceled: true } };
  const service = new ThemesService({ directory, appDataDirectory, getWindow: () => null,
    dialog: { showSaveDialog: async (...args) => { dialogs.push(args); return state.result; } }, fsImpl: options.fsImpl || fs });
  return { root, directory, appDataDirectory, themes, service, dialogs, state };
}

test('presets and complete settings validate colors, ranges, schema and reject injected CSS', () => {
  assert.equal(PRESETS[0].name, 'Goldmarmor');
  assert.equal(PRESETS[0].settings.backgroundUrl, 'https://crazybatto.de/assets/control/marble-gold.webp');
  assert.equal(validateSettings(settings({ accentColor: '#abcdef' })).accentColor, '#ABCDEF');
  for (const patch of [{ preset: 'foreign' }, { accentColor: 'red' }, { accentColor: '#D4AF37;display:none' }, { fontSize: 11 }, { fontSize: 23 }, { fontSize: 16.1 }, { fontSize: '16' }, { borderRadius: -1 }, { borderRadius: 25 }, { backgroundIntensity: 81 }, { backgroundIntensity: NaN }, { extra: true }, { backgroundUrl: undefined }]) assert.throws(() => validateSettings(settings(patch)));
  assert.throws(() => validateSettings({ preset: 'dark' }));
  for (const url of ['http://example.com/x.png', 'https://user:password@example.com/x.png', 'https://example.com:8443/x.png', 'https://127.0.0.1/a.png', 'https://2130706433/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://server.local/a.png', 'file:///C:/private.png', 'data:image/png;base64,AA', 'javascript:alert(1)', 'https://example.com/x.png#part', 'https://example.com/x.png");}body{display:none', 'https://example.com/a\\b.png', 'https://example.com/video.%6dp4', 'https://example.com/a.png?x=' + 'x'.repeat(2048)]) assert.throws(() => validateSettings(settings({ backgroundUrl: url })), undefined, url);
});

test('generator emits a standalone declarative theme with current variables and exactly the configured image', () => {
  const css = generateTheme(settings());
  assert.match(css, /@name CrazyBatto Team Alpha/);
  assert.match(css, /--background-base-lowest:/); assert.match(css, /--text-default:/);
  assert.doesNotMatch(css, /--background-primary:|--text-normal:|@import|<script|javascript:|onload|sourceMappingURL/);
  assert.equal((css.match(/url\(/g) || []).length, 1);
  assert.match(css, /url\("https:\/\/crazybatto\.de\/assets\/control\/marble-gold\.webp"\)/);
  assert.match(css, /--cbta-image-cover: rgba\(11, 13, 18, 0\.75\)/);
  assert.match(css, /--cbta-font-size: 16px/);
  assert.doesNotMatch(generateTheme(settings({ backgroundUrl: '' })), /url\(/);
  assert.doesNotMatch(generateTheme(settings({ backgroundIntensity: 0 })), /url\(/);
});

test('state is local and read-only, missing BetterDiscord never creates or installs anything', async t => {
  const f = await fixture(t, { absent: true });
  const state = await f.service.run('themes.state');
  assert.equal(state.status.localOnly, true); assert.equal(state.status.betterDiscordAvailable, false);
  assert.equal(state.status.activationKnown, false); assert.equal(state.status.activationRequired, true);
  assert.deepEqual(state.themes, []); assert.equal(f.dialogs.length, 0);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  await assert.rejects(f.service.run('themes.install', { confirm: true }), /nicht gefunden/);
  await assert.rejects(fs.stat(f.appDataDirectory), { code: 'ENOENT' });
});

test('private settings persist atomically and survive service reload without installing or altering other files', async t => {
  const f = await fixture(t);
  const saved = settings({ accentColor: '#C0A040', fontSize: 19 });
  const state = await f.service.run('themes.save', { settings: saved });
  assert.deepEqual(state.settings, saved); assert.deepEqual(await fs.readdir(f.themes), []);
  const fresh = new ThemesService({ directory: f.directory, appDataDirectory: f.appDataDirectory });
  assert.deepEqual((await fresh.run('themes.state')).settings, saved);
  assert.deepEqual(await fs.readdir(f.directory), ['theme-settings.json']);
  const previous = await fs.readFile(path.join(f.directory, 'theme-settings.json'));
  await assert.rejects(f.service.run('themes.save', { settings: { ...saved, rawCss: 'body{}' } }));
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'theme-settings.json')), previous);
});

test('list reads bounded metadata only and ignores plugins, directories, backups, and oversized themes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.themes, 'Foreign.theme.css'), '/**\n * @name Foreign <b>text only</b>\n */\n@import "https://must-never-be-fetched.invalid/theme.css";\nglobalThis.__themeExecuted = true;');
  await fs.writeFile(path.join(f.themes, 'plugin.plugin.js'), 'throw new Error("Must not execute");');
  await fs.writeFile(path.join(f.themes, OWNED_THEME_FILE + '.backup.bak'), 'backup');
  await fs.writeFile(path.join(f.themes, 'TooLarge.theme.css'), Buffer.alloc(1024 * 1024 + 1));
  await fs.mkdir(path.join(f.themes, 'Folder.theme.css'));
  const listed = await f.service.run('themes.list');
  assert.equal(listed.length, 1); assert.equal(listed[0].name, 'Foreign <b>text only</b>'); assert.equal(listed[0].owned, false);
  assert.equal(globalThis.__themeExecuted, undefined);
  assert.equal((await f.service.run('themes.state')).status.ownedThemeInstalled, false);
});

test('install requires explicit confirmation and has no caller-controlled target or activation action', async t => {
  const f = await fixture(t);
  for (const payload of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, path: path.join(f.root, 'unexpected.css') }, { confirm: true, activate: true }]) await assert.rejects(f.service.run('themes.install', payload));
  for (const action of ['themes.activate', 'themes.import', 'themes.execute', 'themes.delete']) await assert.rejects(f.service.run(action));
  assert.deepEqual(await fs.readdir(f.themes), []);
});

test('install writes only the owned file and keeps an exact backup before replacing its previous version', async t => {
  const f = await fixture(t), foreign = path.join(f.themes, 'Keep.theme.css');
  await fs.writeFile(foreign, 'foreign must stay identical');
  const first = await f.service.run('themes.install', { settings: settings(), confirm: true });
  assert.equal(first.path, path.join(f.themes, OWNED_THEME_FILE)); assert.equal(first.backupPath, null); assert.equal(first.activationRequired, true);
  const before = await fs.readFile(first.path);
  const second = await f.service.run('themes.install', { settings: settings({ fontSize: 20 }), confirm: true });
  assert.ok(second.backupPath.startsWith(first.path + '.backup-')); assert.match(second.backupPath, /\.bak$/);
  assert.deepEqual(await fs.readFile(second.backupPath), before);
  assert.match(await fs.readFile(first.path, 'utf8'), /--cbta-font-size: 20px/);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign must stay identical');
  assert.equal((await f.service.run('themes.state')).status.ownedThemeInstalled, true);
  assert.deepEqual(await fs.readdir(path.dirname(f.themes)), ['themes']);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('same-name foreign file and hardlinks are protected, even after user confirmation', async t => {
  const f = await fixture(t), target = path.join(f.themes, OWNED_THEME_FILE);
  await fs.writeFile(target, '/* unrelated manually-created theme */ body { color:red }');
  await assert.rejects(f.service.run('themes.install', { confirm: true }), /nicht vom Control Center/);
  assert.equal(await fs.readFile(target, 'utf8'), '/* unrelated manually-created theme */ body { color:red }');
  await fs.unlink(target);
  const original = path.join(f.root, 'outside.css'); await fs.writeFile(original, generateTheme(settings())); await fs.link(original, target);
  await assert.rejects(f.service.run('themes.install', { confirm: true }), /verknüpft/);
  assert.equal(await fs.readFile(original, 'utf8'), generateTheme(settings()));
});

test('native export cancellation is harmless; chosen .theme.css file receives only validated generated CSS', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.run('themes.export', { settings: settings() }), { canceled: true });
  assert.equal(f.dialogs[0][0].defaultPath, OWNED_THEME_FILE);
  const exported = path.join(f.root, 'Export.theme.css'); f.state.result = { canceled: false, filePath: exported };
  const result = await f.service.run('themes.export', { settings: settings({ fontSize: 18 }) });
  assert.equal(result.path, exported); assert.match(await fs.readFile(exported, 'utf8'), /--cbta-font-size: 18px/);
  assert.deepEqual(await fs.readdir(f.themes), []);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  f.state.result.filePath = path.join(f.root, 'plugin.plugin.js');
  await assert.rejects(f.service.run('themes.export'), /\.theme\.css/);
  await assert.rejects(fs.stat(f.state.result.filePath), { code: 'ENOENT' });
});

test('export cannot overwrite a foreign file and ignores invalid settings before showing the picker', async t => {
  const f = await fixture(t), target = path.join(f.root, 'Foreign.theme.css');
  await fs.writeFile(target, 'foreign'); f.state.result = { canceled: false, filePath: target };
  await assert.rejects(f.service.run('themes.export', { settings: settings({ backgroundUrl: 'javascript:evil' }) }));
  assert.equal(f.dialogs.length, 0);
  await assert.rejects(f.service.run('themes.export'), /nicht vom Control Center/);
  assert.equal(await fs.readFile(target, 'utf8'), 'foreign');
});

test('failed atomic replacement leaves original owned theme and exact backup intact with no temporary debris', async t => {
  const io = { ...fs, rename: async () => { const error = new Error('fixture unexpected sensitive path'); error.code = 'EACCES'; throw error; } };
  const f = await fixture(t, { fsImpl: io }), target = path.join(f.themes, OWNED_THEME_FILE), original = generateTheme(settings());
  await fs.writeFile(target, original);
  await assert.rejects(f.service.run('themes.install', { settings: settings({ fontSize: 21 }), confirm: true }), error => !error.message.includes('sensitive') && /Ordnerzugriff/.test(error.message));
  assert.equal(await fs.readFile(target, 'utf8'), original);
  const files = await fs.readdir(f.themes), backups = files.filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1); assert.equal(files.some(name => name.endsWith('.tmp')), false);
  assert.equal(await fs.readFile(path.join(f.themes, backups[0]), 'utf8'), original);
});

test('concurrent saves serialize instead of racing partial settings writes', async t => {
  const f = await fixture(t);
  await Promise.all([f.service.run('themes.save', { settings: settings({ fontSize: 14 }) }), f.service.run('themes.save', { settings: settings({ fontSize: 21 }) })]);
  assert.equal((await f.service.run('themes.state')).settings.fontSize, 21);
  assert.deepEqual(await fs.readdir(f.directory), ['theme-settings.json']);
});
