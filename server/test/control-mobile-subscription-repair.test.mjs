import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({registered=false,initial=true,lookup,check,unsubscribe,subscribe,keepOld=false}={}){
  const nodes=new Map(),calls=[],notices=[],events=[];const stats={permission:0,unsubscribe:0,subscribe:0,status:0};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){}});return nodes.get(id);};
  $('#login-form').elements=[];
  const fresh={endpoint:'https://fcm.googleapis.com/fcm/send/fresh',toJSON(){return {endpoint:this.endpoint};}};
  const old={endpoint:'https://fcm.googleapis.com/fcm/send/expired',toJSON(){return {endpoint:this.endpoint};},async unsubscribe(){stats.unsubscribe++;events.push('unsubscribe');if(unsubscribe)await unsubscribe();if(!keepOld)current=null;return !keepOld;}};
  let current=initial?old:null;
  const registration={pushManager:{async getSubscription(){events.push('lookup');return lookup?await lookup():current;},async subscribe(){stats.subscribe++;events.push('subscribe');if(subscribe)await subscribe();current=fresh;return fresh;}}};
  const api=async(url,options)=>{calls.push({url,options});events.push(url.endsWith('/check')?'check':options?.method==='POST'?'register':'status');if(url.endsWith('/check'))return check?await check():{registered};if(options?.method==='POST')return {setupPushVersion:1,reportPushVersion:1};return {enabled:true,publicKey:'AA'};};
  const context={URL,URLSearchParams,Uint8Array,atob:value=>Buffer.from(value,'base64').toString('binary'),location:{href:'https://example.invalid/control-center/'},window:{Notification:{}},Notification:{requestPermission:async()=>{stats.permission++;return 'granted';}},navigator:{serviceWorker:{}},document:{querySelectorAll:()=>[],addEventListener(){}},$,api,notify:(message,error)=>notices.push({message,error}),currentSession:()=>({user:{id:'owner'}}),
    hooks:{prepare:async()=>{},capabilities:async()=>({setupPushVersion:1,reportPushVersion:1}),status:async()=>stats.status++},
  };
  const source=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(source+'\npreparePushRegistration=hooks.prepare;activePushCapabilities=hooks.capabilities;pushStatus=hooks.status;globalThis.handlers={setRegistration:value=>registration=value,invalidate:privateReset};',context);
  context.handlers.setRegistration(registration);
  return {$,calls,notices,events,stats,enable:()=>$('#enable-push').listeners.click(),invalidate:context.handlers.invalidate};
}
const registrations=f=>f.calls.filter(call=>call.url==='/api/control-mobile/push'&&call.options?.method==='POST');

test('explicit enable replaces an unregistered stale browser subscription before registering the fresh one',async()=>{
  const f=fixture();assert.equal(f.stats.permission,0);assert.equal(f.stats.subscribe,0);assert.equal(f.calls.length,0);
  await f.enable();assert.equal(f.stats.permission,1);assert.equal(f.stats.unsubscribe,1);assert.equal(f.stats.subscribe,1);
  assert.equal(registrations(f).length,1);assert.match(registrations(f)[0].options.body.subscription.endpoint,/fresh$/);
  assert.equal(registrations(f)[0].options.body.reportPushVersion,1);assert.equal(f.stats.status,1);assert.equal(f.$('#enable-push').disabled,false);
  assert.ok(f.events.indexOf('check')<f.events.indexOf('unsubscribe'));assert.ok(f.events.indexOf('unsubscribe')<f.events.indexOf('subscribe'));
});

test('a server-registered subscription is reused without resetting a working phone',async()=>{
  const f=fixture({registered:true});await f.enable();assert.equal(f.stats.unsubscribe,0);assert.equal(f.stats.subscribe,0);
  assert.match(registrations(f)[0].options.body.subscription.endpoint,/expired$/);assert.equal(f.stats.status,1);
});

test('first enable creates one subscription only after an explicit click',async()=>{
  const f=fixture({initial:false});assert.equal(f.stats.subscribe,0);await f.enable();assert.equal(f.stats.subscribe,1);assert.equal(f.stats.unsubscribe,0);assert.equal(f.calls.filter(call=>call.url.endsWith('/check')).length,0);
});

test('failed fresh subscription never claims activation or registers the removed endpoint',async()=>{
  const f=fixture({subscribe:async()=>{throw Error('Push provider unavailable');}});await f.enable();
  assert.equal(f.stats.unsubscribe,1);assert.equal(registrations(f).length,0);assert.equal(f.stats.status,0);
  assert.equal(f.notices.at(-1).error,true);assert.match(f.notices.at(-1).message,/unavailable/);assert.equal(f.$('#enable-push').disabled,false);assert.equal(f.$('#test-push').disabled,true);
});

test('failed unsubscribe or an unchanged browser subscription cannot be silently reused',async()=>{
  for(const options of [{unsubscribe:async()=>{throw Error('Unsubscribe failed');}},{keepOld:true}]){
    const f=fixture(options);await f.enable();assert.equal(f.stats.subscribe,0);assert.equal(registrations(f).length,0);assert.equal(f.notices.at(-1).error,true);
  }
});

test('logout during initial lookup prevents a new browser subscription',async()=>{
  const pending=deferred(),f=fixture({lookup:()=>pending.promise});const operation=f.enable();await settle();f.invalidate();pending.resolve(null);await operation;
  assert.equal(f.stats.subscribe,0);assert.equal(f.stats.unsubscribe,0);assert.equal(registrations(f).length,0);
});

test('logout during the server registration check prevents deleting or registering a subscription',async()=>{
  const pending=deferred(),f=fixture({check:()=>pending.promise});const operation=f.enable();await settle();f.invalidate();pending.resolve({registered:false});await operation;
  assert.equal(f.stats.unsubscribe,0);assert.equal(f.stats.subscribe,0);assert.equal(registrations(f).length,0);
});

test('logout during unsubscribe stops before resubscribing under another session',async()=>{
  const pending=deferred(),f=fixture({unsubscribe:()=>pending.promise});const operation=f.enable();await settle();assert.equal(f.stats.unsubscribe,1);f.invalidate();pending.resolve();await operation;
  assert.equal(f.stats.subscribe,0);assert.equal(registrations(f).length,0);assert.equal(f.notices.length,0);
});

test('logout during subscribe prevents server registration and false activation notices',async()=>{
  const pending=deferred(),f=fixture({initial:false,subscribe:()=>pending.promise});const operation=f.enable();await settle();assert.equal(f.stats.subscribe,1);f.invalidate();pending.resolve();await operation;
  assert.equal(registrations(f).length,0);assert.equal(f.stats.status,0);assert.equal(f.notices.length,0);
});

test('duplicate enable clicks cannot race two subscription repairs',async()=>{
  const pending=deferred(),f=fixture({check:()=>pending.promise});const first=f.enable();await settle();await f.enable();assert.equal(f.stats.permission,1);
  pending.resolve({registered:false});await first;assert.equal(f.stats.unsubscribe,1);assert.equal(f.stats.subscribe,1);assert.equal(registrations(f).length,1);
});
