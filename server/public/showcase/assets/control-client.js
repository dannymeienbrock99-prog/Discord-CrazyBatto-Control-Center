let session=null,generation=0;
export const $=selector=>document.querySelector(selector);
export const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
export function notify(message,error=false){const node=$('#notice');node.hidden=!message;node.textContent=message||'';node.classList.toggle('error',error);}
export async function api(url,{method='GET',body,headers={},raw=false,anonymous=false}={}){
  const captured=generation,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try{
    if(!['GET','HEAD'].includes(method)&&!anonymous){if(!session?.csrfToken)throw Error('Bitte erneut anmelden.');headers={...headers,'X-CSRF-Token':session.csrfToken};}
    if(body!==undefined&&!raw)headers={...headers,'Content-Type':'application/json'};
    const response=await fetch(url,{method,headers,credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});
    let data;try{data=await response.json();}catch{throw Error('Die Serverantwort konnte nicht gelesen werden.');}
    if(captured!==generation)throw Error('Die Anmeldung hat sich geändert. Bitte neu laden.');
    if(!response.ok||data?.ok===false||data?.error)throw Object.assign(Error(data?.message||data?.error?.message||(typeof data?.error==='string'?data.error:'Die Anfrage konnte nicht abgeschlossen werden.')),{status:response.status,kind:data?.kind});
    return data;
  }catch(error){if(error.name==='AbortError')throw Error('Keine eindeutige Serverbestätigung. Bitte vor einem erneuten Versuch deine Anfragen aktualisieren.');throw error;}finally{clearTimeout(timer);}
}
export async function loadSession(admin=false){
  const old=session?.user?.id;const next=await api(admin?'/api/control-mobile/session':'/api/account/session');
  if(old&&old!==next.user?.id){generation++;document.dispatchEvent(new Event('control-account-change'));}
  session=next;return next;
}
export function currentSession(){return session;}
export function clearSession(){generation++;session=null;document.dispatchEvent(new Event('control-account-change'));}
export async function login(form,admin=false){const data=new FormData(form);await api('/api/account/login',{method:'POST',anonymous:true,body:{email:data.get('email'),password:data.get('password')}});form.reset();return loadSession(admin);}
export function cents(value){if(typeof value!=='string'||!/^\d{1,6}(?:[.,]\d{1,2})?$/.test(value.trim()))throw Error('Bitte einen Betrag mit höchstens zwei Nachkommastellen eingeben.');const [whole,fraction='']=value.trim().replace(',','.').split('.');const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(amount<1000||amount>10000000)throw Error('Der Preisvorschlag muss mindestens 10 € und höchstens 100.000 € betragen.');return amount;}
export const money=value=>Number.isSafeInteger(value)?new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(value/100):'–';
export const date=value=>value?new Date(value).toLocaleString('de-DE'):'–';
export const statuses={submitted:'Eingegangen',pending_review:'Wartet auf finale Freigabe',counter_offer:'Neuer Preisvorschlag',approved:'Bestätigt',rejected:'Abgelehnt',closed:'Abgeschlossen',pending:'Wartet auf Freigabe'};
export function button(text,run,secondary=false){const node=el('button',text,secondary?'secondary':'');node.type='button';node.addEventListener('click',async()=>{node.disabled=true;try{await run();}catch(error){notify(error.message,true);}finally{node.disabled=false;}});return node;}
addEventListener('storage',event=>{if(event.key==='cb-account-change')clearSession();});
