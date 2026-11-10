'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TEMPLATE_STORE_LIMIT } = require('./validation.cjs');

class LocalStorage {
  constructor(directory, safeStorage) { this.directory = directory; this.crypto = safeStorage; fs.mkdirSync(directory,{recursive:true}); }
  filename(name) {
    if (!['templates','settings','logs'].includes(name)) throw new Error('Unbekannter lokaler Datensatz.');
    return path.join(this.directory, `${name}.json`);
  }
  read(name, fallback) {
    try {
      const file = this.filename(name);
      if (fs.statSync(file).size > (name === 'templates' ? TEMPLATE_STORE_LIMIT : 2 * 1024 * 1024)) return fallback;
      const value = JSON.parse(fs.readFileSync(file,'utf8'));
      if (Array.isArray(fallback) && !Array.isArray(value)) return fallback;
      if (!value || typeof value !== 'object') return fallback;
      return value;
    } catch { return fallback; }
  }
  write(name, value) {
    const file = this.filename(name);
    const data = JSON.stringify(value,null,2);
    if (Buffer.byteLength(data) > (name === 'templates' ? TEMPLATE_STORE_LIMIT : 2 * 1024 * 1024)) throw new Error(name === 'templates' ? 'Die Vorlagen benötigen zusammen mehr als 64 MB. Entferne einige Bilder oder Vorlagen.' : 'Der lokale Datensatz ist zu groß.');
    const temporary = `${file}.pending`;
    fs.writeFileSync(temporary,data,{mode:0o600});
    fs.renameSync(temporary,file);
  }
  tokenFile() { return path.join(this.directory,'bot-token.encrypted'); }
  hasToken() { return fs.existsSync(this.tokenFile()); }
  saveToken(token) {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Windows kann den Token gerade nicht verschlüsseln. Verbinde den Bot ohne „Token speichern“.');
    const encrypted = this.crypto.encryptString(token);
    const target = this.tokenFile();
    fs.writeFileSync(`${target}.pending`,encrypted,{mode:0o600});
    fs.renameSync(`${target}.pending`,target);
  }
  readToken() {
    if (!this.hasToken()) return null;
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Der gespeicherte Token kann unter diesem Windows-Konto nicht entschlüsselt werden.');
    try { return this.crypto.decryptString(fs.readFileSync(this.tokenFile())); }
    catch { throw new Error('Der gespeicherte Token ist nicht lesbar. Bitte erneut eingeben.'); }
  }
  deleteToken() { fs.rmSync(this.tokenFile(),{force:true}); }
}
module.exports = { LocalStorage };
