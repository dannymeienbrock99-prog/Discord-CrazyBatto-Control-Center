import {useCallback,useEffect,useRef,useState} from 'react';
import {observeJoinRequests,readPendingJoinSnapshot,notificationReason} from './join-request-monitor.mjs';

export default function useJoinRequestMonitor({api,site,guildId,notify}){
 const [enabled,setEnabled]=useState(false),[data,setData]=useState(null),[error,setError]=useState(''),[newCount,setNewCount]=useState(0),[checking,setChecking]=useState(false),[saving,setSaving]=useState(false),[lastCheckedAt,setLastCheckedAt]=useState(null),[notificationNote,setNotificationNote]=useState('');
 const baseline=useRef(null),active=useRef(true),generation=useRef(0),inflight=useRef(null),enabledRef=useRef(false);
 useEffect(()=>{active.current=true;api('settings.get').then(s=>{if(active.current)setEnabled(s.joinRequestNotifications===true);}).catch(()=>{});return()=>{active.current=false;generation.current++;};},[api]);
 enabledRef.current=enabled;
 const refresh=useCallback(async()=>{
  if(!site?.connected||!guildId)return null;
  if(inflight.current)return inflight.current;
  const id=generation.current;setChecking(true);
  const request=(async()=>{try{const result=await readPendingJoinSnapshot(payload=>{if(id!==generation.current)throw new Error('Die Verbindung wurde geändert.');return api('joinrequests.list',payload);},guildId);if(!active.current||id!==generation.current)return null;setData(result);setError('');setLastCheckedAt(new Date().toISOString());const observed=observeJoinRequests(baseline.current,result);baseline.current=observed.baseline;if(enabledRef.current&&observed.newIds.length){setNewCount(n=>Math.min(100,n+observed.newIds.length));try{const sent=await api('notification.joinRequests',{guildId,count:Math.min(100,observed.newIds.length)});if(sent?.shown===false)setNotificationNote(notificationReason(sent.reason));}catch{setNotificationNote('Windows-Hinweise sind derzeit nicht verfügbar. Neue Anfragen bleiben in der App sichtbar.');}}return result;}catch(e){if(active.current&&id===generation.current)setError(e.message);return null;}finally{if(active.current&&id===generation.current)setChecking(false);if(id===generation.current)inflight.current=null;}})();inflight.current=request;return request;
 },[api,site?.connected,site?.profileId,site?.baseUrl,guildId]);
 useEffect(()=>{generation.current++;inflight.current=null;baseline.current=null;setData(null);setError('');setNewCount(0);setLastCheckedAt(null);if(!site?.connected||!guildId)return;if(enabled){refresh();const timer=setInterval(refresh,60000);return()=>clearInterval(timer);}},[refresh,enabled]);
 const toggle=async value=>{setSaving(true);try{await api('settings.save',{settings:{joinRequestNotifications:value}});setEnabled(value);setNotificationNote('');notify(value?'Hinweise auf neue Beitrittsanfragen eingeschaltet.':'Hinweise ausgeschaltet.');}catch(e){notify(e.message,'error');}finally{setSaving(false);}};
 return {enabled,data,error,newCount,checking,saving,lastCheckedAt,notificationNote,refresh,toggle,markRead:()=>setNewCount(0)};
}
