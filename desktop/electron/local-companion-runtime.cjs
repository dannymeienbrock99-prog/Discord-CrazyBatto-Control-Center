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
