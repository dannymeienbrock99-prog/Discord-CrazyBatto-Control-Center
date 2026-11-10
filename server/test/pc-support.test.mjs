import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PCSupport,pcSupportDraft} from '../src/pc-support.mjs';
import {supportFixture,imageRequest,httpCall,IMAGE} from './control-support-fixture.mjs';

const draft=()=>({category:'hardware',subject:'PC startet nicht',symptoms:'Der Bildschirm bleibt beim Einschalten schwarz.',specs:{cpu:'Ryzen 7',gpu:'RTX',mainboard:'Unbekannt',ram:'32 GB',os:'Windows',psu:'750 Watt'},drivers:'unknown',imageIds:[],order:{requested:false,offerCents:null,contact:{email:'',phone:''},consent:false}});
const paid=()=>({...draft(),order:{requested:true,offerCents:1000,contact:{email:'contact@fixture.test',phone:''},consent:true}});
function fixture(t){const f=supportFixture(t),support=new PCSupport(f.service);return{...f,support,create:(input=draft(),user=f.user)=>support.create(user,{requestId:randomUUID(),...input}),review:(ticket,decision,extra={})=>support.review(f.admin,ticket.id,{expectedRevision:ticket.revision,decision,reason:'',patch:{},offerCents:null,confirm:true,...extra})};}

test('all diagnostics are mandatory and uploads/contact/price accept only supported data',()=>{
  assert.equal(pcSupportDraft(draft()).drivers,'unknown');for(const input of [{...draft(),specs:{cpu:'Ryzen'}},{...draft(),symptoms:'kurz'},{...draft(),drivers:''},{...draft(),ownerId:'forged'},{...paid(),order:{...paid().order,offerCents:999}},{...paid(),order:{...paid().order,offerCents:1000.5}},{...paid(),order:{...paid().order,consent:false}},{...paid(),order:{...paid().order,contact:{email:'bad',phone:''}}}])assert.throws(()=>pcSupportDraft(input));
  assert.doesNotThrow(()=>pcSupportDraft({...paid(),order:{...paid().order,contact:{email:'',phone:'+49 123 456789'}}}));
});
test('new private ticket and notice are atomic and request replay never duplicates a submission',async t=>{
  const f=fixture(t),body={requestId:randomUUID(),...paid()};const result=await f.support.create(f.user,body),again=await f.support.create(f.user,body);
  assert.equal(result.ticket.id,again.ticket.id);assert.equal(result.ticket.status,'submitted');assert.equal(result.ticket.order.acceptedCents,1000);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM pc_support_tickets').n,1);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM control_notice_events').n,1);
  await assert.rejects(f.support.create(f.user,{...body,subject:'Anderes Problem'}),{status:409});assert.throws(()=>f.support.detail(f.other,result.ticket.id),{status:404});assert.throws(()=>f.support.query(f.user),{status:403});
  assert(!JSON.stringify(f.store.all('SELECT * FROM account_audit')).includes('contact@fixture.test'));assert(!JSON.stringify(f.store.all('SELECT * FROM control_notice_events')).includes('contact@fixture.test'));
});
test('counter-offer needs customer acceptance then separate final admin approval of exact price',async t=>{
  const f=fixture(t);let ticket=(await f.create(paid())).ticket;
  await assert.rejects(f.review(ticket,'approve',{offerCents:2500}),{status:409});ticket=(await f.review(ticket,'counter_offer',{reason:'Aufwand für Diagnose',offerCents:2500})).ticket;assert.equal(ticket.status,'counter_offer');assert.equal(ticket.order.acceptedCents,1000);
  await assert.rejects(f.review(ticket,'approve',{offerCents:2500}),{status:409});await assert.rejects(f.support.respond(f.other,ticket.id,{expectedRevision:ticket.revision,decision:'accept',offerCents:2500,confirm:true}),{status:404});
  await assert.rejects(f.support.respond(f.user,ticket.id,{expectedRevision:ticket.revision,decision:'accept',offerCents:2000,confirm:true}),{status:409});
  ticket=(await f.support.respond(f.user,ticket.id,{expectedRevision:ticket.revision,decision:'accept',offerCents:2500,confirm:true})).ticket;assert.equal(ticket.status,'pending_review');assert.equal(ticket.order.acceptedCents,2500);
  await assert.rejects(f.review(ticket,'approve',{offerCents:1000}),{status:409});ticket=(await f.review(ticket,'approve',{offerCents:2500})).ticket;assert.equal(ticket.status,'approved');assert.equal(ticket.revision,4);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM control_notice_events').n,2);
});
test('technical edits never alter customer contact or prices and all mutations check reviewed revision',async t=>{
  const f=fixture(t),created=(await f.create(paid())).ticket;let ticket=(await f.review(created,'edit',{patch:{symptoms:'Der PC zeigt jetzt einen Fehlercode an.'}})).ticket;
  assert.equal(ticket.order.offerCents,1000);assert.equal(ticket.order.contact.email,'contact@fixture.test');await assert.rejects(f.review(created,'reject',{reason:'Veraltet'}),{status:409});
  await assert.rejects(f.review(ticket,'edit',{offerCents:2000}));await assert.rejects(f.review(ticket,'edit',{patch:{order:{offerCents:2000}}}));await assert.rejects(f.review(ticket,'edit',{patch:{userId:f.other.user.id}}));
  ticket=(await f.review(ticket,'reject',{reason:'Bitte genauer beschreiben'})).ticket;ticket=(await f.support.update(f.user,ticket.id,{expectedRevision:ticket.revision,...paid(),symptoms:'Neue genaue Beschreibung des Startfehlers.'})).ticket;assert.equal(ticket.status,'submitted');assert.equal(ticket.reviewedBy,null);
});
test('declined counter-offer cannot be approved and close is a distinct confirmed operation',async t=>{
  const f=fixture(t);let ticket=(await f.create(paid())).ticket;ticket=(await f.review(ticket,'counter_offer',{reason:'Mehr Zeit erforderlich',offerCents:2000})).ticket;
  ticket=(await f.support.respond(f.user,ticket.id,{expectedRevision:ticket.revision,decision:'decline',offerCents:2000,confirm:true})).ticket;assert.equal(ticket.status,'rejected');await assert.rejects(f.review(ticket,'approve',{offerCents:2000}),{status:409});
  await assert.rejects(f.support.close(f.user,ticket.id,{expectedRevision:ticket.revision,reason:'Erledigt',confirm:true}),{status:403});ticket=(await f.support.close(f.admin,ticket.id,{expectedRevision:ticket.revision,reason:'Anfrage abgeschlossen',confirm:true})).ticket;assert.equal(ticket.status,'closed');assert(ticket.closedAt);await assert.rejects(f.support.update(f.user,ticket.id,{expectedRevision:ticket.revision,...draft()}),{status:409});
});
test('private images are validated, owned, bounded and never read before authorization',async t=>{
  const f=fixture(t),uploaded=await f.support.upload(f.user,imageRequest()),id=uploaded.image.id;assert.equal(uploaded.image.mimeType,'image/png');assert.equal(f.support.hasImage(id),true);
  let reads=f.state.reads;await assert.rejects(f.support.readImage(f.other,id),{status:404});assert.equal(f.state.reads,reads);await assert.rejects(f.create({...draft(),imageIds:[id]},f.other),{status:403});assert.equal(f.state.reads,reads);
  const ticket=(await f.create({...draft(),imageIds:[id]})).ticket;assert.equal(ticket.images[0].id,id);assert.equal((await f.support.readImage(f.admin,id,{admin:true,preview:true})).dataUrl,'data:image/png;base64,'+IMAGE.toString('base64'));
  await assert.rejects(f.support.upload(f.user,imageRequest(Buffer.from('<svg>bad</svg>'),{'content-type':'image/svg+xml'})),{status:415});await assert.rejects(f.support.upload(f.user,imageRequest(IMAGE,{'x-file-name':'../private.png'})));
  const before=f.state.puts;await assert.rejects(f.support.upload(f.user,imageRequest(IMAGE,{'content-length':String(8*1024*1024+1)})),{status:413});assert.equal(f.state.puts,before);
});
test('revoked sessions cannot commit uploads/submissions or obtain images after awaited storage',async t=>{
  const f=fixture(t),id=(await f.support.upload(f.user,imageRequest())).image.id;
  f.state.readHook=()=>{f.state.revoked=true;};await assert.rejects(f.create({...draft(),imageIds:[id]}),{status:401});assert.equal(f.store.get('SELECT COUNT(*) AS n FROM pc_support_tickets').n,0);f.state.revoked=false;
  await assert.rejects(f.support.readImage(f.admin,id,{admin:true,preview:true}),{status:401});f.state.revoked=false;f.state.readHook=null;
  f.state.putHook=()=>{f.state.revoked=true;};await assert.rejects(f.support.upload(f.other,imageRequest()),{status:401});assert.equal(f.store.get('SELECT COUNT(*) AS n FROM pc_support_images WHERE user_id=?',f.other.user.id).n,0);
});
test('admin query pages deterministically and filters help versus orders without public access',async t=>{
  const f=fixture(t);for(let i=0;i<6;i++)await f.create(i%2?paid():draft());let cursor=null;const ids=[];do{const page=f.support.query(f.admin,{limit:2,cursor});ids.push(...page.tickets.map(row=>row.id));cursor=page.nextCursor;assert.equal(page.counts.total,6);}while(cursor);assert.equal(new Set(ids).size,6);assert.equal(f.support.query(f.admin,{kind:'order'}).tickets.length,3);assert.equal(f.support.own(f.other).tickets.length,0);
});
test('private HTTP routes enforce sessions, administrator authorization and CSRF',async t=>{
  const f=fixture(t),base='/api/account/pc-support',body={requestId:randomUUID(),...paid()};assert.equal((await httpCall(f.support,base)).status,401);
  assert.equal((await httpCall(f.support,base,{method:'POST',body,user:f.user,csrf:'invalid'})).status,403);const created=await httpCall(f.support,base,{method:'POST',body,user:f.user});assert.equal(created.status,201);
  assert.equal((await httpCall(f.support,base+'/'+created.body.ticket.id,{user:f.other})).status,404);assert.equal((await httpCall(f.support,'/api/admin/pc-support/query',{method:'POST',body:{},user:f.user})).status,403);
  const listed=await httpCall(f.support,'/api/admin/pc-support/query',{method:'POST',body:{},user:f.admin});assert.equal(listed.status,200);assert.equal(listed.body.tickets.length,1);assert.equal(listed.headers['Cache-Control'],'no-store');assert.equal((await httpCall(f.support,'/api/unrelated')).handled,false);
});
test('a failed durable notice rolls back the ticket and leaves no partial submission',async t=>{
  const f=fixture(t),original=f.store.run.bind(f.store);f.store.run=(sql,...args)=>{if(sql.includes('INSERT OR IGNORE INTO control_notice_events'))throw Error('fixture notification storage failure');return original(sql,...args);};
  await assert.rejects(f.create());assert.equal(f.store.get('SELECT COUNT(*) AS n FROM pc_support_tickets').n,0);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM account_audit').n,0);
});
test('parallel reviews of one revision cannot approve and reject the same snapshot',async t=>{
  const f=fixture(t),ticket=(await f.create()).ticket;const results=await Promise.allSettled([f.review(ticket,'approve'),f.review(ticket,'reject',{reason:'Andere Entscheidung'})]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.support.row(ticket.id).revision,2);
});
