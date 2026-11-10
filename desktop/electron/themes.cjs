'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const OWNED_THEME_FILE = 'CrazyBatto-TeamAlpha.theme.css';
const OWNER_MARKER = '/* CrazyBatto Control Center managed theme: team-alpha-v1 */';
const MAX_FILE = 1024 * 1024;
const MAX_THEMES = 300;
const PRESETS = [
  { id: 'gold-marble', name: 'Goldmarmor', settings: { preset: 'gold-marble', accentColor: '#D4AF37', backgroundColor: '#0B0D12', surfaceColor: '#151820', textColor: '#F5F2E8', backgroundUrl: 'https://crazybatto.de/assets/control/marble-gold.webp', backgroundIntensity: 25, borderRadius: 12, fontSize: 16 } },
  { id: 'dark', name: 'Dunkel', settings: { preset: 'dark', accentColor: '#8C9DCC', backgroundColor: '#111318', surfaceColor: '#1A1D24', textColor: '#F2F3F5', backgroundUrl: '', backgroundIntensity: 15, borderRadius: 8, fontSize: 16 } },
];
class ThemeError extends Error {}
const fail = message => { throw new ThemeError(message); };
const clone = value => JSON.parse(JSON.stringify(value));
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function backgroundUrl(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\"'(){};<>\x00-\x1f\x7f]/.test(value)) fail('Bitte eine öffentliche HTTPS-Bildadresse ohne CSS-Code verwenden.');
  let url;
  try { url = new URL(value); } catch { fail('Die Hintergrundadresse ist ungültig.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) fail('Der Hintergrund benötigt eine öffentliche HTTPS-Adresse ohne Zugangsdaten.');
  try { if (/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname))) fail('Bitte ein Bild statt einer Videoadresse verwenden.'); } catch (error) { if (error instanceof ThemeError) throw error; fail('Die Hintergrundadresse ist ungültig.'); }
  return url.href;
}
function validateSettings(value) {
  const keys = Object.keys(PRESETS[0].settings);
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) fail('Die Theme-Einstellungen sind unvollständig oder enthalten unbekannte Felder.');
  if (!PRESETS.some(preset => preset.id === value.preset)) fail('Bitte eine vorhandene Theme-Vorlage wählen.');
  const output = { preset: value.preset };
  for (const key of ['accentColor', 'backgroundColor', 'surfaceColor', 'textColor']) {
    if (typeof value[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(value[key])) fail('Farben müssen als sechsstellige HEX-Farbe angegeben werden.');
    output[key] = value[key].toUpperCase();
  }
  output.backgroundUrl = backgroundUrl(value.backgroundUrl);
  for (const [key, min, max] of [['backgroundIntensity', 0, 80], ['borderRadius', 0, 24], ['fontSize', 12, 22]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) fail('Bildstärke, Rundungen oder Textgröße liegen außerhalb des erlaubten Bereichs.');
    output[key] = value[key];
  }
  return output;
}
function rgb(color) { return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16)); }
function mix(a, b, ratio) { return '#' + rgb(a).map((value, index) => Math.round(value * (1 - ratio) + rgb(b)[index] * ratio).toString(16).padStart(2, '0')).join('').toUpperCase(); }
function rgba(color, opacity) { return `rgba(${rgb(color).join(', ')}, ${opacity})`; }
function generateTheme(input) {
  const s = validateSettings(input);
  const muted = mix(s.textColor, s.backgroundColor, 0.32), highlight = mix(s.accentColor, '#FFFFFF', 0.14);
  const buttonText = rgb(s.accentColor).reduce((sum, component, index) => sum + component * [0.299, 0.587, 0.114][index], 0) > 150 ? '#101116' : '#FFFFFF';
  const image = s.backgroundUrl && s.backgroundIntensity ? `url(${JSON.stringify(s.backgroundUrl)})` : 'none';
  const cover = rgba(s.backgroundColor, Number((1 - s.backgroundIntensity / 100).toFixed(2)));
  // BetterDiscord's documented metadata format and prefixed custom variables:
  // https://docs.betterdiscord.app/themes/introduction/quick-start
  // https://docs.betterdiscord.app/themes/introduction/environment
  // Current semantic variables checked against BetterDiscord/AddonAnalyzer's
  // src/data/discord-css-variables.json (2026-07-19); no hashed class names.
  return `/**
 * @name CrazyBatto Team Alpha
 * @author Crazy_Batto
 * @description Lokales Schwarz-Gold-Theme fuer Team Alpha. Aktivierung in BetterDiscord unter Themes.
 * @version 3.1.0
 */
${OWNER_MARKER}
/* No remote imports, scripts or automatic updates. Optional image URL is configured by you. */
:root, .theme-dark, .theme-light {
  --cbta-accent: ${s.accentColor};
  --cbta-background: ${s.backgroundColor};
  --cbta-surface: ${s.surfaceColor};
  --cbta-text: ${s.textColor};
  --cbta-muted: ${muted};
  --cbta-radius: ${s.borderRadius}px;
  --cbta-font-size: ${s.fontSize}px;
  --cbta-image: ${image};
  --cbta-image-cover: ${cover};
  --background-base-lowest: var(--cbta-background);
  --background-base-lower: var(--cbta-background);
  --background-base-low: var(--cbta-surface);
  --background-surface-high: var(--cbta-surface);
  --background-surface-higher: ${mix(s.surfaceColor, s.textColor, 0.04)};
  --background-surface-highest: ${mix(s.surfaceColor, s.textColor, 0.08)};
  --background-accent: var(--cbta-accent);
  --app-frame-background: var(--cbta-background);
  --chat-background: var(--cbta-background);
  --chat-background-default: var(--cbta-background);
  --modal-background: var(--cbta-surface);
  --modal-footer-background: var(--cbta-background);
  --input-background-default: var(--cbta-background);
  --input-text-default: var(--cbta-text);
  --input-border-active: var(--cbta-accent);
  --input-border-default: ${rgba(s.accentColor, 0.25)};
  --text-default: var(--cbta-text);
  --text-strong: var(--cbta-text);
  --text-subtle: var(--cbta-muted);
  --text-muted: var(--cbta-muted);
  --text-link: var(--cbta-accent);
  --icon-default: var(--cbta-text);
  --icon-muted: var(--cbta-muted);
  --interactive-text-default: var(--cbta-muted);
  --interactive-text-hover: var(--cbta-text);
  --interactive-text-active: var(--cbta-accent);
  --interactive-background-hover: ${rgba(s.accentColor, 0.09)};
  --interactive-background-selected: ${rgba(s.accentColor, 0.15)};
  --mention-background: ${rgba(s.accentColor, 0.15)};
  --mention-foreground: var(--cbta-accent);
  --message-mentioned-background-default: ${rgba(s.accentColor, 0.08)};
  --message-mentioned-background-hover: ${rgba(s.accentColor, 0.13)};
  --control-primary-background-default: var(--cbta-accent);
  --control-primary-background-hover: ${highlight};
  --control-primary-background-active: ${mix(s.accentColor, '#000000', 0.12)};
  --control-primary-text-default: ${buttonText};
  --control-primary-text-hover: ${buttonText};
  --control-primary-text-active: ${buttonText};
  --control-primary-icon-default: ${buttonText};
  --custom-border-radius: var(--cbta-radius);
  --custom-input-border-radius: var(--cbta-radius);
  --radius-sm: ${Math.min(s.borderRadius, 8)}px;
  --radius-md: var(--cbta-radius);
  --radius-lg: var(--cbta-radius);
}
#app-mount {
  color: var(--cbta-text);
  background-color: var(--cbta-background);
}
/* Stable message-list attribute rather than Discord's generated class suffixes. */
#app-mount [data-list-id="chat-messages"] {
  background-color: var(--cbta-background);
  background-image: linear-gradient(var(--cbta-image-cover), var(--cbta-image-cover)), var(--cbta-image);
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  background-attachment: fixed;
}
#app-mount [id^="message-content-"] {
  font-size: var(--cbta-font-size);
  line-height: 1.5;
}
#app-mount :is([role="dialog"], [role="menu"], input, textarea) {
  border-radius: var(--cbta-radius);
}
`;
}

async function optionalStat(io, file) { try { return await io.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function regularFile(io, file, limit = MAX_FILE) {
  const stat = await optionalStat(io, file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > limit) fail('Die Datei ist verknüpft, zu groß oder kein reguläres Theme.');
  return stat;
}
function owned(bytes) { return bytes.toString('utf8').slice(0, 8192).includes(OWNER_MARKER); }
async function atomicWrite(io, target, bytes, expected = null) {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await io.open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const current = await regularFile(io, target);
    if (!!current !== !!expected || current && (current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ino !== expected.ino)) fail('Die Datei wurde zwischenzeitlich geändert. Bitte erneut prüfen.');
    await io.rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

class ThemesService {
  constructor({ directory, appDataDirectory, dialog, getWindow = () => null, fsImpl = fs }) {
    if (!path.isAbsolute(directory || '') || !path.isAbsolute(appDataDirectory || '')) throw new TypeError('Absolute application directories required.');
    this.directory = path.resolve(directory); this.appDataDirectory = path.resolve(appDataDirectory);
    this.themesDirectory = path.join(this.appDataDirectory, 'BetterDiscord', 'themes');
    this.settingsFile = path.join(this.directory, 'theme-settings.json');
    this.dialog = dialog; this.getWindow = getWindow; this.fs = fsImpl; this.queue = Promise.resolve();
  }
  async settings() {
    const stat = await regularFile(this.fs, this.settingsFile, 16384);
    if (!stat) return clone(PRESETS[0].settings);
    try { const data = JSON.parse(await this.fs.readFile(this.settingsFile, 'utf8')); if (data.version !== 1) fail('Unbekanntes Theme-Einstellungsformat.'); return validateSettings(data.settings); }
    catch (error) { if (error instanceof ThemeError) throw error; fail('Die lokalen Theme-Einstellungen können nicht gelesen werden.'); }
  }
  async themesFolder() {
    const base = await optionalStat(this.fs, this.appDataDirectory);
    if (!base?.isDirectory()) return null;
    const canonical = await this.fs.realpath(this.appDataDirectory);
    for (const part of [path.join(canonical, 'BetterDiscord'), path.join(canonical, 'BetterDiscord', 'themes')]) {
      const stat = await optionalStat(this.fs, part);
      if (!stat) return null;
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Der BetterDiscord-Themeordner darf keine Verknüpfung sein.');
    }
    return path.join(canonical, 'BetterDiscord', 'themes');
  }
  async list() {
    const folder = await this.themesFolder();
    if (!folder) return [];
    const entries = await this.fs.readdir(folder, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (result.length >= MAX_THEMES) break;
      if (!entry.isFile() || entry.isSymbolicLink() || !/\.theme\.css$/i.test(entry.name) || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
      const file = path.join(folder, entry.name), stat = await optionalStat(this.fs, file);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > MAX_FILE) continue;
      // Only bounded metadata is read; other themes are never evaluated or imported.
      const handle = await this.fs.open(file, 'r');
      let head;
      try { const buffer = Buffer.alloc(8192); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); head = buffer.subarray(0, bytesRead).toString('utf8'); }
      finally { await handle.close(); }
      const name = /^\s*\*?\s*@name\s+([^\r\n]{1,120})/m.exec(head)?.[1]?.trim() || entry.name.replace(/\.theme\.css$/i, '');
      result.push({ fileName: entry.name, name: name.replace(/[\x00-\x1f\x7f]/g, ''), owned: entry.name === OWNED_THEME_FILE && head.includes(OWNER_MARKER), size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
    return result.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }
  async state() {
    const [settings, folder] = await Promise.all([this.settings(), this.themesFolder()]);
    const themes = folder ? await this.list() : [];
    return { settings, presets: clone(PRESETS), themes, status: { localOnly: true, betterDiscordAvailable: !!folder, themesPath: this.themesDirectory, ownedThemeInstalled: themes.some(theme => theme.owned), activationRequired: true, activationKnown: false } };
  }
  async save(settings) {
    await this.fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await this.fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Der lokale Einstellungsordner darf keine Verknüpfung sein.');
    const previous = await regularFile(this.fs, this.settingsFile, 16384);
    await atomicWrite(this.fs, this.settingsFile, JSON.stringify({ version: 1, settings }, null, 2) + '\n', previous);
    return this.state();
  }
  async writeTheme(target, settings) {
    const previous = await regularFile(this.fs, target);
    let backupPath = null;
    if (previous) {
      const bytes = await this.fs.readFile(target);
      if (!owned(bytes)) fail('Diese vorhandene Datei wurde nicht vom Control Center erstellt und wird nicht überschrieben. Bitte einen anderen Exportnamen wählen.');
      backupPath = target + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8) + '.bak';
      await this.fs.writeFile(backupPath, bytes, { flag: 'wx', mode: 0o600 });
    }
    await atomicWrite(this.fs, target, generateTheme(settings), previous);
    return { canceled: false, path: target, fileName: path.basename(target), backupPath, activationRequired: true };
  }
  async perform(action, payload) {
    if (!plain(payload)) fail('Ungültige Theme-Anfrage.');
    const allowed = { 'themes.state': [], 'themes.list': [], 'themes.save': ['settings'], 'themes.export': ['settings'], 'themes.install': ['settings', 'confirm'] }[action];
    if (!allowed || Object.keys(payload).some(key => !allowed.includes(key))) fail('Unbekannte Theme-Aktion oder Einstellung.');
    if (action === 'themes.state') return this.state();
    if (action === 'themes.list') return this.list();
    const settings = payload.settings === undefined && action !== 'themes.save' ? await this.settings() : validateSettings(payload.settings);
    if (action === 'themes.save') return this.save(settings);
    if (action === 'themes.install') {
      if (payload.confirm !== true) fail('Bitte das Ablegen der eigenen Theme-Datei ausdrücklich bestätigen.');
      const folder = await this.themesFolder();
      if (!folder) fail('Der BetterDiscord-Themeordner wurde auf diesem PC nicht gefunden. Das Theme kann stattdessen exportiert werden.');
      return this.writeTheme(path.join(folder, OWNED_THEME_FILE), settings);
    }
    const options = { title: 'Team-Alpha-Theme exportieren', defaultPath: OWNED_THEME_FILE, filters: [{ name: 'BetterDiscord-Theme', extensions: ['css'] }], properties: ['showOverwriteConfirmation', 'dontAddToRecent'] };
    const window = this.getWindow();
    const result = await (window ? this.dialog.showSaveDialog(window, options) : this.dialog.showSaveDialog(options));
    if (result.canceled || !result.filePath) return { canceled: true };
    if (!path.isAbsolute(result.filePath) || !/\.theme\.css$/i.test(path.basename(result.filePath)) || /[\x00-\x1f\x7f]/.test(result.filePath)) fail('Bitte als Datei mit der Endung .theme.css speichern.');
    const folder = await this.fs.realpath(path.dirname(result.filePath));
    return this.writeTheme(path.join(folder, path.basename(result.filePath)), settings);
  }
  run(action, payload = {}) {
    const result = this.queue.then(() => this.perform(action, payload));
    this.queue = result.catch(() => {});
    return result.catch(error => { if (error instanceof ThemeError) throw error; throw new ThemeError('Die lokale Theme-Aktion konnte nicht abgeschlossen werden. Bitte Ordnerzugriff und Datei prüfen.'); });
  }
}

module.exports = { ThemesService, ThemeError, validateSettings, generateTheme, PRESETS, OWNED_THEME_FILE };
