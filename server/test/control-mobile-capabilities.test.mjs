import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

function fixture({replyVersion=1,reply=true,registered=true}={}){
  const nodes=new Map(),timers=new Map(),events={},calls=[],messages=[],ports=[];let timerId=0;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,hidden:false,textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){}});return nodes.get(id);};
  $('#login-form').elements=[];
  class MessageChannel{
    constructor(){this.port1={onmessage:null,closed:false,close(){this.closed=true;}};this.port2={closed:false,close(){this.closed=true;},postMessage:value=>this.port1.onmessage?.({data:value})};ports.push(this.port1,this.port2);}
  }
  const active={state:'activated',postMessage(value,transfer){messages.push({value,transfer});if(reply)Promise.resolve().then(()=>transfer[0].postMessage({type:'control-push-capabilities',requestId:value.requestId,setupPushVersion:replyVersion}));}};
  const registration={active,update:async()=>{},pushManager:{getSubscription:async()=>({endpoint:'https://fcm.googleapis.com/fcm/send/device'})}};
  const navigator={serviceWorker:{register:async()=>registration,ready:Promise.resolve(registration),addEventListener:(name,fn)=>events[name]=fn}};
  const context={URL,URLSearchParams,crypto,MessageChannel,navigator,window:{PushManager:class{},Notification:{}},Notification:{permission:'granted'},location:{href:'https://example.invalid/control-center/'},document:{hidden:false,querySelectorAll:()=>[],addEventListener:(name,fn)=>events[name]=fn},$,notify(){},currentSession:()=>({user:{id:'owner'}}),loadSession:async()=>({user:{id:'owner'}}),
    setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),
    api:async(url,options)=>{calls.push({url,options});return url.endsWith('/check')?{registered,setupPushVersion:options.body.setupPushVersion}:{enabled:true,publicKey:'public'};},
  };
  const source=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.handlers={activeSetupPushVersion,pushStatus,setRegistration:value=>registration=value,invalidate:privateReset};',context);
  context.handlers.setRegistration(registration);
  return {...context.handlers,$,timers,events,calls,messages,ports,registration,context};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('capability handshake requires a matching private-channel response from the same active worker',async()=>{
  const f=fixture();assert.equal(await f.activeSetupPushVersion(),1);assert.match(f.messages[0].value.requestId,/^[a-f0-9-]{36}$/);assert.ok(f.ports.every(port=>port.closed));assert.equal(f.timers.size,0);
  const unknown=fixture({replyVersion:2});assert.equal(await unknown.activeSetupPushVersion(),0);
});

test('old worker, wrong request ID and a replaced active worker cannot claim setup support',async()=>{
  const old=fixture({reply:false}),waiting=old.activeSetupPushVersion();old.messages[0].transfer[0].postMessage({type:'control-push-capabilities',requestId:'wrong',setupPushVersion:1});assert.equal(old.timers.size,1);[...old.timers.values()][0]();assert.equal(await waiting,0);assert.ok(old.ports.every(port=>port.closed));
  const stale=fixture({reply:false}),pending=stale.activeSetupPushVersion();stale.registration.active={state:'activated'};const request=stale.messages[0];request.transfer[0].postMessage({type:'control-push-capabilities',requestId:request.value.requestId,setupPushVersion:1});assert.equal(await pending,0);
  const absent=fixture();absent.registration.active=null;assert.equal(await absent.activeSetupPushVersion(),0);
});

test('confirmed active worker registers capability through the authenticated device check',async()=>{
  const f=fixture();await f.pushStatus();const check=f.calls.find(call=>call.url.endsWith('/check'));
  assert.equal(check.options.method,'POST');assert.equal(check.options.body.setupPushVersion,1);assert.match(f.$('#push-state').textContent,/auch für Gaming-Setups/);assert.equal(f.$('#test-push').disabled,false);
});

test('a legacy worker timeout reports queued setup notices without blocking ordinary push',async()=>{
  const f=fixture({reply:false}),status=f.pushStatus();await settle();assert.equal(f.timers.size,1);[...f.timers.values()][0]();await status;
  assert.equal(f.calls.find(call=>call.url.endsWith('/check')).options.body.setupPushVersion,0);assert.match(f.$('#push-state').textContent,/warten auf die App-Aktualisierung/);assert.equal(f.$('#test-push').disabled,false);
});

test('device permission without a server registration is never reported as enabled',async()=>{
  const f=fixture({registered:false});await f.pushStatus();assert.equal(f.$('#test-push').disabled,true);assert.match(f.$('#push-state').textContent,/Noch nicht eingeschaltet/);
});

test('account change during worker handshake cannot update another session device capability',async()=>{
  const f=fixture({reply:false}),status=f.pushStatus();await settle();f.invalidate();const request=f.messages[0];request.transfer[0].postMessage({type:'control-push-capabilities',requestId:request.value.requestId,setupPushVersion:1});await status;
  assert.equal(f.calls.filter(call=>call.url.endsWith('/check')).length,0);
});

test('worker activation triggers one refreshed capability check',async()=>{
  const f=fixture();f.events.controllerchange();await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/check')).length,1);
});

test('returning to the foreground retries the handshake after session confirmation',async()=>{
  const f=fixture();f.events.visibilitychange();await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/check')).length,1);
  f.context.document.hidden=true;f.events.visibilitychange();await settle();assert.equal(f.calls.filter(call=>call.url.endsWith('/check')).length,1);
});

test('a stale foreground session refresh cannot announce capability after an account change',async()=>{
  const f=fixture();let resolve;f.context.loadSession=()=>new Promise(done=>resolve=done);f.events.visibilitychange();f.invalidate();resolve({user:{id:'owner'}});await settle();assert.equal(f.calls.length,0);
});

test('service worker answers capability requests only through their supplied reply port',()=>{
  const events={},responses=[];vm.runInNewContext(fs.readFileSync(new URL('../public/showcase/control-mobile-sw.js',import.meta.url),'utf8'),{self:{addEventListener:(name,fn)=>events[name]=fn}});
  const requestId=crypto.randomUUID();events.message({data:{type:'control-push-capabilities',requestId},ports:[{postMessage:value=>responses.push(value)}]});
  assert.equal(responses.length,1);assert.equal(responses[0].requestId,requestId);assert.equal(responses[0].setupPushVersion,1);
  events.message({data:{type:'control-push-capabilities',requestId:'wrong'},ports:[{postMessage:value=>responses.push(value)}]});assert.equal(responses.length,1);
});
