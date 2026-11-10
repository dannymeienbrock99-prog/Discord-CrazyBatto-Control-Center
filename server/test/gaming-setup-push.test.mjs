import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { AccountStore } from '../src/account-store.mjs';
import { GamingSetups } from '../src/gaming-setups.mjs';
import { ControlPush } from '../src/control-push.mjs';

const OWNER='11111111-1111-4111-8111-111111111111',MEMBER='22222222-2222-4222-8222-222222222222';
const DAY=86400_000;
function fixture(t){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cb-setup-push-')),store=new AccountStore(folder);
  let now=1800000000000;const sent=[],keys=webpush.generateVAPIDKeys();
  for(const id of [OWNER,MEMBER])store.run('INSERT INTO accounts(id,email,name,confirmed,is_admin,created_at) VALUES(?,?,?,?,?,?)',id,id+'@example.invalid',id===OWNER?'Admin':'Private Member',1,Number(id===OWNER),now);
  const accounts={store,now:()=>now,config:{encryptionKey:crypto.randomBytes(32),publicOrigin:'https://example.invalid'},imageStorage:{},gallery:{exclusive:fn=>fn()},community:{push:{enabled:true,keys:()=>keys}},limit(){},suiteLicense:{operator:()=>OWNER,requireOperator:context=>{assert.equal(context.user.id,OWNER);return context.user;}},assertCurrent(context,{admin=false}={}){const user=store.get('SELECT * FROM accounts WHERE id=?',context.user.id);assert.ok(user.confirmed&&!user.suspended&&(!admin||user.is_admin));return {id:user.id};}};
  const service={accounts,config:{publicOrigin:'https://example.invalid'},discord:{request(){throw Error('No Discord transport allowed');}}};
  let setups=new GamingSetups(service,{now:()=>now});accounts.gamingSetups=setups;
  const worker=new ControlPush(accounts,{autoStart:false,transport:async(subscription,payload)=>sent.push(JSON.parse(payload))});
  const context={user:{id:OWNER}},member={user:{id:MEMBER}},ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/SETUP-TEST-DEVICE',keys:{auth:crypto.randomBytes(16).toString('base64url'),p256dh:ecdh.getPublicKey().toString('base64url')}};
  const configure=(enabled=true,publicationMode='review')=>store.setSetting('gaming_setups_settings_v1',JSON.stringify({revision:1,settings:{enabled,publicationMode,forumChannelId:'900000000000000060'}}));configure();
  const save=changes=>setups.save(member,{expectedRevision:setups.own(MEMBER)?.revision||0,title:'Private Gaming PC',description:'Private hardware details',specs:{cpu:'Private CPU'},imageIds:[],publish:true,consent:true,...changes});
  const row=()=>setups.own(MEMBER);
  const moderate=(operation='approve',extra={})=>setups.run(context,'setup.moderate',{id:row().id,expectedRevision:row().revision,operation,confirm:true,...extra});
  t.after(async()=>{worker.close();await setups.stop();store.close();const target=path.resolve(folder);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep+'cb-setup-push-'));fs.rmSync(target,{recursive:true,force:true});});
  return {store,worker,accounts,context,member,subscription,sent,save,row,moderate,configure,get setups(){return setups;},advance:(ms=60000)=>now+=ms,register:(setupPushVersion=1)=>worker.register(context,subscription,{setupPushVersion}),restart(){setups=new GamingSetups(service,{now:()=>now});accounts.gamingSetups=setups;return setups;},legacy(){store.run('DELETE FROM control_notice_events');store.run('DELETE FROM gaming_setup_notice_receipts');}};
}

test('submission records an atomic generic notice for the submitted revision; drafts do not notify',async t=>{
  const f=fixture(t);await f.save({publish:false,consent:false});assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,0);
  await f.save();const submitted=f.row(),event=f.store.get('SELECT * FROM control_notice_events');
  assert.equal(event.type,'gaming_setup');assert.equal(event.revision,submitted.published_revision);assert.equal(event.created_at,submitted.consent_at);
  await f.save({publish:false,title:'Later unsubmitted draft'});f.setups.backfillReviewNotices();
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
  f.register();await f.worker.drain();await f.worker.drain();assert.equal(f.sent.length,1);
  assert.equal(f.sent[0].url,'/control-center/?view=setups');assert.equal(f.sent[0].tag,'cb-control-gaming_setup-'+submitted.id);
  assert.equal(f.sent[0].body,'Ein Gaming-Setup wartet auf deine Freigabe.');assert.doesNotMatch(JSON.stringify(f.sent),/Private|Later|CPU|example\.invalid/);
});

test('a failed submission transaction creates neither setup, notice nor receipt',async t=>{
  const f=fixture(t),original=f.store.audit;f.store.audit=()=>{throw Error('Audit write failed');};
  await assert.rejects(f.save(),/Audit write failed/);f.store.audit=original;
  for(const table of ['gaming_setups','control_notice_events','gaming_setup_notice_receipts'])assert.equal(f.store.get('SELECT COUNT(*) n FROM '+table).n,0);
});

test('legacy pending submissions are backfilled once, even across restarts or event cleanup',async t=>{
  const f=fixture(t);await f.save();f.legacy();await f.save({publish:false,title:'New private draft'});
  f.setups.backfillReviewNotices();const event=f.store.get('SELECT * FROM control_notice_events');
  assert.equal(event.revision,f.row().published_revision);assert.notEqual(event.revision,f.row().revision);
  f.restart().backfillReviewNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
  assert.equal(f.store.get('SELECT id FROM control_notice_events').id,event.id);
  f.store.run('DELETE FROM control_notice_events');f.advance(15*DAY);f.restart().backfillReviewNotices();
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,0);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM gaming_setup_notice_receipts').n,1);
});

test('first phone registration receives an old still-pending setup exactly once without weekly repeats',async t=>{
  const f=fixture(t);await f.save();f.legacy();f.advance(14*DAY);f.setups.backfillReviewNotices();
  await f.worker.drain();assert.equal(f.sent.length,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
  f.advance();f.register();await f.worker.drain();assert.equal(f.sent.length,1);
  f.advance(30*DAY);f.restart().backfillReviewNotices();await f.worker.drain();assert.equal(f.sent.length,1);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
});

test('a resubmission supersedes an unsent version and each later submitted version can notify once',async t=>{
  const f=fixture(t);f.register();await f.save();f.advance();await f.save({title:'Revised submission'});
  await f.worker.drain();assert.equal(f.sent.length,1);assert.equal(f.store.get("SELECT COUNT(*) n FROM control_push_deliveries WHERE status='discarded'").n,1);
  f.advance();await f.save({title:'Another submission'});await f.worker.drain();assert.equal(f.sent.length,2);
  f.restart().backfillReviewNotices();await f.worker.drain();assert.equal(f.sent.length,2);
});

test('approved, hidden and withdrawn setups are rechecked before notification delivery',async t=>{
  for(const operation of ['approve','hide','withdraw'])await t.test(operation,async t=>{
    const f=fixture(t);f.register();await f.save();
    if(operation==='withdraw')await f.setups.withdraw(f.member,{expectedRevision:f.row().revision});else await f.moderate(operation);
    await f.worker.drain();assert.equal(f.sent.length,0);assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'discarded');
    f.advance(8*DAY);f.restart().backfillReviewNotices();await f.worker.drain();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,0);
    assert.equal(f.store.get('SELECT COUNT(*) n FROM gaming_setup_notice_receipts').n,1);
  });
});

test('temporary setup disablement pauses delivery without losing the approval notice',async t=>{
  const f=fixture(t);f.register();await f.save();f.configure(false);await f.worker.drain();assert.equal(f.sent.length,0);
  assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'pending');f.configure();f.advance();await f.worker.drain();assert.equal(f.sent.length,1);
});

test('unconfigured push reports disabled without requesting keys and retains pending setup events',async t=>{
  const f=fixture(t);f.register();await f.save();const keys=f.accounts.community.push.keys;
  f.accounts.community.push.enabled=false;f.accounts.community.push.keys=()=>{throw Error('Keys unavailable');};
  assert.deepEqual(f.worker.status(OWNER),{enabled:false,publicKey:null,registeredDevices:1});await f.worker.drain();assert.equal(f.sent.length,0);
  f.accounts.community.push.enabled=true;f.accounts.community.push.keys=keys;await f.worker.drain();assert.equal(f.sent.length,1);
});

test('drafts and immediate publications do not create review notices during backfill',async t=>{
  const f=fixture(t);await f.save({publish:false,consent:false});f.setups.backfillReviewNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,0);
  f.configure(true,'immediate');await f.save();f.setups.backfillReviewNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,0);
});

test('moderation reason is validated, saved and audited only in private admin output',async t=>{
  const f=fixture(t);await f.save();await assert.rejects(f.moderate('hide',{reason:'x'.repeat(1001)}),/lang/);
  assert.equal(f.row().status,'pending');await f.moderate('hide',{reason:'Bitte Fotos ohne persönliche Angaben hochladen.'});
  assert.equal(f.setups.adminView(f.context).entries[0].moderationReason,'Bitte Fotos ohne persönliche Angaben hochladen.');
  assert.equal(JSON.parse(f.store.get("SELECT details FROM account_audit WHERE action='gaming-setup.hide'").details).reason,'Bitte Fotos ohne persönliche Angaben hochladen.');
  assert.ok(!Object.hasOwn(f.setups.view(f.member).setup,'moderationReason'));
  await f.moderate('approve');assert.equal(f.setups.adminView(f.context).entries[0].moderationReason,'');
  assert.ok(!Object.hasOwn(f.setups.list().setups[0],'moderationReason'));
});

test('old phone workers retain setup notices until their active-worker capability is confirmed',async t=>{
  const f=fixture(t);f.register(0);await f.save();f.advance(14*DAY);await f.worker.drain();
  assert.equal(f.sent.length,0);assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_push_deliveries').n,0);
  const registered=f.worker.check(f.context,f.subscription.endpoint,{setupPushVersion:0});assert.equal(registered.registered,true);
  await f.worker.drain();assert.equal(f.sent.length,0);
  const ready=f.worker.check(f.context,f.subscription.endpoint,{setupPushVersion:1});assert.equal(ready.setupPushVersion,1);
  await f.worker.drain();await f.worker.drain();assert.equal(f.sent.length,1);
  assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'delivered');
});

test('a legacy device still receives ordinary notices, but cannot claim unsupported setup capability',async t=>{
  const f=fixture(t);f.register(0);f.advance();await f.save();f.worker.test(f.context);await f.worker.drain();
  assert.equal(f.sent.length,1);assert.ok(f.sent[0].tag.startsWith('cb-control-test-'));
  assert.throws(()=>f.worker.check(f.context,f.subscription.endpoint,{setupPushVersion:2}),/Geräteversion/);
  assert.throws(()=>f.worker.register(f.context,f.subscription,{setupPushVersion:'1'}),/Geräteversion/);
  const missing=f.worker.check(f.context,f.subscription.endpoint+'-unknown',{setupPushVersion:1});assert.equal(missing.registered,false);
  assert.equal(f.store.get('SELECT setup_push_version FROM control_push_capabilities').setup_push_version,0);
});

test('capability migration leaves the legacy five-column device insert compatible with rollback',async t=>{
  const f=fixture(t);f.register();assert.equal(f.store.all('PRAGMA table_info(control_push_devices)').length,5);
  const row=f.store.get('SELECT * FROM control_push_devices');f.store.run('DELETE FROM control_push_devices WHERE id=?',row.id);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM control_push_capabilities').n,0);
  f.store.run('INSERT INTO control_push_devices VALUES (?,?,?,?,?)',row.id,row.user_id,row.subscription,row.created_at,row.updated_at);
  await f.save();await f.worker.drain();assert.equal(f.sent.length,0);
  f.worker.check(f.context,f.subscription.endpoint,{setupPushVersion:1});await f.worker.drain();assert.equal(f.sent.length,1);
});

test('late old-page requests cannot downgrade a confirmed worker or lose an existing retry',async t=>{
  const f=fixture(t);f.register();await f.save();const transport=f.worker.transport;f.worker.transport=async()=>{throw Error('Temporary outage');};
  await f.worker.drain();assert.equal(f.store.get('SELECT status FROM control_push_deliveries').status,'pending');
  assert.equal(f.worker.check(f.context,f.subscription.endpoint,{setupPushVersion:0}).setupPushVersion,1);
  assert.equal(f.worker.check(f.context,f.subscription.endpoint).setupPushVersion,1);
  assert.equal(f.worker.register(f.context,f.subscription).setupPushVersion,1);
  f.advance();f.worker.transport=transport;await f.worker.drain();assert.equal(f.sent.length,1);
});
