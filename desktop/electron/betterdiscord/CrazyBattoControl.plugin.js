/**
 * @name CrazyBattoControl
 * @author Crazy_Batto
 * @version 3.4.0
 * @description Verbindet ausschließlich das lokale Control Center mit deinen vorhandenen Plugins. Keine Netzwerkverbindung, keine Discord-Token.
 * @crazybatto-original-bridge 1
 * @crazybatto-single-file 1
 * @coreSha256 8fec5a3225378ebd82456a480e106556cd3ecdce6420e148808806071592ff9a
 * @runtimeSha256 e72ba101656da414031d71efb48f845d39bb3bf43bcd8718775abe6668751c8a
 */
'use strict';
// Generated from our own local-discord-core.cjs and local-companion-runtime.cjs.
// Static source only: no external helper imports or runtime code compilation.
const core=(()=>{
  const module={exports:{}};
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

  return module.exports;
})();
const createCompanion=(()=>{
  const module={exports:{}};
'use strict';
// Original runtime. Bundled statically into the single BetterDiscord plugin.
module.exports=function createCompanion(c) {
const {path,fs}=c;
const NAME='CrazyBattoControl';
const DEFAULT_ROLES={enabled:false,guildId:'',rules:[]};
const deepClone=value=>JSON.parse(JSON.stringify(value));
const get=(value,key)=>key.split('.').reduce((current,part)=>current?.[part],value);
function set(value,key,data){const parts=key.split('.');let current=value;for(const part of parts.slice(0,-1)){if(!c.plain(current[part]))current[part]={};current=current[part];}current[parts.at(-1)]=deepClone(data);}
function simpleRule(rule){return c.plain(rule)&&!rule.regex&&!rule.segment&&!rule.case&&!rule.empty&&rule.exact!==false&&(!rule.replace||rule.replace==='');}
return class CrazyBattoControl {
  constructor(meta,testing={}){this.api=testing.api||globalThis.BdApi;this.now=testing.now||Date.now;this.folder=testing.folder||this.api.Plugins.folder;this.bridge=path.join(this.folder,'.crazybatto-control');this.running=false;this.busy=false;this.lastHeartbeat=0;this.unpatches=[];this.rolePatch=null;this.roleMessage='';this.library=testing.library||null;}
  start(){
    this.auth=c.readJson(path.join(this.bridge,'auth.json'));
    if(this.auth.protocol!==c.PROTOCOL||!/^[a-f0-9]{64}$/.test(this.auth.secret))throw new Error('Control Center: lokale Kopplung fehlt.');
    for(const name of ['requests','responses','processing','backups'])c.checkPath(path.join(this.bridge,name),{directory:true});
    this.bootId=c.crypto.randomUUID();this.running=true;
    this.roles=this.readRoles();this.syncRolePatch();this.heartbeat();
    this.timer=setInterval(()=>this.tick().catch(()=>{}),250);
  }
  stop(){this.running=false;clearInterval(this.timer);this.clearRolePatch();try{c.remove(path.join(this.bridge,'heartbeat.json'));}catch{} }
  getSettingsPanel(){const element=document.createElement('div');element.textContent='Die Einstellungen findest du im CrazyBatto Control Center unter „Mein Discord“. Die Verbindung ist lokal auf diesem PC; es werden keine Anmeldedaten übertragen.';return element;}
  store(name){try{return this.api.Webpack.getStore(name);}catch{return null;}}
  account(){const id=this.store('UserStore')?.getCurrentUser?.()?.id;return c.SNOWFLAKE.test(id)?id:null;}
  enabled(id){try{return this.api.Plugins.isEnabled(id)===true;}catch{return false;}}
  bdfdb(){if(this.library)return this.library;const globalLibrary=globalThis.BDFDB_Global||globalThis.window?.BDFDB_Global;if(!globalLibrary?.loaded||typeof globalLibrary.PluginUtils?.buildPlugin!=='function')throw new Error('BDFDB ist noch nicht bereit.');this.library=globalLibrary.PluginUtils.buildPlugin({})[1];if(!this.library?.DataUtils)throw new Error('BDFDB-Schnittstelle ist nicht verfügbar.');return this.library;}
  plugin(id){const meta=this.api.Plugins.get(id);return meta?.instance||meta;}
  metadata(id){const found=c.discover(this.folder,[id])[0];if(!found?.installed)throw new Error(`${id} ist nicht installiert.`);if(found.version!==c.catalog[id].version)throw new Error(`Die Einstellungen für ${id} ${found.version} sind noch nicht geprüft.`);return found;}
  configPath(id){return path.join(this.folder,`${id==='BDFDB'?'0BDFDB':id}.config.json`);}
  guardConfig(id){c.checkPath(this.configPath(id),{missing:true,max:4*c.MAX_JSON});}
  readConfig(id){
    const spec=c.specFor(id);this.guardConfig(id);
    if(spec.storage==='bdfdb'){if(!this.enabled('BDFDB'))throw new Error('Bitte zuerst BDFDB einschalten.');return deepClone(this.bdfdb().DataUtils.load(id)||{});}
    if(spec.storage==='individual')return Object.fromEntries(spec.fields.map(field=>[field.key,this.api.Data.load(id,field.key)??field.default]));
    const data=this.api.Data.load(id,spec.storage);return c.plain(data)?deepClone(data):{};
  }
  settings(id){
    const spec=c.specFor(id);this.metadata(id);
    if(!spec.fields.length)throw new Error('Diese Bibliothek hat keine Einstellungen im Control Center.');
    const config=this.readConfig(id),values={};const settings=spec.nested?(config[spec.nested]||{}):config;
    for(const field of spec.fields){
      if(field.type==='words'){const group=field.key==='blockedWords'?'blocked':'censored';const words=Object.entries(config.words?.[group]||{}).filter(([,rule])=>simpleRule(rule)).map(([word])=>word);if(words.length>100)throw new Error('Diese ChatFilter-Liste enthält mehr als 100 einfache Regeln. Bitte direkt in Discord bearbeiten; im Center wird sie zum Schutz vor unvollständigem Speichern nicht gekürzt.');values[field.key]=words;}
      else values[field.key]=get(settings,field.key)??field.default;
    }
    return {pluginId:id,revision:c.digest(config),fields:spec.fields,values,message:id==='SpotifyEnhance'?'Der Listen-Along-Premium-Patch wird bei Änderungen deaktiviert.':id==='ChatFilter'?'Erweiterte vorhandene Filterregeln bleiben unverändert.':''};
  }
  async reload(id){
    if(!this.enabled(id))return;
    const result=await this.api.Plugins.reload(id);
    if(result===false)throw new Error('Einstellungen wurden gesichert, aber das Plugin konnte nicht neu geladen werden.');
    if(!this.enabled(id))throw new Error('Einstellungen gespeichert; das Plugin konnte danach nicht gestartet werden.');
  }
  writeConfig(id,config){
    const spec=c.specFor(id);this.guardConfig(id);c.backup(this.configPath(id),path.join(this.bridge,'backups'));this.guardConfig(id);
    if(spec.storage==='bdfdb')this.bdfdb().DataUtils.save(config,id);
    else if(spec.storage==='individual'){for(const field of spec.fields)this.api.Data.save(id,field.key,config[field.key]);}
    else this.api.Data.save(id,spec.storage,config);
    this.guardConfig(id);
    const disk=c.readJson(this.configPath(id),{max:4*c.MAX_JSON});
    const persisted=spec.storage==='bdfdb'?[disk?.all,disk?.[this.account()],disk]:spec.storage==='individual'?[Object.fromEntries(spec.fields.map(field=>[field.key,disk?.[field.key]]))]:[disk?.[spec.storage]];
    if(!persisted.some(value=>c.plain(value)&&c.digest(value)===c.digest(config)))throw new Error('Das Plugin konnte die Einstellungen nicht auf dem Datenträger bestätigen. Die vorherige Datei liegt in der Sicherung.');
  }
  async save(payload){
    const id=payload.pluginId,spec=c.specFor(id);const before=this.settings(id);if(before.revision!==payload.expectedRevision)throw new Error('Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden.');
    const config=this.readConfig(id),target=spec.nested?(config[spec.nested]||=( {})):config;
    for(const [key,value] of Object.entries(payload.values)){
      const field=spec.fields.find(item=>item.key===key);
      if(field.type==='words'){
        const group=key==='blockedWords'?'blocked':'censored';config.words||={};config.words[group]||={};
        for(const word of value)if(Object.hasOwn(config.words[group],word)&&!simpleRule(config.words[group][word]))throw new Error('Ein Wort hat bereits eine erweiterte Filterregel. Diese bitte direkt in ChatFilter bearbeiten.');
        for(const [word,rule] of Object.entries(config.words[group]))if(simpleRule(rule))delete config.words[group][word];
        for(const word of [...new Set(value.map(item=>item.trim()))])if(!Object.hasOwn(config.words[group],word))config.words[group][word]={replace:'',empty:false,case:false,exact:true,segment:false,regex:false};
      }else set(target,key,value);
    }
    if(id==='SpotifyEnhance')config.enableListenAlong=false;
    this.writeConfig(id,config);await this.reload(id);this.syncRolePatch();
    const result=this.settings(id);
    for(const [key,value] of Object.entries(payload.values)){const words=Array.isArray(value);if(c.canonical(words?[...result.values[key]].sort():result.values[key])!==c.canonical(words?[...value].sort():value))throw new Error('Das Plugin hat eine Einstellung nicht übernommen. Bitte erneut laden.');}
    return result;
  }
  async toggle({pluginId:id,enabled}){
    this.metadata(id);
    if(enabled){for(const dependency of c.catalog[id].dependencies)if(!this.enabled(dependency))throw new Error(`Bitte zuerst ${dependency} einschalten.`);}
    if(id==='BDFDB'&&!enabled&&['StaffTag','ChatFilter'].some(name=>this.enabled(name)))throw new Error('Bitte zuerst StaffTag und ChatFilter ausschalten; sie benötigen BDFDB.');
    if(id==='SpotifyEnhance'&&enabled){const config=this.readConfig(id);if(config.enableListenAlong!==false){config.enableListenAlong=false;this.writeConfig(id,config);if(this.enabled(id))await this.reload(id);}}
    const result=await this.api.Plugins[enabled?'enable':'disable'](id);
    if(result===false||this.enabled(id)!==enabled)throw new Error('BetterDiscord konnte den gewünschten Plugin-Zustand nicht herstellen.');
    if(id==='BDFDB')this.library=null;
    this.syncRolePatch();return {enabled:this.enabled(id)};
  }
  readRoles(){const value=c.readJson(path.join(this.bridge,'role-badges.json'),{optional:true});if(!value)return deepClone(DEFAULT_ROLES);return c.validateRoleSettings(value);}
  roleState(){const settings=this.roles||DEFAULT_ROLES;return {...settings,revision:c.digest(settings),active:!!this.rolePatch,supported:this.enabled('StaffTag'),message:this.roleMessage||'Die Symbole sind nur auf diesem PC sichtbar und verleihen keine Rechte.'};}
  saveRoles(payload){const {expectedRevision,...settings}=payload;const before=this.readRoles();if(c.digest(before)!==expectedRevision)throw new Error('Rollen-Zuordnung wurde geändert. Bitte aktualisieren.');const file=path.join(this.bridge,'role-badges.json');c.backup(file,path.join(this.bridge,'backups'));c.jsonAtomic(file,c.validateRoleSettings(settings));this.roles=settings;this.clearRolePatch();this.syncRolePatch();return this.roleState();}
  matchRole(user,channelId){
    if(!this.roles?.enabled||!user?.id)return null;
    const channel=this.store('ChannelStore')?.getChannel?.(channelId||this.store('SelectedChannelStore')?.getChannelId?.());
    if(channel&&!channel.guild_id)return null;
    const guildId=channel?.guild_id||this.store('SelectedGuildStore')?.getGuildId?.();
    if(guildId!==this.roles.guildId)return null;
    const roles=this.store('GuildMemberStore')?.getMember?.(guildId,user.id)?.roles;
    return Array.isArray(roles)?this.roles.rules.find(rule=>roles.includes(rule.roleId))||null:null;
  }
  clearRolePatch(){const previous=this.rolePatch;for(const unpatch of this.unpatches.splice(0))try{unpatch();}catch{}this.rolePatch=null;try{previous?.forceUpdateAll?.();}catch{} }
  syncRolePatch(){
    if(!this.roles?.enabled){if(this.rolePatch)this.clearRolePatch();this.roleMessage='Rollen-Symbole sind ausgeschaltet.';return;}
    if(!this.enabled('StaffTag')){this.clearRolePatch();this.roleMessage='Für die Rollen-Symbole bitte StaffTag und BDFDB einschalten.';return;}
    const plugin=this.plugin('StaffTag');if(this.rolePatch===plugin)return;this.clearRolePatch();
    if(typeof plugin?.getUserType!=='function'||typeof plugin?.injectStaffTag!=='function'||!this.api.React?.createElement||!this.api.Patcher){this.roleMessage='Diese StaffTag-Version stellt die benötigte Darstellung nicht bereit.';return;}
    try{
      this.metadata('StaffTag');
      this.unpatches.push(this.api.Patcher.after(NAME,plugin,'getUserType',(_self,args,result)=>this.matchRole(args[0],args[1])?'crazybatto-role':result));
      this.unpatches.push(this.api.Patcher.instead(NAME,plugin,'injectStaffTag',(_self,args,original)=>{
        const [children,user,,index,config={}]=args;const rule=this.matchRole(user,config.channelId);
        if(!rule||!Array.isArray(children))return original(...args);
        if(children.some(child=>child?.key==='crazybatto-role'))return;
        const drawings={crown:'M2 5l5 4 5-7 5 7 5-4-3 14H5L2 5zm4 16h12v2H6z',shield:'M12 2l9 4v6c0 6-9 10-9 10S3 18 3 12V6l9-4z',star:'M12 2l3 7 8 1-6 5 2 8-7-4-7 4 2-8-6-5 8-1 3-7z'};
        const element=this.api.React.createElement('span',{key:'crazybatto-role',title:rule.label,'aria-label':rule.label,style:{display:'inline-flex',verticalAlign:'middle',alignItems:'center',color:rule.color,marginLeft:4,marginRight:4}},this.api.React.createElement('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:'currentColor','aria-hidden':true},this.api.React.createElement('path',{d:drawings[rule.icon]})));
        children.splice(Math.max(0,Math.min(children.length,index||0)),0,element);
      }));
      this.rolePatch=plugin;this.roleMessage='Aktiv: Rollen-Symbole auf diesem PC. Serverrechte bleiben unverändert.';plugin.forceUpdateAll?.();
    }catch{this.clearRolePatch();this.roleMessage='Rollen-Symbole konnten nicht aktiviert werden. Bitte StaffTag aktualisieren und erneut prüfen.';}
  }
  spectators(){
    const base={supported:false,active:false,source:null,channelName:'',streamer:null,viewers:[],total:0,message:'Discord stellt derzeit keine Stream-Zuschauer bereit.',observedAt:new Date(this.now()).toISOString()};
    const streams=this.store('ApplicationStreamingStore');if(typeof streams?.getViewerIds!=='function')return base;
    let stream=streams.getCurrentUserActiveStream?.(),source='own';
    if(!stream){const channelId=this.store('SelectedChannelStore')?.getVoiceChannelId?.();stream=this.store('ChannelRTCStore')?.getSelectedParticipant?.(channelId)?.stream;source='watched';}
    if(!stream)return {...base,supported:true,message:'Du sendest keinen Stream und hast keinen Stream ausgewählt.'};
    const ids=streams.getViewerIds(stream);if(!Array.isArray(ids))return base;
    const userStore=this.store('UserStore'),users=[...new Set(ids.filter(id=>c.SNOWFLAKE.test(id)))].slice(0,200);const streamerId=stream.ownerId||stream.owner_id||stream.userId;
    const label=id=>{const user=userStore?.getUser?.(id);return {id,name:String(user?.globalName||user?.username||'Unbekanntes Mitglied').slice(0,100)};};
    return {...base,supported:true,active:true,source,channelName:String(this.store('ChannelStore')?.getChannel?.(stream.channelId||stream.channel_id)?.name||'Sprachkanal').slice(0,100),streamer:c.SNOWFLAKE.test(streamerId)?label(streamerId):null,viewers:users.map(label),total:ids.length,message:'Sichtbare Zuschauer des eigenen oder aktuell ausgewählten Streams.'};
  }
  history({limit=100}){
    const account=this.account();if(!account)throw new Error('Kein angemeldetes Discord-Konto.');
    const key=`RemovedConnectionAlerts_${account}`,file=path.join(this.folder,`${key}.config.json`);
    c.checkPath(file,{missing:true,max:4*c.MAX_JSON});
    const saved=this.api.Data.load(key,'savedData');const entries=[];
    if(!saved)return {supported:true,entries:[],truncated:false,limit,message:'Für dieses Konto ist noch kein Verlauf vorhanden.'};
    for(const [list,kind] of [['removedFriendHistory','friend'],['removedGuildHistory','server']]){
      const values=saved[list];if(!Array.isArray(values))continue;
      for(const item of values.slice(-2000)){
        const raw=typeof item?.timeRemoved==='number'?item.timeRemoved:Date.parse(item?.timeRemoved);if(!Number.isFinite(raw))continue;
        const time=new Date(raw);if(!Number.isFinite(time.getTime()))continue;
        const name=String(kind==='friend'?(item.globalName||item.tag||'Unbekannter Kontakt'):(item.name||'Unbekannter Server')).slice(0,100);
        entries.push({id:c.digest({id:String(item.id||''),kind,time:time.toISOString()}),kind,name,removedAt:time.toISOString()});
      }
    }
    entries.sort((a,b)=>b.removedAt.localeCompare(a.removedAt));
    return {supported:true,entries:entries.slice(0,limit),truncated:entries.length>limit,limit,message:'Privater lokaler Verlauf des aktuell angemeldeten Kontos. Ein Eintrag beweist keinen bestimmten Grund.'};
  }
  status(){return {plugins:c.discover(this.folder).map(item=>({...item,enabled:item.installed?this.enabled(item.id):null,message:item.id==='SpotifyEnhance'?'Beim Einschalten über das Center bleibt der Listen-Along-Premium-Patch deaktiviert.':item.message})),roleBadges:this.roleState()};}
  async dispatch(operation,payload){c.validate(operation,payload);if(operation==='state')return this.status();if(operation==='settings')return this.settings(payload.pluginId);if(operation==='save')return this.save(payload);if(operation==='toggle')return this.toggle(payload);if(operation==='roles.save')return this.saveRoles(payload);if(operation==='spectators')return this.spectators();if(operation==='history')return this.history(payload);throw new Error('Unbekannte Aktion.');}
  heartbeat(){const accountId=this.account();if(!accountId)return;this.lastHeartbeat=this.now();c.jsonAtomic(path.join(this.bridge,'heartbeat.json'),c.signed({protocol:c.PROTOCOL,bootId:this.bootId,accountId,time:this.now(),version:c.VERSION},this.auth.secret));}
  async tick(){
    if(!this.running||this.busy)return;this.busy=true;
    try{
      if(this.now()-this.lastHeartbeat>=2000){this.syncRolePatch();this.heartbeat();this.cleanup();}
      const folder=path.join(this.bridge,'requests');c.checkPath(folder,{directory:true});
      const files=fs.readdirSync(folder).filter(name=>c.UUID.test(name.slice(0,-5))&&name.endsWith('.json')).slice(0,20);
      for(const file of files){if(!this.running)break;await this.consume(file);}
    }finally{this.busy=false;}
  }
  cleanup(){for(const name of ['responses','processing']){const folder=path.join(this.bridge,name);c.checkPath(folder,{directory:true});for(const file of fs.readdirSync(folder).slice(0,200)){if(!file.endsWith('.json')||!c.UUID.test(file.slice(0,-5)))continue;const target=path.join(folder,file),stat=c.checkPath(target);if(this.now()-stat.mtimeMs>60000)c.remove(target);}}}
  async consume(file){
    const id=file.slice(0,-5),requestPath=path.join(this.bridge,'requests',file),claimPath=path.join(this.bridge,'processing',file);
    let request;try{request=c.readJson(requestPath);}catch{c.remove(requestPath);return;}
    const accountId=this.account(),time=this.now();
    if(!request||!c.verify(request,this.auth.secret)||request.protocol!==c.PROTOCOL||request.id!==id||request.bootId!==this.bootId||request.accountId!==accountId||!Number.isFinite(request.issuedAt)||!Number.isFinite(request.expiresAt)||request.issuedAt>time+1000||request.expiresAt<time||request.expiresAt-request.issuedAt>30000||request.expiresAt<=request.issuedAt){c.remove(requestPath);return;}
    if(c.checkPath(claimPath,{missing:true})){c.remove(requestPath);return;}
    // Atomic exclusive claim is the durable replay ledger. Keep it longer than any request lifetime.
    c.writeExclusive(claimPath,JSON.stringify({id,time}));
    c.remove(requestPath);
    let response;
    try{const result=await this.dispatch(request.operation,request.payload);if(accountId!==this.account()||!this.running)throw new Error('Discord-Konto wurde während der Aktion gewechselt.');response={ok:true,result};}
    catch(error){response={ok:false,error:String(error.message||'Aktion fehlgeschlagen.').slice(0,300)};}
    if(this.now()>request.expiresAt)return;
    c.jsonAtomic(path.join(this.bridge,'responses',file),c.signed({protocol:c.PROTOCOL,id,bootId:this.bootId,accountId,time:this.now(),...response},this.auth.secret));
  }
};

};

  return module.exports;
})();
module.exports=createCompanion(core);
