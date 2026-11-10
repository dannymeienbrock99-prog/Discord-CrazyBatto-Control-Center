import React,{useEffect,useRef,useState} from 'react';
import {CheckCircle2,Headphones,Info,Link2,Music2,Pause,Play,RefreshCw,Search,ShieldCheck,SkipBack,SkipForward,Square,Volume2} from 'lucide-react';
import {afterMusicLinkPoll,filterMusicTracks,musicBotLabel,musicContextKey,musicControls,pendingMusicLink,validMusicState} from './music-panel-state.mjs';
import './music-panel.css';

const errorText=error=>error?.message||'Die Musiksteuerung ist gerade nicht erreichbar.';

export default function MusicPanel({api,site,notify,navigate}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(''),[refreshing,setRefreshing]=useState(false),[error,setError]=useState(null),[link,setLink]=useState(null),[volume,setVolume]=useState(50),[volumeEdited,setVolumeEdited]=useState(false),[query,setQuery]=useState(''),[playlist,setPlaylist]=useState('all'),[verified,setVerified]=useState(false),[updatedAt,setUpdatedAt]=useState(null);
  const epoch=useRef(0),alive=useRef(false),readSequence=useRef(0),reading=useRef(null),operation=useRef(null),volumeDirty=useRef(false),dataRef=useRef(null),apiRef=useRef(api),notifyRef=useRef(notify),reloadRef=useRef(null),pollingLink=useRef(null);
  apiRef.current=api;notifyRef.current=notify;dataRef.current=data;
  const contextKey=musicContextKey(site);
  const current=(generation,sequence)=>alive.current&&epoch.current===generation&&(sequence===undefined||sequence===readSequence.current);
  const acceptLink=result=>{
    const next=result.discord?.linked?null:pendingMusicLink(result.link);
    setLink(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
  };
  const load=async({silent=false,afterOperation=false}={})=>{
    if(!site?.connected||!alive.current||(operation.current&&!afterOperation)||pollingLink.current)return null;
    if(reading.current)return reading.current.promise;
    const generation=epoch.current,sequence=++readSequence.current,read={promise:null};
    reading.current=read;if(!silent)setRefreshing(true);
    read.promise=(async()=>{
      try{
        const result=await apiRef.current('website.request',{operation:'music.read'});
        if(!current(generation,sequence))return null;
        if(!validMusicState(result))throw Error('Der Server hat keinen vollständigen Musikstatus geliefert. Bitte erneut laden.');
        dataRef.current=result;setData(result);setVerified(true);setUpdatedAt(Date.now());acceptLink(result);
        if(!volumeDirty.current)setVolume(result.bot.volume??50);
        setPlaylist(previous=>previous==='all'||result.library.playlists.some(item=>item.id===previous)?previous:'all');
        setError(previous=>!silent||previous?.source==='read'?null:previous);
        return result;
      }catch(err){if(current(generation,sequence)){setError({source:'read',text:errorText(err)});setVerified(false);}return null;}
      finally{if(reading.current===read)reading.current=null;if(current(generation,sequence)&&!silent)setRefreshing(false);}
    })();
    return read.promise;
  };
  reloadRef.current=load;
  useEffect(()=>{
    alive.current=true;epoch.current++;readSequence.current++;reading.current=null;operation.current=null;pollingLink.current=null;
    volumeDirty.current=false;setVolumeEdited(false);setData(null);dataRef.current=null;setError(null);setLink(null);setVerified(false);setUpdatedAt(null);setBusy('');setRefreshing(false);setQuery('');setPlaylist('all');
    if(site?.connected)void reloadRef.current();
    const refresh=()=>{if(document.visibilityState!=='hidden')void reloadRef.current({silent:true});};
    const timer=site?.connected?setInterval(refresh,10000):null;
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{alive.current=false;epoch.current++;readSequence.current++;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[contextKey,site?.connected]);

  const run=async(kind,task)=>{
    if(operation.current||!site?.connected)return;
    const op={},generation=epoch.current,pendingLinkPoll=pollingLink.current?.promise;operation.current=op;readSequence.current++;reading.current=null;
    setBusy(kind);setRefreshing(false);setError(null);
    try{await afterMusicLinkPoll(pendingLinkPoll,()=>current(generation),task);}
    catch(err){if(current(generation))setError({source:'action',text:errorText(err)});}
    finally{
      if(current(generation))await reloadRef.current({silent:true,afterOperation:true});
      if(operation.current===op)operation.current=null;
      if(current(generation))setBusy('');
    }
  };
  const control=(action,extra={})=>run(action,async isCurrent=>{
    const result=await apiRef.current('website.request',{operation:'music.control',body:{action,...extra}});
    if(!isCurrent())return;
    if(result.ok!==true)throw Error('Der Server hat diese Musikaktion nicht bestätigt. Bitte den Status prüfen.');
    if(action==='volume'){volumeDirty.current=false;setVolumeEdited(false);}
    if(result.bot&&Array.isArray(result.queue))setData(previous=>previous?{...previous,bot:{...previous.bot,...result.bot},queue:result.queue}:previous);
    notifyRef.current?.(result.message||'Musiksteuerung ausgeführt.');
  });

  useEffect(()=>{
    if(!link||!site?.connected)return;
    let cancelled=false,timer;const generation=epoch.current;
    const schedule=delay=>{timer=setTimeout(poll,delay);};
    const poll=async()=>{
      if(cancelled||!current(generation))return;
      if(operation.current||pollingLink.current){schedule(1000);return;}
      const pollOperation={promise:null};pollingLink.current=pollOperation;readSequence.current++;reading.current=null;setRefreshing(false);
      pollOperation.promise=(async()=>{try{
        const result=await apiRef.current('website.request',{operation:'music.link.poll',body:{}});
        if(cancelled||!current(generation))return;
        if(result.status==='authorized'){
          setLink(null);if(pollingLink.current===pollOperation)pollingLink.current=null;
          await reloadRef.current({silent:true});
          if(!cancelled&&current(generation))notifyRef.current?.('Discord-Konto verknüpft.');
        }else if(result.status==='pending')schedule(Math.max(3000,result.intervalMs||3000));
        else{setLink(null);setError({source:'action',text:'Die Verknüpfung ist abgelaufen. Bitte neu starten.'});}
      }catch(err){if(!cancelled&&current(generation)){setLink(null);setError({source:'action',text:errorText(err)});}}
      finally{if(pollingLink.current===pollOperation)pollingLink.current=null;}})();
      return pollOperation.promise;
    };
    schedule(link.status==='authorized'?0:Math.max(3000,link.intervalMs||3000));
    return()=>{cancelled=true;clearTimeout(timer);};
  },[link,contextKey,site?.connected]);

  const startLink=()=>run('link',async isCurrent=>{
    const result=await apiRef.current('website.request',{operation:'music.link.start',body:{}});
    if(!isCurrent())return;
    setLink({...result,status:'pending'});
    await apiRef.current('app.openExternal',{url:new URL(result.authorizePath,site.baseUrl||'https://crazybatto.de').href});
  });
  const cancelLink=()=>run('cancel-link',async isCurrent=>{
    setLink(null);
    await apiRef.current('website.request',{operation:'music.link.cancel',body:{}});
    if(isCurrent())setLink(null);
  });
  const unlink=()=>run('unlink',async isCurrent=>{
    setLink(null);
    await apiRef.current('website.request',{operation:'music.link.unlink'});
    if(isCurrent()){setLink(null);notifyRef.current?.('Discord-Verknüpfung getrennt.');}
  });

  if(!site?.connected)return <section className="panel empty-state"><ShieldCheck size={36} aria-hidden="true"/><h2>Mit deiner Website anmelden</h2><p>Steuere die Musik deines vorhandenen Website-Bots im Discord-Sprachkanal.</p><button className="btn btn-primary" onClick={()=>navigate('website')}>Konto & Bot öffnen</button></section>;
  const controls=musicControls(data,verified),tracks=filterMusicTracks(data,query,playlist),allTracks=data?.library?.tracks||[],hasFilters=!!query.trim()||playlist!=='all';
  const blocked=Boolean(busy),queue=data?.queue||[],currentTrack=data?.bot?.currentTrack;
  const resetFilters=()=>{setQuery('');setPlaylist('all');};
  const botChannel=(data?.channels||[]).find(item=>item.id===data?.bot?.channelId)?.name;
  return <div className="page-stack music-panel-page">
    {error&&<div className="admin-error" role="alert">{error.text}{error.source==='read'&&data&&<small>Die Anzeige enthält den zuletzt geladenen Stand. Steuerung wird nach erfolgreichem Aktualisieren wieder freigegeben.</small>}</div>}
    <section className="panel admin-pad"><div className="row"><div><span className="admin-overline">DEINE MEDIATHEK · DEIN DISCORD</span><h2 className="site-space">Musik gemeinsam hören</h2></div><button className="btn" disabled={blocked||refreshing} onClick={()=>load()}><RefreshCw size={15} aria-hidden="true"/>{refreshing?'Wird geladen …':'Musikstatus aktualisieren'}</button></div>
      {!data?<p className="muted site-space">{refreshing?'Musikstatus wird geladen …':'Der Musikstatus ist noch nicht bestätigt. Bitte erneut laden.'}</p>:<>
      <p className="muted site-space">{data.permissions?.reason||'Tritt mit deinem verbundenen Discord-Konto einem Sprachkanal bei. Danach kannst du den Bot dazuholen und Musik starten.'}</p>
      <div className="site-facts"><div><span>Dein Discord-Konto</span><span>{data.discord.linked?data.discord.user?.displayName||data.discord.user?.username:'Noch nicht verknüpft'}</span></div><div><span>Dein Sprachkanal</span><span>{data.channel?.name||'Bitte einem Discord-Sprachkanal beitreten'}</span></div><div><span>Mediathek</span><span>{data.storage?.message||(data.storage?.online?'Verbunden':'Nicht erreichbar')}</span></div><div><span>Musikbot</span><span>{musicBotLabel(data)}{controls.connected&&botChannel?` · ${botChannel}`:''}</span></div></div>
      {data.bot?.message&&data.bot.message!==data.permissions?.reason&&<div className="notice music-status-notice"><Info size={17} aria-hidden="true"/><span>{data.bot.message}</span></div>}
      <div className="music-join-actions"><button className="btn btn-primary" disabled={!controls.canJoin||blocked} onClick={()=>control('join')}><Headphones size={18} aria-hidden="true"/>{busy==='join'?'Bot tritt bei …':controls.connected?'Bot ist im Sprachkanal':'Bot meinem Sprachkanal beitreten lassen'}</button>{controls.connected&&<span className="music-connected-note"><CheckCircle2 size={16} aria-hidden="true"/>Von Discord bestätigt</span>}</div>
      <p className="music-help">Der Bot folgt deinem verbundenen Discord-Konto in dessen aktuellen Sprachkanal. Zum Beitreten ist keine laufende Musik nötig.</p>
      {data.discord.linked?<button className="btn site-space" disabled={blocked} onClick={unlink}>Discord-Konto trennen</button>:<button className="btn site-space" disabled={blocked||!!link} onClick={startLink}><Link2 size={16} aria-hidden="true"/>Mein Discord-Konto verknüpfen</button>}
      {link&&<div className="notice site-space music-link-notice"><span>{link.status==='authorized'?'Discord-Zustimmung liegt vor. Verknüpfung wird abgeschlossen …':'Bestätige die Verknüpfung im geöffneten Browser.'}{link.displayCode&&<> Code: <strong>{link.displayCode}</strong></>}</span><button className="text-btn" disabled={blocked} onClick={cancelLink}>Abbrechen</button></div>}
      <p className="music-refresh-note">{updatedAt?`Zuletzt aktualisiert: ${new Date(updatedAt).toLocaleTimeString('de-DE')} · Status wird etwa alle 10 Sekunden geprüft.`:'Status noch nicht geladen.'}</p>
      </>}
    </section>
    <div className="admin-two-col"><section className="panel music-player"><div className="record"><Music2 size={58} aria-hidden="true"/></div><small>JETZT IM SPRACHKANAL</small><h2>{currentTrack?.title||'Noch kein Titel'}</h2><p className="muted">{currentTrack?.artist||(controls.connected?'Bot ist bereit. Wähle einen Titel aus der Mediathek.':'Hole den Bot in deinen Sprachkanal und wähle einen Titel.')}</p>
      <div className="music-controls"><button className="icon-btn" aria-label="Vorheriger Titel" disabled={!controls.canNavigate||blocked} onClick={()=>control('previous')}><SkipBack aria-hidden="true"/></button><button className="btn btn-primary" aria-label={!currentTrack?'Zuerst einen Titel in der Mediathek auswählen':data?.bot?.paused?'Fortsetzen':'Pausieren'} title={!currentTrack?'Wähle unten einen Titel und klicke auf Abspielen.':undefined} disabled={!controls.canPause||blocked} onClick={()=>control(data?.bot?.paused?'resume':'pause')}>{data?.bot?.paused||!currentTrack?<Play aria-hidden="true"/>:<Pause aria-hidden="true"/>}</button><button className="icon-btn" aria-label="Nächster Titel" disabled={!controls.canNavigate||blocked} onClick={()=>control('next')}><SkipForward aria-hidden="true"/></button><button className="icon-btn" aria-label="Musik stoppen und Sprachkanal verlassen" disabled={!controls.canStop||blocked} onClick={()=>control('stop')}><Square size={18} aria-hidden="true"/></button></div>
      <label className="field music-volume"><span><Volume2 size={16} aria-hidden="true"/>Lautstärke · {volume}%{volumeEdited?' · noch nicht übernommen':''}</span><input type="range" min="0" max="100" value={volume} disabled={!controls.allowed||blocked} onChange={event=>{volumeDirty.current=true;setVolumeEdited(true);setVolume(Number(event.target.value));}}/></label><button className="btn" disabled={!controls.allowed||blocked||!volumeEdited} onClick={()=>control('volume',{volume})}>Lautstärke übernehmen</button>
    </section><section className="panel admin-pad"><h2>Warteschlange</h2><p className="muted site-space">{queue.length} Titel · Eine gemeinsame Liste für deinen Server</p><div className="track-list">{queue.map((track,index)=><div className="track-row" key={`${track.id}-${index}`}><span className="track-number">{track.current?<Music2 size={15} aria-hidden="true"/>:index+1}</span><div><strong>{track.title}</strong><small>{track.artist}</small></div>{track.current&&<span className="badge">Aktuell</span>}</div>)}{!queue.length&&<div className="empty-state compact"><Music2 aria-hidden="true"/><p>Noch keine Titel eingereiht.</p><small>In der Mediathek „Abspielen“ oder „Einreihen“ wählen. Der Bot kann auch ohne Warteschlange beitreten.</small></div>}</div></section></div>
    <section className="panel admin-pad"><div className="row"><h2>Mediathek</h2><span className="muted">{tracks.length} von {allTracks.length} geladenen Titeln{data?.library?.truncated?' · Auswahl gekürzt':''}</span></div><div className="form-grid site-space"><label className="field">Suche<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Titel oder Künstler"/></label><label className="field">Playlist<select value={playlist} onChange={event=>setPlaylist(event.target.value)}><option value="all">Alle Titel</option>{data?.library?.playlists?.filter(item=>item.id!=='all').map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
      {hasFilters&&<div className="music-filter-summary"><span>Filter aktiv{query.trim()?` · Suche: „${query.trim()}“`:''}{playlist!=='all'?` · ${data?.library?.playlists?.find(item=>item.id===playlist)?.name||'Ausgewählte Playlist'}`:''}</span><button className="text-btn" onClick={resetFilters}>Filter zurücksetzen</button></div>}
      <div className="track-list">{tracks.map(track=><div className="track-row" key={track.id}><Music2 size={18} aria-hidden="true"/><div><strong>{track.title}</strong><small>{track.artist||'Unbekannter Künstler'}</small></div><button className="btn" disabled={!controls.allowed||blocked} onClick={()=>control('queue',{trackId:track.id,playlistId:playlist})}>Einreihen</button><button className="btn btn-primary music-play-track" aria-label={`${track.title} abspielen`} disabled={!controls.allowed||blocked} onClick={()=>control('play',{trackId:track.id,playlistId:playlist})}><Play size={16} aria-hidden="true"/>Abspielen</button></div>)}</div>
      {!tracks.length&&<div className="empty-state music-library-empty"><Search size={29} aria-hidden="true"/><h3>{!data?'Mediathek noch nicht geladen':!allTracks.length?'Deine Mediathek enthält noch keine Titel':'Keine Titel passen zu deinen Filtern'}</h3><p>{!data?'Lade zunächst den Musikstatus.':!allTracks.length?'Lade Musik über die bestehende Website-Mediathek hoch. Der Bot kann deinem Sprachkanal bereits ohne Titel beitreten.':`${allTracks.length} Titel sind geladen. Setze Suche und Playlist zurück, um sie wieder zu sehen.`}</p>{hasFilters&&<button className="btn" onClick={resetFilters}>Alle Titel anzeigen</button>}</div>}
      <p className="muted site-space music-help">Die Titel kommen aus deiner bestehenden privaten Mediathek. Deine Discord-Verknüpfung und die Berechtigungen im Sprachkanal gelten auch hier.</p>
    </section>
  </div>;
}
