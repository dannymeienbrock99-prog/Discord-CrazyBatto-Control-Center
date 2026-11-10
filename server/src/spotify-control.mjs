import { assert } from './errors.mjs';

export const SPOTIFY_CONTROL_SCOPE = 'user-read-playback-state';
const ROOT = 'https://api.spotify.com/v1/me/player';
const DEVICE = /^[A-Za-z0-9_-]{1,128}$/;
const jobs = new WeakMap();
const clean = (value, max=160) => typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max) : '';
export function spotifyControlUrl(value) {
  let url; try { url=new URL(value); } catch { return false; }
  if(url.origin!=='https://api.spotify.com'||url.username||url.password||url.hash)return false;
  const path=url.pathname,keys=[...url.searchParams.keys()];
  if(['/v1/me/player','/v1/me/player/devices'].includes(path))return keys.length===0;
  if(!['play','pause','next','previous','volume'].some(name=>path==='/v1/me/player/'+name))return false;
  if(keys.some(key=>!['device_id',...(path.endsWith('/volume')?['volume_percent']:[])].includes(key))||new Set(keys).size!==keys.length)return false;
  if(!DEVICE.test(url.searchParams.get('device_id')||''))return false;
  return !path.endsWith('/volume')||/^(?:[0-9]|[1-9][0-9]|100)$/.test(url.searchParams.get('volume_percent')||'');
}
export function spotifyMedia(value) {
  assert(typeof value==='string'&&value.length<=1024&&!/[\s\\]/.test(value),'Bitte einen Spotify-Titel, ein Album oder eine Playlist wählen.');
  let match=/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/.exec(value);
  if(!match){let u;try{u=new URL(value);}catch{}
    assert(u?.protocol==='https:'&&u.hostname==='open.spotify.com'&&!u.port&&!u.username&&!u.password&&!u.hash,'Bitte einen gültigen Spotify-Link verwenden.');
    assert([...u.searchParams.keys()].every(k=>k==='si')&&u.searchParams.getAll('si').length<=1,'Der Spotify-Link enthält unbekannte Angaben.');
    match=/^\/(?:intl-[a-z]{2}\/)?(track|album|playlist)\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname);
  }
  assert(match,'Bitte einen Spotify-Titel, ein Album oder eine Playlist wählen.');
  return {type:match[1],uri:`spotify:${match[1]}:${match[2]}`};
}
function validate(body){
  assert(body&&typeof body==='object'&&!Array.isArray(body),'Ungültige Spotify-Steuerung.');
  const {action,deviceId}=body;
  assert(['play','pause','next','previous','volume','transfer'].includes(action)&&typeof deviceId==='string'&&DEVICE.test(deviceId),'Bitte eine Aktion und ein Spotify-Gerät auswählen.');
  const allowed=['action','deviceId',...(action==='play'?['uri']:[]),...(action==='volume'?['volume']:[])];
  assert(Object.keys(body).every(k=>allowed.includes(k)),'Die Spotify-Steuerung enthält unbekannte Angaben.');
  if(action==='volume')assert(Number.isInteger(body.volume)&&body.volume>=0&&body.volume<=100,'Bitte eine Lautstärke von 0 bis 100 angeben.');
  return {...body,...(body.uri!==undefined?{media:spotifyMedia(body.uri)}:{})};
}
function deviceView(data){
  assert(Array.isArray(data?.devices),'Spotify hat keine gültige Geräteliste geliefert.','spotify_response',503);
  return data.devices.filter(d=>typeof d?.id==='string'&&DEVICE.test(d.id)).slice(0,100).map(d=>({id:d.id,name:clean(d.name),type:clean(d.type,40),isActive:d.is_active===true,isRestricted:d.is_restricted===true,volumePercent:Number.isInteger(d.volume_percent)&&d.volume_percent>=0&&d.volume_percent<=100?d.volume_percent:null,supportsVolume:d.supports_volume===true}));
}
function safeLink(value,kind){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return null;return kind==='cover'&&['i.scdn.co','mosaic.scdn.co','image-cdn-ak.spotifycdn.com','image-cdn-fa.spotifycdn.com'].includes(u.hostname)?u.href:kind==='track'&&u.hostname==='open.spotify.com'?u.href:null;}catch{return null;}}
function playbackView(data){
  if(data===null)return null;
  assert(data&&typeof data==='object'&&typeof data.is_playing==='boolean','Spotify hat keinen gültigen Wiedergabestatus geliefert.','spotify_response',503);
  const t=data.item;
  return {isPlaying:data.is_playing,progressMs:Number.isFinite(data.progress_ms)?Math.max(0,data.progress_ms):0,deviceId:DEVICE.test(data.device?.id||'')?data.device.id:null,
    track:t&&typeof t.name==='string'?{name:clean(t.name,300),artists:Array.isArray(t.artists)?t.artists.slice(0,30).map(a=>clean(a.name)):[],durationMs:Number.isFinite(t.duration_ms)?Math.max(0,t.duration_ms):0,imageUrl:safeLink(t.album?.images?.[0]?.url||t.images?.[0]?.url,'cover'),externalUrl:safeLink(t.external_urls?.spotify,'track')}:null};
}
async function auth(owner,context){
  owner.requireLive();const user=owner.accounts.assertCurrent(context);
  assert(owner.status(context).controllerReady,'Bitte Spotify auf der Website erneut verbinden und den Zugriff auf den Wiedergabestatus erlauben.','spotify_reconnect',409);
  const grant=await owner.access(context);owner.assertBinding(context,grant.configRevision,grant.generation);
  return {user,grant,headers:{Authorization:'Bearer '+grant.accessToken},guard:()=>owner.assertBinding(context,grant.configRevision,grant.generation)};
}
export async function spotifyPlayer(owner,context){
  owner.accounts.limit('spotify:player:'+owner.accounts.assertCurrent(context).id,30);
  const state=await auth(owner,context);
  const results=await Promise.all([owner.request(ROOT+'/devices',{headers:state.headers}),owner.request(ROOT,{headers:state.headers})]);state.guard();
  return {ok:true,devices:deviceView(results[0].data),playback:playbackView(results[1].status===204?null:results[1].data)};
}
export async function spotifyControl(owner,context,body){
  const input=validate(body),user=owner.accounts.assertCurrent(context);
  owner.requireLive();
  // A queued command belongs to the grant that existed when it was accepted.
  // Reconnecting the same website account must not revive an earlier command.
  const binding={configRevision:owner.configured().revision,generation:owner.generation(user.id)};
  owner.assertBinding(context,binding.configRevision,binding.generation);
  owner.accounts.limit('spotify:controller:'+user.id,30);
  if(!jobs.has(owner))jobs.set(owner,new Map());const users=jobs.get(owner),previous=users.get(user.id)||{promise:Promise.resolve(),pending:0};
  assert(previous.pending<5,'Spotify verarbeitet noch andere Befehle. Bitte kurz warten.','busy',429);
  const entry={pending:previous.pending+1,promise:null};
  entry.promise=previous.promise.catch(()=>{}).then(async()=>{
    owner.assertBinding(context,binding.configRevision,binding.generation);
    const state=await auth(owner,context);
    owner.assertBinding(context,binding.configRevision,binding.generation);
    const devices=deviceView((await owner.request(ROOT+'/devices',{headers:state.headers})).data);state.guard();
    const device=devices.find(d=>d.id===input.deviceId);assert(device&&!device.isRestricted,'Dieses Spotify-Gerät ist nicht verfügbar oder lässt sich nicht fernsteuern.','spotify_device',409);
    if(input.action==='volume')assert(device.supportsVolume,'Dieses Spotify-Gerät unterstützt keine Lautstärkesteuerung.','spotify_device',409);
    let url=ROOT,method='PUT',payload;
    if(input.action==='transfer')payload={device_ids:[input.deviceId],play:false};
    else{url+='/'+input.action+'?device_id='+encodeURIComponent(input.deviceId);if(['next','previous'].includes(input.action))method='POST';if(input.action==='volume')url+='&volume_percent='+input.volume;
      if(input.action==='play'&&input.media)payload=input.media.type==='track'?{uris:[input.media.uri]}:{context_uri:input.media.uri};}
    state.guard();await owner.request(url,{method,headers:{...state.headers,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});state.guard();
    return {ok:true,message:'Spotify hat den Steuerbefehl angenommen.'};
  }).finally(()=>{const latest=users.get(user.id);if(latest){latest.pending=Math.max(0,latest.pending-1);if(latest===entry)users.delete(user.id);}});
  users.set(user.id,entry);return entry.promise;
}
