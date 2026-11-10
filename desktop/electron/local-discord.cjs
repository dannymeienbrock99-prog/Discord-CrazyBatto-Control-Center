'use strict';
const c = require('./local-discord-core.cjs');
const {fs,path,crypto} = c;
const COMPANION = 'CrazyBattoControl.plugin.js';
const MARKER = '@crazybatto-original-bridge 1';
function readBundledSource(name) {
  const allowed=new Set([path.join('betterdiscord',COMPANION)]);
  if(!allowed.has(name))throw new Error('Unbekannte mitgelieferte Verbindungsdatei.');
  const source=path.join(__dirname,name),before=fs.lstatSync(source);
  if(!before.isFile()||before.isSymbolicLink()||before.size>c.MAX_JSON)throw new Error('Die mitgelieferte Verbindungsdatei ist ungültig.');
  // Electron gives ASAR members virtual inode metadata but openSync materializes
  // a real temporary file. Only this immutable, fixed application resource
  // use the ASAR-aware path reader; all external files keep c.read's strict checks.
  const contents=fs.readFileSync(source),after=fs.lstatSync(source);
  if(contents.length!==before.size||contents.length>c.MAX_JSON||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Die mitgelieferte Verbindungsdatei wurde verändert.');
  return contents;
}
class LocalDiscordService {
  constructor({directory,appDataDirectory,requestTimeout=12000,now=Date.now}) {
    if(!directory || !appDataDirectory) throw new Error('Lokale App-Ordner fehlen.');
    this.directory=path.resolve(directory);
    this.folder=path.join(path.resolve(appDataDirectory),'BetterDiscord','plugins');
    this.bridge=path.join(this.folder,'.crazybatto-control');
    this.pairFile=path.join(this.directory,'local-discord-pairing.json');
    this.timeout=requestTimeout;this.now=now;this.queue=Promise.resolve();
  }
  pair() {
    const pair=c.readJson(this.pairFile,{optional:true});
    if(!pair)return null;
    if(!/^[a-f0-9]{64}$/.test(pair.secret)||pair.protocol!==c.PROTOCOL)throw new Error('Lokale Kopplung ist ungültig.');
    const auth=c.readJson(path.join(this.bridge,'auth.json'),{optional:true});
    if(!auth || auth.secret!==pair.secret || auth.protocol!==c.PROTOCOL)throw new Error('Discord ist mit einer anderen lokalen Installation gekoppelt.');
    return pair;
  }
  heartbeat(pair=this.pair()) {
    if(!pair)return null;
    const heartbeat=c.readJson(path.join(this.bridge,'heartbeat.json'),{optional:true});
    if(!heartbeat||!c.verify(heartbeat,pair.secret)||heartbeat.protocol!==c.PROTOCOL||!c.UUID.test(heartbeat.bootId)||!c.SNOWFLAKE.test(heartbeat.accountId)||!Number.isFinite(heartbeat.time)||this.now()-heartbeat.time>8000||heartbeat.time-this.now()>2000)return null;
    return heartbeat;
  }
  async state() {
    let available=false,pair=null,heartbeat=null,message='BetterDiscord wurde auf diesem PC nicht gefunden.';
    try {available=!!c.checkPath(this.folder,{missing:true,directory:true});}catch{message='Der BetterDiscord-Ordner ist nicht sicher zugänglich.';}
    let installed=false;
    if(available){
      try {const plugin=c.read(path.join(this.folder,COMPANION),{optional:true});installed=!!plugin?.toString('utf8').includes(MARKER);pair=this.pair();heartbeat=this.heartbeat(pair);message=heartbeat?'Discord ist verbunden. Änderungen wirken auf diesem PC.':installed?'Bitte CrazyBattoControl unter Discord → BetterDiscord → Plugins einschalten.':'Die lokale Verbindung ist noch nicht installiert.';}
      catch(error){message=error.message;}
    }
    let live=null,liveBinding=null;
    if(heartbeat){try{const confirmed=await this.request('state',{},true);live=confirmed.result;liveBinding=confirmed.binding;}catch(error){heartbeat=null;message=error.message;}}
    const plugins=available?c.discover(this.folder):Object.values(c.catalog).map(spec=>({id:spec.id,name:spec.id,installed:false,version:null,enabled:null,dependencies:spec.dependencies,message:''}));
    for(const plugin of plugins){const status=live?.plugins?.find(item=>item.id===plugin.id);if(status&&plugin.installed){plugin.enabled=status.enabled;plugin.message=status.message||plugin.message;plugin.settingsSupported=plugin.settingsSupported&&status.settingsSupported;}}
    return {available,pluginsPath:this.folder,bridge:{installed,connected:!!live,binding:liveBinding,version:live?c.VERSION:null,lastSeen:heartbeat?new Date(heartbeat.time).toISOString():null,message},plugins,roleBadges:live?.roleBadges||{revision:null,enabled:false,guildId:'',rules:[],active:false,supported:false,message:'Zum Bearbeiten Discord verbinden.'}};
  }
  async install(payload) {
    c.keys(payload,['confirm']);if(payload.confirm!==true)throw new Error('Installation wurde nicht bestätigt.');
    // Validate packaged resources before creating a pairing or changing files.
    const companionSource=readBundledSource(path.join('betterdiscord',COMPANION));
    if(!companionSource.toString('utf8').includes('@crazybatto-single-file 1'))throw new Error('Das mitgelieferte Verbindungsmodul muss neu erstellt werden.');
    c.checkPath(this.folder,{directory:true});
    c.mkdir(this.directory);c.mkdir(this.bridge);
    for(const name of ['requests','responses','processing','backups'])c.mkdir(path.join(this.bridge,name));
    const pluginPath=path.join(this.folder,COMPANION);
    const previous=c.read(pluginPath,{optional:true});
    if(previous && !previous.toString('utf8').includes(MARKER))throw new Error('Eine gleichnamige fremde Datei wird nicht überschrieben.');
    let pair=c.readJson(this.pairFile,{optional:true});
    const auth=c.readJson(path.join(this.bridge,'auth.json'),{optional:true});
    if(auth && (!pair||auth.secret!==pair.secret))throw new Error('Die bestehende Kopplung gehört zu einer anderen Installation.');
    if(!pair){pair={protocol:c.PROTOCOL,secret:crypto.randomBytes(32).toString('hex')};c.jsonAtomic(this.pairFile,pair);}
    if(pair.protocol!==c.PROTOCOL||!/^[a-f0-9]{64}$/.test(pair.secret))throw new Error('Kopplung ist beschädigt.');
    const backups=path.join(this.bridge,'backups');
    c.backup(pluginPath,backups);
    c.jsonAtomic(path.join(this.bridge,'auth.json'),pair);
    c.writeAtomic(pluginPath,companionSource);
    return this.state();
  }
  async request(operation,payload,includeContext=false,expectedBinding=null) {
    c.validate(operation,payload);
    const pair=this.pair();const heartbeat=this.heartbeat(pair);
    if(!heartbeat)throw new Error('Discord ist nicht verbunden. Discord öffnen und CrazyBattoControl in BetterDiscord einschalten.');
    if(expectedBinding!==null&&expectedBinding!==c.digest({bootId:heartbeat.bootId,accountId:heartbeat.accountId}))throw new Error('Discord-Konto oder Verbindung wurde gewechselt. Bitte aktualisieren und erneut auswählen.');
    const id=crypto.randomUUID(),issuedAt=this.now();
    const request={protocol:c.PROTOCOL,id,issuedAt,expiresAt:issuedAt+this.timeout,bootId:heartbeat.bootId,accountId:heartbeat.accountId,operation,payload};
    const requestPath=path.join(this.bridge,'requests',`${id}.json`),responsePath=path.join(this.bridge,'responses',`${id}.json`);
    c.jsonAtomic(requestPath,c.signed(request,pair.secret));
    try {
      while(this.now()<request.expiresAt){
        const response=c.readJson(responsePath,{optional:true});
        if(response){
          if(!c.verify(response,pair.secret)||response.protocol!==c.PROTOCOL||response.id!==id||response.bootId!==request.bootId||response.accountId!==request.accountId||!Number.isFinite(response.time)||response.time<issuedAt||response.time>request.expiresAt+1000)throw new Error('Discord-Antwort konnte nicht sicher bestätigt werden.');
          const current=this.heartbeat(pair);
          if(!current||current.bootId!==request.bootId||current.accountId!==request.accountId)throw new Error('Discord wurde neu gestartet oder das Konto gewechselt. Bitte aktualisieren.');
          if(response.ok!==true)throw new Error(typeof response.error==='string'?response.error.slice(0,300):'Discord konnte die Änderung nicht ausführen.');
          const result=c.clean(response.result);
          return includeContext?{result,binding:c.digest({bootId:request.bootId,accountId:request.accountId})}:result;
        }
        await new Promise(resolve=>setTimeout(resolve,80));
      }
      throw new Error('Discord antwortet nicht rechtzeitig. Der tatsächliche Zustand muss vor einem erneuten Versuch aktualisiert werden.');
    } finally {c.remove(requestPath);c.remove(responsePath);}
  }
  async run(action,payload={}) {
    if(typeof action!=='string'||!action.startsWith('localdiscord.'))throw new Error('Unbekannte lokale Aktion.');
    const operation=action.slice(13);
    const perform=async()=>{
      if(operation==='state'){c.keys(payload,[]);return this.state();}
      if(operation==='install')return this.install(payload);
      if(!c.plain(payload))throw new Error('Ungültige lokale Angaben.');
      const {expectedBinding,...body}=payload;
      const heartbeat=this.heartbeat();
      if(!heartbeat)throw new Error('Discord ist nicht verbunden. Bitte Discord öffnen und die lokale Verbindung einschalten.');
      if(typeof expectedBinding!=='string'||expectedBinding!==c.digest({bootId:heartbeat.bootId,accountId:heartbeat.accountId}))throw new Error('Discord-Konto oder Verbindung wurde gewechselt. Bitte aktualisieren und erneut auswählen.');
      c.validate(operation,body);
      const result=await this.request(operation,body,false,expectedBinding);
      return ['toggle','roles.save'].includes(operation)?this.state():result;
    };
    const result=this.queue.then(perform,perform);this.queue=result.catch(()=>{});return result;
  }
}
module.exports={LocalDiscordService,readBundledSource};
