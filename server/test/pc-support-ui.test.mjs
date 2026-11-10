import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.listeners={};this.value='';this.disabled=false;this.hidden=false;this.files=[];this.attributes={};}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(name,handler){this.listeners[name]=handler;}
  setAttribute(name,value){this.attributes[name]=value;}
}
const children=node=>node.children.flatMap(child=>[child,...children(child)]);
const defer=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const photoId='gallery_'+'a'.repeat(64);
const record=(requestId='other',subject='Mein PC')=>({id:'ticket-1',requestId,subject,revision:2,status:'submitted',category:'hardware',symptoms:'Startet ohne Bild',createdAt:1,images:[],order:{requested:false,offerCents:null,proposedCents:null}});
function fixture(transport){
  const elements=new Map(),$=key=>{if(!elements.has(key))elements.set(key,new Element(key));return elements.get(key);};
  const fields=['category','subject','symptoms','cpu','gpu','mainboard','ram','os','psu','drivers','price','contactEmail','phone','consent'];
  const defaults={category:'hardware',subject:'Mein PC startet nicht',symptoms:'Seit gestern kein Bild',cpu:'CPU',gpu:'GPU',mainboard:'Board',ram:'32 GB',os:'Windows',psu:'600 W',drivers:'unknown',price:'10',contactEmail:'me@example.invalid',phone:'',consent:'on'};
  const form=$('#ticket-form'),controls=fields.map(name=>Object.assign(new Element('input'),{name,value:defaults[name]}));
  for(const control of controls)controls[control.name]=control;
  controls.push($('#photos'),$('#request-order'),$('#submit-ticket'));form.elements=controls;
  form.reset=()=>{for(const name of fields)controls[name].value=defaults[name];};
  let session={user:{id:'user-a',name:'A'}},uuid=0;
  const notices=[],requests=[],events={},revoked=[];
  const el=(tag,text,className)=>Object.assign(new Element(tag,text),{className}),button=(text,run)=>Object.assign(el('button',text),{run});
  const context={
    $,el,button,currentSession:()=>session,loadSession:async()=>session,login:async()=>{},
    crypto:{randomUUID:()=>`request-${++uuid}`},URL:{createObjectURL:()=>`blob:${uuid}`,revokeObjectURL:url=>revoked.push(url)},
    FormData:class {constructor(node){this.data=Object.fromEntries([...node.elements].filter(item=>item.name).map(item=>[item.name,item.value]));}get(name){return this.data[name]??null;}},
    document:{addEventListener:(name,handler)=>{events[name]=handler;}},
    notify:(message,error=false)=>notices.push({message,error}),cents:value=>Math.round(Number(value)*100),money:String,date:String,statuses:{},confirm:()=>true,
    api:(url,options)=>{requests.push({url,options});return transport(url,options);},
  };
  const source=fs.readFileSync(new URL('../public/showcase/assets/pc-support.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void showAccount\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.handlers={submit,recover,refresh,privateReset,showAccount,state:()=>({ordered,files:[...files],uploaded:[...uploaded],requestId,busy,pending})};',context);
  return {...context.handlers,$,form,notices,requests,revoked,context,
    submit:()=>context.handlers.submit({preventDefault(){}}),
    changeAccount(id){session={user:{id,name:id}};events['control-account-change']();},
    selectPhoto(){const input=$('#photos');input.files=[{name:'PC.png',type:'image/png',size:10}];input.listeners.change();},
    all:()=>children($('#my-tickets')),
  };
}

test('lost creation response freezes form and retries the exact request including images and price',async()=>{
  let attempts=0;
  const f=fixture(async(url,options)=>{
    if(url.endsWith('/images'))return {image:{id:photoId}};
    if(options?.method==='POST'){if(++attempts===1)throw Error('Verbindung abgebrochen');return {ticket:record(options.body.requestId)};}
    return {tickets:[]};
  });
  f.$('#request-order').listeners.click();f.selectPhoto();await f.submit();
  const first=f.requests.find(request=>request.options?.body?.requestId).options.body;
  assert.equal(f.state().pending.uncertain,true);assert.ok([...f.form.elements].every(control=>control.disabled));
  assert.equal(f.$('#retry-ticket').disabled,false);assert.equal(f.$('#check-ticket').disabled,false);
  f.form.elements.subject.value='Unbestätigte Änderung';f.form.elements.price.value='999';
  await f.recover(true);
  const sent=f.requests.filter(request=>request.options?.body?.requestId).map(request=>request.options.body);
  assert.equal(sent.length,2);assert.equal(JSON.stringify(sent[1]),JSON.stringify(first));assert.equal(sent[1].imageIds[0],photoId);assert.equal(sent[1].order.offerCents,1000);
  assert.equal(f.requests.filter(request=>request.url.endsWith('/images')).length,1);
  assert.equal(f.state().pending,null);assert.equal(f.state().ordered,false);assert.ok([...f.form.elements].every(control=>!control.disabled));
});

test('own-ticket status reconciles a lost response without creating a second request',async()=>{
  let saved;
  const f=fixture(async(url,options)=>{if(options?.method==='POST'){saved=record(options.body.requestId);throw Error('Zeitüberschreitung');}return {tickets:[saved]};});
  await f.submit();const id=f.state().requestId;await f.recover(true);
  assert.equal(f.requests.filter(request=>request.options?.method==='POST').length,1);
  assert.equal(f.state().pending,null);assert.notEqual(f.state().requestId,id);assert.equal(f.all().find(node=>node.tag==='h3').textContent,'Mein PC');
});

test('definitive first validation errors allow correction while ambiguous conflicts retain the snapshot',async()=>{
  let kind='validation';
  const f=fixture(async(url,options)=>{if(options)throw Object.assign(Error('Prüfen'),{status:kind==='validation'?400:409,kind});return {tickets:[]};});
  await f.submit();assert.equal(f.state().pending,null);assert.equal(f.form.elements.subject.disabled,false);
  kind='conflict';f.form.elements.subject.value='Korrigiert';await f.submit();assert.ok(f.state().pending);assert.equal(f.form.elements.subject.disabled,true);
  const saved=f.state().pending.json;kind='validation';await f.recover(true);assert.equal(f.state().pending.json,saved);assert.equal(f.form.elements.subject.disabled,true);
});

test('account changes reset paid mode, images, request ID and suppress an old upload completion',async()=>{
  const upload=defer();const f=fixture(()=>upload.promise);f.$('#request-order').listeners.click();f.selectPhoto();const id=f.state().requestId;
  const sending=f.submit();f.changeAccount('user-b');upload.resolve({image:{id:photoId}});await sending;
  assert.equal(f.requests.length,1);assert.equal(f.state().pending,null);assert.equal(f.state().ordered,false);assert.notEqual(f.state().requestId,id);
  assert.equal(f.state().files.length,0);assert.equal(f.state().uploaded.length,0);assert.equal(f.revoked.length,1);assert.equal(f.state().busy,false);
  assert.equal(f.$('#order-fields').hidden,true);assert.equal(f.$('#request-order').attributes['aria-expanded'],'false');assert.equal(f.form.elements.price.required,false);
});

test('old creation acknowledgement cannot overwrite a new account draft or expose tickets',async()=>{
  const response=defer();const f=fixture(()=>response.promise);const pending=f.submit();const old=f.state().requestId;
  f.changeAccount('user-b');f.form.elements.subject.value='Privater neuer Entwurf';response.resolve({ticket:record(old)});await pending;
  assert.equal(f.form.elements.subject.value,'Privater neuer Entwurf');assert.equal(f.all().length,0);assert.equal(f.requests.length,1);
  assert.ok(!f.notices.some(item=>item.message.includes('ist eingegangen')));
});

test('lists ignore old reads, old failures and replies after logout',async()=>{
  const first=defer(),second=defer(),third=defer();let count=0;const f=fixture(()=>[first,second,third][count++].promise);
  const a=f.refresh(),b=f.refresh();second.resolve({tickets:[record('b','Aktuell')]});await b;first.reject(Error('Alter Fehler'));await a;
  assert.equal(f.all().find(node=>node.tag==='h3').textContent,'Aktuell');
  const c=f.refresh();f.changeAccount(null);third.resolve({tickets:[record('c','Private Daten')]});await c;assert.equal(f.all().length,0);
});

test('counteroffer actions are tied to their account and rendered list revision',async()=>{
  const offer={...record(),status:'counter_offer',order:{requested:true,offerCents:1000,proposedCents:2400}};let posts=0;
  const f=fixture(async(url,options)=>{if(options)posts++;return {tickets:[offer]};});
  await f.refresh();const old=f.all().find(node=>node.textContent==='Preis zustimmen');await f.refresh();await old.run();assert.equal(posts,0);
  const fresh=f.all().find(node=>node.textContent==='Preis zustimmen');f.context.confirm=()=>{f.changeAccount('user-b');return true;};await fresh.run();assert.equal(posts,0);
});

test('counteroffer captures the exact reviewed price and suppresses results after account change',async()=>{
  const reply=defer(),offer={...record(),status:'counter_offer',order:{requested:true,offerCents:1000,proposedCents:2400}};
  const f=fixture(async(url,options)=>options?reply.promise:{tickets:[offer]});await f.refresh();
  f.context.confirm=()=>{offer.order.proposedCents=9900;return true;};const action=f.all().find(node=>node.textContent==='Preis zustimmen').run();
  assert.equal(f.requests.at(-1).options.body.offerCents,2400);assert.equal(f.requests.at(-1).options.body.expectedRevision,2);
  f.changeAccount('user-b');reply.reject(Error('Private alte Antwort'));await action;
  assert.equal(f.all().length,0);assert.ok(!f.notices.some(item=>item.message.includes('Private alte Antwort')));
});

test('ticket images use only the own private image endpoint',async()=>{
  const ticket=record();ticket.images=[
    {url:'/api/account/pc-support/images/'+photoId,name:'Eigenes Bild'},
    {url:'https://outside.invalid/private.png',name:'Fremd'},
    {url:'/api/admin/pc-support/images/'+photoId,name:'Admin'},
    {url:'/api/account/pc-support/images/'+photoId+'?redirect=outside',name:'Query'},
  ];const f=fixture(async()=>({tickets:[ticket]}));await f.refresh();
  const images=f.all().filter(node=>node.tag==='img');assert.equal(images.length,1);assert.equal(images[0].src,ticket.images[0].url);assert.equal(images[0].loading,'lazy');
});

test('recovery controls are outside the disabled form and private drafts are not persisted',()=>{
  const html=fs.readFileSync(new URL('../public/showcase/pc-hilfe.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="submission-recovery"')>html.indexOf('</form>',html.indexOf('id="ticket-form"')));
  const script=fs.readFileSync(new URL('../public/showcase/assets/pc-support.js',import.meta.url),'utf8');assert.doesNotMatch(script,/localStorage|sessionStorage/);
});
