'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {StreamDeckBridge,StreamDeckController,validateAction,PAGES}=require('../electron/streamdeck.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
 const calls=[],session={connected:true,profileId:'test-profile',user:{id:'test-user'},baseUrl:'https://example.invalid',expiresAt:123456789};
 const playback={isPlaying:true,deviceId:'desktop',shuffleState:false,repeatState:'off',progressMs:100,track:{name:'Test title',artists:['Test artist'],durationMs:100000}};
 const player={devices:[{id:'desktop',name:'PC',isActive:true,isRestricted:false,volumePercent:98,supportsVolume:true},{id:'locked',name:'Restricted',isRestricted:true}],playback};
 const music={bot:{connected:true,status:'playing',paused:false,volume:2,channelId:'voice',track:'Local title'},channels:[{id:'voice',name:'Voice'}],library:{tracks:[{id:'10000000-0000-4000-8000-000000000001'}]},queue:[{}]};
 const website={state:()=>({...session,user:{...session.user}}),run:async(_action,{operation,body})=>{calls.push({operation,body});if(operation==='spotify.status')return {connected:true,controllerReady:true};if(operation==='spotify.player')return player;if(operation==='music.read')return music;return {ok:true,message:'Accepted'};}};
 const opened=[],controller=new StreamDeckController({website,openPage:p=>opened.push(p)});return {controller,website,session,player,music,calls,opened};
}
test('only explicit music and navigation actions are accepted',()=>{
 assert(PAGES.some(p=>p.id==='members'));assert(PAGES.some(p=>p.id==='streamdeck'));
 for(const input of [{action:'member.ban',userId:'1'},{action:'app.open',page:'../private'},{action:'spotify.play',url:'https://evil.invalid'},{action:'spotify.volume',volume:101},{action:'music.play',trackId:'../../x'},{action:'spotify.context',uri:'https://evil.invalid/a'}])assert.throws(()=>validateAction(input));
 assert.equal(validateAction({action:'app.open',page:'members'}).page,'members');
});
test('Spotify toggle, volume clamping, shuffle, repeat and fixed context reach real operation contracts',async()=>{
 const f=fixture();for(const [input,expected] of [[{action:'spotify.toggle'},{action:'pause',deviceId:'desktop'}],[{action:'spotify.volumeUp'},{action:'volume',deviceId:'desktop',volume:100}],[{action:'spotify.shuffle'},{action:'shuffle',deviceId:'desktop',state:true}],[{action:'spotify.repeat'},{action:'repeat',deviceId:'desktop',state:'context'}],[{action:'spotify.context',uri:'spotify:track:1234567890123456789012'},{action:'play',deviceId:'desktop',uri:'spotify:track:1234567890123456789012'}]]){await f.controller.action(input);assert.deepEqual(f.calls.at(-1),{operation:'spotify.control',body:expected});}
 await assert.rejects(f.controller.action({action:'spotify.play',deviceId:'locked'}),e=>e.code==='spotify_device');
 f.player.devices[0].supportsVolume=false;await assert.rejects(f.controller.action({action:'spotify.volumeDown'}),e=>e.code==='spotify_device');
});
test('Bot leave stops, pause resumes, and playlist selection is passed without invented channel IDs',async()=>{
 const f=fixture();await f.controller.action({action:'music.leave'});assert.deepEqual(f.calls.at(-1),{operation:'music.control',body:{action:'stop'}});
 f.music.bot.paused=true;f.music.bot.status='paused';await f.controller.action({action:'music.play'});assert.equal(f.calls.at(-1).body.action,'resume');
 await f.controller.action({action:'music.volumeDown'});assert.equal(f.calls.at(-1).body.volume,0);
 await f.controller.action({action:'music.play',playlistId:'all'});assert.deepEqual(f.calls.at(-1).body,{action:'play',playlistId:'all'});
 await f.controller.action({action:'app.open',page:'members'});assert.deepEqual(f.opened,['members']);
});
test('status coalesces a shared snapshot and exposes no account or token objects',async()=>{
 const f=fixture();f.player.playback.repeatState='context';const first=await f.controller.status();assert.equal(first.spotify.repeat,'context');assert.equal(first.spotify.track,'Test title');assert.equal(first.music.channelName,'Voice');assert.equal(first.spotify.devices.length,1);const count=f.calls.length;
 assert.equal(await f.controller.status(),first);assert.equal(f.calls.length,count);assert(!JSON.stringify(first).includes('test-user'));
 f.session.connected=false;const disconnected=await f.controller.status();assert.equal(disconnected.app.connected,false);assert.equal(disconnected.spotify.track,'');await assert.rejects(f.controller.action({action:'spotify.next'}),e=>e.code==='auth');
});
test('session changes during device lookup cannot send a command to another account',async()=>{
 const f=fixture(),pending=deferred(),original=f.website.run;f.website.run=async(action,data)=>{if(data.operation==='spotify.player'){await pending.promise;return f.player;}return original(action,data);};
 const result=f.controller.action({action:'spotify.next'});await new Promise(setImmediate);f.session.user.id='different-user';pending.resolve();await assert.rejects(result,e=>e.code==='auth');assert(!f.calls.some(c=>c.operation==='spotify.control'));
});
async function bridgeFixture(t,options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cb-streamdeck-test-')),fixtureState=fixture();
 const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted-test:'+s),decryptString:b=>b.toString().replace('encrypted-test:','')};
 const bridge=new StreamDeckBridge({directory,safeStorage,controller:fixtureState.controller,port:0,...options});
 await bridge.start();t.after(async()=>{await bridge.stop();fs.rmSync(directory,{recursive:true,force:true});});
 const token=bridge.copyToken();return {...fixtureState,bridge,directory,safeStorage,token};
}
function httpCall(f,{method='GET',url='/v1/status',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.bridge.port,path:url,method,headers:{Authorization:'Bearer '+f.token,...headers}},res=>{let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(text)}));});req.on('error',reject);req.end(body);});}
test('real loopback transport requires token and exact Host, rejects websites and secret output',async t=>{
 const f=await bridgeFixture(t);const good=await httpCall(f);assert.equal(good.status,200);assert.equal(good.headers['cache-control'],'no-store');assert.equal(good.headers['access-control-allow-origin'],undefined);assert(!JSON.stringify(good.body).includes(f.token));
 for(const headers of [{Authorization:'Bearer '+'0'.repeat(64)},{Host:'attacker.invalid'},{Origin:'https://evil.invalid'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}])assert([401,403].includes((await httpCall(f,{headers})).status));
 const action=await httpCall(f,{method:'POST',url:'/v1/action',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'music.leave'})});assert.equal(action.status,200);assert.equal(f.calls.at(-1).body.action,'stop');
 assert.equal((await httpCall(f,{url:'/private'})).status,404);
});
test('rotation revokes queued commands before execution and encrypted token survives restart',async t=>{
 const queued=deferred(),accepted=deferred();const f=await bridgeFixture(t,{execute:async task=>{accepted.resolve();await queued.promise;return task();}});
 const result=httpCall(f,{method:'POST',url:'/v1/action',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'spotify.next'})});await accepted.promise;f.bridge.rotate();queued.resolve();assert.equal((await result).status,401);assert.equal(f.calls.length,0);
 const changed=f.bridge.copyToken();assert.notEqual(changed,f.token);await f.bridge.stop();await f.bridge.start();assert.equal(f.bridge.copyToken(),changed);assert.equal((await httpCall(f)).status,401);
});
test('disabled encryption never falls back to a plaintext connection code',async()=>{
 const bridge=new StreamDeckBridge({directory:os.tmpdir(),safeStorage:{isEncryptionAvailable:()=>false},controller:fixture().controller,port:0});await assert.rejects(bridge.start(),/geschützt/);assert.equal(bridge.state().enabled,false);assert.throws(()=>bridge.copyToken());
});

test('accepted HTTP commands are bound to their website account before waiting in the application queue',async t=>{
 const queued=deferred(),accepted=deferred();const f=await bridgeFixture(t,{execute:async task=>{accepted.resolve();await queued.promise;return task();}});
 const result=httpCall(f,{method:'POST',url:'/v1/action',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'music.leave'})});await accepted.promise;f.session.user.id='second-account';queued.resolve();assert.equal((await result).status,401);assert.equal(f.calls.length,0);
});
