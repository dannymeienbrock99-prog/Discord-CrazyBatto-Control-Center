export function musicContextKey(site) {
  return site?.connected ? [site.baseUrl,site.profileId,site.user?.id,site.expiresAt].join('|') : 'disconnected';
}

export function validMusicState(value) {
  return value?.ok===true&&value.bot&&typeof value.bot.connected==='boolean'
    &&value.permissions&&typeof value.permissions.canControl==='boolean'
    &&value.discord&&typeof value.discord.linked==='boolean'
    &&Array.isArray(value.library?.tracks)&&Array.isArray(value.library?.playlists)&&Array.isArray(value.queue);
}

export function pendingMusicLink(link) {
  return link&&['pending','authorized'].includes(link.status)&&typeof link.authorizePath==='string' ? link : null;
}

export async function afterMusicLinkPoll(pending,isCurrent,task) {
  if(pending)await pending.catch(()=>{});
  if(isCurrent())return task(isCurrent);
}

export function filterMusicTracks(data,query,playlistId) {
  const tracks=Array.isArray(data?.library?.tracks)?data.library.tracks:[];
  const selected=(data?.library?.playlists||[]).find(item=>item.id===playlistId);
  const search=String(query||'').trim().toLocaleLowerCase('de');
  return tracks.filter(track=>(playlistId==='all'||selected?.trackIds?.includes(track.id))
    &&`${track.title||''} ${track.artist||''}`.toLocaleLowerCase('de').includes(search));
}

export function musicControls(data,verified=true) {
  const allowed=verified&&data?.discord?.linked===true&&data?.permissions?.canControl===true;
  const connected=data?.bot?.connected===true,hasTrack=Boolean(data?.bot?.currentTrack),hasQueue=(data?.queue?.length||0)>0;
  return {allowed,connected,hasTrack,hasQueue,canJoin:allowed&&!connected&&data?.bot?.status!=='connecting',canPause:allowed&&connected&&hasTrack,
    canNavigate:allowed&&connected&&hasQueue,canStop:allowed&&(connected||hasQueue||data?.bot?.status==='connecting')};
}

export function musicBotLabel(data) {
  if(!data)return 'Status wird geladen';
  if(!data.bot?.configured)return 'Musikwiedergabe nicht eingerichtet';
  if(!data.bot?.enabled)return 'Musikbot ausgeschaltet';
  if(data.bot?.gateway?.ready===false)return 'Discord-Verbindung nicht bereit';
  if(data.bot?.connected){
    if(data.bot.paused)return 'Pausiert im Sprachkanal';
    if(data.bot.status==='playing'&&data.bot.currentTrack)return 'Musik läuft im Sprachkanal';
    if(data.bot.status==='buffering')return 'Im Sprachkanal · Titel wird geladen';
    return data.bot.currentTrack?'Im Sprachkanal · Titel ausgewählt':'Im Sprachkanal · bereit';
  }
  return data.bot?.status==='connecting'?'Sprachverbindung wird aufgebaut':'Noch nicht im Sprachkanal';
}
