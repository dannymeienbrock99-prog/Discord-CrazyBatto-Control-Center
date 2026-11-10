'use strict';
// Original Control Center bridge code. No third-party plugin code is bundled here.
// BetterDiscord exposes the traditional names through its limited polyfills.
const fs = require('fs');
const path = require('path');
const nativeCrypto = require('crypto');
const crypto = {...nativeCrypto, randomUUID: nativeCrypto.randomUUID || (()=>{
  const bytes=Buffer.from(nativeCrypto.randomBytes(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
})};
const VERSION = '3.4.0';
const PROTOCOL = 1;
const MAX_JSON = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
function fail(message) { throw new Error(message); }
function plain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function clean(v, depth = 0) {
  if (depth > 12) fail('Daten sind zu tief verschachtelt.');
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length <= 32768) return v;
  if (Array.isArray(v) && v.length <= 1000) return v.map(x => clean(x, depth + 1));
  if (plain(v) && Object.keys(v).length <= 200) {
    const out = {};
    for (const key of Object.keys(v).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 100) fail('Ungültiger Datenschlüssel.');
      out[key] = clean(v[key], depth + 1);
    }
    return out;
  }
  fail('Ungültige oder zu große Daten.');
}
function canonical(v) { return JSON.stringify(clean(v)); }
function digest(v) { return crypto.createHash('sha256').update(canonical(v)).digest('hex'); }
function hmac256(secret, text) {
  if(typeof crypto.createHmac==='function')return crypto.createHmac('sha256',secret).update(text).digest('hex');
  // RFC 2104 composition using the native SHA-256 exposed by BetterDiscord.
  let key=Buffer.from(secret,'utf8');if(key.length>64)key=Buffer.from(crypto.createHash('sha256').update(key).digest('hex'),'hex');
  const inner=Buffer.alloc(64,0x36),outer=Buffer.alloc(64,0x5c);
  for(let index=0;index<key.length;index++){inner[index]^=key[index];outer[index]^=key[index];}
  const inside=Buffer.from(crypto.createHash('sha256').update(inner).update(text).digest('hex'),'hex');
  return crypto.createHash('sha256').update(outer).update(inside).digest('hex');
}
function signed(v, secret) {
  const body = clean(v);
  return {...body, signature: hmac256(secret,canonical(body))};
}
function verify(envelope, secret) {
  if (!plain(envelope) || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) return false;
  const {signature, ...body} = envelope;
  const expected = signed(body, secret).signature;
  if(typeof crypto.timingSafeEqual==='function')return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  let difference=0;for(let index=0;index<64;index++)difference|=signature.charCodeAt(index)^expected.charCodeAt(index);return difference===0;
}
function checkPath(target, {missing = false, directory = false, max = MAX_JSON} = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    if(!fs.existsSync(current)){
      // A dangling link is present in the parent directory even though existsSync
      // follows it and says false. Never treat that as an ordinary missing file.
      if(fs.readdirSync(path.dirname(current)).some(name=>path.sep==='\\'?name.toLowerCase()===parts[index].toLowerCase():name===parts[index]))fail('Nicht erreichbare Verknüpfung oder Datei.');
      if(missing)return null;
      fail('Die erwartete Datei oder der Ordner fehlt.');
    }
    try { stat = fs.lstatSync(current); } catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      throw error;
    }
    // BD's lstatSync is statSync. Resolve every component as an additional check.
    const real=path.resolve(fs.realpathSync(current)),expected=path.resolve(current);
    const equal=path.sep==='\\'?real.toLowerCase()===expected.toLowerCase():real===expected;
    if (stat.isSymbolicLink()||!equal) fail('Verknüpfte Dateien oder Ordner werden nicht verwendet.');
    if (index < parts.length - 1 || directory) {
      if (!stat.isDirectory()) fail('Der erwartete Ordner fehlt.');
    } else if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail('Die Datei ist nicht sicher lesbar oder zu groß.');
    if (index === parts.length - 1) return stat;
  }
  fail('Ungültiger Dateipfad.');
}
function mkdir(target) {
  checkPath(target, {missing: true, directory: true});
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  checkPath(target, {directory: true});
}
function read(target, {optional = false, max = MAX_JSON} = {}) {
  const stat = checkPath(target, {missing: optional, max});
  if (!stat) return null;
  if(typeof fs.openSync!=='function'){
    const data=Buffer.from(fs.readFileSync(target,{encoding:null}));
    const after=checkPath(target,{max});
    if(data.length>max||after.ino!==stat.ino||after.dev!==stat.dev||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)fail('Datei wurde während des Lesens geändert.');
    return data;
  }
  const handle = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(handle);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || opened.size > max) fail('Datei wurde während des Lesens geändert.');
    const data = fs.readFileSync(handle);
    if (data.length > max) fail('Datei zu groß.');
    return data;
  } finally { fs.closeSync(handle); }
}
function readJson(target, options) {
  const value = read(target, options);
  return value === null ? null : clean(JSON.parse(value.toString('utf8')));
}
function writeAtomic(target, data) {
  const contents = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  if (contents.length > MAX_JSON * 4) fail('Datei zu groß.');
  checkPath(path.dirname(target), {directory: true});
  checkPath(target, {missing: true, max: MAX_JSON * 4});
  const temporary = path.join(path.dirname(target), `.cc-${crypto.randomUUID()}.tmp`);
  try {
    writeExclusive(temporary,contents);
    checkPath(target, {missing: true, max: MAX_JSON * 4});
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function writeExclusive(target,contents){
  checkPath(path.dirname(target),{directory:true});checkPath(target,{missing:true,max:MAX_JSON*4});
  if(typeof fs.openSync!=='function'){fs.writeFileSync(target,contents,{flag:'wx',mode:0o600});return;}
  const fd=fs.openSync(target,'wx',0o600);
  try{fs.writeFileSync(fd,contents);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function jsonAtomic(target, data) { writeAtomic(target, JSON.stringify(clean(data))); }
function remove(target) { if (checkPath(target, {missing: true, max: MAX_JSON * 4})) fs.unlinkSync(target); }
function backup(target, destination) {
  const contents = read(target, {optional: true, max: MAX_JSON * 4});
  if (contents === null) return;
  mkdir(destination);
  writeAtomic(path.join(destination, `${path.basename(target)}.${Date.now()}.${crypto.randomUUID()}.bak`), contents);
}
const bool = (key, label, value = true) => ({key, label, type: 'boolean', default: value});
const txt = (key, label, value = '') => ({key, label, type: 'text', default: value, maxLength: 80});
const catalog = {
  BDFDB: {file: '0BDFDB.plugin.js', version: '4.5.9', fields: [], dependencies: []},
  MoreRoleColors: {version: '2.0.19', storage: 'settings', fields: [
    ...Object.entries({voiceUsers:'Mitglieder im Sprachkanal',speakingIndicator:'Sprechende Mitglieder',typingUsers:'Tippende Mitglieder',mentions:'Erwähnungen',accountArea:'Eigener Kontobereich',textEditor:'Nachrichtenfeld',auditLog:'Audit-Protokoll',roleHeaders:'Rollenüberschriften',messages:'Nachrichten',userProfile:'Nutzerprofile',serverProfileDisplayName:'Server-Profilname',Tags:'Rollen-Tags'}).map(([key,label]) => bool(key,label,!['speakingIndicator','messages'].includes(key))),
    ...Object.entries({voiceUsers:'Sprachkanal',typingUsers:'Tippende Mitglieder',mentions:'Erwähnungen',accountArea:'Kontobereich',textEditor:'Nachrichtenfeld',auditLog:'Audit-Protokoll',roleHeaders:'Rollenüberschriften',messages:'Nachrichten',userProfile:'Nutzerprofile',serverProfileDisplayName:'Server-Profilname'}).map(([key,label]) => bool(`${key}Gradient`,`${label}: Farbverläufe`,key !== 'messages'))
  ]},
  StaffTag: {version: '1.7.4', storage: 'bdfdb', dependencies: ['BDFDB'], fields: [
    bool('general.useCrown','Kronen statt Text-Badges'),bool('general.useRoleColor','Rollenfarbe verwenden'),bool('general.useBlackFont','Schwarze Schrift',false),bool('general.ignoreBots','Bots ausblenden',false),bool('general.ignoreMyself','Eigene Kennzeichnung ausblenden',false),
    ...Object.entries({owners:'Serverinhaber',groupOwners:'Gruppeninhaber',threadCreators:'Thread-Ersteller',forumCreators:'Forum-Ersteller',admins:'Administratoren',managementG:'Serververwaltung',managementC:'Kanalverwaltung',managementT:'Threadverwaltung',managementE:'Eventverwaltung',managementR:'Rollenverwaltung',managementU:'Mitgliederverwaltung',managementV:'Sprachverwaltung',managementM:'Nachrichtenverwaltung'}).map(([key,label])=>bool(`tagTypes.${key}`,label)),
    ...Object.entries({chat:'Im Chat',memberList:'In der Mitgliederliste',voiceList:'In Sprachkanälen',userPopout:'Im Kurzprofil',userProfile:'Im Profil'}).map(([key,label])=>bool(`tagPlaces.${key}`,label)),
    ...Object.entries({owner:'Text für Inhaber',groupOwner:'Text für Gruppeninhaber',forumCreator:'Text für Forum-Ersteller',threadCreator:'Text für Thread-Ersteller',admin:'Text für Administratoren',management:'Text für Verwaltung'}).map(([key,label])=>({...txt(`customTitles.${key}`,label),maxLength:40}))
  ]},
  ShowSpectators: {version:'1.2.2',storage:'SETTINGS',fields:[bool('showPanel','Zuschauerbereich anzeigen'),bool('openFullProfile','Vollständiges Profil öffnen',false),bool('compactMode','Kompakte Anzeige',false),bool('showWatchedStream','Angesehenen Stream anzeigen')]},
  SpotifyEnhance: {version:'1.1.20',storage:'settings',fields:Object.entries({activityIndicator:'Aktivitätsanzeige',playerBannerBackground:'Cover im Player',embedBannerBackground:'Cover in Einbettungen',playerCompactMode:'Kompakter Player',activity:'Spotify-Aktivität anzeigen',player:'Spotify-Player anzeigen',Share:'Teilen-Schaltfläche',Shuffle:'Zufallswiedergabe',Previous:'Vorheriger Titel',Play:'Wiedergabe',Next:'Nächster Titel',Repeat:'Wiederholung',Volume:'Lautstärke'}).map(([key,label])=>bool(key,label))},
  RemovedConnectionAlerts: {version:'0.9.6',storage:'config',nested:'settings',fields:[bool('hideButton','Verlauf-Schaltfläche in Discord ausblenden',false)]},
  VoiceMessages: {version:'0.1.17',storage:'settings',fields:[bool('skipMetadata','Audiodetails überspringen',false),bool('voiceDownload','Download-Schaltfläche anzeigen')]},
  AllCallTimeCounter: {version:'1.1.3',storage:'individual',fields:[bool('showWithoutHover','Timer immer anzeigen'),bool('showRoleColor','Rollenfarbe verwenden'),bool('trackSelf','Eigenen Timer anzeigen'),bool('showSeconds','Sekunden anzeigen'),bool('watchLargeGuilds','Auch große Server beobachten',false),{key:'format',label:'Zeitformat',type:'select',default:true,options:[{label:'Stunden:Minuten:Sekunden',value:true},{label:'Ausgeschrieben',value:'human'}]}]},
  ChatFilter: {version:'3.6.2',storage:'bdfdb',dependencies:['BDFDB'],fields:[bool('general.addContextMenu','Filter im Kontextmenü'),bool('general.targetMessages','Nachrichten filtern'),bool('general.targetStatuses','Status filtern'),bool('general.targetOwn','Eigene Nachrichten filtern'),txt('replaces.blocked','Ersatz für blockierte Nachrichten','~~BLOCKED~~'),txt('replaces.censored','Ersatz für zensierte Wörter','$!%&%!&'),{key:'blockedWords',label:'Nachrichten mit diesen Wörtern ausblenden',type:'words',default:[],maxLength:60,max:100},{key:'censoredWords',label:'Diese Wörter ersetzen',type:'words',default:[],maxLength:60,max:100}]}
};
for (const [id, spec] of Object.entries(catalog)) { spec.id = id; spec.file ||= `${id}.plugin.js`; spec.dependencies ||= []; }
function specFor(id) { if (typeof id !== 'string' || !Object.hasOwn(catalog,id)) fail('Dieses Plugin wird nicht unterstützt.'); return catalog[id]; }
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('Unbekannte Eingabefelder.');
}
function validValues(id, values) {
  const spec = specFor(id); keys(values,spec.fields.map(x=>x.key));
  for (const [key,value] of Object.entries(values)) {
    const field = spec.fields.find(x=>x.key===key);
    if (field.type==='boolean' && typeof value !== 'boolean') fail('Erwartet wird ein Schalter.');
    if (field.type==='text' && (typeof value !== 'string' || value.length>field.maxLength || /[\x00-\x08\x0b-\x1f]/.test(value))) fail('Text ist zu lang oder ungültig.');
    if (field.type==='select' && !field.options.some(option=>option.value===value)) fail('Auswahl ist ungültig.');
    if (field.type==='words' && (!Array.isArray(value) || value.length>100 || new Set(value).size!==value.length || value.some(word=>typeof word!=='string' || !word.trim() || word!==word.trim() || word.length>60 || /[\r\n\x00]/.test(word) || ['__proto__','constructor','prototype'].includes(word)))) fail('Höchstens 100 unterschiedliche Wörter mit je 60 Zeichen, ohne Leerzeichen am Rand.');
  }
  return clean(values);
}
function validateRoleSettings(value) {
  keys(value,['enabled','guildId','rules']);
  if (typeof value.enabled !== 'boolean' || typeof value.guildId !== 'string' || (value.guildId && !SNOWFLAKE.test(value.guildId)) || (value.enabled && !SNOWFLAKE.test(value.guildId)) || !Array.isArray(value.rules) || value.rules.length>20) fail('Rollen-Zuordnung ist ungültig.');
  const seen = new Set();
  for (const rule of value.rules) {
    keys(rule,['roleId','label','icon','color']);
    if (!SNOWFLAKE.test(rule.roleId) || seen.has(rule.roleId) || typeof rule.label!=='string' || !rule.label.trim() || rule.label.length>40 || !['crown','shield','star'].includes(rule.icon) || !/^#[a-f0-9]{6}$/i.test(rule.color)) fail('Jede Rolle benötigt eine eindeutige ID, einen Namen und ein gültiges Symbol.');
    seen.add(rule.roleId);
  }
  return clean(value);
}
function validate(operation, payload) {
  clean(payload);
  if (['state','spectators'].includes(operation)) keys(payload,[]);
  else if(operation==='settings') {keys(payload,['pluginId']); specFor(payload.pluginId);}
  else if(operation==='toggle') {keys(payload,['pluginId','enabled']);specFor(payload.pluginId);if(typeof payload.enabled!=='boolean')fail('Schalter ist ungültig.');}
  else if(operation==='save') {keys(payload,['pluginId','expectedRevision','values']);validValues(payload.pluginId,payload.values);if(!/^[a-f0-9]{64}$/.test(payload.expectedRevision))fail('Einstellungsstand fehlt.');}
  else if(operation==='history') {keys(payload,['limit']);if(payload.limit!==undefined&&(!Number.isInteger(payload.limit)||payload.limit<1||payload.limit>200))fail('Ungültige Anzahl.');}
  else if(operation==='roles.save') {keys(payload,['expectedRevision','enabled','guildId','rules']);const {expectedRevision,...settings}=payload;if(!/^[a-f0-9]{64}$/.test(expectedRevision))fail('Einstellungsstand fehlt.');validateRoleSettings(settings);}
  else fail('Unbekannte lokale Aktion.');
  return payload;
}
function discover(folder, ids=Object.keys(catalog)) {
  return ids.map(id=>specFor(id)).map(spec=>{
    const base={id:spec.id,name:spec.id,installed:false,version:null,enabled:null,dependencies:spec.dependencies,message:''};
    try {
      const contents=read(path.join(folder,spec.file),{optional:true,max:4*MAX_JSON});
      if(!contents)return base;
      const header=contents.toString('utf8',0,Math.min(contents.length,8000));
      const name=header.match(/@name\s+([^\r\n]+)/)?.[1]?.trim();
      const version=header.match(/@version\s+([^\r\n]+)/)?.[1]?.trim();
      if(name!==spec.id || !version || version.length>40) return {...base,message:'Plugin-Kopf oder Dateiname stimmt nicht überein.'};
      return {...base,installed:true,version,settingsSupported:version===spec.version,message:version===spec.version?'':`Einstellungen für Version ${version} noch nicht geprüft.`};
    } catch { return {...base,message:'Datei ist nicht sicher lesbar.'}; }
  });
}
module.exports={VERSION,PROTOCOL,MAX_JSON,UUID,SNOWFLAKE,fs,path,crypto,fail,plain,clean,canonical,digest,signed,verify,checkPath,mkdir,read,readJson,writeAtomic,writeExclusive,jsonAtomic,remove,backup,catalog,specFor,keys,validValues,validateRoleSettings,validate,discover};
