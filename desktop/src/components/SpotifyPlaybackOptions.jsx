import React,{useEffect,useState} from 'react';
import {Shuffle,Repeat,Repeat1} from 'lucide-react';
import {duration} from './integration-state.mjs';
export default function SpotifyPlaybackOptions({player,canControl,isCurrentDevice,control}){
  const playback=player?.playback,track=playback?.track;
  const [position,setPosition]=useState(0),[dirty,setDirty]=useState(false),[elapsed,setElapsed]=useState(0);
  useEffect(()=>{setDirty(false);setPosition(playback?.progressMs||0);},[track?.externalUrl,track?.name,track?.durationMs,playback?.deviceId]);
  useEffect(()=>{const started=Date.now();const update=()=>setElapsed(Math.min(track?.durationMs||0,(playback?.progressMs||0)+(playback?.isPlaying?Date.now()-started:0)));update();const timer=setInterval(update,1000);return()=>clearInterval(timer);},[playback,track?.durationMs]);
  const repeat=playback?.repeatState||'off',labels={off:'Aus',context:'Album / Playlist',track:'Dieser Titel'};
  const nextRepeat=({off:'context',context:'track',track:'off'})[repeat];
  return <div className="integration-space"><div className="integration-actions"><button className={`btn ${playback?.shuffleState?'btn-primary':''}`} disabled={!canControl} aria-pressed={playback?.shuffleState===true} onClick={()=>control('shuffle',{state:playback?.shuffleState!==true})}><Shuffle size={16}/>Zufallswiedergabe {playback?.shuffleState?'an':'aus'}</button><button className="btn" disabled={!canControl} onClick={()=>control('repeat',{state:nextRepeat})}>{repeat==='track'?<Repeat1 size={16}/>:<Repeat size={16}/>}Wiederholen: {labels[repeat]}</button></div>
    {!!track?.durationMs&&<div className="integration-actions"><label className="field integration-wide"><span>Wiedergabeposition · {duration((dirty?position:elapsed)/1000)} / {duration(track.durationMs/1000)}</span><input aria-label="Wiedergabeposition" type="range" min="0" max={Math.min(track.durationMs,86400000)} step="1000" value={dirty?position:elapsed} disabled={!canControl||!isCurrentDevice} onChange={event=>{setPosition(Number(event.target.value));setDirty(true);}}/></label><button className="btn" disabled={!canControl||!isCurrentDevice||!dirty} onClick={()=>control('seek',{positionMs:position},()=>setDirty(false))}>Zu dieser Stelle springen</button></div>}
  </div>;
}
