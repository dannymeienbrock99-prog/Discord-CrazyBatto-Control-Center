import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { AccountStore } from '../src/account-store.mjs';
import { ControlPush } from '../src/control-push.mjs';
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
  return {store,worker,context,subscription,event,advance:()=>now+=60000,setOwner:x=>operator=x};
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
