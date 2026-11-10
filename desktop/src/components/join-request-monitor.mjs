export function observeJoinRequests(previous,response){
 if(!response?.available||response.snapshotComplete!==true||!Array.isArray(response.requests))return {baseline:previous||null,newIds:[]};
 const ids=[...new Set(response.requests.map(r=>String(r.id)).filter(id=>/^\d{17,20}$/.test(id)))];
 if(!previous)return {baseline:{seen:ids},newIds:[]};
 const known=new Set(previous.seen||[]);
 const newIds=ids.filter(id=>!known.has(id));
 return {baseline:{seen:ids},newIds};
}
export function joinRequestCount(response){
 if(!response?.available)return null;
 return typeof response.total==='number'?response.total:Array.isArray(response.requests)?response.requests.length:0;
}

export async function readPendingJoinSnapshot(fetchPage,guildId){
 const rows=new Map(),seenCursors=new Set();let cursor={},first,last;
 for(let page=0;page<10;page++){
  const result=await fetchPage({guildId,status:'SUBMITTED',limit:100,...cursor});
  if(!result?.available)return {...result,requests:null,total:null,snapshotComplete:false};
  if(!Array.isArray(result.requests))throw new Error('Discord hat keine lesbare Liste der Beitrittsanfragen geliefert.');
  first??=result;last=result;
  for(const request of result.requests.slice(0,100))rows.set(String(request.id),request);
  const next=result.pagination?.nextBefore?{before:result.pagination.nextBefore}:result.pagination?.nextAfter?{after:result.pagination.nextAfter}:null;
  const complete=result.requests.length<=100&&(result.pagination?.hasMore===false||(result.pagination?.hasMore!==true&&!next&&result.requests.length<100));
  if(complete)return {...first,requests:[...rows.values()],total:first.total??rows.size,snapshotComplete:true,pagination:{...result.pagination,nextBefore:null,nextAfter:null,hasMore:false}};
  if(!next||seenCursors.has(JSON.stringify(next)))break;
  seenCursors.add(JSON.stringify(next));cursor=next;
 }
 return {...first,requests:[...rows.values()],total:first?.total??null,pagination:last?.pagination,snapshotComplete:false,snapshotMessage:'Die Prüfung ist auf 1.000 offene Anfragen begrenzt oder konnte nicht vollständig abgeschlossen werden. Windows-Hinweise bleiben für diesen Durchlauf aus. Weitere Anfragen kannst du manuell laden.'};
}

export function notificationReason(reason){
 return ({rate_limit:'Der Windows-Hinweis wurde begrenzt. Neue Anfragen bleiben in der App sichtbar.',unsupported:'Windows-Hinweise werden auf diesem PC nicht unterstützt. Neue Anfragen bleiben in der App sichtbar.',disabled:'Windows-Hinweise sind ausgeschaltet. Neue Anfragen bleiben in der App sichtbar.'})[reason]||'Windows hat diesen Hinweis nicht angezeigt. Neue Anfragen bleiben in der App sichtbar.';
}
