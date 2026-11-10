import React,{useState} from 'react';
import {ArrowUpRight,ImageOff,Info,Radio} from 'lucide-react';
import {tikTokPreview} from './tiktok-preview.mjs';
import './tiktok-preview.css';

const statusLabels={unconfigured:'Nicht eingerichtet',disabled:'Meldungen pausiert',unknown:'Status unbekannt',live:'LIVE bestätigt',offline:'Offline',error:'Status unbekannt · Abfragefehler'};
const time=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('de-DE'):'Noch keine erfolgreiche Abfrage';

function PreviewImage({src,alt,kind,emptyLabel='Kein Bild verfügbar'}){
 const [failedUrl,setFailedUrl]=useState(null);
 if(!src||failedUrl===src)return <div className="tiktok-image-empty"><ImageOff size={30}/><strong>{failedUrl===src&&src?'Bild konnte nicht geladen werden':emptyLabel}</strong>{failedUrl===src&&src&&<span>Die Bild-Adresse ist möglicherweise abgelaufen. Prüfe den Status erneut.</span>}</div>;
 return <img className={`tiktok-preview-image ${kind==='creator-avatar'?'tiktok-avatar-image':''}`} src={src} alt={alt} referrerPolicy="no-referrer" onError={()=>setFailedUrl(src)}/>;
}

function AvatarThumbnail({src}){
 const [failedUrl,setFailedUrl]=useState(null);
 if(!src||failedUrl===src)return null;
 return <img className="embed-thumbnail" src={src} alt="TikTok-Profilbild" referrerPolicy="no-referrer" onError={()=>setFailedUrl(src)}/>;
}

export default function TikTokPreview({slot,savedSlot,runtime,guildData,api,notify,dirty}){
 const preview=tikTokPreview({slot,savedSlot,runtime});
 const role=guildData?.roles?.find(item=>item.id===slot.roleId);
 const channel=guildData?.channels?.find(item=>item.id===slot.channelId);
 const openLive=()=>api('app.openExternal',{url:preview.liveUrl}).catch(error=>notify(error.message,'error'));
 return <div className="tiktok-preview-grid">
  <section className="panel tiktok-live-preview" aria-labelledby="tiktok-live-preview-title">
   <div className="tiktok-preview-heading"><div><span className="admin-overline">AUSGEWÄHLTER ACCOUNT</span><h3 id="tiktok-live-preview-title">Live-Vorschau</h3></div><span className={`tiktok-live-state ${preview.isLive?'confirmed':''}`}><Radio size={13}/>{statusLabels[preview.status]||'Status unbekannt'}</span></div>
   <div className="tiktok-cover-frame"><PreviewImage key={`${preview.username}:${preview.lastCheckedAt}`} src={preview.imageUrl} kind={preview.kind} alt={preview.kind==='live-cover'?`Von TikTok geladenes Live-Cover von ${preview.displayName}`:preview.kind==='creator-avatar'?`TikTok-Profilbild von ${preview.displayName}`:'Eigenes Ersatzbild für die Live-Meldung'} emptyLabel={preview.label}/>{preview.imageUrl&&<span className="tiktok-cover-source">{preview.label}</span>}</div>
   <div className="tiktok-cover-details"><div><strong>{preview.username?'@'+preview.username:'Noch kein Account'}</strong>{preview.displayName!==preview.username&&preview.username&&<span>{preview.displayName}</span>}</div><p>{preview.note}</p><small>Zuletzt geprüft: {time(preview.lastCheckedAt)}</small><button className="btn btn-primary" disabled={!preview.liveUrl} onClick={openLive}>{preview.isLive?'Live ansehen':'Live-Seite öffnen'}<ArrowUpRight size={16}/></button></div>
  </section>
  <section className="panel community-preview tiktok-discord-preview" aria-labelledby="tiktok-discord-preview-title">
   <div className="preview-heading"><div><h3 id="tiktok-discord-preview-title">Discord-Vorschau</h3><p>{dirty?'Ungespeicherter Entwurf':'Vorlage für die nächste Live-Meldung'}</p></div><span className="badge neutral">VORSCHAU</span></div>
   <div className="community-discord"><div className="discord-author"><img className="community-bot-avatar" src="./assets/logo.jpeg" alt=""/><strong>Crazy_Batto</strong><span className="app-badge">APP</span></div>{slot.roleId&&<p className="message-content"><span className="mention">@{role?.name||'Ausgewählte Rolle'}</span></p>}<div className="discord-embed" style={{borderLeftColor:preview.embed.color}}><AvatarThumbnail key={`${preview.username}:avatar:${preview.lastCheckedAt}`} src={preview.embed.thumbnailUrl}/>{preview.embed.title&&<h3 className="with-link">{preview.embed.title}</h3>}{preview.embed.description&&<p className="embed-description">{preview.embed.description}</p>}<div className="tiktok-embed-time"><strong>{preview.isLive?(preview.startEstimated?'Live erkannt':'Live seit'):'Zeitpunkt der nächsten Live-Erkennung'}</strong><span>{preview.isLive?time(preview.startedAt):'Wird beim Senden automatisch ergänzt.'}</span></div><div className="tiktok-embed-image"><PreviewImage key={`${preview.username}:discord:${preview.lastCheckedAt}`} src={preview.embed.imageUrl} kind={preview.kind} alt={`Bild in der Discord-Vorschau: ${preview.label}`} emptyLabel="Die Nachricht enthält derzeit kein Vorschaubild."/></div><div className="embed-footer">{preview.embed.footer}</div></div>{preview.liveUrl&&<button className="tiktok-preview-link" onClick={openLive}>Livestream auf TikTok ansehen <ArrowUpRight size={13}/></button>}</div>
   <p className="community-preview-note"><Info size={14}/><span>{channel?`Ziel: #${channel.name}. `:'Wähle einen Zielkanal. '}Bild und Text werden als Discord-Einbettung gesendet. Die Vorschau zeigt deine aktuelle Vorlage, keine bereits gesendete Nachricht. Sie veröffentlicht nichts und spielt kein Video ab.</span></p>
  </section>
 </div>;
}
