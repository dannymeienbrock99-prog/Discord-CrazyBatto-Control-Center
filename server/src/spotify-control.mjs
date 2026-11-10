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
  const action=path.slice('/v1/me/player/'.length);
  if(!['play','pause','next','previous','volume','shuffle','repeat','seek'].some(name=>path==='/v1/me/player/'+name))return false;
  const extra={volume:'volume_percent',shuffle:'state',repeat:'state',seek:'position_ms'}[action];
  if(keys.some(key=>!['device_id',...(extra?[extra]:[])].includes(key))||new Set(keys).size!==keys.length)return false;
  if(!DEVICE.test(url.searchParams.get('device_id')||''))return false;
  if(action==='volume')return /^(?:[0-9]|[1-9][0-9]|100)$/.test(url.searchParams.get('volume_percent')||'');
  if(action==='shuffle')return ['true','false'].includes(url.searchParams.get('state'));
  if(action==='repeat')return ['off','context','track'].includes(url.searchParams.get('state'));
  if(action==='seek'){const position=url.searchParams.get('position_ms')||'';return /^(?:0|[1-9]\d{0,15})$/.test(position)&&Number.isSafeInteger(Number(position));}
  return true;
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
  assert(['play','pause','next','previous','volume','transfer','shuffle','repeat','seek'].includes(action)&&typeof deviceId==='string'&&DEVICE.test(deviceId),'Bitte eine Aktion und ein Spotify-Gerät auswählen.');
  const allowed=['action','deviceId',...(action==='play'?['uri']:[]),...(action==='volume'?['volume']:[]),...(['shuffle','repeat'].includes(action)?['state']:[]),...(action==='seek'?['positionMs']:[])];
  assert(Object.keys(body).every(k=>allowed.includes(k)),'Die Spotify-Steuerung enthält unbekannte Angaben.');
  if(action==='volume')assert(Number.isInteger(body.volume)&&body.volume>=0&&body.volume<=100,'Bitte eine Lautstärke von 0 bis 100 angeben.');
  if(action==='shuffle')assert(typeof body.state==='boolean','Bitte Zufallswiedergabe eindeutig ein- oder ausschalten.');
  if(action==='repeat')assert(['off','context','track'].includes(body.state),'Bitte einen gültigen Wiederholungsmodus wählen.');
  if(action==='seek')assert(Number.isSafeInteger(body.positionMs)&&body.positionMs>=0,'Bitte eine gültige Wiedergabeposition angeben.');
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
    shuffleState:typeof data.shuffle_state==='boolean'?data.shuffle_state:null,repeatState:['off','context','track'].includes(data.repeat_state)?data.repeat_state:null,
    track:t&&typeof t.name==='string'?{name:clean(t.name,300),artists:Array.isArray(t.artists)?t.artists.slice(0,30).map(a=>clean(a.name)):[],durationMs:Number.isFinite(t.duration_ms)?Math.max(0,t.duration_ms):0,imageUrl:safeLink(t.album?.images?.[0]?.url||t.images?.[0]?.url,'cover'),externalUrl:safeLink(t.external_urls?.spotify,'track')}:null};
}
async function auth(owner,context){
  owner.requireLive();const user=owner.accounts.assertCurrent(context);
  assert(owner.status(context).controllerReady,'Bitte Spotify auf der Website erneut verbinden und den Zugriff auf den Wiedergabestatus erlauben.','spotify_reconnect',409);
  const grant=await owner.access(context);owner.assertBinding(context,grant.configRevision,grant.generation);
  return {user,grant,request:(url,options={})=>owner.authorizedRequest(context,url,options,grant),guard:()=>owner.assertBinding(context,grant.configRevision,grant.generation)};
}
export async function spotifyPlayer(owner,context){
  owner.accounts.limit('spotify:player:'+owner.accounts.assertCurrent(context).id,30);
  const state=await auth(owner,context);
  const results=await Promise.all([state.request(ROOT+'/devices'),state.request(ROOT)]);state.guard();
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
    const devices=deviceView((await state.request(ROOT+'/devices')).data);state.guard();
    const device=devices.find(d=>d.id===input.deviceId);assert(device&&!device.isRestricted,'Dieses Spotify-Gerät ist nicht verfügbar oder lässt sich nicht fernsteuern.','spotify_device',409);
    if(input.action==='volume')assert(device.supportsVolume,'Dieses Spotify-Gerät unterstützt keine Lautstärkesteuerung.','spotify_device',409);
    let url=ROOT,method='PUT',payload;
    if(input.action==='transfer')payload={device_ids:[input.deviceId],play:false};
    else{url+='/'+input.action+'?device_id='+encodeURIComponent(input.deviceId);if(['next','previous'].includes(input.action))method='POST';if(input.action==='volume')url+='&volume_percent='+input.volume;
      if(['shuffle','repeat'].includes(input.action))url+='&state='+input.state;
      if(input.action==='seek')url+='&position_ms='+input.positionMs;
      if(input.action==='play'&&input.media)payload=input.media.type==='track'?{uris:[input.media.uri]}:{context_uri:input.media.uri};}
    state.guard();const response=await state.request(url,{method,...(payload?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{})});state.guard();
    assert(response.status===204,'Spotify hat den Steuerbefehl nicht eindeutig bestätigt. Bitte den aktuellen Playerstatus prüfen.','spotify_uncertain',502);
    return {ok:true,message:'Spotify hat den Steuerbefehl angenommen.'};
  }).finally(()=>{const latest=users.get(user.id);if(latest){latest.pending=Math.max(0,latest.pending-1);if(latest===entry)users.delete(user.id);}});
  users.set(user.id,entry);return entry.promise;
}
