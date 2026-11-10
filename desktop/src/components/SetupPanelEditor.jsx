import React, {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, CheckCircle2, ExternalLink, Hash, Image, Info, Monitor, RefreshCw, Save, Send, X} from 'lucide-react';
import './setup-panel-editor.css';

const SUBMIT_URL='https://crazybatto.de/eure-gaming-setups.html#mein-setup';
const keys=['channelId','title','description','imageUrl','buttonLabel'];
const settingsOnly=value=>Object.fromEntries(keys.map(key=>[key,typeof value?.[key]==='string'?value[key]:'']));
const validState=value=>value&&Number.isSafeInteger(value.revision)&&value.revision>=0&&value.settings&&keys.every(key=>typeof value.settings[key]==='string');
const message=error=>error?.message||'Die Einbettung konnte nicht aktualisiert werden.';
const date=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('de-DE'):'Noch nicht bestätigt';

function safeImageUrl(value) {
  if(!value?.trim())return '';
  try {
    const url=new URL(value),host=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||value.length>2048||/[\s\\\u0000-\u001f\u007f]/.test(value))return '';
    if(host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host)||!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)||/(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|test|invalid|example|onion)$/.test(host)||/(?:^|\.)home\.arpa$/.test(host))return '';
    if(/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname)))return '';
    return url.href;
  }catch{return '';}
}

function PanelPreview({settings,botName='Crazy_Batto',compact=false}) {
  const imageUrl=safeImageUrl(settings.imageUrl),[failedImage,setFailedImage]=useState('');
  return <div className={`setup-panel-preview ${compact?'setup-panel-preview-compact':''}`}>
    <div className="setup-panel-preview-author"><span className="setup-panel-bot-avatar"><Monitor size={20} aria-hidden="true"/></span><strong>{botName}</strong><span className="setup-panel-app-tag">APP</span><small>Vorschau</small></div>
    <article className="setup-panel-discord-embed"><h3>{settings.title||'Eure Gaming Setups'}</h3><p>{settings.description||'Hier erscheint deine Beschreibung.'}</p>{imageUrl&&failedImage!==imageUrl&&<img src={imageUrl} alt="Bild der Gaming-Setup-Einbettung" referrerPolicy="no-referrer" onError={()=>setFailedImage(imageUrl)}/>} {imageUrl&&failedImage===imageUrl&&<div className="setup-panel-image-failed"><Image size={20} aria-hidden="true"/><span>Bild konnte nicht geladen werden.</span></div>}<footer>Crazy_Batto · Eure Gaming Setups</footer></article>
    <div className="setup-panel-link-preview"><span>{settings.buttonLabel||'Mein Setup einreichen'}</span><ExternalLink size={15} aria-hidden="true"/></div>
    <small className="setup-panel-preview-note">Schrift und Markdown-Formatierung können in Discord abweichen. Der Button öffnet die Setup-Einreichung.</small>
  </div>;
}

function PanelConfirmation({decision,busy,onCancel,onConfirm,botName}) {
  const [checked,setChecked]=useState(false),dialog=useRef(null),cancel=useRef(null);
  useEffect(()=>{const previous=document.activeElement;cancel.current?.focus();return()=>previous?.focus?.();},[]);
  const trap=event=>{
    if(event.key==='Escape'&&!busy)onCancel();
    if(event.key!=='Tab')return;
    const controls=dialog.current?.querySelectorAll('button:not(:disabled),input:not(:disabled)'),first=controls?.[0],last=controls?.[controls.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
  const publishing=decision.kind==='publish';
  return <div className="modal-backdrop"><section className="modal panel setup-panel-confirmation" role="dialog" aria-modal="true" aria-labelledby="setup-panel-confirm-title" ref={dialog} onKeyDown={trap}>
    <button className="icon-btn modal-close" aria-label="Bestätigung schließen" disabled={busy} onClick={onCancel}><X aria-hidden="true"/></button>
    <h2 id="setup-panel-confirm-title">{publishing?'Gaming-Setup-Einbettung veröffentlichen?':'Einbettung speichern?'}</h2>
    <p>{publishing?<>Die gespeicherte Einbettung wird in <strong>#{decision.channelName}</strong> auf deinem Discord-Server {decision.publication?.channelId===decision.settings.channelId?'aktualisiert':'veröffentlicht'}.</>:<>Der Entwurf für <strong>#{decision.channelName}</strong> wird gespeichert. Eine vorhandene Discord-Nachricht bleibt bis zum Veröffentlichen unverändert.</>}</p>
    {publishing&&decision.publication&&decision.publication.channelId!==decision.settings.channelId&&<p className="setup-panel-confirm-note">Im neuen Kanal wird eine neue Nachricht angelegt. Die bisherige Nachricht im anderen Kanal bleibt bestehen.</p>}
    <PanelPreview settings={decision.settings} botName={botName} compact/>
    <p className="setup-panel-fixed-link"><strong>Festes Buttonziel</strong><span>{SUBMIT_URL}</span></p>
    <label className="checkbox-label"><input type="checkbox" checked={checked} disabled={busy} onChange={event=>setChecked(event.target.checked)}/>Ich habe Kanal, Text, Bild und Button geprüft.</label>
    <div className="dialog-actions"><button className="btn" ref={cancel} disabled={busy} onClick={onCancel}>Abbrechen</button><button className="btn btn-primary" disabled={!checked||busy} onClick={onConfirm}>{busy?'Wird verarbeitet …':publishing?'Jetzt veröffentlichen':'Entwurf speichern'}</button></div>
  </section></div>;
}

export default function SetupPanelEditor({api,guildId,guildData,state,notify,refresh,contextKey}) {
  const [data,setData]=useState(null),[draft,setDraft]=useState(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[needsReload,setNeedsReload]=useState(false),[decision,setDecision]=useState(null);
  const alive=useRef(false),request=useRef(0),operation=useRef(false);
  const load=async()=>{
    if(operation.current)return;
    const preservedDraft=data&&draft&&JSON.stringify(settingsOnly(data.settings))!==JSON.stringify(draft)?{...draft}:null;
    const current=++request.current;setLoading(true);setError('');
    try{const result=await api('setup.panel.state',{guildId});if(!validState(result))throw Error('Der Server hat keine vollständigen Daten zur Setup-Einbettung geliefert.');if(alive.current&&current===request.current){setData(result);setDraft(preservedDraft||settingsOnly(result.settings));setNeedsReload(false);}}
    catch(err){if(alive.current&&current===request.current){setError(message(err));setNeedsReload(true);}}
    finally{if(alive.current&&current===request.current)setLoading(false);}
  };
  useEffect(()=>{alive.current=true;setData(null);setDraft(null);setDecision(null);load();return()=>{alive.current=false;request.current++;};},[contextKey,guildId]);
  const channels=guildData?.guild?.id===guildId?(guildData.channels||[]).filter(channel=>[0,5].includes(channel.type)):[];
  const channel=channels.find(item=>item.id===draft?.channelId),pending=busy||loading;
  const dirty=Boolean(data&&draft&&JSON.stringify(settingsOnly(data.settings))!==JSON.stringify(draft));
  const imageInvalid=Boolean(draft?.imageUrl.trim()&&!safeImageUrl(draft.imageUrl));
  const fieldInvalid=!draft?.title.trim()||!draft?.description.trim()||!draft?.buttonLabel.trim()||imageInvalid;
  const uncertainBlocked=data?.publishAttempt?.status==='uncertain'&&!(data.publishAttempt.operation==='edit'&&data.publication?.channelId===data.publishAttempt.channelId&&data.publication?.messageId===data.publishAttempt.messageId&&data.settings.channelId===data.publishAttempt.channelId);
  const sending=data?.publishAttempt?.status==='sending';
  const alreadyPublished=Boolean(data?.publication&&data.publication.revision===data.revision&&data.publication.channelId===data.settings.channelId&&data.publishAttempt?.status!=='uncertain');
  const change=(key,value)=>setDraft(previous=>({...previous,[key]:value}));
  const open=async url=>{try{await api('app.openExternal',{url});}catch(err){if(alive.current)notify(message(err),'error');}};
  const decide=kind=>setDecision({kind,revision:data.revision,settings:settingsOnly(kind==='publish'?data.settings:draft),channelName:channel?.name||draft.channelId,publication:data.publication});
  const confirm=async()=>{
    if(!decision||pending||operation.current)return;
    operation.current=true;const current=++request.current;setBusy(true);setError('');
    try{
      const result=await api(decision.kind==='save'?'setup.panel.save':'setup.panel.publish',{guildId,expectedRevision:decision.revision,...(decision.kind==='save'?{settings:decision.settings}:{}),confirm:true});
      if(!validState(result))throw Error('Die Aktion wurde nicht vollständig bestätigt. Lade den gespeicherten Stand neu, bevor du fortfährst.');
      if(alive.current&&current===request.current){setData(result);setDraft(settingsOnly(result.settings));setDecision(null);setNeedsReload(false);const status=result.publishAttempt?.status;if(decision.kind==='save')notify('Gaming-Setup-Einbettung gespeichert. Du kannst sie jetzt veröffentlichen.');else if(result.publication?.revision===result.revision&&status==='published')notify('Die Gaming-Setup-Einbettung wurde von Discord bestätigt.');else if(status==='uncertain'){setError('Discord hat den Versand nicht eindeutig bestätigt. Prüfe den Kanal und den gespeicherten Versandstand.');notify('Der Versand ist ungeklärt. Es wird nicht automatisch erneut gesendet.','error');}else if(status==='failed'){setError(result.publishAttempt.error||'Discord hat die Einbettung nicht übernommen.');}else notify('Der Versandstand wurde aktualisiert. Prüfe die Anzeige unter der Vorschau.');}
    }catch(err){if(alive.current&&current===request.current){setError(message(err));setNeedsReload(true);setDecision(null);notify(message(err),'error');}}
    finally{operation.current=false;if(alive.current&&current===request.current)setBusy(false);}
  };
  return <section className="panel setup-panel-editor" aria-labelledby="setup-panel-title">
    <div className="setup-section-title"><div><h2 id="setup-panel-title">Gaming-Setup-Einbettung</h2><p>Gestalte die Einladung in Discord. Der Button führt Mitglieder direkt zur Setup-Einreichung auf deiner Website.</p></div><button className="btn" disabled={pending||(dirty&&!needsReload)} onClick={load} title={dirty?(needsReload?'Den Serverstand neu laden. Deine Änderungen bleiben als Entwurf erhalten.':'Speichere den Entwurf vor dem Neuladen.'):undefined}><RefreshCw size={16} aria-hidden="true"/>Neu laden</button></div>
    {error&&<div className="admin-error setup-panel-error" role="alert">{error}{data&&<small>Die angezeigten Werte stammen aus dem zuletzt bestätigten Stand.</small>}</div>}
    {!data||!draft?<div className="setup-panel-empty"><Monitor size={30} aria-hidden="true"/><h3>{loading?'Einbettung wird geladen …':'Noch keine bestätigte Einbettung'}</h3><p>{loading?'Der Entwurf und sein Discord-Versandstand werden abgerufen.':'Lade die Daten neu, um die Einladung zu bearbeiten.'}</p></div>:<>
      <div className="setup-panel-columns"><div className="setup-panel-fields">
        <label className="field">Discord-Kanal für die Einladung<select value={draft.channelId} disabled={pending} onChange={event=>change('channelId',event.target.value)}><option value="">Text- oder Ankündigungskanal auswählen</option>{draft.channelId&&!channel&&<option value={draft.channelId}>Gespeicherter Kanal · {draft.channelId}</option>}{channels.map(item=><option value={item.id} key={item.id}># {item.name}</option>)}</select><small>Diese Einladung steht in einem Text- oder Ankündigungskanal. Eingereichte Setups erscheinen nach Freigabe im ausgewählten Forum.</small></label>
        {!channels.length&&<p className="setup-small-note">{guildData?'Keine geeigneten Textkanäle geladen.':'Die Kanäle deines Servers werden noch geladen.'} <button className="text-btn" disabled={pending} onClick={refresh}>Kanäle neu laden</button></p>}
        <label className="field">Titel<input value={draft.title} maxLength={256} disabled={pending} onChange={event=>change('title',event.target.value)} placeholder="Zeig uns dein Gaming Setup"/><small>{draft.title.length}/256 Zeichen</small></label>
        <label className="field">Beschreibung<textarea rows={6} value={draft.description} maxLength={4000} disabled={pending} onChange={event=>change('description',event.target.value)} placeholder="Lade deine Community ein, Hardware und Bilder ihres Setups zu teilen."/><small>{draft.description.length}/4.000 Zeichen · Nach deiner Freigabe auf Website und in Discord.</small></label>
        <label className="field">Bildlink (optional)<input type="url" value={draft.imageUrl} maxLength={2048} disabled={pending} onChange={event=>change('imageUrl',event.target.value)} placeholder="https://…/gaming-setup.jpg" aria-invalid={imageInvalid} aria-describedby={imageInvalid?'setup-panel-image-warning':undefined}/><small>Öffentlicher HTTPS-Link zu einem Bild. Das Bild wird in der Einbettung angezeigt.</small></label>
        {imageInvalid&&<p id="setup-panel-image-warning" className="setup-panel-warning" role="alert">Bitte einen öffentlichen HTTPS-Bildlink ohne Zugangsdaten, Sonderport oder Fragment eingeben. Lokale Adressen, IP-Adressen und Videolinks sind nicht erlaubt.</p>}
        <label className="field">Buttontext<input value={draft.buttonLabel} maxLength={80} disabled={pending} onChange={event=>change('buttonLabel',event.target.value)} placeholder="Mein Setup einreichen"/><small>{draft.buttonLabel.length}/80 Zeichen</small></label>
        <div className="setup-panel-destination"><ExternalLink size={17} aria-hidden="true"/><div><strong>Buttonziel ist fest verbunden</strong><span>crazybatto.de/eure-gaming-setups.html#mein-setup</span><button className="text-btn" onClick={()=>open(SUBMIT_URL)}>Einreichung öffnen <ArrowUpRight size={13} aria-hidden="true"/></button></div></div>
      </div><aside className="setup-panel-preview-column"><div className="setup-panel-preview-heading"><span>Live-Vorschau</span><small>{dirty?'Entwurf':'Gespeicherter Stand'}</small></div><PanelPreview settings={draft} botName={state?.bot?.username||'Crazy_Batto'}/><div className="setup-panel-publication"><strong>Discord-Veröffentlichung</strong>{data.publication?<><p><Hash size={14} aria-hidden="true"/>{channels.find(item=>item.id===data.publication.channelId)?.name||data.publication.channelId}</p><small>Bestätigt: {date(data.publication.updatedAt||data.publication.publishedAt)}</small>{data.publication.url&&<button className="text-btn" onClick={()=>open(data.publication.url)}>Nachricht in Discord öffnen <ArrowUpRight size={13} aria-hidden="true"/></button>}</>:<p>Noch keine bestätigte Discord-Nachricht.</p>}{alreadyPublished&&!dirty&&<div className="setup-panel-confirmed"><CheckCircle2 size={15} aria-hidden="true"/>Gespeicherter Stand veröffentlicht</div>}{data.publication&&!alreadyPublished&&<small>Der gespeicherte Entwurf unterscheidet sich vom bestätigten Discord-Stand.</small>}</div>
      {sending&&<div className="notice setup-panel-notice"><Info size={17} aria-hidden="true"/><span>Die Veröffentlichung läuft. Lade den Stand neu, bevor du erneut veröffentlichst.</span></div>}
      {data.publishAttempt?.status==='uncertain'&&<div className="notice setup-panel-notice"><Info size={17} aria-hidden="true"/><span>{uncertainBlocked?'Ein Versand wurde nicht eindeutig bestätigt. Eine neue Nachricht ist gesperrt, damit kein doppelter Beitrag entsteht. Prüfe den bisherigen Kanal.':'Die letzte Änderung wurde nicht eindeutig bestätigt. Du kannst denselben gespeicherten Stand an der bekannten Nachricht erneut anwenden.'}</span></div>}
      {data.publishAttempt?.status==='failed'&&<p className="setup-panel-warning">Letzter Versuch fehlgeschlagen: {data.publishAttempt.error||'Discord hat keine Veröffentlichung bestätigt.'}</p>}
      </aside></div>
      <div className="setup-panel-footer"><div><strong>{dirty?'Nicht gespeicherte Änderungen':'Entwurf gespeichert'}</strong><small>{needsReload?'Bitte zuerst den Serverstand neu laden.':dirty?'Speichere zuerst. Danach kannst du die Einbettung veröffentlichen.':`Version ${data.revision} · Veröffentlichen benötigt eine separate Bestätigung.`}</small></div><div className="setup-panel-footer-actions"><button className="btn" disabled={pending||needsReload||!dirty||!channel||fieldInvalid} onClick={()=>decide('save')}><Save size={16} aria-hidden="true"/>Entwurf speichern</button><button className="btn btn-primary" disabled={pending||needsReload||dirty||!channel||fieldInvalid||uncertainBlocked||sending||alreadyPublished} onClick={()=>decide('publish')}><Send size={16} aria-hidden="true"/>{alreadyPublished&&!dirty?'Veröffentlicht':'In Discord veröffentlichen'}</button></div></div>
    </>}
    {decision&&<PanelConfirmation decision={decision} busy={busy} onCancel={()=>setDecision(null)} onConfirm={confirm} botName={state?.bot?.username||'Crazy_Batto'}/>}
  </section>;
}
