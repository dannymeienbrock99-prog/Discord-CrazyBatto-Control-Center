import React,{useEffect,useRef,useState} from 'react';
import {RefreshCw,ShieldCheck,X} from 'lucide-react';
import {REPORT_ACTIONS,REPORT_STATUS,TIMEOUT_DURATIONS,canModerateReport,reportDecision,reportPayload} from './report-moderation.mjs';
const date=value=>value?new Date(value).toLocaleString('de-DE'):'Nicht angegeben';
const resultLabels={succeeded:'Ausgeführt',success:'Ausgeführt',sent:'Gesendet',failed:'Fehlgeschlagen',uncertain:'Ergebnis unklar',processing:'In Bearbeitung',pending:'In Bearbeitung'};
function DecisionDialog({decision,busy,onCancel,onConfirm}){
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[notifyUser,setNotifyUser]=useState(false),[checkedDiscord,setCheckedDiscord]=useState(false),[durationSeconds,setDurationSeconds]=useState(600),[error,setError]=useState('');
  const dialog=useRef(null),first=useRef(null);
  useEffect(()=>{const previous=document.activeElement;first.current?.focus();return()=>previous?.focus?.();},[]);
  const keyboard=event=>{if(event.key==='Escape'&&!busy)onCancel();if(event.key==='Tab'){const controls=dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)');const a=controls[0],z=controls[controls.length-1];if(event.shiftKey&&document.activeElement===a){event.preventDefault();z?.focus();}else if(!event.shiftKey&&document.activeElement===z){event.preventDefault();a?.focus();}}};
  const confirm=()=>{try{onConfirm(reportPayload(decision,{reason,confirmed,durationSeconds,notifyUser,checkedDiscord}));}catch(failure){setError(failure.message);}};
  return <div className="modal-backdrop"><section className="modal panel community-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="report-decision-title" onKeyDown={keyboard}>
    <button className="icon-btn modal-close" ref={first} disabled={busy} onClick={onCancel} aria-label="Prüfung abbrechen"><X/></button>
    <h2 id="report-decision-title">{REPORT_ACTIONS[decision.operation].label}</h2><p><strong>{decision.targetName}</strong><br/><small>Discord-ID: {decision.targetId}</small></p>
    <p>{REPORT_ACTIONS[decision.operation].effect}</p>
    {decision.status==='uncertain'&&<p className="notice">Prüfe das bisher unklare Ergebnis zuerst in Discord. Der Abschluss löst keine Wiederholung aus.</p>}
    {decision.operation==='timeout'&&<label className="field">Dauer der Sperre<select disabled={busy} value={durationSeconds} onChange={event=>setDurationSeconds(Number(event.target.value))}>{TIMEOUT_DURATIONS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
    <label className="field">{decision.operation==='warn'?'Text der privaten Verwarnung':'Begründung'} · Pflichtfeld<textarea disabled={busy} rows={4} minLength={5} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/><small className="muted">5 bis 500 Zeichen. Wird im Maßnahmenverlauf gespeichert.</small></label>
    {decision.operation==='warn'&&<label className="checkbox-label community-confirm-check"><input type="checkbox" disabled={busy} checked={notifyUser} onChange={event=>setNotifyUser(event.target.checked)}/>Diese Begründung als echte private Nachricht an das Mitglied senden.</label>}
    {decision.status==='uncertain'&&<label className="checkbox-label community-confirm-check"><input type="checkbox" disabled={busy} checked={checkedDiscord} onChange={event=>setCheckedDiscord(event.target.checked)}/>Ich habe das tatsächliche Ergebnis in Discord geprüft.</label>}
    <label className="checkbox-label community-confirm-check"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Ich habe Mitglied, Maßnahme und Begründung geprüft.</label>
    {error&&<p className="admin-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button className="btn" disabled={busy} onClick={onCancel}>Abbrechen</button><button className={`btn ${['kick','ban'].includes(decision.operation)?'community-danger':'btn-primary'}`} disabled={busy||!confirmed||reason.trim().length<5||(decision.operation==='warn'&&!notifyUser)||(decision.status==='uncertain'&&!checkedDiscord)} onClick={confirm}>{busy?'Wird ausgeführt …':`${REPORT_ACTIONS[decision.operation].label} bestätigen`}</button></div>
  </section></div>;
}
export default function ReportCaseList({reports,onReports,perform,busy,notify}){
  const [filter,setFilter]=useState('active'),[query,setQuery]=useState(''),[review,setReview]=useState(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const alive=useRef(true),inFlight=useRef(false),readSequence=useRef(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;readSequence.current++;};},[]);
  const reload=async()=>{const sequence=++readSequence.current;const response=await perform('community.report.list',{});if(alive.current&&sequence===readSequence.current){if(!Array.isArray(response?.reports))throw Error('Der Meldeeingang wurde nicht vollständig geladen.');onReports(response.reports);}};
  const decide=async payload=>{
    if(inFlight.current)return;inFlight.current=true;setWorking(true);setError('');readSequence.current++;
    try{const response=await perform('community.report.moderate',payload);if(alive.current){if(!Array.isArray(response?.reports))throw Error('Die Maßnahme wurde angefragt, aber das Ergebnis ist unvollständig. Bitte den Fall neu laden.');onReports(response.reports);notify(payload.operation==='close'?'Fall abgeschlossen.':'Maßnahme verarbeitet. Prüfe den bestätigten Verlauf des Falls.');}}
    catch(failure){if(alive.current)setError(failure.message||'Die Maßnahme konnte nicht bestätigt werden. Bitte neu laden; sie wird nicht automatisch wiederholt.');}
    finally{inFlight.current=false;if(alive.current){setWorking(false);setReview(null);try{await reload();}catch(failure){if(alive.current)setError(failure.message);}}}
  };
  const disabled=busy||working;
  const visible=reports.filter(report=>(filter==='all'||(filter==='active'?report.status!=='resolved':report.status===filter))&&[report.targetName,report.targetId,report.categoryLabel,report.reason].join(' ').toLocaleLowerCase('de').includes(query.trim().toLocaleLowerCase('de')));
  return <section className="panel admin-pad"><div className="row"><div><h2>Eingegangene Meldungen</h2><p className="muted">Vertraulich prüfen, Maßnahmen durchführen und den Fall bewusst abschließen.</p></div><button className="btn" disabled={disabled} onClick={()=>reload().catch(failure=>setError(failure.message))}><RefreshCw size={15}/>Aktualisieren</button></div>
    {error&&<div className="admin-error" role="alert">{error}</div>}
    <div className="form-grid community-space"><label className="field">Meldungen<select value={filter} onChange={event=>setFilter(event.target.value)}><option value="active">Offen & zu prüfen</option><option value="all">Alle</option><option value="resolved">Abgeschlossen</option><option value="uncertain">Ergebnis unklar</option></select></label><label className="field">Suche<input value={query} maxLength={100} onChange={event=>setQuery(event.target.value)} placeholder="Mitglied, ID, Vorfall oder Grund"/></label></div>
    <div className="community-list">{visible.length?visible.map(report=><article className="community-case" key={report.id}>
      <div className="row"><h3>{report.targetName||report.targetId}</h3><span className="badge neutral">{REPORT_STATUS[report.status]||report.status}</span></div>
      <small className="muted">Discord-ID: {report.targetId} · {date(report.createdAt)}</small>
      <p className="community-report-category"><span>Art des Vorfalls</span><strong>{report.categoryLabel||'Nicht angegeben'}</strong></p>
      <p className="community-reason">{report.reason}</p>{report.details&&<p>{report.details}</p>}<small className="muted">Vertraulich gemeldet von {report.reporterId}</small>
      {report.status==='uncertain'&&<p className="notice">Eine Discord-Antwort fehlt. Prüfe den tatsächlichen Stand in Discord. Diese Aktion wird nicht automatisch wiederholt.</p>}
      {Array.isArray(report.history)&&report.history.length>0?<details className="community-space"><summary>Maßnahmenverlauf · {report.history.length}</summary><ol>{report.history.map((entry,index)=><li key={entry.id||index}><p><strong>{REPORT_ACTIONS[entry.operation]?.label||entry.operation}</strong> · {resultLabels[entry.status]||entry.status||'Protokolliert'}<br/>{entry.reason}<br/><small className="muted">{date(entry.finishedAt||entry.startedAt)}{entry.durationSeconds?` · Dauer: ${entry.durationSeconds/60} Minuten`:''}</small>{entry.message&&<><br/>{entry.message}</>}</p></li>)}</ol></details>:report.reviewReason&&<p>Frühere Teambegründung: {report.reviewReason}</p>}
      <div className="admin-button-row report-actions">{Object.entries(REPORT_ACTIONS).map(([operation,action])=><button key={operation} className={`btn ${operation==='ban'?'community-danger':''}`} disabled={disabled||!canModerateReport(report,operation)} onClick={()=>{try{setReview(reportDecision(report,operation));setError('');}catch(failure){setError(failure.message);}}}>{action.label}</button>)}</div>
    </article>):<div className="empty-state compact"><ShieldCheck size={28}/><p>{reports.length?'Keine Meldung passt zu diesem Filter.':'Keine Meldungen vorhanden.'}</p></div>}</div>
    {review&&<DecisionDialog decision={review} busy={disabled} onCancel={()=>setReview(null)} onConfirm={decide}/>}
  </section>;
}
