import React,{useEffect,useRef} from 'react';
import {X,Info} from 'lucide-react';
import './integrations.css';

export function useIntegrationGuard(scope){
  const ref=useRef({scope,epoch:0,alive:false});
  if(ref.current.scope!==scope){ref.current.scope=scope;ref.current.epoch++;}
  useEffect(()=>{ref.current.alive=true;return()=>{ref.current.alive=false;ref.current.epoch++;};},[scope]);
  return ()=>{const epoch=ref.current.epoch;return ()=>ref.current.alive&&ref.current.epoch===epoch&&ref.current.scope===scope;};
}

export function IntegrationConfirm({title,children,busy,onClose,onConfirm,label='Jetzt übernehmen'}){
  const box=useRef(null),cancel=useRef(null);
  useEffect(()=>{const previous=document.activeElement;cancel.current?.focus();return()=>previous?.focus?.();},[]);
  const keys=event=>{if(event.key==='Escape'&&!busy)onClose();if(event.key==='Tab'){const items=box.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]');if(!items?.length)return;const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}};
  return <div className="modal-backdrop"><section ref={box} className="modal panel integration-confirm" role="dialog" aria-modal="true" aria-labelledby="integration-confirm-title" onKeyDown={keys}><button className="icon-btn modal-close" aria-label="Dialog schließen" disabled={busy} onClick={onClose}><X aria-hidden="true"/></button><span className="admin-overline">VOR DEM ÜBERNEHMEN</span><h2 id="integration-confirm-title">{title}</h2><div className="integration-confirm-body">{children}</div><div className="dialog-actions"><button ref={cancel} className="btn" disabled={busy} onClick={onClose}>Abbrechen</button><button className="btn btn-primary" disabled={busy} onClick={onConfirm}>{busy?'Wird verarbeitet …':label}</button></div></section></div>;
}
export function IntegrationError({error,stale=false}){return error?<div className="admin-error integration-error" role="alert"><Info size={18} aria-hidden="true"/><div>{error}{stale&&<small>Die angezeigten Daten stammen vom letzten erfolgreichen Abruf.</small>}</div></div>:null;}
export function IntegrationEmpty({title,children}){return <div className="integration-empty"><h3>{title}</h3><p>{children}</p></div>;}
