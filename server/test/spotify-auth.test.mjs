import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccountStore, accountView } from '../src/account-store.mjs';
import { Vault } from '../src/store.mjs';
import { AppError } from '../src/errors.mjs';
import { Spotify } from '../src/spotify.mjs';

const TOKEN='https://accounts.spotify.com/api/token', PROFILE='https://api.spotify.com/v1/me', PLAYER=PROFILE+'/player';
const SCOPES=['streaming','user-read-email','user-read-private','user-modify-playback-state','user-read-playback-state'];
const OLD='fixture-access-before-refresh', NEXT='fixture-access-after-refresh', REFRESH='fixture-renewable-refresh-token';
const response=(status,data=null,headers={})=>new Response(status===204?null:JSON.stringify(data),{status,headers});
function fixture(t,handler=async()=>response(204)){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cb-spotify-auth-')),store=new AccountStore(directory),userId=randomUUID();
  const key=randomBytes(32),vault=new Vault(key),calls=[],state={now:1794300000000};
  store.run('INSERT INTO accounts(id,email,name,confirmed,is_admin,created_at) VALUES (?,?,?,?,?,?)',userId,'owner@fixture.invalid','Fixture owner',1,1,state.now);
  const session=(kind='browser')=>{
    const hash=randomBytes(32).toString('hex');
    store.run('INSERT INTO account_sessions VALUES (?,?,?,?,?,?,?)',hash,userId,kind,'fixture-csrf','fixture-session-only',state.now+86400_000,state.now);
    return {user:{id:userId},session:{hash,kind}};
  };
  const context=session();
  const accounts={store,vault,config:{publicOrigin:'https://spotify-fixture.invalid',encryptionKey:key},now:()=>state.now,limit(){},
    assertCurrent(ctx,{admin=false}={}){
      const user=store.get('SELECT * FROM accounts WHERE id=?',ctx?.user?.id||''),active=store.get('SELECT * FROM account_sessions WHERE hash=?',ctx?.session?.hash||'');
      if(!user?.confirmed||user.suspended||active?.user_id!==user.id||active.expires_at<=state.now)throw new AppError('auth','Fixture session revoked.',401);
      if(admin&&!user.is_admin)throw new AppError('forbidden','Fixture admin required.',403);
      return accountView(user);
    },async authenticateRequest(req){this.assertCurrent(req.context);return req.context;}
  };
  const spotify=new Spotify(accounts,{fetchImpl:async(url,options)=>{calls.push({url,options});return handler(url,options,calls.length);}});
  spotify.save(context,{clientId:'a'.repeat(32),clientSecret:'fixture-application-secret',expectedRevision:0});
  const seed=({expiresAt=state.now+3600_000,scope=SCOPES,accessToken=OLD}={})=>{
    const generation=spotify.invalidateUser(userId);
    store.run('INSERT INTO spotify_connections VALUES (?,?,?,?,?,?)',userId,generation,1,spotify.seal({accessToken,refreshToken:REFRESH,scope,profile:{id:'fixture-user',displayName:'Fixture'},expiresAt}),expiresAt,state.now);
    return generation;
  };
  const revoke=ctx=>store.run('DELETE FROM account_sessions WHERE hash=?',ctx.session.hash);
  t.after(()=>{store.close();const target=path.resolve(directory);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep+'cb-spotify-auth-'));fs.rmSync(target,{recursive:true,force:true});});
  return {spotify,store,context,session,seed,revoke,calls,state,userId};
}
function result(){return{headers:{},setHeader(key,value){this.headers[key]=value;},writeHead(status,headers={}){this.status=status;Object.assign(this.headers,headers);},end(value){this.body=value;}};}

test('browser PKCE callback binds state to its original session and accepts profiles without removed product/email fields',async t=>{
  const f=fixture(t,async(url,options)=>{
    if(url===TOKEN){const body=new URLSearchParams(options.body);assert.equal(body.get('grant_type'),'authorization_code');assert.equal(body.get('client_id'),'a'.repeat(32));assert.equal(body.get('redirect_uri'),'https://spotify-fixture.invalid/api/spotify/callback');assert.match(body.get('code_verifier'),/^[A-Za-z0-9_-]{43,128}$/);assert.equal(options.headers.Authorization,undefined);return response(200,{access_token:OLD,refresh_token:REFRESH,token_type:'Bearer',expires_in:3600,scope:SCOPES.join(' ')});}
    assert.equal(url,PROFILE);return response(200,{id:'fixture-spotify-user',display_name:'Fixture user'});
  });
  const login=f.spotify.connect(f.context,{}),url=new URL(login.authorizationUrl),callback=new URL('https://spotify-fixture.invalid/api/spotify/callback');
  assert.equal(url.origin,'https://accounts.spotify.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.match(url.searchParams.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
  callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','fixture-authorization-code');
  const wrong=result();await f.spotify.callback({context:f.session()},wrong,callback);assert.equal(wrong.headers.Location,'/media-player.html?spotify=error');assert.equal(f.calls.length,0);
  const correct=result();await f.spotify.callback({context:f.context},correct,callback);assert.equal(correct.headers.Location,'/media-player.html?spotify=connected');
  const status=f.spotify.status(f.context);assert.equal(status.connected,true);assert.equal(status.controllerReady,true);assert.equal(status.spotifyUser.product,null);
  const row=f.store.get('SELECT tokens FROM spotify_connections WHERE user_id=?',f.userId);assert.ok(!row.tokens.includes(OLD));assert.ok(!row.tokens.includes(REFRESH));
  const replay=result();await f.spotify.callback({context:f.context},replay,callback);assert.equal(replay.headers.Location,'/media-player.html?spotify=error');assert.equal(f.calls.length,2);
});
test('native sessions cannot begin or substitute a browser OAuth callback',async t=>{
  const f=fixture(t),native=f.session('native');f.seed();
  assert.throws(()=>f.spotify.connect(native,{}),error=>error.kind==='spotify_browser');assert.equal(f.spotify.status(f.context).connected,true);
  const start=f.spotify.connect(f.context,{}),state=new URL(start.authorizationUrl).searchParams.get('state');
  await f.spotify.callback({context:native},result(),new URL('https://spotify-fixture.invalid/api/spotify/callback?state='+state+'&code=fixture-code'));
  assert.equal(f.calls.length,0);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM spotify_logins').n,1);
});
test('an early 401 read refreshes once and retries with the renewed token',async t=>{
  const f=fixture(t,async(url,options)=>url===TOKEN?response(200,{access_token:NEXT,token_type:'Bearer',expires_in:3600}):options.headers.Authorization==='Bearer '+OLD?response(401,{error:{message:'expired'}}):response(200,{devices:[]}));f.seed();
  const read=await f.spotify.authorizedRequest(f.context,PLAYER+'/devices');assert.equal(read.status,200);assert.equal(f.calls.length,3);
  const tokenRequest=new URLSearchParams(f.calls[1].options.body);assert.equal(tokenRequest.get('grant_type'),'refresh_token');assert.equal(tokenRequest.get('refresh_token'),REFRESH);assert.equal(tokenRequest.get('client_id'),'a'.repeat(32));
  assert.equal(f.calls[1].options.headers.Authorization,undefined);assert.equal((await f.spotify.access(f.context)).accessToken,NEXT);
});
test('concurrent rejected-token reads share one refresh and retain the existing refresh token when omitted',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=fixture(t,async(url,options)=>{if(url===TOKEN){await gate;return response(200,{access_token:NEXT,token_type:'Bearer',expires_in:3600});}return options.headers.Authorization==='Bearer '+OLD?response(401,{error:{status:401}}):response(200,{devices:[]});});f.seed();
  const reads=[f.spotify.authorizedRequest(f.context,PLAYER),f.spotify.authorizedRequest(f.context,PLAYER+'/devices')];
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(call=>call.url===TOKEN).length,1);release();await Promise.all(reads);
  const grant=f.spotify.open(f.store.get('SELECT tokens FROM spotify_connections WHERE user_id=?',f.userId).tokens);assert.equal(grant.refreshToken,REFRESH);assert.deepEqual(grant.scope,SCOPES);
});
test('a successful concurrent refresh is preserved even if its initiating session logs out',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),secondToken='fixture-rotated-refresh-token';
  const f=fixture(t,async()=>{await gate;return response(200,{access_token:NEXT,refresh_token:secondToken,token_type:'Bearer',expires_in:3600});});f.seed({expiresAt:f.state.now+1000});
  const other=f.session(),pending=f.spotify.access(f.context);await new Promise(resolve=>setImmediate(resolve));f.revoke(f.context);release();
  await assert.rejects(pending,error=>error.kind==='auth');assert.equal((await f.spotify.access(other)).accessToken,NEXT);
  assert.equal(f.spotify.open(f.store.get('SELECT tokens FROM spotify_connections WHERE user_id=?',f.userId).tokens).refreshToken,secondToken);assert.equal(f.calls.length,1);
});
test('invalid_grant removes the unusable connection without another refresh attempt',async t=>{
  const f=fixture(t,async()=>response(400,{error:'invalid_grant',error_description:'provider-private-detail'}));f.seed({expiresAt:f.state.now});
  await assert.rejects(f.spotify.access(f.context),error=>error.kind==='spotify_reconnect'&&!error.message.includes('provider-private-detail'));
  assert.equal(f.spotify.status(f.context).connected,false);await assert.rejects(f.spotify.access(f.context));assert.equal(f.calls.length,1);
});
test('a second 401 after refresh disconnects only the failed grant',async t=>{
  const f=fixture(t,async url=>url===TOKEN?response(200,{access_token:NEXT,token_type:'Bearer',expires_in:3600}):response(401,{error:{status:401}}));f.seed();
  await assert.rejects(f.spotify.authorizedRequest(f.context,PLAYER),error=>error.kind==='spotify_reconnect');assert.equal(f.spotify.status(f.context).connected,false);assert.equal(f.calls.length,3);
});
test('playback mutations and ambiguous network failures are never automatically replayed',async t=>{
  for(const failure of [()=>response(401,{error:{status:401}}),()=>{throw Error('fixture network failure');}]){
    const f=fixture(t,async()=>failure());f.seed();
    await assert.rejects(f.spotify.authorizedRequest(f.context,PLAYER+'/next?device_id=device-one',{method:'POST'}));assert.equal(f.calls.length,1);
  }
});
test('disconnect during refresh cannot resurrect the old Spotify grant',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=fixture(t,async()=>{await gate;return response(200,{access_token:NEXT,token_type:'Bearer',expires_in:3600});});f.seed({expiresAt:f.state.now});
  const pending=f.spotify.access(f.context);await new Promise(resolve=>setImmediate(resolve));f.spotify.disconnect(f.context,{});release();
  await assert.rejects(pending,error=>error.kind==='spotify_disconnected');assert.equal(f.spotify.status(f.context).connected,false);
});
test('Retry-After throttles further provider requests and exposes a bounded remaining delay',async t=>{
  const f=fixture(t,async(_url,_options,count)=>count===1?response(429,{error:{status:429}}, {'retry-after':'12'}):response(200,{}));
  await assert.rejects(f.spotify.request(PLAYER),error=>error.kind==='spotify_rate_limited'&&error.retryAfterMs===12000);
  f.state.now+=3000;await assert.rejects(f.spotify.request(PLAYER+'/devices'),error=>error.retryAfterMs===9000);assert.equal(f.calls.length,1);
  await f.spotify.request(TOKEN);assert.equal(f.calls.length,2);f.state.now+=9000;await f.spotify.request(PLAYER);assert.equal(f.calls.length,3);
});
test('development quota errors are distinguished without exposing provider response text',async t=>{
  const f=fixture(t,async()=>response(429,{error:{reason:'QUOTA_EXCEEDED',message:'fixture-provider-secret'}}));
  await assert.rejects(f.spotify.request(PLAYER),error=>error.kind==='spotify_quota'&&error.retryAfterMs===60000&&!error.message.includes('fixture-provider-secret'));
  await assert.rejects(f.spotify.request(PROFILE),error=>error.kind==='spotify_quota');assert.equal(f.calls.length,1);
});
test('all playback endpoints report missing devices and restricted actions accurately',async t=>{
  for(const action of ['pause','next','previous','volume','shuffle','repeat','seek']){
    const extra={volume:'&volume_percent=50',shuffle:'&state=true',repeat:'&state=off',seek:'&position_ms=0'}[action]||'';
    const f=fixture(t,async()=>response(404,{error:{reason:'NO_ACTIVE_DEVICE'}}));
    await assert.rejects(f.spotify.request(PLAYER+'/'+action+'?device_id=device-one'+extra),error=>error.kind==='spotify_device');
  }
  const f=fixture(t,async()=>response(403,{error:{reason:'RESTRICTION_VIOLATED'}}));
  await assert.rejects(f.spotify.request(PLAYER+'/shuffle?device_id=device-one&state=true'),error=>error.kind==='spotify_restricted');
});
test('Spotify status and token responses are never cacheable',async t=>{
  const f=fixture(t);f.seed();const res=result();
  await f.spotify.handle({method:'GET',url:'/api/spotify/status',context:f.context},res);
  assert.equal(res.headers['Cache-Control'],'private, no-store');assert.equal(res.headers.Vary,'Cookie, Authorization');assert.equal(res.status,200);assert.ok(!res.body.includes(OLD));
});
