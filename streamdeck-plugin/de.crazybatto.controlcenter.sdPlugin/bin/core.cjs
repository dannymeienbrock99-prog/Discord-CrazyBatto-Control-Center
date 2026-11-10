'use strict';
const catalog=require('./catalog.js');
const BASE='http://127.0.0.1:17654';
const TOKEN=/^[A-Za-z0-9_-]{32,256}$/;
const clip=(value,max=80)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max);
function definition(uuid){return catalog.actions.find(a=>uuid===catalog.id+'.'+a.key);}
function spotifyUri(value){
  const input=String(value||'').trim();
  if(/^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/.test(input))return input;
  let url;try{url=new URL(input)}catch{throw Error('Bitte einen Spotify-Link oder eine Spotify-URI für Titel, Album oder Playlist eintragen.');}
  const match=/^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
  if(url.protocol!=='https:'||url.hostname!=='open.spotify.com'||url.username||url.password||url.port||!match)throw Error('Bitte einen offiziellen Spotify-Link für Titel, Album oder Playlist verwenden.');
  return `spotify:${match[1]}:${match[2]}`;
}
function payloadFor(uuid,settings={}){
  const def=definition(uuid);if(!def)throw Error('Diese Stream-Deck-Aktion ist nicht bekannt.');
  const action=typeof settings.command==='string'?settings.command:def.commands[0][0];
  if(!def.commands.some(([name])=>name===action))throw Error('Die gewählte Aktion gehört nicht zu dieser Taste.');
  const result={action};
  if(action.startsWith('spotify.')&&settings.deviceId){const id=String(settings.deviceId).trim();if(id.length>256||/[\s\u0000-\u001f\u007f]/.test(id))throw Error('Bitte ein gültiges Spotify-Gerät wählen.');result.deviceId=id;}
  if(action==='spotify.transfer'&&!result.deviceId)throw Error('Bitte zuerst das Spotify-Zielgerät auswählen.');
  if(action==='spotify.context')result.uri=spotifyUri(settings.uri);
  if(action.endsWith('.volume')){const n=Number(settings.volume);if(String(settings.volume??'').trim()===''||!Number.isInteger(n)||n<0||n>100)throw Error('Die Lautstärke muss zwischen 0 und 100 liegen.');result.volume=n;}
  if(action==='app.open'){const page=String(settings.page||'overview');if(!catalog.pages.some(([id])=>id===page))throw Error('Bitte einen vorhandenen Control-Center-Bereich wählen.');result.page=page;}
  if(action==='music.play'){
    for(const key of ['trackId','playlistId'])if(settings[key]){const value=String(settings[key]).trim();if(!/^[A-Za-z0-9_-]{1,160}$/.test(value))throw Error('Bitte die gültige Mediathek-ID verwenden.');result[key]=value;}
    if(result.trackId&&result.playlistId)throw Error('Bitte entweder einen Titel oder eine Playlist wählen.');
  }
  return result;
}
function friendlyError(error){
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'Das Control Center antwortet gerade nicht. Bitte erneut versuchen.';
  if(error?.code==='offline'||error?.name==='TypeError')return 'Control Center öffnen und die Stream-Deck-Verbindung einschalten.';
  return clip(error?.message||'Die Aktion konnte nicht ausgeführt werden.',240);
}
class Bridge {
  constructor({fetchFn=globalThis.fetch,timeoutMs=8000}={}){this.fetch=fetchFn;this.timeoutMs=timeoutMs;}
  async request(token,method,path,body){
    if(!TOKEN.test(token||''))throw Error('Bitte das Stream Deck zuerst mit dem Control Center koppeln.');
    let response;try{response=await this.fetch(BASE+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});}catch(e){if(e?.name==='TimeoutError'||e?.name==='AbortError')throw e;const offline=new Error('Control Center ist nicht erreichbar.');offline.code='offline';throw offline;}
    if(response.status===401)throw Error('Die Kopplung ist nicht mehr gültig. Im Control Center einen neuen Schlüssel kopieren und hier verbinden.');
    const text=await response.text();if(text.length>256*1024)throw Error('Die Antwort des Control Centers ist zu groß.');
    let value;try{value=JSON.parse(text)}catch{throw Error('Das Control Center hat keine gültige Antwort gesendet.');}
    if(!response.ok||value?.ok!==true)throw Error(clip(typeof value?.error==='string'?value.error:value?.error?.message||'Die Aktion wurde vom Control Center abgelehnt.',240));
    return value;
  }
  status(token){return this.request(token,'GET','/v1/status');}
  action(token,payload){return this.request(token,'POST','/v1/action',payload);}
}
function titleFor(uuid,settings,status,error){
  const def=definition(uuid);if(!def)return '';
  if(error)return 'Center\nverbinden';
  const action=settings?.command||def.commands[0][0],s=status?.spotify,m=status?.music;
  if(action.startsWith('spotify.')&&!s?.connected)return 'Spotify\nverbinden';
  if(action.startsWith('spotify.')&&s?.controllerReady===false)return 'Spotify\nfreigeben';
  if(action==='spotify.toggle')return (s?.isPlaying?'Pause':'Wiedergabe')+'\n'+clip(s?.track||'Spotify',18);
  if(action==='spotify.volume'||action==='spotify.volumeUp'||action==='spotify.volumeDown')return (action.endsWith('Up')?'Lauter':action.endsWith('Down')?'Leiser':'Lautstärke')+'\n'+(Number.isFinite(s?.volume)?s.volume+' %':'Spotify');
  if(action==='spotify.shuffle')return 'Zufall\n'+(s?.shuffle?'Ein':'Aus');
  if(action==='spotify.repeat')return 'Wiederholen\n'+({off:'Aus',context:'Alles',track:'Titel'}[s?.repeat]||'Aus');
  if(action==='music.join')return 'Bot beitreten\n'+clip(m?.channelName||'Sprachkanal',18);
  if(action==='music.leave')return 'Bot verlassen';
  if(action==='music.toggle')return (m?.playing?'Pause':'Wiedergabe')+'\n'+clip(m?.title||'Bot-Musik',18);
  if(action.startsWith('music.volume'))return (action.endsWith('Up')?'Lauter':action.endsWith('Down')?'Leiser':'Lautstärke')+'\n'+(Number.isFinite(m?.volume)?m.volume+' %':'Bot-Musik');
  if(action==='app.open')return clip(catalog.pages.find(([id])=>id===(settings.page||'overview'))?.[1]||'Control Center',30);
  return clip(settings?.title||def.name.replace(/^.* · /,''),32);
}
class Controller {
  constructor({send,bridge=new Bridge(),uuid,now=Date.now}={}){this.send=send;this.bridge=bridge;this.uuid=uuid;this.now=now;this.keys=new Map();this.token='';this.status=null;this.error='Bitte mit dem Control Center verbinden.';this.polling=null;this.nextPoll=0;this.actionQueue=Promise.resolve();this.generation=0;this.inspectors=new Set();this.lastPress=new Map();}
  emit(event,context,payload){this.send({event,...(context?{context}:{}),...(payload!==undefined?{payload}:{})});}
  updateTitles(){for(const [context,key]of this.keys)this.emit('setTitle',context,{title:titleFor(key.action,key.settings,this.status,this.error),target:0});}
  inspector(context,message){const key=this.keys.get(context);this.send({event:'sendToPropertyInspector',context,action:key?.action||catalog.id+'.app.open',payload:{kind:'state',paired:TOKEN.test(this.token),online:!this.error,app:this.status?.app||null,spotify:this.status?.spotify||null,music:this.status?.music||null,pages:this.status?.pages||catalog.pages.map(([id,title])=>({id,title})),message:message||this.error||'Control Center verbunden.'}});}
  async poll(force=false){
    if(this.polling)return this.polling;
    if(!force&&this.now()<this.nextPoll)return;
    this.nextPoll=this.now()+10000;const generation=this.generation,token=this.token;
    this.polling=(async()=>{try{const state=await this.bridge.status(token);if(generation!==this.generation)return;this.status=state;this.error='';}catch(error){if(generation!==this.generation)return;this.status=null;this.error=friendlyError(error);}finally{if(generation===this.generation){this.updateTitles();for(const context of this.inspectors)this.inspector(context);}}})().finally(()=>{this.polling=null});return this.polling;
  }
  execute(context,key){
    const prior=this.lastPress.get(context)||0;if(this.now()-prior<250)return Promise.resolve();this.lastPress.set(context,this.now());
    const generation=this.generation,token=this.token;
    let payload;try{payload=payloadFor(key.action,key.settings)}catch(error){this.emit('showAlert',context);this.inspector(context,friendlyError(error));return Promise.resolve();}
    const work=async()=>{if(generation!==this.generation)return;try{const result=await this.bridge.action(token,payload);if(generation!==this.generation)return;this.emit('showOk',context);this.inspector(context,result.message||'Aktion ausgeführt.');await this.poll(true);}catch(error){if(generation!==this.generation)return;this.emit('showAlert',context);this.inspector(context,friendlyError(error));}};
    this.actionQueue=this.actionQueue.then(work,work);return this.actionQueue;
  }
  async pair(context,token){
    if(!TOKEN.test(token||'')){this.inspector(context,'Bitte den vollständigen Verbindungsschlüssel aus dem Control Center einfügen.');return;}
    const generation=++this.generation;
    try{const state=await this.bridge.status(token);if(generation!==this.generation)return;this.token=token;this.status=state;this.error='';this.nextPoll=this.now()+10000;this.emit('setGlobalSettings',this.uuid,{token});this.updateTitles();for(const ctx of this.inspectors)this.inspector(ctx,'Mit dem Control Center verbunden.');this.inspector(context,'Mit dem Control Center verbunden.');}catch(error){if(generation===this.generation)this.inspector(context,friendlyError(error));}
  }
  async receive(message){
    if(!message||typeof message!=='object')return;
    const {event,context,action,payload}=message;
    if(event==='didReceiveGlobalSettings'){const token=payload?.settings?.token||'';if(token!==this.token){this.generation++;this.token=TOKEN.test(token)?token:'';this.status=null;this.error='Verbindung wird geprüft…';}return this.poll(true);}
    if(event==='willAppear'||event==='didReceiveSettings'){if(!definition(action)||typeof context!=='string')return;this.keys.set(context,{action,settings:payload?.settings||{}});this.updateTitles();return this.poll();}
    if(event==='willDisappear'){this.keys.delete(context);this.inspectors.delete(context);this.lastPress.delete(context);return;}
    if(event==='propertyInspectorDidAppear'){if(!definition(action)||typeof context!=='string')return;this.inspectors.add(context);if(!this.keys.has(context))this.keys.set(context,{action,settings:{}});this.inspector(context);return this.poll();}
    if(event==='propertyInspectorDidDisappear'){this.inspectors.delete(context);return;}
    if(event==='keyDown'){if(!definition(action)||typeof context!=='string')return;const key={action,settings:payload?.settings||this.keys.get(context)?.settings||{}};this.keys.set(context,key);return this.execute(context,key);}
    if(event==='sendToPlugin'){if(!definition(action)||typeof context!=='string')return;if(!this.keys.has(context))this.keys.set(context,{action,settings:{}});this.inspectors.add(context);if(payload?.kind==='pair')return this.pair(context,String(payload.token||'').trim());if(payload?.kind==='disconnect'){this.generation++;this.token='';this.status=null;this.error='Kopplung wurde entfernt.';this.emit('setGlobalSettings',this.uuid,{});this.updateTitles();this.inspector(context);return;}if(payload?.kind==='refresh'){await this.poll(true);this.inspector(context);return;}if(payload?.kind==='inspect'){this.inspector(context);return this.poll();}}
  }
}
module.exports={BASE,TOKEN,Bridge,Controller,payloadFor,spotifyUri,titleFor,friendlyError,definition};
