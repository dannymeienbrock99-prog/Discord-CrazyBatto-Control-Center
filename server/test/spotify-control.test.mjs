import test from 'node:test';
import assert from 'node:assert/strict';
import { spotifyControl, spotifyPlayer, spotifyControlUrl, spotifyMedia } from '../src/spotify-control.mjs';
function fixture(handler){
  const calls=[];let current=true,ready=true,generation=3;
  const guard=()=>{if(!current)throw Error('revoked');return{id:'owner'};};
  const owner={accounts:{assertCurrent:guard,limit(){}},requireLive(){},configured:()=>({revision:2}),generation:()=>generation,status:()=>({controllerReady:ready}),access:async()=>({accessToken:'private-test-token',configRevision:2,generation}),assertBinding:(_context,revision,expectedGeneration)=>{guard();if(revision!==2||expectedGeneration!==generation)throw Error('revoked grant');},
    async request(url,options){calls.push({url,options});if(handler)return handler(url,options,calls.length);return url.endsWith('/devices')?{status:200,data:{devices:[{id:'device-one',name:'PC',is_active:true,is_restricted:false,supports_volume:true,volume_percent:50}]}}:{status:204,data:null};}};
  return {owner,calls,revoke:()=>current=false,reconnect:()=>ready=false,renew:()=>generation++};
}
test('Spotify endpoints reject off-origin, duplicated parameters, and foreign links',()=>{
  for(const u of ['https://evil.test/v1/me/player','https://api.spotify.com/v1/me/player/devices?x=y','https://api.spotify.com/v1/me/player/play?device_id=x&device_id=y','https://api.spotify.com/v1/me/player/volume?device_id=x&volume_percent=101','https://x@api.spotify.com/v1/me/player'])assert.equal(spotifyControlUrl(u),false);
  assert.equal(spotifyControlUrl('https://api.spotify.com/v1/me/player/play?device_id=device-one'),true);
  assert.equal(spotifyMedia('https://open.spotify.com/track/0123456789012345678901?si=abc').uri,'spotify:track:0123456789012345678901');
  for(const u of ['https://evil.test/track/0123456789012345678901','spotify:user:0123456789012345678901','https://open.spotify.com/track/0123456789012345678901?redirect=evil'])assert.throws(()=>spotifyMedia(u));
});
test('Spotify reads real devices and empty playback without returning credentials',async()=>{
  const f=fixture(),result=await spotifyPlayer(f.owner,{});assert.equal(result.devices[0].name,'PC');assert.equal(result.playback,null);assert.ok(!JSON.stringify(result).includes('private-test-token'));
});
test('Spotify mutations validate a current device and dispatch once with exact route/body',async()=>{
  for(const action of ['play','pause','next','previous','volume','transfer']){
    const f=fixture();await spotifyControl(f.owner,{}, {action,deviceId:'device-one',...(action==='volume'?{volume:27}:{}),...(action==='play'?{uri:'spotify:track:0123456789012345678901'}:{})});
    assert.equal(f.calls.length,2);const sent=f.calls[1];assert.equal(sent.options.method,['next','previous'].includes(action)?'POST':'PUT');
    if(action==='transfer')assert.deepEqual(JSON.parse(sent.options.body),{device_ids:['device-one'],play:false});
    if(action==='play')assert.deepEqual(JSON.parse(sent.options.body),{uris:['spotify:track:0123456789012345678901']});
  }
});
test('absent, restricted and volume-incapable devices never receive mutations',async()=>{
  for(const device of [null,{id:'device-one',is_restricted:true},{id:'device-one',supports_volume:false}]){
    const f=fixture(async()=>({status:200,data:{devices:device?[device]:[]}}));await assert.rejects(spotifyControl(f.owner,{}, {action:device?.supports_volume===false?'volume':'play',deviceId:'device-one',...(device?.supports_volume===false?{volume:50}:{})}));assert.equal(f.calls.length,1);
  }
});
test('revocation while devices load prevents the command and suppresses read results',async()=>{
  let release;const gate=new Promise(r=>release=r);const f=fixture(async()=>{await gate;return{status:200,data:{devices:[{id:'device-one'}]}};});
  const promise=spotifyControl(f.owner,{}, {action:'play',deviceId:'device-one'});await new Promise(r=>setImmediate(r));f.revoke();release();await assert.rejects(promise,/revoked/);assert.equal(f.calls.length,1);
});
test('queued commands recheck account access and mutation errors are never retried',async()=>{
  let release;const gate=new Promise(r=>release=r);const f=fixture(async(url)=>{if(url.endsWith('/devices'))return{status:200,data:{devices:[{id:'device-one'}]}};await gate;throw Error('uncertain delivery');});
  const first=spotifyControl(f.owner,{}, {action:'next',deviceId:'device-one'});const second=spotifyControl(f.owner,{}, {action:'next',deviceId:'device-one'});await new Promise(r=>setImmediate(r));f.revoke();release();const results=await Promise.allSettled([first,second]);assert.ok(results.every(r=>r.status==='rejected'));assert.equal(f.calls.length,2);
});
test('old grants require explicit reconnection and unknown fields are refused before requests',async()=>{
  const f=fixture();f.reconnect();await assert.rejects(spotifyPlayer(f.owner,{}),/erneut verbinden/);assert.equal(f.calls.length,0);
  for(const body of [{action:'play',deviceId:'device-one',url:'https://evil.test'},{action:'volume',deviceId:'device-one',volume:101},{action:'pause',deviceId:'device-one',uri:'spotify:track:0123456789012345678901'}])await assert.rejects(spotifyControl(f.owner,{},body));assert.equal(f.calls.length,0);
});
test('reconnecting the same account does not revive commands already waiting in the queue',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=fixture(async url=>{if(url.endsWith('/devices'))return{status:200,data:{devices:[{id:'device-one'}]}};await gate;return{status:204,data:null};});
  const first=spotifyControl(f.owner,{}, {action:'next',deviceId:'device-one'});
  const waiting=spotifyControl(f.owner,{}, {action:'next',deviceId:'device-one'});
  await new Promise(resolve=>setImmediate(resolve));f.renew();release();
  const results=await Promise.allSettled([first,waiting]);assert.ok(results.every(result=>result.status==='rejected'));assert.equal(f.calls.length,2);
});
