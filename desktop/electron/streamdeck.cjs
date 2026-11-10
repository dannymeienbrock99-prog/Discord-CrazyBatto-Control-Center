'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const PORT=17654;
const PAGES=Object.freeze(Object.entries({overview:'Schaltzentrale',embeds:'Einbettungen',templates:'Vorlagen',welcome:'Willkommen',rules:'Regeln & Zustimmung',tiktok:'TikTok Live',reports:'Meldungen',joinrequests:'Beitrittsanfragen',crowns:'Rollen & Geräte',setups:'Gaming Setups',voice:'Sprachkanäle',botextras:'Bot-Erweiterungen',tickets:'Tickets',support:'PC-Hilfe',members:'Mitglieder',robotorders:'Robot SchichtLog',counter:'Mitgliederzähler',birthdays:'Geburtstagskalender',birthdayembed:'Geburtstags-Einbettung',eventposts:'Event-Ankündigungen',events:'Discord-Termine',music:'Musik',spotify:'Spotify',streamdeck:'Stream Deck',localdiscord:'Mein Discord',themes:'Discord-Themes',server:'Server gestalten',channels:'Kanäle & Rollen',files:'Server-Dateien',connections:'Gespeicherte Zugänge',website:'Konto & Bot',modules:'Alle Funktionen',activity:'Aktivitäten'}).map(([id,title])=>Object.freeze({id,title})));
const ACTIONS=new Set(['spotify.toggle','spotify.play','spotify.pause','spotify.next','spotify.previous','spotify.volumeUp','spotify.volumeDown','spotify.volume','spotify.shuffle','spotify.repeat','spotify.transfer','spotify.context','music.join','music.leave','music.play','music.pause','music.toggle','music.next','music.previous','music.volumeUp','music.volumeDown','music.volume','app.open']);
const fail=(message,code='validation',status=400)=>{throw Object.assign(new Error(message),{code,status});};
const clean=(s,max=160)=>typeof s==='string'?s.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):'';
function validateAction(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!ACTIONS.has(input.action))fail('Diese Stream-Deck-Aktion ist nicht verfügbar.');
  const allowed=['action'];
  if(input.action==='app.open')allowed.push('page');
  else if(input.action.startsWith('spotify.')){allowed.push('deviceId');if(['spotify.play','spotify.context'].includes(input.action))allowed.push('uri');if(input.action==='spotify.volume')allowed.push('volume');}
  else{if(input.action==='music.play')allowed.push('trackId','playlistId');if(input.action==='music.volume')allowed.push('volume');}
  if(Object.keys(input).some(key=>!allowed.includes(key)))fail('Die Taste enthält unbekannte Angaben.');
  if(input.action==='app.open'&&!PAGES.some(p=>p.id===input.page))fail('Bitte einen vorhandenen Control-Center-Bereich auswählen.');
  if(input.deviceId!==undefined&&(typeof input.deviceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.deviceId)))fail('Das Spotify-Gerät ist ungültig.');
  if(input.action.endsWith('.volume')&&(!Number.isInteger(input.volume)||input.volume<0||input.volume>100))fail('Die Lautstärke muss zwischen 0 und 100 liegen.');
  if(input.uri!==undefined&&(typeof input.uri!=='string'||! /^(?:spotify:(?:track|album|playlist):[A-Za-z0-9]{22}|https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|playlist)\/[A-Za-z0-9]{22}\/?(?:\?si=[A-Za-z0-9_-]+)?)$/.test(input.uri)))fail('Bitte einen gültigen Spotify-Link verwenden.');
  if(input.action==='spotify.context'&&!input.uri)fail('Bitte einen Spotify-Titel, ein Album oder eine Playlist für diese Taste hinterlegen.');
  for(const key of ['trackId','playlistId'])if(input[key]!==undefined&&!(key==='playlistId'&&input[key]==='all')&&(typeof input[key]!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input[key])))fail('Bitte einen gültigen Mediathek-Eintrag wählen.');
  return {...input};
}
class StreamDeckController{
  constructor({website,openPage,version='3.6.0',now=Date.now}){this.website=website;this.openPage=openPage;this.version=version;this.now=now;this.cache=null;}
  scope(){const s=this.website.state();return s.connected?JSON.stringify([s.baseUrl,s.profileId,s.user?.id,s.expiresAt]):'';}
  async request(operation,body,scope=this.scope()){
    if(!scope)fail('Bitte im Control Center mit deinem Website-Konto anmelden.','auth',401);
    if(this.scope()!==scope)fail('Die Website-Sitzung hat sich geändert. Bitte erneut drücken.','auth',401);
    const result=await this.website.run('website.request',{operation,...(body===undefined?{}:{body})});
    if(this.scope()!==scope)fail('Die Website-Sitzung hat sich geändert. Bitte erneut drücken.','auth',401);
    return result;
  }
  async spotify(scope){const status=await this.request('spotify.status',undefined,scope);if(!status.connected||!status.controllerReady||status.previewOnly)return {status,player:null};return {status,player:await this.request('spotify.player',undefined,scope)};}
  async status(){
    const scope=this.scope();if(this.cache?.scope===scope&&this.cache.until>this.now())return this.cache.value;
    const value={ok:true,app:{connected:!!scope,version:this.version},spotify:{connected:false,controllerReady:false,isPlaying:false,track:'',artist:'',volume:null,device:null,devices:[],shuffle:false,repeat:'off'},music:{connected:false,playing:false,title:'',channelName:'',volume:0,queueLength:0},pages:PAGES};
    if(scope){
      try{const {status,player}=await this.spotify(scope),playback=player?.playback,device=player?.devices?.find(d=>d.id===playback?.deviceId);
        Object.assign(value.spotify,{connected:status.connected===true,controllerReady:status.controllerReady===true,isPlaying:playback?.isPlaying===true,track:clean(playback?.track?.name),artist:(playback?.track?.artists||[]).map(a=>clean(a,80)).join(', '),volume:device?.volumePercent??null,device:device?{id:device.id,name:clean(device.name)}:null,devices:(player?.devices||[]).filter(d=>!d.isRestricted).map(d=>({id:d.id,name:clean(d.name)})),shuffle:playback?.shuffleState===true,repeat:['context','track'].includes(playback?.repeatState)?playback.repeatState:'off'});
        if(!status.connected)value.spotify.error='Spotify im Control Center verbinden.';else if(!status.controllerReady)value.spotify.error='Spotify-Zugriff erneut freigeben.';
      }catch(error){value.spotify.error=clean(error.message,300);}
      try{const m=await this.request('music.read',undefined,scope);Object.assign(value.music,{connected:m.bot?.connected===true,playing:m.bot?.status==='playing',title:clean(m.bot?.track),channelName:clean(m.channels?.find(c=>c.id===m.bot?.channelId)?.name||m.channel?.name),volume:m.bot?.volume??0,queueLength:m.queue?.length||0});if(m.permissions?.reason)value.music.error=clean(m.permissions.reason,300);}catch(error){value.music.error=clean(error.message,300);}
    }
    if(this.scope()!==scope)fail('Die Website-Sitzung wurde geändert.','auth',401);
    this.cache={scope,until:this.now()+8000,value};return value;
  }
  async action(raw){
    const input=validateAction(raw),scope=this.scope();this.cache=null;
    if(input.action==='app.open'){await this.openPage(input.page);return {ok:true,message:'Control Center geöffnet.'};}
    let result;
    if(input.action.startsWith('spotify.')){
      const {status,player}=await this.spotify(scope);if(!player)fail(status.connected?'Bitte Spotify erneut für die Steuerung freigeben.':'Bitte zuerst dein Spotify-Konto im Control Center verbinden.','spotify_reconnect',409);
      const candidates=(player.devices||[]).filter(d=>!d.isRestricted),device=input.deviceId?candidates.find(d=>d.id===input.deviceId):candidates.find(d=>d.isActive)||candidates[0];
      if(!device)fail('Öffne Spotify auf deinem Gerät und aktualisiere die Verbindung.','spotify_device',409);
      let action=input.action.split('.')[1],body={deviceId:device.id};
      if(action==='toggle')action=player.playback?.deviceId===device.id&&player.playback?.isPlaying?'pause':'play';
      if(action==='context')action='play';
      if(['volumeUp','volumeDown','volume'].includes(action)){
        if(!device.supportsVolume||!Number.isInteger(device.volumePercent))fail('Die Lautstärke wird an diesem Spotify-Gerät selbst eingestellt.','spotify_device',409);
        body.volume=action==='volume'?input.volume:Math.max(0,Math.min(100,device.volumePercent+(action==='volumeUp'?5:-5)));action='volume';
      }
      if(action==='shuffle')body.state=player.playback?.shuffleState!==true;
      if(action==='repeat'){const order=['off','context','track'];body.state=order[(order.indexOf(player.playback?.repeatState||'off')+1)%order.length];}
      if(input.uri)body.uri=input.uri;
      result=await this.request('spotify.control',{action,...body},scope);
    }else{
      const m=await this.request('music.read',undefined,scope);let action=input.action.split('.')[1],body={};
      if(action==='leave')action='stop';
      if(action==='toggle')action=m.bot?.status==='playing'?'pause':'play';
      if(['volumeUp','volumeDown','volume'].includes(action)){body.volume=action==='volume'?input.volume:Math.max(0,Math.min(100,(m.bot?.volume??70)+(action==='volumeUp'?5:-5)));action='volume';}
      if(action==='play'){
        if(!input.trackId&&!input.playlistId&&m.bot?.paused)action='resume';
        else if(!input.trackId&&!input.playlistId&&m.bot?.status==='playing')return {ok:true,message:'Die Mediathek wird bereits abgespielt.'};
        else{body.playlistId=input.playlistId||'all';if(input.trackId)body.trackId=input.trackId;if(!m.library?.tracks?.length)fail('Deine Mediathek ist leer. Füge zuerst einen Titel hinzu.','music_empty',409);}
      }
      result=await this.request('music.control',{action,...body},scope);
    }
    if(result?.ok!==true)fail('Der Server hat den Befehl nicht bestätigt. Bitte den Status prüfen.','response',502);
    this.cache=null;return {ok:true,message:clean(result.message||'Befehl ausgeführt.',300)};
  }
}
class StreamDeckBridge{
  constructor({directory,safeStorage,controller,execute=fn=>fn(),port=PORT,now=Date.now}){this.directory=directory;this.crypto=safeStorage;this.controller=controller;this.execute=execute;this.port=port;this.now=now;this.server=null;this.token=null;this.problem=null;this.lastRequestAt=null;this.requests=[];this.pending=0;}
  state(){return {enabled:!!this.server?.listening,port:this.port,paired:!!this.token,lastRequestAt:this.lastRequestAt,problem:this.problem,version:'1.0.0',pages:PAGES};}
  loadToken(){
    if(!this.crypto.isEncryptionAvailable())fail('Windows kann die Stream-Deck-Verbindung gerade nicht geschützt speichern.');
    const file=path.join(this.directory,'streamdeck-token.encrypted');
    try{const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)fail('Die gespeicherte Stream-Deck-Verbindung ist ungültig.');const token=this.crypto.decryptString(fs.readFileSync(file));if(!/^[a-f0-9]{64}$/.test(token))fail('Die gespeicherte Stream-Deck-Verbindung ist ungültig.');return token;}catch(error){if(error.code!=='ENOENT')throw error;return this.newToken();}
  }
  newToken(){
    if(!this.crypto.isEncryptionAvailable())fail('Windows kann den Verbindungsschlüssel gerade nicht geschützt speichern.');
    const token=crypto.randomBytes(32).toString('hex'),bytes=this.crypto.encryptString(token);fs.mkdirSync(this.directory,{recursive:true});
    const target=path.join(this.directory,'streamdeck-token.encrypted'),temporary=target+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});fs.renameSync(temporary,target);}finally{try{fs.unlinkSync(temporary);}catch{}}
    return token;
  }
  authorized(request){const value=request.headers.authorization;return typeof value==='string'&&/^Bearer [a-f0-9]{64}$/.test(value)&&!!this.token&&crypto.timingSafeEqual(Buffer.from(value.slice(7)),Buffer.from(this.token));}
  async start(){
    if(this.server?.listening)return this.state();this.token=this.loadToken();this.problem=null;
    const server=http.createServer((req,res)=>this.handle(req,res));server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1000;server.maxHeadersCount=30;
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(this.port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});this.server=server;this.port=server.address().port;server.on('error',()=>{this.problem='Die lokale Stream-Deck-Verbindung wurde unterbrochen.';});return this.state();}
    catch(error){this.problem=error.code==='EADDRINUSE'?'Der Stream-Deck-Anschluss wird bereits verwendet. Beende die andere Control-Center-Instanz.':'Die lokale Stream-Deck-Verbindung konnte nicht gestartet werden.';this.token=null;throw Error(this.problem);}
  }
  async stop(){const server=this.server;this.server=null;this.token=null;this.controller.cache=null;if(server){server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));}return this.state();}
  rotate(){if(!this.server?.listening)fail('Bitte die Stream-Deck-Verbindung zuerst einschalten.');this.token=this.newToken();this.controller.cache=null;this.lastRequestAt=null;return this.state();}
  copyToken(){if(!this.server?.listening||!this.token)fail('Bitte die Stream-Deck-Verbindung zuerst einschalten.');return this.token;}
  async handle(request,response){
    response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,value)=>{if(!response.destroyed&&!response.writableEnded){response.writeHead(status);response.end(JSON.stringify(value));}};
    try{
      if(request.socket.remoteAddress!=='127.0.0.1'||request.headers.host!==`127.0.0.1:${this.port}`||request.headers.origin!==undefined||request.headers['sec-fetch-site']!==undefined)fail('Nur die lokale Stream-Deck-Anwendung darf diese Verbindung verwenden.','forbidden',403);
      if(!this.authorized(request))fail('Bitte den Verbindungsschlüssel aus dem Control Center im Stream-Deck-Plugin eintragen.','auth',401);
      const acceptedScope=this.controller.scope();
      const now=this.now();this.requests=this.requests.filter(t=>now-t<60000);if(this.requests.length>=120||this.pending>=6)fail('Zu viele Tastenbefehle. Bitte kurz warten.','busy',429);this.requests.push(now);
      const status=request.method==='GET'&&request.url==='/v1/status',action=request.method==='POST'&&request.url==='/v1/action';
      if(!status&&!action)fail('Diese Schnittstelle ist nicht verfügbar.','not_found',404);
      let input;
      if(action){if(!/^application\/json(?:;|$)/i.test(request.headers['content-type']||''))fail('Die Taste muss gültiges JSON senden.','validation',415);
        const chunks=[];let count=0;for await(const chunk of request){count+=chunk.length;if(count>4096)fail('Die Tastenangaben sind zu groß.','validation',413);chunks.push(chunk);}try{input=validateAction(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){if(error.code)throw error;fail('Die Tastenangaben sind ungültig.');}
      }
      this.pending++;
      try{const value=await this.execute(async()=>{if(!this.authorized(request))fail('Der Verbindungsschlüssel wurde geändert.','auth',401);if(this.controller.scope()!==acceptedScope)fail('Die Website-Sitzung wurde geändert. Bitte erneut drücken.','auth',401);return status?this.controller.status():this.controller.action(input);});if(!this.authorized(request))fail('Der Verbindungsschlüssel wurde geändert.','auth',401);if(this.controller.scope()!==acceptedScope)fail('Die Website-Sitzung wurde geändert.','auth',401);this.lastRequestAt=this.now();send(200,value);}finally{this.pending--;}
    }catch(error){send(Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:503,{ok:false,error:clean(error.message||'Die Verbindung ist nicht verfügbar.',400),code:typeof error.code==='string'&&/^[a-z_]+$/.test(error.code)?error.code:'unavailable'});}
  }
}
module.exports={StreamDeckBridge,StreamDeckController,validateAction,PAGES,PORT};
