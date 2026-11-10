'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard, Menu, session, Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { LocalStorage } = require('./storage.cjs');
const { AdminService } = require('./service.cjs');
const { ConnectionsService, parseWinScpIni } = require('./connections.cjs');
const { WebsiteService } = require('./website.cjs');
const { ThemesService } = require('./themes.cjs');
const { LocalDiscordService } = require('./local-discord.cjs');
const { pickAudio, createAudioPermission } = require('./audio.cjs');
const { createOwnerProfileActions } = require('./owner-profile.cjs');
const V = require('./validation.cjs');
const ownerProfileAction = createOwnerProfileActions({writeText: text => clipboard.writeText(text), openExternal: url => shell.openExternal(url)});

app.setName('CrazyBatto Discord Admin');
if (process.platform === 'win32') app.setAppUserModelId('de.crazybatto.discordadmin');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
let window, service, storage, connections, website, themes, localDiscord, audioPermission;
const extrasActions = ['extras.state','extras.automod.list','extras.automod.save','extras.audio.send'];
const localActions = ['localdiscord.state','localdiscord.install','localdiscord.toggle','localdiscord.settings','localdiscord.save','localdiscord.spectators','localdiscord.history','localdiscord.roles.save','audio.pick','audio.recordPermission','audio.recordEnd'];
let lastJoinNotificationAt = 0;
const activeNotifications = new Set();
let startupReconnect = null;
let selectedConnectionMode = 'website';
const communityActions = ['roles.state','roles.save','roles.decorate','roles.publish','setup.state','setup.save','setup.moderate','setup.retry','setup.image','setup.panel.state','setup.panel.save','setup.panel.publish','joinrole.state','joinrole.save','community.state','community.save','community.publish','community.register','community.report.list','community.report.moderate','community.voice.list','community.voice.control','community.ticket.list','community.ticket.close','tiktok.state','tiktok.save','tiktok.check','joinrequests.list','joinrequests.review','admincrown.list','admincrown.lookup','admincrown.apply','admincrown.remove'];
const controlActions = new Set(['guild.load','message.send','guild.update','channel.create','channel.update','role.create','role.update','bot.profile','event.create','log.list',...communityActions,...extrasActions]);
let actionQueue = Promise.resolve();
const productionUrl = pathToFileURL(path.join(__dirname,'../dist/index.html')).href;
let rendererUrl = productionUrl;
if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
  const url = new URL(process.env.VITE_DEV_SERVER_URL);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.username || url.password) throw new Error('Der Entwicklungsserver muss lokal laufen.');
  rendererUrl = url.href;
}
const allowed = new Set([
  ...communityActions,
  ...extrasActions, ...localActions,
  'ownerprofile.copy','ownerprofile.open',
  'themes.state','themes.list','themes.save','themes.export','themes.install','notification.joinRequests',
  'app.state','bot.connect','bot.disconnect','guild.load','message.send','guild.update',
  'channel.create','channel.update','role.create','role.update','bot.profile','event.create',
  'log.list','templates.list','templates.save','templates.delete','settings.get','settings.save',
  'app.export','app.import','image.pick','image.builtin','app.openExternal',
  'connections.list','connections.save','connections.delete','connections.clearSecret','connections.importWinSCP',
  'files.state','files.connect','files.disconnect','files.list','files.chooseLocalFolder','files.localList','files.upload','files.download','files.mkdir',
  'website.state','website.login','website.reconnect','website.disconnect','website.load','website.request'
]);
function trusted(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === rendererUrl;
}
async function nativeAction(action,payload) {
  if (action === 'ownerprofile.copy' || action === 'ownerprofile.open') return ownerProfileAction(action,payload);
  if (action.startsWith('themes.')) return themes.run(action,payload);
  if (action.startsWith('localdiscord.')) return localDiscord.run(action,payload);
  if (action === 'audio.pick') return pickAudio({dialog,getWindow:()=>window});
  if (action === 'audio.recordPermission') return audioPermission.arm();
  if (action === 'audio.recordEnd') return audioPermission.clear();
  if (startupReconnect) await startupReconnect;
  if (action === 'notification.joinRequests') {
    V.id(payload.guildId);
    if (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > 100) throw new Error('Ungültige Anzahl neuer Beitrittsanfragen.');
    if (!storage.read('settings',{}).joinRequestNotifications || !website.state().connected) return {shown:false,reason:'disabled'};
    if (!Notification.isSupported()) return {shown:false,reason:'unsupported'};
    if (Date.now() - lastJoinNotificationAt < 45000) return {shown:false,reason:'rate_limit'};
    lastJoinNotificationAt = Date.now();
    const note = new Notification({title:'Neue Beitrittsanfragen',body:payload.count === 1 ? 'Eine neue Bewerbung wartet im Control Center auf deine Entscheidung.' : `${payload.count} neue Bewerbungen warten im Control Center auf deine Entscheidung.`,icon:path.join(__dirname,'../dist/assets/app-icon.ico')});
    activeNotifications.add(note);
    note.on('click',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
    note.on('close',()=>activeNotifications.delete(note));
    note.on('failed',()=>activeNotifications.delete(note));
    note.show(); return {shown:true};
  }
  if (action === 'app.state') {
    const site = website.state();
    if (selectedConnectionMode === 'direct') return {...service.state(),mode:'direct',website:site};
    if (!site.connected) return {connected:false,bot:null,guilds:[],mode:'website',website:site};
    try {
      const data = await website.run('website.request',{operation:'discord.state'});
      return {...data.state,mode:'website',website:site};
    } catch(error) {
      return {connected:false,bot:null,guilds:[],mode:'website',website:website.state(),bridgeError:error.message};
    }
  }
  if (action.startsWith('website.')) {
    if (['website.login','website.reconnect'].includes(action)) selectedConnectionMode='website';
    const result = await website.run(action,payload);
    if (['website.login','website.reconnect'].includes(action) && result.connected) {
      await service.run('bot.disconnect',{});
      const settings = storage.read('settings',{});
      storage.write('settings',{...settings,lastWebsiteProfile:result.profileId||null});
    }
    if (action === 'website.disconnect') {
      const settings=storage.read('settings',{});
      storage.write('settings',{...settings,lastWebsiteProfile:null});
    }
    return result;
  }
  if (controlActions.has(action) && selectedConnectionMode === 'website') {
    if (!website.state().connected) throw new Error('Bitte mit deinem Website-Konto anmelden. Deine Sitzung ist nicht verbunden oder abgelaufen.');
    const response = await website.run('website.request',{operation:'discord.action',body:{action,payload}});
    return response.result;
  }
  if (communityActions.includes(action) || extrasActions.includes(action)) throw new Error('Diese Funktion gehört zum laufenden Website-Bot. Bitte mit deinem Website-Konto anmelden.');
  if (action === 'bot.connect' && website.state().connected) throw new Error('Bitte zuerst die Website-Sitzung abmelden, bevor du eine andere Bot-Verbindung verwendest.');
  if (action === 'bot.connect') {
    const result=await service.run(action,payload);
    selectedConnectionMode='direct';
    return {...result,mode:'direct'};
  }
  if (['connections.delete','connections.clearSecret'].includes(action) && website.state().profileId===payload.id) {
    await website.run('website.disconnect',{forget:true});
    storage.write('settings',{...storage.read('settings',{}),lastWebsiteProfile:null});
  }
  if (action === 'connections.importWinSCP') {
    const selected = await dialog.showOpenDialog(window,{title:'WinSCP-Sitzungen importieren',properties:['openFile'],filters:[{name:'WinSCP-Einstellungen',extensions:['ini']}]});
    if(selected.canceled) return {canceled:true};
    if((await fs.stat(selected.filePaths[0])).size > 1024*1024) throw new Error('Die Einstellungsdatei darf höchstens 1 MB groß sein.');
    const profiles = parseWinScpIni(await fs.readFile(selected.filePaths[0],'utf8'));
    let count=0;
    for(const profile of profiles){await connections.run('connections.save',{...profile,remember:false});count++;}
    return {count};
  }
  if (action.startsWith('connections.') || action.startsWith('files.')) return connections.run(action,payload);
  switch (action) {
    case 'image.builtin': {
      const data = await fs.readFile(path.join(__dirname,'../dist/assets/community-banner.png'));
      const dataUrl = `data:image/png;base64,${data.toString('base64')}`;
      V.imageData(dataUrl);
      return {name:'community-banner.png',dataUrl};
    }
    case 'image.pick': {
      const result = await dialog.showOpenDialog(window,{title:'Bild auswählen',properties:['openFile'],filters:[{name:'Bilder',extensions:['png','jpg','jpeg','gif','webp']}]});
      if (result.canceled) return null;
      const file = result.filePaths[0];
      const stat = await fs.stat(file);
      if (stat.size > V.IMAGE_LIMIT) throw new Error('Bitte ein Bild mit höchstens 8 MB auswählen.');
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      const dataUrl = `data:image/${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
      V.imageData(dataUrl);
      return {name:path.basename(file),dataUrl};
    }
    case 'app.export': {
      const templates = storage.read('templates',[]).map(template=>({id:template.id,name:V.text(template.name,100,'Vorlagenname',{required:true}),draft:V.cleanDraft(template.draft),updatedAt:template.updatedAt}));
      const result = await dialog.showSaveDialog(window,{title:'Vorlagen exportieren',defaultPath:'CrazyBatto-Vorlagen.json',filters:[{name:'JSON-Datei',extensions:['json']}]});
      if (result.canceled) return {canceled:true};
      await fs.writeFile(result.filePath,JSON.stringify({format:'crazybatto-templates',version:1,templates},null,2),'utf8');
      return {count:templates.length};
    }
    case 'app.import': {
      const result = await dialog.showOpenDialog(window,{title:'Vorlagen importieren',properties:['openFile'],filters:[{name:'JSON-Datei',extensions:['json']}]});
      if (result.canceled) return {canceled:true};
      if ((await fs.stat(result.filePaths[0])).size > V.TEMPLATE_STORE_LIMIT) throw new Error('Die Vorlagendatei darf höchstens 64 MB groß sein.');
      let data;
      try { data = JSON.parse(await fs.readFile(result.filePaths[0],'utf8')); } catch { throw new Error('Diese Datei enthält kein gültiges JSON.'); }
      if (data?.format !== 'crazybatto-templates' || data.version !== 1 || !Array.isArray(data.templates)) throw new Error('Bitte eine exportierte CrazyBatto-Vorlagendatei wählen.');
      const existing = storage.read('templates',[]);
      if (data.templates.length + existing.length > 100) throw new Error('Zusammen mit deinen vorhandenen Vorlagen wären es mehr als 100 Einträge.');
      const incoming = data.templates.map(template=>({id:randomUUID(),name:V.text(template.name,100,'Vorlagenname',{required:true}),draft:V.cleanDraft(template.draft),updatedAt:new Date().toISOString()}));
      storage.write('templates',[...incoming,...existing]);
      return {count:incoming.length};
    }
    case 'app.openExternal': await shell.openExternal(V.externalUrl(payload.url)); return {opened:true};
    default: return service.run(action,payload);
  }
}
function createWindow() {
  window = new BrowserWindow({width:1440,height:980,minWidth:900,minHeight:650,title:'Crazy_Batto · Control Center',backgroundColor:'#0b0d10',autoHideMenuBar:true,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,spellcheck:false}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url !== rendererUrl) event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.on('closed',()=>audioPermission?.clear());
  window.once('ready-to-show',()=>window.show());
  window.loadURL(rendererUrl);
}
if (gotLock) app.whenReady().then(()=>{
  storage = new LocalStorage(app.getPath('userData'),safeStorage);
  service = new AdminService(storage);
  connections = new ConnectionsService({directory:app.getPath('userData'),safeStorage,dialog,getWindow:()=>window});
  website = new WebsiteService({connections});
  themes = new ThemesService({directory:app.getPath('userData'),appDataDirectory:app.getPath('appData'),dialog,getWindow:()=>window});
  localDiscord = new LocalDiscordService({directory:app.getPath('userData'),appDataDirectory:app.getPath('appData'),dialog,getWindow:()=>window});
  audioPermission = createAudioPermission({getWindow:()=>window,getRendererUrl:()=>rendererUrl});
  const previousProfile=storage.read('settings',{}).lastWebsiteProfile;
  if(previousProfile) startupReconnect=website.run('website.reconnect',{profileId:previousProfile}).catch(()=>{}).finally(()=>{startupReconnect=null;});
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Datei',submenu:[{role:'quit',label:'Beenden'}]},
    {label:'Bearbeiten',submenu:[{role:'undo',label:'Rückgängig'},{role:'redo',label:'Wiederholen'},{type:'separator'},{role:'cut',label:'Ausschneiden'},{role:'copy',label:'Kopieren'},{role:'paste',label:'Einfügen'},{role:'selectAll',label:'Alles auswählen'}]},
    {label:'Ansicht',submenu:[{role:'resetZoom',label:'Originalgröße'},{role:'zoomIn',label:'Vergrößern'},{role:'zoomOut',label:'Verkleinern'},{role:'togglefullscreen',label:'Vollbild'}]}
  ]));
  session.defaultSession.setPermissionRequestHandler(audioPermission.request);
  session.defaultSession.setPermissionCheckHandler(audioPermission.check);
  session.defaultSession.webRequest.onHeadersReceived((details,callback)=>{
    const development = rendererUrl.startsWith('http:');
    const csp = `default-src 'self'; script-src 'self'${development ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob: data:; font-src 'self'; connect-src 'self'${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
    callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[csp]}});
  });
  ipcMain.handle('discord-admin:invoke',(event,action,payload)=>{
    if (!trusted(event) || !allowed.has(action)) return {ok:false,error:'Diese Anfrage ist nicht freigegeben.'};
    const result = actionQueue.then(async()=>{
      try { V.object(payload || {}); return {ok:true,data:await nativeAction(action,payload || {})}; }
      catch (error) {
        // Never serialize request arguments, Discord response bodies, or credentials.
        const message = typeof error?.message === 'string' ? error.message.slice(0,500) : 'Die Aktion konnte nicht ausgeführt werden.';
        return {ok:false,error:message,status:Number.isInteger(error.status)?error.status:0,code:typeof error.code==='string'&&/^[a-z_]{1,40}$/.test(error.code)?error.code:null};
      }
    });
    actionQueue = result.catch(()=>{});
    return result;
  });
  createWindow();
});
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)createWindow();});
