import {$,el,api,notify,loadSession,login,currentSession,clearSession,cents,money,date,statuses,button} from './control-client.js';
let view=['members','setups','support','robot'].includes(new URL(location.href).searchParams.get('view'))?new URL(location.href).searchParams.get('view'):'members',cursor=null,version=0,registration=null;
let detailVersion=0,cancelConfirmation=null,authVersion=0,logoutBusy=false,pushVersion=0;
const setupNames={draft:'Entwurf',pending:'Wartet auf Freigabe',published:'Veröffentlicht',hidden:'Ausgeblendet',withdrawn:'Vom Mitglied zurückgezogen'};
const setupDelivery={none:'Noch kein Discord-Versand',queued:'Für Discord vorgemerkt',sending:'Wird an Discord gesendet',sent:'Discord hat bestätigt',failed:'Discord-Versand fehlgeschlagen',uncertain:'Discord-Versand ungeklärt',superseded:'Durch neueren Stand ersetzt'};
const setupSpecs={cpu:'Prozessor',gpu:'Grafikkarte',ram:'Arbeitsspeicher',storage:'Speicher',mainboard:'Mainboard',cooling:'Kühlung',case:'Gehäuse',monitor:'Monitor',peripherals:'Zubehör'};
async function setupAction(action,payload={}){const response=await api('/api/admin/discord-control/action',{method:'POST',body:{action,payload}});return response.result;}
function setupState(value){if(!value||!Array.isArray(value.entries)||!value.settings||typeof value.settings.enabled!=='boolean')throw Error('Die Setup-Daten konnten nicht vollständig geladen werden. Bitte aktualisieren.');return value;}
function invalidateDetail(){detailVersion++;cancelConfirmation?.();$('#detail').replaceChildren();$('#detail').hidden=true;}
function ask(title,text){cancelConfirmation?.();return new Promise(resolve=>{const modal=$('#confirm-dialog');$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;const done=value=>{modal.close();$('#confirm-yes').onclick=null;$('#confirm-cancel').onclick=null;modal.oncancel=null;cancelConfirmation=null;resolve(value);};cancelConfirmation=()=>done(false);$('#confirm-yes').onclick=()=>done(true);$('#confirm-cancel').onclick=()=>done(false);modal.oncancel=event=>{event.preventDefault();done(false);};modal.showModal();});}
function privateReset(){version++;authVersion++;invalidateDetail();$('#admin-area').hidden=true;$('#login-panel').hidden=false;$('#logout').hidden=true;$('#records').replaceChildren();}
document.addEventListener('control-account-change',privateReset);
async function start(){const current=++authVersion;try{const state=await loadSession(true);if(current!==authVersion||logoutBusy)return;$('#greeting').textContent='WILLKOMMEN, '+state.user.name.toUpperCase();$('#admin-area').hidden=false;$('#login-panel').hidden=true;$('#logout').hidden=false;await Promise.allSettled([load().catch(error=>notify(error.message,true)),pushStatus()]);}catch(error){if(current!==authVersion||logoutBusy)return;privateReset();if(error.status!==401)notify(error.message,true);}}
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();if(logoutBusy)return;const control=event.currentTarget.querySelector('button');control.disabled=true;try{await login(event.currentTarget,true);if(logoutBusy)return;notify('');await start();}catch(error){if(!logoutBusy)notify(error.message,true);}finally{control.disabled=logoutBusy;}});
async function logout(){
  if(logoutBusy)return;logoutBusy=true;
  // Hide private content immediately, but retain the CSRF token for server logout.
  privateReset();const cleanupVersion=authVersion;for(const control of $('#login-form').elements)control.disabled=true;
  const pushCleanup=(async()=>{
    try{const sub=await registration?.pushManager.getSubscription();if(sub&&cleanupVersion===authVersion)await Promise.allSettled([
      api('/api/control-mobile/push',{method:'DELETE',body:{endpoint:sub.endpoint}}),
      Promise.resolve().then(()=>sub.unsubscribe()),
    ]);}catch{} // Browser push cleanup must never prevent account logout.
  })();
  let error;
  try{await api('/api/account/logout',{method:'POST',body:{}});}catch(failure){error=failure;}
  finally{clearSession();logoutBusy=false;for(const control of $('#login-form').elements)control.disabled=false;}
  if(error)notify('Die private Ansicht wurde geschlossen. Die Abmeldung auf dem Server konnte nicht bestätigt werden. Bitte bei wiederhergestellter Verbindung erneut anmelden und abmelden.',true);
  else notify('Abgemeldet.');
  // Cleanup handles its own errors and may finish after the account has closed.
  void pushCleanup;
}
$('#logout').addEventListener('click',logout);
for(const tab of document.querySelectorAll('[data-view]'))tab.addEventListener('click',()=>{view=tab.dataset.view;$('#search').value='';invalidateDetail();history.replaceState(null,'','?view='+view);void load().catch(error=>notify(error.message,true));});
function keyValue(parent,values){const dl=el('dl',undefined,'detail-grid');for(const [key,value] of values){dl.append(el('dt',key),el('dd',value==null?'–':String(value)));}parent.append(dl);}
function finishDetail(){const box=$('#detail');box.hidden=false;box.scrollIntoView({behavior:'smooth',block:'start'});}
async function load(more=false){
  const current=++version,section=view;if(!more){cursor=null;$('#records').replaceChildren();}for(const tab of document.querySelectorAll('[data-view]'))tab.setAttribute('aria-selected',String(tab.dataset.view===section));$('#setup-filter-label').hidden=section!=='setups';
  const search=$('#search').value.trim();let result;
  if(section==='setups'){
    result=setupState(await setupAction('setup.state'));if(current!==version)return;$('#more').hidden=true;const filter=$('#setup-filter').value||'pending',term=search.toLocaleLowerCase('de-DE');
    const rows=result.entries.filter(item=>(filter==='all'||(filter==='problem'?['failed','uncertain'].includes(item.discordStatus):item.status===filter))&&(!term||[item.authorName,item.title,item.description].some(value=>String(value||'').toLocaleLowerCase('de-DE').includes(term))));
    $('#summary').textContent=`${result.entries.filter(item=>item.status==='pending').length} warten auf Freigabe · ${rows.length} angezeigt · bis zu 200 aktuelle Setups`;
    if(!rows.length)$('#records').append(el('p',filter==='pending'&&!search?'Aktuell wartet kein Gaming Setup auf deine Freigabe. Unter „Alle“ siehst du auch veröffentlichte und ausgeblendete Beiträge.':'Keine Setups für diese Auswahl gefunden.','empty'));
    for(const item of rows){const row=button('',()=>setupDetail(item.id),true);row.className='list-item';row.append(el('strong',item.title),el('small',`${item.authorName} · ${setupNames[item.status]||'Unbekannter Stand'}`),el('small',setupDelivery[item.discordStatus]||'Discord-Status unbekannt'));$('#records').append(row);}return;
  }
  if(section==='members')result=await api('/api/admin/control-members/query',{method:'POST',body:{limit:100,cursor,status:'all',search}});
  else if(section==='support')result=await api('/api/admin/pc-support/query',{method:'POST',body:{limit:50,cursor,status:'all',kind:'all',search}});
  else {const query=new URLSearchParams({state:'active'});if(search)query.set('q',search);if(cursor)query.set('cursor',cursor);result=await api('/api/admin/robot/orders?'+query);}
  if(current!==version)return;cursor=result.nextCursor||null;$('#more').hidden=!cursor;const rows=result.members||result.tickets||result.orders||[];
  $('#summary').textContent=view==='members'?`${result.counts?.total??rows.length} Mitglieder · ${result.counts?.pending??0} warten auf Freigabe`:view==='robot'?'Synchronisierte Einträge aus deiner Robot-App':`${result.counts?.total??rows.length} PC-Anfragen`;
  if(!rows.length&&!more)$('#records').append(el('p',view==='robot'?'Noch keine synchronisierten Einträge. In der Robot-App die Auftragssynchronisierung starten und das Gerät im PC-Control-Center freigeben.':'Keine Einträge gefunden.','empty'));
  for(const item of rows){const row=button('',()=>section==='members'?memberDetail(item):section==='support'?supportDetail(item.id):robotDetail(item.id),true);row.className='list-item';row.append(el('strong',section==='members'?item.name:section==='support'?item.subject:'Auftrag '+item.orderNumber));row.append(el('small',section==='members'?`${item.email} · ${statuses[item.approval.status]||item.approval.status}${item.confirmed?'':' · E-Mail noch unbestätigt'}`:section==='support'?`${item.author.name} · ${statuses[item.status]||item.status}${item.order.requested?' · '+money(item.order.acceptedCents):''}`:`Robot ${item.robot} · ${item.articleNumber||'Ohne Artikel'} · ${date(item.timestamp)}`));$('#records').append(row);}
}
async function setupDetail(id){
  invalidateDetail();const current=detailVersion,state=setupState(await setupAction('setup.state'));if(current!==detailVersion)return;
  const item=state.entries.find(entry=>entry.id===id);if(!item)throw Error('Dieses Setup ist nicht mehr in der aktuellen Liste. Bitte aktualisieren.');
  const box=$('#detail');box.replaceChildren(el('div','GAMING SETUPS · EINREICHUNG PRÜFEN','eyebrow'),el('h2',item.title),el('span',setupNames[item.status]||'Unbekannter Stand','badge'),el('p',item.description||'Keine Beschreibung angegeben.','preserve'));
  keyValue(box,[['Mitglied',item.authorName],['Aktualisiert',date(item.updatedAt)],['Discord',setupDelivery[item.discordStatus]||'Unbekannt'],...Object.entries(setupSpecs).filter(([key])=>item.specs?.[key]).map(([key,label])=>[label,item.specs[key]])]);
  if(item.discordError)box.append(el('p',item.discordError,'preserve'));
  if(item.hasNewerDraft)box.append(el('p','Das Mitglied hat zusätzlich einen neueren Entwurf. Du prüfst hier ausschließlich den bereits zur Veröffentlichung eingereichten Stand.','muted'));
  if(item.contentKind==='draft')box.append(el('p','Dieser Entwurf wurde noch nicht zur Veröffentlichung eingereicht.','muted'));
  const images=el('div',undefined,'image-grid');for(const [index,image] of (item.images||[]).entries()){
    const figure=el('figure'),preview=el('div','Vorschau noch nicht geladen','empty'),caption=el('figcaption',image.name||`Setup-Bild ${index+1}`);
    const control=button(`Bild ${index+1} ansehen`,async()=>{const data=await setupAction('setup.image',{id:item.id,imageId:image.id});if(current!==detailVersion)return;
      if(typeof data?.dataUrl!=='string'||!/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(data.dataUrl))throw Error('Die Bildvorschau konnte nicht bestätigt werden.');
      const img=el('img');img.alt=`Setup von ${item.authorName}: Bild ${index+1}`;img.addEventListener('error',()=>{if(current===detailVersion)notify('Ein Setup-Bild konnte nicht angezeigt werden. Bitte erneut laden.',true);});img.src=data.dataUrl;preview.replaceChildren(img);preview.className='';control.textContent='Bild neu laden';
    },true);figure.append(preview,caption,control);images.append(figure);
  }box.append(images);if(!item.images?.length)box.append(el('p','Keine Bilder eingereicht.','muted'));
  const noteLabel=el('label','Interne Begründung · beim Ausblenden erforderlich'),reason=el('textarea');reason.maxLength=1000;reason.value=item.moderationReason||'';noteLabel.append(reason);box.append(noteLabel);
  const actions=el('div',undefined,'actions');const canApprove=typeof item.canApprove==='boolean'?item.canApprove:state.settings.enabled&&item.contentKind==='submitted'&&['pending','hidden'].includes(item.status);
  const canHide=typeof item.canHide==='boolean'?item.canHide:['pending','published'].includes(item.status);
  for(const operation of ['approve','hide']){const title=operation==='approve'?'Setup freigeben':'Ausblenden / ablehnen',action=button(title,async()=>{
    const payload={id:item.id,expectedRevision:item.revision,operation,reason:reason.value.trim(),confirm:true};if(operation==='hide'&&!payload.reason)throw Error('Bitte einen Grund für das Ausblenden angeben.');
    const explanation=operation==='approve'?'Den eingereichten Stand öffentlich auf der Website freigeben und den Discord-Versand vormerken.':'Den Beitrag auf der Website ausblenden und den Setup-Inhalt im Discord-Beitrag entfernen lassen. Das Setup bleibt gespeichert und kann später erneut freigegeben werden.';
    if(!await ask(title+'?',`${item.title} von ${item.authorName}\n${explanation}${payload.reason?'\nInterne Begründung: '+payload.reason:''}`)||current!==detailVersion)return;
    try{setupState(await setupAction('setup.moderate',payload));}catch(error){
      if(current!==detailVersion)return;
      if(error.status===409){await load();if(current===detailVersion)await setupDetail(id);throw Error('Das Setup wurde inzwischen geändert. Der aktuelle Stand ist geladen. Bitte erneut prüfen und deine Entscheidung neu bestätigen.');}throw error;
    }
    if(current!==detailVersion)return;notify(operation==='approve'?'Freigabe gespeichert. Den Discord-Versand siehst du im Setup-Status.':'Setup ausgeblendet. Die Entfernung des Discord-Inhalts wird separat bestätigt.');await load();if(current===detailVersion)await setupDetail(id);
  },operation==='hide');action.disabled=operation==='approve'?!canApprove:!canHide;actions.append(action);}
  box.append(actions,el('p','Eine Freigabe veröffentlicht nur den bewusst eingereichten Stand. Website-Freigabe und Discord-Zustellung werden getrennt angezeigt.','muted'));finishDetail();
}
function memberDetail(member){invalidateDetail();const current=detailVersion;const box=$('#detail');box.replaceChildren(el('div','MITGLIEDERFREIGABE','eyebrow'),el('h2',member.name));keyValue(box,[['E-Mail',member.email],['E-Mail bestätigt',member.confirmed?'Ja':'Noch nicht'],['Registriert',date(member.createdAt)],['Freigabe',statuses[member.approval.status]||member.approval.status],['Begründung',member.approval.reason||'–']]);
  const label=el('label','Deine Rückmeldung / Ablehnungsgrund'),reason=el('textarea');reason.maxLength=1000;label.append(reason);box.append(label);const actions=el('div',undefined,'actions');
  if(!member.isAdmin&&member.id!==currentSession()?.user?.id){for(const decision of ['approve','reject']){const action=button(decision==='approve'?'Mitglied bestätigen':'Ablehnen',async()=>{const body={expectedRevision:member.approval.revision,decision,reason:reason.value,confirm:true};if(!await ask(decision==='approve'?'Mitglied bestätigen?':'Mitglied ablehnen?',`${member.name} (${member.email}) – ${decision==='approve'?'Website-Zugang freigeben.':'Registrierung ablehnen. Grund: '+body.reason}`)||current!==detailVersion)return;const saved=await api('/api/admin/control-members/'+member.id+'/review',{method:'POST',body});if(current!==detailVersion)return;notify('Entscheidung gespeichert.');await load();if(current===detailVersion)memberDetail(saved.member);},decision==='reject');action.disabled=decision==='approve'?(!member.confirmed||member.suspended||member.approval.status==='approved'):member.approval.status!=='pending';actions.append(action);}}
  box.append(actions);finishDetail();
}
async function supportDetail(id){invalidateDetail();const current=detailVersion;const {ticket}=await api('/api/admin/pc-support/'+id);if(current!==detailVersion)return;const box=$('#detail');box.replaceChildren(el('div','PC-HILFE · PRIVATE ANFRAGE','eyebrow'),el('h2',ticket.subject),el('span',statuses[ticket.status]||ticket.status,'badge'),el('p',ticket.symptoms,'preserve'));keyValue(box,[['Mitglied',ticket.author.name],['Bereich',ticket.category==='hardware'?'Hardware':'Software'],...Object.entries(ticket.specs).map(([key,value])=>[({cpu:'CPU / Prozessor',gpu:'GPU / Grafikkarte',mainboard:'Mainboard',ram:'Arbeitsspeicher',os:'Betriebssystem',psu:'Netzteil'})[key]||key,value]),['Treiber',{current:'Aktuell',outdated:'Nicht aktuell',unknown:'Unbekannt'}[ticket.drivers]],['Kontakt-E-Mail',ticket.order.contact.email||'–'],['Handynummer',ticket.order.contact.phone||'–'],['Kundenangebot',money(ticket.order.offerCents)],['Vereinbarter Vorschlag',money(ticket.order.acceptedCents)]]);
  const images=el('div',undefined,'image-grid');for(const image of ticket.images){if(!image.url?.startsWith('/api/account/pc-support/images/'))continue;const img=el('img');img.src=image.url;img.alt=image.name||'PC-Bild';img.loading='lazy';images.append(img);}box.append(images);
  const noteLabel=el('label','Rückmeldung / Begründung'),note=el('textarea');note.maxLength=2000;note.value=ticket.adminNote||'';noteLabel.append(note);box.append(noteLabel);
  let price=null;if(ticket.order.requested){const label=el('label','Betrag in €'),input=el('input');input.type='number';input.min='10';input.max='100000';input.step='.01';input.value=((ticket.order.proposedCents??ticket.order.acceptedCents??ticket.order.offerCents)/100).toFixed(2);label.append(input);box.append(label);price=input;}
  const actions=el('div',undefined,'actions');for(const decision of ['approve',...(ticket.order.requested?['counter_offer']:[]),'reject']){const titles={approve:'Bestätigen',counter_offer:'Anderen Preis vorschlagen',reject:'Ablehnen'};const action=button(titles[decision],async()=>{const amount=decision==='reject'?null:price?cents(price.value):null;if(decision==='approve'&&ticket.order.requested&&amount!==ticket.order.acceptedCents)throw Error('Ein geänderter Preis muss zuerst als neuer Preisvorschlag an das Mitglied gehen.');const body={expectedRevision:ticket.revision,decision,reason:note.value,patch:{},offerCents:amount,confirm:true};if(!await ask(titles[decision]+'?',ticket.subject+(amount!==null?' · '+money(amount):'')+(body.reason?' · '+body.reason:''))||current!==detailVersion)return;await api('/api/admin/pc-support/'+id+'/review',{method:'POST',body});if(current!==detailVersion)return;notify('Entscheidung gespeichert.');await load();if(current===detailVersion)await supportDetail(id);},decision!=='approve');action.disabled=['closed','approved','rejected'].includes(ticket.status)||(decision==='approve'&&!['submitted','pending_review'].includes(ticket.status));actions.append(action);}box.append(actions);finishDetail();
}
async function robotDetail(id){invalidateDetail();const current=detailVersion;const result=await api('/api/admin/robot/orders/'+id),item=result.order;if(current!==detailVersion)return;const box=$('#detail');box.replaceChildren(el('div','ROBOT SCHICHTLOG','eyebrow'),el('h2','Auftrag '+item.orderNumber));keyValue(box,[['Artikel',item.articleNumber],['Robot',item.robot],['Menge',item.quantity],['Schicht',item.shift],['Ereignis',item.eventType],['Zeit',date(item.timestamp)],['Gerät',item.deviceLabel],['Letzte Änderung',date(item.updatedAt)]]);box.append(el('p',item.note,'preserve'),el('p',item.handoverNote,'preserve'),el('p','Bearbeiten, nacharbeiten und wiederherstellbar löschen kannst du diesen Eintrag im PC-Control-Center.','muted'));finishDetail();}
$('#reload').addEventListener('click',()=>{invalidateDetail();void load().catch(error=>notify(error.message,true));});$('#more').addEventListener('click',()=>load(true).catch(error=>notify(error.message,true)));$('#search').addEventListener('keydown',event=>{if(event.key==='Enter'){invalidateDetail();void load().catch(error=>notify(error.message,true));}});
$('#setup-filter').addEventListener('change',()=>{invalidateDetail();void load().catch(error=>notify(error.message,true));});
function activeSetupPushVersion(){
  const active=registration?.active;
  if(!active||active.state!=='activated'||typeof MessageChannel!=='function'||!globalThis.crypto?.randomUUID)return Promise.resolve(0);
  return new Promise(resolve=>{
    const channel=new MessageChannel(),requestId=crypto.randomUUID();let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);channel.port1.close();channel.port2.close();resolve(value);};
    const timer=setTimeout(()=>finish(0),1800);
    channel.port1.onmessage=event=>{const value=event.data;if(value?.type==='control-push-capabilities'&&value.requestId===requestId)finish(value.setupPushVersion===1&&registration?.active===active&&active.state==='activated'?1:0);};
    try{active.postMessage({type:'control-push-capabilities',requestId},[channel.port2]);}catch{finish(0);}
  });
}
async function preparePushRegistration(){
  registration=await navigator.serviceWorker.register('/control-center/service-worker.js',{scope:'/control-center/'});
  await navigator.serviceWorker.ready;
  // Updating is independent of login. controllerchange checks the new active worker.
  try{void registration.update().catch(()=>{});}catch{}
}
async function pushStatus(){
  const generation=++pushVersion,sessionVersion=authVersion,current=()=>generation===pushVersion&&sessionVersion===authVersion&&!logoutBusy&&!!currentSession();
  try{
    $('#test-push').disabled=true;$('#disable-push').disabled=true;
    if(!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window)){ $('#push-state').textContent='Dieser Browser unterstützt keine Push-Mitteilungen. Bitte die Android-App mit aktuellem Chrome öffnen.';return; }
    await preparePushRegistration();if(!current())return;
    const sub=await registration.pushManager.getSubscription();if(!current())return;
    const state=await api('/api/control-mobile/push');if(!current())return;
    const setupPushVersion=await activeSetupPushVersion();if(!current())return;
    const check=sub?await api('/api/control-mobile/push/check',{method:'POST',body:{endpoint:sub.endpoint,setupPushVersion}}):{registered:false};if(!current())return;
    const enabled=!!state.enabled&&!!sub&&Notification.permission==='granted'&&check.registered;
    $('#push-state').textContent=enabled?(check.setupPushVersion===1?'Auf diesem Handy eingeschaltet – auch für Gaming-Setups.':'Mitteilungen sind aktiv. Gaming-Setup-Hinweise warten auf die App-Aktualisierung. Bitte die App erneut öffnen.'):!state.enabled?'Benachrichtigungen sind auf dem Server noch nicht eingerichtet.':Notification.permission==='denied'?'Mitteilungen sind in den Handy-/Browser-Einstellungen gesperrt.':'Noch nicht eingeschaltet';
    $('#test-push').disabled=!enabled;$('#disable-push').disabled=!enabled;$('#enable-push').textContent=enabled?'Verbindung erneuern':'Ton & Mitteilungen einschalten';
  }catch(error){if(current())$('#push-state').textContent=error.message;}
}
if(navigator.serviceWorker?.addEventListener)navigator.serviceWorker.addEventListener('controllerchange',()=>{if(currentSession()&&!logoutBusy)void pushStatus();});
$('#enable-push').addEventListener('click',async()=>{
  const sessionVersion=authVersion,current=()=>sessionVersion===authVersion&&!logoutBusy&&!!currentSession();
  try{
    if(!('Notification'in window)||!('serviceWorker'in navigator))throw Error('Bitte die App mit einem aktuellen Chrome-Browser öffnen.');
    const permission=await Notification.requestPermission();if(!current())return;if(permission!=='granted')throw Error('Bitte Mitteilungen in deinen Handy-Einstellungen erlauben.');
    await preparePushRegistration();if(!current())return;const state=await api('/api/control-mobile/push');if(!current())return;
    if(!state.enabled||!state.publicKey)throw Error('Benachrichtigungen sind auf dem Server noch nicht eingerichtet.');
    const key=Uint8Array.from(atob(state.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
    const sub=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});if(!current())return;
    const setupPushVersion=await activeSetupPushVersion();if(!current())return;
    const registered=await api('/api/control-mobile/push',{method:'POST',body:{subscription:sub.toJSON(),setupPushVersion}});if(!current())return;
    notify(registered.setupPushVersion===1?'Benachrichtigungen eingeschaltet. Über „Testmitteilung senden“ kannst du Ton und Anzeige prüfen.':'Mitteilungen eingeschaltet. Gaming-Setup-Hinweise bleiben vorgemerkt, bis die App-Aktualisierung bestätigt ist.');await pushStatus();
  }catch(error){if(current())notify(error.message,true);}
});
$('#test-push').addEventListener('click',async()=>{try{await api('/api/control-mobile/push/test',{method:'POST',body:{confirm:true}});notify('Testmitteilung wird gesendet.');}catch(error){notify(error.message,true);}});
$('#disable-push').addEventListener('click',async()=>{try{const sub=await registration?.pushManager.getSubscription();if(sub){await api('/api/control-mobile/push',{method:'DELETE',body:{endpoint:sub.endpoint}});await sub.unsubscribe();}await pushStatus();notify('Mitteilungen auf diesem Handy ausgeschaltet.');}catch(error){notify(error.message,true);}});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden||!currentSession()||logoutBusy)return;const sessionVersion=authVersion;
  void loadSession(true).then(()=>{if(sessionVersion===authVersion&&!document.hidden&&currentSession()&&!logoutBusy)void pushStatus();}).catch(()=>{if(sessionVersion===authVersion){clearSession();notify('Bitte erneut anmelden.');}});
});
void start();
