import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { AccountStore } from '../src/account-store.mjs';
import { ControlPush } from '../src/control-push.mjs';
import { CommunityControl } from '../src/community-control.mjs';
const ID='11111111-1111-4111-8111-111111111111';
const TARGET='22222222-2222-4222-8222-222222222222';
function fixture(t,transport){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cb-push-test-')),store=new AccountStore(folder);let now=1800000000000,operator=ID;
  store.run('INSERT INTO accounts(id,email,name,confirmed,is_admin,created_at) VALUES(?,?,?,?,?,?)',ID,'test@example.invalid','Owner',1,1,now);
  const keys=webpush.generateVAPIDKeys();
  const accounts={store,now:()=>now,config:{encryptionKey:crypto.randomBytes(32),publicOrigin:'https://example.invalid'},community:{push:{enabled:true,keys:()=>keys}},limit(){},suiteLicense:{operator:()=>operator,requireOperator(context){assert.equal(context.user.id,operator);return context.user;}}};
  const worker=new ControlPush(accounts,{transport,autoStart:false}),context={user:{id:ID}};
  const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/TEST-DEVICE',keys:{auth:crypto.randomBytes(16).toString('base64url'),p256dh:ecdh.getPublicKey().toString('base64url')}};
  t.after(()=>{worker.close();store.close();fs.rmSync(folder,{recursive:true,force:true});});
  const event=(type='pc_order')=>{const id=crypto.randomUUID();store.run('INSERT INTO control_notice_events VALUES(?,?,?,?,?)',id,type,TARGET,now,now);return id;};
  return {store,worker,accounts,context,subscription,event,advance:(ms=60000)=>now+=ms,setOwner:x=>operator=x};
}
test('owner notifications contain generic text, use high urgency and are deduplicated after delivery',async t=>{
  const sent=[],f=fixture(t,async(sub,payload,options)=>sent.push({payload:JSON.parse(payload),options}));
  f.worker.register(f.context,f.subscription);f.advance();f.event();await f.worker.drain();await f.worker.drain();
  assert.equal(sent.length,1);assert.equal(sent[0].options.urgency,'high');assert.equal(sent[0].payload.recipientId,ID);assert.equal(sent[0].payload.url,'/control-center/?view=support');assert.equal(JSON.stringify(sent[0].payload).includes('test@example.invalid'),false);
  assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'delivered');
});
test('subscriptions are encrypted and invalid endpoints cannot reach transport',t=>{
  const f=fixture(t,()=>{throw Error('no transport');});f.worker.register(f.context,f.subscription);
  const row=f.store.get('SELECT * FROM control_push_devices');assert.equal(row.subscription.includes(f.subscription.endpoint),false);assert.equal(f.worker.decrypt(row).endpoint,f.subscription.endpoint);
  assert.throws(()=>f.worker.register(f.context,{...f.subscription,endpoint:'http://127.0.0.1/private'}));
});
test('new devices do not receive old registration backlog',async t=>{
  let sent=0;const f=fixture(t,async()=>sent++);f.event('member_registered');f.advance();f.worker.register(f.context,f.subscription);await f.worker.drain();assert.equal(sent,0);
});
test('permanently expired endpoint is removed with its delivery records',async t=>{
  const f=fixture(t,async()=>{throw Object.assign(Error('gone'),{statusCode:410});});f.worker.register(f.context,f.subscription);f.advance();f.event();await f.worker.drain();assert.equal(f.store.get('SELECT COUNT(*) AS n FROM control_push_devices').n,0);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM control_push_deliveries').n,0);
});
test('temporary failures back off without losing or duplicating the event',async t=>{
  let calls=0;const f=fixture(t,async()=>{if(++calls===1)throw Error('offline');});f.worker.register(f.context,f.subscription);f.advance();f.event();await f.worker.drain();await f.worker.drain();assert.equal(calls,1);f.advance();await f.worker.drain();assert.equal(calls,2);assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'delivered');
});
test('operator change prevents delivery to previous operator',async t=>{
  let sent=0;const f=fixture(t,async()=>sent++);f.worker.register(f.context,f.subscription);f.advance();f.event();f.setOwner(TARGET);await f.worker.drain();assert.equal(sent,0);assert.throws(()=>f.worker.register(f.context,f.subscription));
});
test('unsubscribing prevents pending delivery and repeated removal is safe',async t=>{
  let sent=0;const f=fixture(t,async()=>sent++);f.worker.register(f.context,f.subscription);f.advance();f.event();f.worker.remove(f.context,f.subscription.endpoint);f.worker.remove(f.context,f.subscription.endpoint);await f.worker.drain();assert.equal(sent,0);
});

test('report notifications wait for their own active-worker capability and preserve a late pending report',async t=>{
  const sent=[],f=fixture(t,async(sub,payload)=>sent.push(JSON.parse(payload)));let state='ready';
  f.accounts.communityControl={reportNoticeState:()=>state};f.event('community_report');f.advance(14*86400_000);
  f.worker.register(f.context,f.subscription,{setupPushVersion:1});await f.worker.drain();assert.equal(sent.length,0);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM control_notice_events WHERE type='community_report'").n,1);
  const check=f.worker.check(f.context,f.subscription.endpoint,{reportPushVersion:1});assert.equal(check.reportPushVersion,1);assert.equal(check.setupPushVersion,1);
  f.worker.check(f.context,f.subscription.endpoint);assert.equal(f.store.get('SELECT report_push_version FROM control_push_capabilities').report_push_version,1);
  await f.worker.drain();await f.worker.drain();assert.equal(sent.length,1);assert.equal(sent[0].url,'/control-center/?view=reports');
  assert.equal(sent[0].body,'Eine Mitgliedermeldung wartet auf deine Prüfung.');assert.equal(sent[0].tag,'cb-control-community_report-'+TARGET);
  assert.doesNotMatch(JSON.stringify(sent),/test@example|reporter|reason|targetName/);
});

test('resolved reports are discarded and temporarily processing or disabled reports pause',async t=>{
  const sent=[],f=fixture(t,async()=>sent.push(true));let state='paused';f.accounts.communityControl={reportNoticeState:()=>state};
  f.worker.register(f.context,f.subscription,{reportPushVersion:1});f.event('community_report');await f.worker.drain();assert.equal(sent.length,0);
  state='obsolete';f.advance();await f.worker.drain();assert.equal(sent.length,0);assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'discarded');
  assert.equal(f.store.get('SELECT status FROM control_push_delivery_history').status,'discarded');
});

test('delivery evidence survives explicit unsubscribe and prevents repeating the same event after reregistration',async t=>{
  let sent=0;const f=fixture(t,async()=>sent++);f.accounts.communityControl={reportNoticeState:()=> 'ready'};
  f.worker.register(f.context,f.subscription,{reportPushVersion:1});f.event('community_report');await f.worker.drain();assert.equal(sent,1);
  f.worker.remove(f.context,f.subscription.endpoint);assert.equal(f.store.get('SELECT COUNT(*) n FROM control_push_deliveries').n,0);
  const history=f.store.get('SELECT status,last_status FROM control_push_delivery_history');assert.deepEqual({...history},{status:'delivered',last_status:201});
  assert.equal(f.store.get("SELECT COUNT(*) n FROM control_push_device_events WHERE reason='user_removed'").n,1);
  f.worker.register(f.context,f.subscription,{reportPushVersion:1});await f.worker.drain();assert.equal(sent,1);
});

test('provider expiration keeps earlier successful evidence and records the removal cause',async t=>{
  let fail=false;const f=fixture(t,async()=>{if(fail)throw Object.assign(Error('Gone'),{statusCode:410});});
  f.worker.register(f.context,f.subscription);f.event();await f.worker.drain();f.advance();fail=true;f.event('test');await f.worker.drain();
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_push_devices').n,0);
  const rows=f.store.all('SELECT type,status,last_status FROM control_push_delivery_history ORDER BY type');
  assert.equal(rows.find(row=>row.type==='pc_order').status,'delivered');assert.equal(rows.find(row=>row.type==='pc_order').last_status,201);
  assert.equal(rows.find(row=>row.type==='test').status,'expired');assert.equal(rows.find(row=>row.type==='test').last_status,410);
  assert.equal(f.store.get("SELECT http_status FROM control_push_device_events WHERE reason='provider_expired'").http_status,410);
  const serialized=JSON.stringify(f.store.all('SELECT * FROM control_push_delivery_history'))+JSON.stringify(f.store.all('SELECT * FROM control_push_device_events'));
  assert.ok(!serialized.includes(f.subscription.endpoint));assert.ok(!serialized.includes(f.subscription.keys.auth));assert.ok(!serialized.includes(f.subscription.keys.p256dh));
});

test('new capability column remains compatible with previous named-column capability inserts',t=>{
  const f=fixture(t,async()=>{});f.worker.register(f.context,f.subscription);
  const id=f.store.get('SELECT id FROM control_push_devices').id;f.store.run('DELETE FROM control_push_capabilities');
  f.store.run('INSERT INTO control_push_capabilities(device_id,setup_push_version) VALUES(?,?)',id,1);
  assert.equal(f.store.get('SELECT report_push_version FROM control_push_capabilities').report_push_version,0);
  assert.throws(()=>f.worker.check(f.context,f.subscription.endpoint,{reportPushVersion:2}),/Geräteversion/);
});

test('real community backfill reaches push once and a later resolved case cannot notify a new device',async t=>{
  const sent=[],f=fixture(t,async(sub,payload)=>sent.push(JSON.parse(payload)));
  const community=new CommunityControl({accounts:f.accounts,config:{}},{now:f.accounts.now});f.accounts.communityControl=community;
  community.mutate(data=>{data.settings.reports.enabled=true;data.reports.push({id:TARGET,createdAt:f.accounts.now()-14*86400_000,status:'open',revision:0,reason:'Private incident reason',reporterId:'private',history:[]});});
  community.backfillReportNotices();community.backfillReportNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM community_report_notice_receipts').n,1);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM control_notice_events WHERE type='community_report'").n,1);
  f.worker.register(f.context,f.subscription,{reportPushVersion:1});await f.worker.drain();assert.equal(sent.length,1);assert.doesNotMatch(JSON.stringify(sent),/Private incident|reporterId/);
  community.mutate(data=>{data.reports[0].status='resolved';});f.worker.remove(f.context,f.subscription.endpoint);
  f.worker.register(f.context,{...f.subscription,endpoint:f.subscription.endpoint+'-new'},{reportPushVersion:1});await f.worker.drain();assert.equal(sent.length,1);
  community.backfillReportNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM community_report_notice_receipts').n,1);
});

test('delivery deduplication is operator-bound when a device changes owner',async t=>{
  const sent=[],f=fixture(t,async(sub,payload)=>sent.push(JSON.parse(payload)));f.accounts.communityControl={reportNoticeState:()=> 'ready'};
  f.worker.register(f.context,f.subscription,{reportPushVersion:1});f.event('community_report');await f.worker.drain();
  f.store.run('INSERT INTO accounts(id,email,name,confirmed,is_admin,created_at) VALUES(?,?,?,?,?,?)',TARGET,'next@example.invalid','Next owner',1,1,f.accounts.now());
  f.setOwner(TARGET);f.worker.register({user:{id:TARGET}},f.subscription,{reportPushVersion:1});await f.worker.drain();
  assert.equal(sent.length,2);assert.equal(sent[0].recipientId,ID);assert.equal(sent[1].recipientId,TARGET);
  assert.equal(f.store.get("SELECT COUNT(*) n FROM control_push_delivery_history WHERE status='delivered'").n,2);
});
