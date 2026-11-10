import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const defer=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const OWNER='11111111-1111-4111-8111-111111111111',EVENT='22222222-2222-4222-8222-222222222222';
const payload=()=>({kind:'control-center',recipientId:OWNER,eventId:EVENT,title:'Crazy_Batto · Control Center',body:'Eine neue PC-Auftragsanfrage wartet.',url:'/control-center/?view=support',tag:'cb-control-pc_order-'+EVENT});
function mobile({api=async()=>({}),subscription,loadSession}={}){
  const nodes=new Map(),events={},notices=[],calls=[];let session={user:{id:OWNER},csrfToken:'existing-csrf'},logins=0,cleared=0;
  const $=id=>{if(!nodes.has(id))nodes.set(id,{listeners:{},children:[],disabled:false,hidden:false,addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(...items){this.children=items;}});return nodes.get(id);};
  const submit={disabled:false};$('#login-form').elements=[{disabled:false},{disabled:false},submit];$('#login-form').querySelector=()=>submit;
  const context={URL,URLSearchParams,location:{href:'https://example.invalid/control-center/'},document:{addEventListener:(name,fn)=>events[name]=fn,querySelectorAll:()=>[]},$,notify:(message,error=false)=>notices.push({message,error}),
    currentSession:()=>session,clearSession(){cleared++;session=null;events['control-account-change']();},loadSession:loadSession||(async()=>session),login:async()=>{logins++;},navigator:{},window:{},
    api:(url,options)=>{calls.push({url,options,sessionPresent:!!session});return api(url,options);},
  };
  const script=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(script+'\nglobalThis.handlers={logout,start,registration:value=>registration=value};',context);
  context.handlers.registration({pushManager:{getSubscription:subscription||(async()=>null)}});
  return {...context.handlers,$,calls,notices,stats:()=>({cleared,logins,session}),submitLogin:()=>$('#login-form').listeners.submit({preventDefault(){},currentTarget:$('#login-form')})};
}
function worker(fetch){
  const handlers={},shown=[],opened=[],calls=[],timers=new Map();let sequence=0;
  const context={URL,AbortController,fetch:(...args)=>{calls.push(args);return fetch(...args);},setTimeout:fn=>{timers.set(++sequence,fn);return sequence;},clearTimeout:id=>timers.delete(id),
    self:{location:{origin:'https://crazybatto.de'},addEventListener:(name,fn)=>handlers[name]=fn,
      registration:{showNotification:async(title,options)=>shown.push({title,...options})},
      clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)},
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/showcase/control-mobile-sw.js',import.meta.url),'utf8'),context);
  return {shown,opened,calls,timers,
    push(data=payload()){let task;handlers.push({data:{json:()=>data},waitUntil:promise=>task=promise});return task;},
    click(url){let task;handlers.notificationclick({notification:{data:{url},close(){}},waitUntil:promise=>task=promise});return task;},
  };
}

test('logout still reaches server with its CSRF session when both push cleanup steps fail',async()=>{
  let unsubscribed=0;const f=mobile({subscription:async()=>({endpoint:'https://fcm.googleapis.com/fcm/send/test',unsubscribe:async()=>{unsubscribed++;throw Error('Browser failure');}}),api:async url=>{if(url.endsWith('/push'))throw Error('Push endpoint failure');return{};}});
  await f.logout();await Promise.resolve();
  assert.equal(unsubscribed,1);assert.ok(f.calls.some(call=>call.url==='/api/control-mobile/push'));
  const logout=f.calls.find(call=>call.url==='/api/account/logout');assert.equal(logout.sessionPresent,true);assert.equal(logout.options.method,'POST');
  assert.equal(f.stats().cleared,1);assert.equal(f.$('#admin-area').hidden,true);assert.equal(f.notices.at(-1).message,'Abgemeldet.');
});

test('unavailable push lookup or hanging lookup/unsubscribe do not block account logout',async()=>{
  for(const subscription of [async()=>{throw Error('Unavailable');},()=>new Promise(()=>{}),async()=>({endpoint:'https://fcm.googleapis.com/fcm/send/test',unsubscribe:()=>new Promise(()=>{})})]){
    const f=mobile({subscription});await f.logout();assert.ok(f.calls.some(call=>call.url==='/api/account/logout'));assert.equal(f.stats().cleared,1);
  }
});

test('failed server logout closes private UI but reports unconfirmed server state and never false success',async()=>{
  const f=mobile({api:async()=>{throw Error('Offline');}});await f.logout();
  assert.equal(f.stats().session,null);assert.equal(f.$('#admin-area').hidden,true);assert.equal(f.$('#detail').hidden,true);
  assert.match(f.notices.at(-1).message,/Abmeldung auf dem Server konnte nicht bestätigt werden/);assert.equal(f.notices.at(-1).error,true);assert.ok(!f.notices.some(item=>item.message==='Abgemeldet.'));
});

test('a late push lookup cannot use a subsequent login session to remove its subscription',async()=>{
  const lookup=defer();let unsubscribed=0;const f=mobile({subscription:()=>lookup.promise});
  await f.logout();assert.equal(f.stats().cleared,1);
  lookup.resolve({endpoint:'https://fcm.googleapis.com/fcm/send/test',unsubscribe:async()=>{unsubscribed++;}});await Promise.resolve();await Promise.resolve();
  assert.equal(unsubscribed,0);assert.equal(f.calls.filter(call=>call.url==='/api/control-mobile/push').length,0);
});

test('logout hides private state immediately and prevents a new login or stale startup response',async()=>{
  const logoutReply=defer(),sessionReply=defer();const f=mobile({api:()=>logoutReply.promise,loadSession:()=>sessionReply.promise});
  const startup=f.start(),leaving=f.logout();assert.equal(f.$('#admin-area').hidden,true);assert.ok(f.$('#login-form').elements.every(item=>item.disabled));
  await f.submitLogin();assert.equal(f.stats().logins,0);
  sessionReply.resolve({user:{id:OWNER,name:'Private Name'}});await startup;assert.equal(f.$('#admin-area').hidden,true);
  logoutReply.resolve({});await leaving;assert.ok(f.$('#login-form').elements.every(item=>!item.disabled));assert.equal(f.stats().cleared,1);
});

test('a verified matching owner receives the server notice and its private destination',async()=>{
  const f=worker(async()=>({ok:true,status:200,json:async()=>({user:{id:OWNER}})}));await f.push();
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].body,payload().body);assert.equal(f.shown[0].data.url,payload().url);
  assert.equal(f.calls[0][1].cache,'no-store');assert.equal(f.calls[0][1].credentials,'include');assert.equal(f.timers.size,0);
});

test('temporary 5xx and network failure show only a generic notice with no original recipient, type, ID or text',async()=>{
  for(const fetch of [async()=>({ok:false,status:503}),async()=>{throw Error('Network unavailable');}]){
    const f=worker(fetch),data={...payload(),body:'PRIVATE CONTACT private@example.invalid'};await f.push(data);
    assert.equal(f.shown.length,1);assert.equal(f.shown[0].body,'Neue Aktivität. Bitte im Control Center anmelden und prüfen.');
    assert.equal(f.shown[0].data.url,'/control-center/');assert.equal(f.shown[0].tag,'cb-control-activity');
    const displayed=JSON.stringify(f.shown);for(const privateValue of [OWNER,EVENT,'pc_order','support','PRIVATE CONTACT','private@example.invalid'])assert.ok(!displayed.includes(privateValue));
    assert.equal(f.timers.size,0);
  }
});

test('a timed-out session check aborts and emits the same generic fallback',async()=>{
  const f=worker((url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout')))));
  const push=f.push();assert.equal(f.timers.size,1);[...f.timers.values()][0]();await push;
  assert.equal(f.shown[0].tag,'cb-control-activity');assert.equal(f.timers.size,0);
});

test('confirmed logout, denied access and a different current owner discard the push',async()=>{
  for(const response of [{ok:false,status:401},{ok:false,status:403},{ok:true,status:200,json:async()=>({user:{id:EVENT}})},{ok:true,status:200,json:async()=>({user:null})}]){
    const f=worker(async()=>response);await f.push();assert.equal(f.shown.length,0);assert.equal(f.timers.size,0);
  }
});

test('malformed payloads are discarded before any session request and Robot event IDs are accepted',async()=>{
  for(const patch of [{kind:'chat'},{recipientId:'not-an-id'},{eventId:'invalid'},{tag:'private-tag'},{url:'https://outside.invalid/'},{body:'x'.repeat(181)}]){
    const f=worker(async()=>{throw Error('must not fetch');});await f.push({...payload(),...patch});assert.equal(f.calls.length,0);assert.equal(f.shown.length,0);
  }
  const f=worker(async()=>({ok:true,status:200,json:async()=>({user:{id:OWNER}})}));await f.push({...payload(),eventId:'robot:'+EVENT+':12',tag:'cb-control-robot_order-'+EVENT,url:'/control-center/?view=robot'});assert.equal(f.shown.length,1);
});

test('generic notification opens only the fixed same-origin Control Center',async()=>{
  const f=worker(async()=>({ok:false,status:503}));await f.push();await f.click(f.shown[0].data.url);assert.equal(f.opened[0],'https://crazybatto.de/control-center/');
  await f.click('https://outside.invalid/');await f.click('//outside.invalid/');assert.equal(f.opened.length,1);
});

test('a verified setup approval notice opens the fixed setups tab; unknown destinations remain rejected',async()=>{
  const f=worker(async()=>({ok:true,status:200,json:async()=>({user:{id:OWNER}})}));
  await f.push({...payload(),tag:'cb-control-gaming_setup-'+EVENT,url:'/control-center/?view=setups',body:'Ein Gaming-Setup wartet auf deine Freigabe.'});
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].silent,false);
  await f.click(f.shown[0].data.url);assert.equal(f.opened[0],'https://crazybatto.de/control-center/?view=setups');
  await f.push({...payload(),url:'/control-center/?view=unknown'});await f.click('/control-center/?view=setups&redirect=https://outside.invalid/');
  assert.equal(f.shown.length,1);assert.equal(f.opened.length,1);
});
