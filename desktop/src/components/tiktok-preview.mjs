const USERNAME=/^[a-zA-Z0-9_.]{2,24}$/;
// Keep the same TikTok image domains as the server's public room parser.
const IMAGE_DOMAINS=['tiktokcdn.com','tiktokcdn-us.com','tiktokcdn-eu.com'];
const normalizeUsername=value=>String(value||'').trim().replace(/^@/,'').toLowerCase();

export function safePreviewImage(value,{tiktokOnly=false}={}){
 if(typeof value!=='string'||!value||value.length>2048||/[\s\\\u0000-\u001f\u007f]/.test(value))return null;
 try{
  const url=new URL(value),host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host))return null;
  if(tiktokOnly&&!IMAGE_DOMAINS.some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))return null;
  if(/\.(m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname)))return null;
  return url.href;
 }catch{return null;}
}

export function tikTokLiveUrl(username){
 const name=normalizeUsername(username);
 return USERNAME.test(name)?`https://www.tiktok.com/@${name}/live`:null;
}

export function isSameTikTokAccount(slot={},savedSlot=slot,runtime=null){
 const username=normalizeUsername(slot.username),savedUsername=normalizeUsername(savedSlot?.username);
 return !!username&&username===savedUsername&&(!runtime?.slotId||String(runtime.slotId)===String(slot.id));
}

export function tikTokPreview({slot={},savedSlot=slot,runtime=null}={}){
 const username=normalizeUsername(slot.username);
 const accountMatches=isSameTikTokAccount(slot,savedSlot,runtime);
 const current=accountMatches?runtime:null;
 const supplied=current?.preview;
 const coverUrl=safePreviewImage(current?.coverUrl,{tiktokOnly:true})||
  (supplied?.kind==='live-cover'?safePreviewImage(supplied.imageUrl,{tiktokOnly:true}):null);
 const avatarUrl=safePreviewImage(current?.avatarUrl,{tiktokOnly:true})||
  (supplied?.kind==='creator-avatar'?safePreviewImage(supplied.imageUrl,{tiktokOnly:true}):null);
 const customUrl=safePreviewImage(slot.imageUrl);
 const imageUrl=coverUrl||customUrl||avatarUrl||null;
 const kind=coverUrl?'live-cover':customUrl?'custom-image':avatarUrl?'creator-avatar':'unavailable';
 const status=current?.status||(!username?'unconfigured':'unknown');
 const isLive=status==='live';
 const displayName=(typeof current?.name==='string'?current.name.trim():'')||username||'Creator';
 const embedName=displayName.replace(/@/g,'@\u200b');
 let label,note;
 if(kind==='live-cover'){
  label=isLive?'Live-Cover von TikTok':'Zuletzt geladenes Live-Cover';
  note=isLive?'Standbild aus der letzten Statusabfrage. Das laufende Video öffnet sich auf TikTok.':status==='offline'?'Der Stream ist offline. Dieses Bild stammt aus der letzten verfügbaren Live-Vorschau.':'Dieses Bild bestätigt keinen laufenden Stream. Der aktuelle Status wird separat angezeigt.';
 }else if(kind==='custom-image'){
  label='Eigenes Ersatzbild';
  note='TikTok liefert kein Live-Cover. Hier siehst du deine eingetragene Bild-Adresse, kein Bild aus dem Stream.';
 }else if(kind==='creator-avatar'){
  label='TikTok-Profilbild';
  note='TikTok liefert kein Live-Cover. Das Profilbild ist kein Bild aus dem Stream.';
 }else{
  label='Kein Vorschaubild verfügbar';
  note=!username?'Trage einen TikTok-Account ein und speichere ihn, um seinen Status abzufragen.':!accountMatches?'Der Accountname wurde geändert. Erst speichern und prüfen, um die Vorschau dieses Creators zu laden.':'TikTok hat kein verwendbares Cover oder Profilbild geliefert. Du kannst eine eigene Bild-Adresse als Ersatz festlegen.';
 }
 const embedImageLabel=kind==='live-cover'?'TikTok-Cover · Standbild, kein Live-Video':kind==='custom-image'?'Eigenes Ersatzbild · kein Livebild':kind==='creator-avatar'?'TikTok-Profilbild · kein Livebild':'Keine Bildvorschau von TikTok verfügbar';
 return {
  username,accountMatches,status,isLive,displayName,liveUrl:tikTokLiveUrl(username),imageUrl,avatarUrl,kind,label,note,
  lastCheckedAt:current?.lastCheckedAt||null,
  startedAt:current?.startedAt||current?.detectedAt||null,
  startEstimated:current?.startEstimated!==false||!current?.startedAt,
  embed:{title:String(slot.title||'').replaceAll('{name}',embedName).slice(0,256),description:String(slot.description||'').replaceAll('{name}',embedName).slice(0,4096),imageUrl,thumbnailUrl:avatarUrl&&kind!=='creator-avatar'?avatarUrl:null,color:'#d4af57',footer:'Crazy_Batto · Live-Benachrichtigung · '+embedImageLabel}
 };
}
