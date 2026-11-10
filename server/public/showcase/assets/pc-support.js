import {$,el,api,notify,loadSession,login,currentSession,cents,money,date,statuses,button} from './control-client.js';
let ordered=false,files=[],urls=[],uploaded=[],requestId=crypto.randomUUID(),busy=false,pending=null;
let accountGeneration=0,listGeneration=0,sessionGeneration=0;
const form=$('#ticket-form'),ownRoot='/api/account/pc-support';
const account=()=>({generation:accountGeneration,id:currentSession()?.user?.id});
const current=context=>!!context.id&&context.generation===accountGeneration&&context.id===currentSession()?.user?.id;
function controls(){
  for(const control of form.elements)control.disabled=busy||!!pending;
  $('#submission-recovery').hidden=!pending;
  $('#retry-ticket').disabled=busy;$('#check-ticket').disabled=busy;
}
function orderControls(){
  $('#order-fields').hidden=!ordered;$('#request-order').setAttribute('aria-expanded',String(ordered));
  $('#request-order').textContent=ordered?'Bei normaler Problemmeldung bleiben':'Auftrag anfragen';
  form.elements.price.required=ordered;form.elements.consent.required=ordered;
  $('#submit-ticket').textContent=ordered?'Auftragsanfrage einreichen':'Problemmeldung einreichen';
}
function clearPhotos(){for(const url of urls)URL.revokeObjectURL(url);urls=[];files=[];uploaded=[];$('#chosen-photos').replaceChildren();$('#photos').value='';}
function resetDraft(){form.reset();clearPhotos();ordered=false;requestId=crypto.randomUUID();pending=null;orderControls();controls();}
function privateReset(){
  accountGeneration++;listGeneration++;sessionGeneration++;busy=false;resetDraft();
  $('#my-tickets').replaceChildren();$('#signed-in').textContent='';$('#member-area').hidden=true;$('#login-panel').hidden=false;
  notify('Die Anmeldung hat sich geändert. Bitte erneut anmelden.');
}
async function showAccount(){
  const generation=++sessionGeneration;
  try{
    const session=await loadSession();if(generation!==sessionGeneration||session.user?.id!==currentSession()?.user?.id)return;
    const active=!!session.user;$('#login-panel').hidden=active;$('#member-area').hidden=!active;
    if(active){
      if(session.approval&&session.approval.status!=='approved'&&!session.user.isAdmin){$('#member-area').hidden=true;notify(session.approval.status==='rejected'?'Deine Registrierung wurde nicht freigegeben. '+session.approval.reason:'Deine E-Mail ist bestätigt. Sobald Crazy_Batto dein Konto freigibt, kannst du hier deine PC-Anfrage einreichen.');return;}
      $('#signed-in').textContent=session.user.name;await refresh();
    }
  }catch(error){if(generation!==sessionGeneration)return;$('#member-area').hidden=true;$('#login-panel').hidden=false;notify(error.message,true);}
}
document.addEventListener('control-account-change',privateReset);
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const control=event.currentTarget.querySelector('button');control.disabled=true;
  try{await login(event.currentTarget);notify('');await showAccount();}catch(error){notify(error.message,true);}finally{control.disabled=false;}
});
$('#request-order').addEventListener('click',()=>{if(busy||pending)return;ordered=!ordered;orderControls();});
$('#photos').addEventListener('change',()=>{
  if(busy||pending)return;const chosen=[...$('#photos').files];clearPhotos();
  if(chosen.length>6||chosen.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8388608)){notify('Bitte höchstens 6 JPG-, PNG- oder WebP-Bilder wählen, jeweils maximal 8 MB.',true);return;}
  files=chosen;for(const file of files){const figure=el('figure'),img=el('img');img.alt=file.name;img.src=URL.createObjectURL(file);urls.push(img.src);figure.append(img,el('figcaption',file.name));$('#chosen-photos').append(figure);}
});
function completed(ticket,context){
  if(!current(context)||!pending||ticket.requestId!==pending.payload.requestId)return false;
  resetDraft();notify(`Deine ${ticket.order.requested?'Auftragsanfrage':'Problemmeldung'} ist eingegangen. Du findest den Status unten.`);return true;
}
async function transmit(context){
  const sent=pending;if(!sent||!current(context))return;
  try{
    // Never rebuild a dispatched request from the editable form, including its image IDs.
    const result=await api(ownRoot,{method:'POST',body:JSON.parse(sent.json)});
    if(!current(context)||pending!==sent)return;
    if(!result.ticket||result.ticket.requestId!==sent.payload.requestId)throw Error('Die Bestätigung passt nicht zur gesendeten Anfrage.');
    completed(result.ticket,context);await refresh();
  }catch(error){
    if(!current(context)||pending!==sent)return;
    const definitive=!sent.uncertain&&error.status>=400&&error.status<500&&![408,409,425].includes(error.status);
    const capacity=!sent.uncertain&&error.status===409&&error.kind==='capacity';
    if(definitive||capacity){pending=null;controls();notify(error.message,true);return;}
    sent.uncertain=true;
    notify('Die Speicherung ist noch nicht eindeutig bestätigt. Deine gesendeten Angaben bleiben unverändert. Prüfe den Status oder wiederhole genau dieselbe Anfrage. '+error.message,true);
  }
}
async function submit(event){
  event.preventDefault();if(busy||pending)return;const context=account();if(!current(context)){notify('Bitte zuerst anmelden.',true);return;}notify('');
  try{
    const data=new FormData(form),contact={email:String(data.get('contactEmail')||'').trim(),phone:String(data.get('phone')||'').trim()};
    if(ordered&&!contact.email&&!contact.phone)throw Error('Für einen Auftrag benötige ich eine E-Mail-Adresse oder Handynummer.');
    const draft={requestId,category:data.get('category'),subject:data.get('subject'),symptoms:data.get('symptoms'),specs:Object.fromEntries(['cpu','gpu','mainboard','ram','os','psu'].map(key=>[key,String(data.get(key)||'').trim()])),drivers:data.get('drivers'),imageIds:[],order:{requested:ordered,offerCents:ordered?cents(String(data.get('price'))):null,contact:ordered?contact:{email:'',phone:''},consent:ordered&&data.get('consent')==='on'}};
    busy=true;controls();const chosen=[...files];
    for(let index=uploaded.length;index<chosen.length;index++){
      notify(`Bild ${index+1} von ${chosen.length} wird hochgeladen …`);
      const result=await api(ownRoot+'/images',{method:'POST',raw:true,body:chosen[index],headers:{'Content-Type':chosen[index].type,'X-File-Name':encodeURIComponent(chosen[index].name)}});
      if(!current(context))return;uploaded.push(result.image.id);
    }
    draft.imageIds=[...uploaded];const json=JSON.stringify(draft);pending={json,payload:JSON.parse(json),uncertain:false};controls();await transmit(context);
  }catch(error){if(current(context))notify(error.message,true);}finally{if(current(context)){busy=false;controls();}}
}
form.addEventListener('submit',submit);
async function recover(retry){
  if(busy||!pending)return;const context=account(),sent=pending;if(!current(context))return;busy=true;controls();
  try{
    const tickets=await refresh();if(!current(context)||pending!==sent)return;
    if(!tickets)return;
    if(retry)await transmit(context);
    else notify('In deinen neuesten Anfragen ist noch keine Bestätigung gefunden. Du kannst dieselbe Anfrage unverändert erneut senden. Die bisherige Kennung bleibt erhalten.');
  }catch(error){if(current(context)&&pending===sent)notify('Status konnte nicht geprüft werden. Deine gesendeten Angaben bleiben erhalten. '+error.message,true);}
  finally{if(current(context)){busy=false;controls();}}
}
$('#retry-ticket').addEventListener('click',()=>recover(true));
$('#check-ticket').addEventListener('click',()=>recover(false));
function ticketImages(ticket,card){
  const pictures=(ticket.images||[]).filter(image=>typeof image.url==='string'&&/^\/api\/account\/pc-support\/images\/gallery_[a-f0-9]{64}$/.test(image.url)).slice(0,6);
  if(!pictures.length)return;const gallery=el('div',undefined,'image-grid');
  for(const image of pictures){const link=el('a'),img=el('img');link.href=image.url;link.target='_blank';link.rel='noopener noreferrer';img.src=image.url;img.alt=image.name||'Bild zu deiner PC-Anfrage';img.loading='lazy';img.referrerPolicy='no-referrer';link.append(img);gallery.append(link);}
  card.append(gallery);
}
async function respond(ticket,decision,context,generation){
  const valid=()=>current(context)&&generation===listGeneration;
  if(!valid())return;
  const snapshot={expectedRevision:ticket.revision,decision,offerCents:ticket.order.proposedCents,confirm:true};
  if(!confirm(decision==='accept'?`Dem Preis von ${money(snapshot.offerCents)} zustimmen?`:'Diesen Preisvorschlag ablehnen?')||!valid())return;
  try{await api(ownRoot+'/'+ticket.id+'/respond',{method:'POST',body:snapshot});if(valid())await refresh();}
  catch(error){if(valid())notify(error.message,true);}
}
async function refresh(){
  const context=account(),generation=++listGeneration;if(!current(context))return null;
  let tickets;try{({tickets}=await api(ownRoot));}catch(error){if(!current(context)||generation!==listGeneration)return null;throw error;}
  if(!current(context)||generation!==listGeneration)return null;
  if(pending){const saved=tickets.find(ticket=>ticket.requestId===pending.payload.requestId);if(saved)completed(saved,context);}
  const list=$('#my-tickets');list.replaceChildren();
  if(!tickets.length){list.append(el('p','Du hast noch keine PC-Anfrage eingereicht.','empty'));return tickets;}
  for(const ticket of tickets){
    const card=el('article',undefined,'card'),heading=el('div',undefined,'section-heading');
    heading.append(el('h3',ticket.subject),el('span',statuses[ticket.status]||ticket.status,'badge'));
    card.append(heading,el('p',`${ticket.category==='hardware'?'Hardware':'Software'} · ${date(ticket.createdAt)}`,'muted'),el('p',ticket.symptoms));ticketImages(ticket,card);
    if(ticket.adminNote)card.append(el('p','Rückmeldung: '+ticket.adminNote));
    if(ticket.order.requested)card.append(el('p','Dein Preisvorschlag: '+money(ticket.order.offerCents)));
    if(ticket.status==='counter_offer'){
      card.append(el('p','Neuer Preisvorschlag: '+money(ticket.order.proposedCents),'price'),el('p','Nach deiner Zustimmung muss Crazy_Batto den Auftrag noch abschließend bestätigen.','muted'));
      const actions=el('div',undefined,'actions');
      for(const decision of ['accept','decline'])actions.append(button(decision==='accept'?'Preis zustimmen':'Preis ablehnen',()=>respond(ticket,decision,context,generation)));
      card.append(actions);
    }
    list.append(card);
  }
  return tickets;
}
$('#refresh').addEventListener('click',()=>{const context=account();refresh().catch(error=>{if(current(context))notify(error.message,true);});});
void showAccount();
