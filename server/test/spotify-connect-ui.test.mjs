import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element{
  constructor(){this.hidden=false;this.disabled=false;this.textContent='';this.listeners={};this.classList={toggle(){}};}
  addEventListener(name,fn){this.listeners[name]=fn;}setAttribute(){}
}
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture({user={id:'website-member',confirmed:true,suspended:false,isAdmin:false},status={configured:true,connected:false,controllerReady:false},target='https://accounts.spotify.com/authorize?state=opaque',consent=true,callback='',apiOverride,sessionOverride}={}){
  const elements=new Map(),events={},requests=[],redirects=[],history=[],settings=[];
  const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const window={location:{href:'https://example.invalid/media-player.html'+callback,assign:url=>redirects.push(url)},history:{replaceState:(_a,_b,url)=>history.push(url)},CBConsent:{allowsSpotify:()=>consent,openSettings:()=>settings.push(true)},addEventListener:(name,fn)=>{events[name]=fn;}};
  const api=async(path,options)=>{requests.push({path,...options});return apiOverride?apiOverride(path,options):path==='/api/spotify/status'?status:{authorizationUrl:target};};
  const context={URL,window,document:{hidden:false,getElementById:get},api,getSession:sessionOverride||(async()=>({user})),errorText:error=>error.message};
  const source=fs.readFileSync(new URL('../public/showcase/assets/spotify-connect.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void run\(start\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.handlers={connect,refresh,start,run,invalidate};',context);
  return {...context.handlers,get,events,requests,redirects,history,settings,setConsent:value=>{consent=value;}};
}

test('the current media player contains a visible Spotify entry and independent module',()=>{
  const html=fs.readFileSync(new URL('../public/showcase/media-player.html',import.meta.url),'utf8');
  assert.match(html,/id="spotifyConnectButton"[^>]*>Spotify verbinden/);assert.match(html,/type="module" src="assets\/spotify-connect.js"/);assert.match(html,/id="spotifyConnectStatus" role="status"/);
  assert.ok(html.indexOf('id="spotifyConnect"')<html.indexOf('id="player-title"'));assert.match(html,/id="audioPlayer"/);assert.match(html,/src="assets\/player.js"/);
  assert.doesNotMatch(html,/src="https:\/\/sdk.scdn.co/);
});

test('signed-out visitors get the website login entry and no Spotify API request',async()=>{
  const f=fixture({user:null});await f.run(f.start);assert.equal(f.get('spotifyConnectButton').disabled,true);assert.equal(f.get('spotifyConnectLogin').hidden,false);assert.match(f.get('spotifyConnectStatus').textContent,/Websitekonto/);assert.equal(f.requests.length,0);
});

test('unconfirmed, suspended, unconfigured and preview accounts cannot connect',async()=>{
  for(const options of [{user:{id:'member',confirmed:false}},{user:{id:'member',confirmed:true,suspended:true}},{status:{configured:false,connected:false}},{status:{configured:true,connected:false,previewOnly:true}}]){
    const f=fixture(options);await f.run(f.connect);assert.equal(f.get('spotifyConnectButton').disabled,true);assert.equal(f.requests.some(r=>r.path.endsWith('/connect')),false);assert.equal(f.redirects.length,0);
  }
});

test('existing connections missing controller permission show a working reconnect button',async()=>{
  const f=fixture({status:{configured:true,connected:true,controllerReady:false}});await f.run(f.start);assert.equal(f.get('spotifyConnectButton').hidden,false);assert.equal(f.get('spotifyConnectButton').disabled,false);assert.equal(f.get('spotifyConnectButton').textContent,'Spotify erneut freigeben');
});

test('only an explicit connect click starts the existing CSRF-protected Spotify authorization action',async()=>{
  const f=fixture();await f.run(f.start);assert.equal(f.requests.some(r=>r.path.endsWith('/connect')),false);await f.run(f.connect);
  const call=f.requests.find(r=>r.path.endsWith('/connect'));assert.equal(call.method,'POST');assert.deepEqual(JSON.parse(JSON.stringify(call.body)),{});assert.equal(call.csrf,undefined);assert.equal(f.redirects.length,1);assert.match(f.redirects[0],/^https:\/\/accounts.spotify.com\/authorize\?/);
  assert.ok(f.requests.every(r=>['/api/spotify/status','/api/spotify/connect'].includes(r.path)));
});

test('the retired embed consent flag cannot block explicit OAuth and never starts an automatic connection',async()=>{
  const f=fixture({consent:false});await f.run(f.start);assert.equal(f.requests.some(r=>r.path.endsWith('/connect')),false);assert.equal(f.redirects.length,0);
  await f.run(f.connect);assert.equal(f.settings.length,0);assert.equal(f.requests.filter(r=>r.path.endsWith('/connect')).length,1);assert.equal(f.redirects.length,1);
  assert.ok(f.requests.every(r=>['/api/spotify/status','/api/spotify/connect'].includes(r.path)));
});

test('unexpected OAuth hosts, protocols, credentials, paths, ports and fragments are rejected',async()=>{
  for(const target of ['https://attacker.invalid/authorize','http://accounts.spotify.com/authorize','https://user:secret@accounts.spotify.com/authorize','https://accounts.spotify.com:8443/authorize','https://accounts.spotify.com/other','https://accounts.spotify.com/authorize#secret','not a URL']){
    const f=fixture({target});await f.run(f.connect);assert.equal(f.redirects.length,0);assert.match(f.get('spotifyConnectStatus').textContent,/Anmeldeadresse/);assert.ok(!f.get('spotifyConnectStatus').textContent.includes(target));
  }
});

test('OAuth callback flag alone never claims a successful usable connection',async()=>{
  const f=fixture({callback:'?spotify=connected&view=music'});await f.run(f.start);assert.match(f.get('spotifyConnectStatus').textContent,/nicht bestätigt/);assert.equal(f.get('spotifyConnectButton').hidden,false);assert.deepEqual(f.history,['/media-player.html?view=music#spotify-connect']);
  const g=fixture({callback:'?spotify=error'});await g.run(g.start);assert.match(g.get('spotifyConnectStatus').textContent,/nicht bestätigt/);
});

test('verified controller-ready return points back to the Control Center without starting playback',async()=>{
  const f=fixture({callback:'?spotify=connected',status:{configured:true,connected:true,controllerReady:true,spotifyUser:{displayName:'Mein Spotify'}}});await f.run(f.start);assert.equal(f.get('spotifyConnectButton').hidden,true);assert.match(f.get('spotifyConnectIdentity').textContent,/Mein Spotify/);assert.match(f.get('spotifyConnectStatus').textContent,/zurück zum Crazy_Batto Control Center/);assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'/api/spotify/status');
});

test('account changes and leaving the page cancel a pending OAuth redirect',async()=>{
  for(const action of ['account','pagehide']){
    const pending=defer(),f=fixture({apiOverride:async path=>path.endsWith('/status')?{configured:true,connected:false}:pending.promise});const running=f.run(f.connect);
    while(!f.requests.some(r=>r.path.endsWith('/connect')))await Promise.resolve();if(action==='account')f.events['cb-account-changed']();else f.events.pagehide();
    pending.resolve({authorizationUrl:'https://accounts.spotify.com/authorize?state=opaque'});await running;assert.equal(f.redirects.length,0);
  }
});

test('late status cannot restore a different account or display callback success',async()=>{
  const pending=defer(),f=fixture({callback:'?spotify=connected',apiOverride:()=>pending.promise});const running=f.run(f.start);while(!f.requests.length)await Promise.resolve();f.events.storage({key:'cb-account-change'});pending.resolve({configured:true,connected:true,controllerReady:true,spotifyUser:{displayName:'Old account'}});await running;
  assert.equal(f.get('spotifyConnectButton').disabled,true);assert.doesNotMatch(f.get('spotifyConnectIdentity').textContent,/Old account/);assert.match(f.get('spotifyConnectStatus').textContent,/Anmeldung hat sich geändert/);
});

test('duplicate clicks and failed status never start duplicate or stale OAuth actions',async()=>{
  const pending=defer(),f=fixture({apiOverride:async path=>path.endsWith('/status')?{configured:true,connected:false}:pending.promise});const first=f.run(f.connect);while(!f.requests.some(r=>r.path.endsWith('/connect')))await Promise.resolve();await f.run(f.connect);assert.equal(f.requests.filter(r=>r.path.endsWith('/connect')).length,1);pending.resolve({authorizationUrl:'https://accounts.spotify.com/authorize'});await first;
  const g=fixture({apiOverride:()=>{throw Error('Offline');}});await g.run(g.connect);assert.equal(g.redirects.length,0);assert.equal(g.get('spotifyConnectButton').disabled,true);assert.match(g.get('spotifyConnectStatus').textContent,/Offline/);
});

test('OAuth-only entry states the external authorization step and has no SDK, token or embed integration',()=>{
  const html=fs.readFileSync(new URL('../public/showcase/media-player.html',import.meta.url),'utf8'),source=fs.readFileSync(new URL('../public/showcase/assets/spotify-connect.js',import.meta.url),'utf8');
  assert.match(html,/Dort entscheidest du über den Zugriff/);assert.match(html,/kein externer Player geladen oder automatisch gestartet/);
  assert.doesNotMatch(source,/CBConsent|sdk\.scdn\.co|Spotify\.Player|\/api\/spotify\/(?:token|play|control)|createElement\(['"](?:script|iframe)/);
});
