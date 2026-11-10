import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {AccountService} from '../src/accounts.mjs';
import {ControlMembers} from '../src/control-members.mjs';
import {PCSupport} from '../src/pc-support.mjs';
import {sha256} from '../src/store.mjs';

const ORIGIN='https://crazybatto.test',CSRF='fixture-review-csrf';
const draft=()=>({requestId:crypto.randomUUID(),category:'hardware',subject:'Diagnose gewünscht',symptoms:'Der Computer bleibt während des Starts stehen.',specs:{cpu:'Unbekannt',gpu:'Unbekannt',mainboard:'Unbekannt',ram:'Unbekannt',os:'Windows',psu:'Unbekannt'},drivers:'unknown',imageIds:[],order:{requested:false,offerCents:null,contact:{email:'',phone:''},consent:false}});
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'control-accounts-test-')),users=new Map(),now=Date.now();
  const identity={configured:true,async user(access){const user=users.get(access);assert(user,'Unknown fixture identity');return user;},async logout(){}};
  const config={dataDir:directory,encryptionKey:crypto.randomBytes(32),publicOrigin:ORIGIN,clientId:'900000000000000002',discordGuildId:'900000000000000018',botToken:'fixture-only',musicStorageUrl:'',musicStorageToken:''};
  const accounts=new AccountService(config,{identity,now:()=>now,storage:{configured:false},imageStorage:{configured:false}});
  const seed=({admin=false,kind='native'}={})=>{
    const id=crypto.randomUUID(),access='fixture-access-'+id,raw={id,email:id+'@fixture.test',email_confirmed_at:new Date(now).toISOString(),user_metadata:{name:'Fixture Member'}};users.set(access,raw);accounts.mirror(accounts.identityUser(raw),true);if(admin)accounts.store.run('UPDATE accounts SET is_admin=1 WHERE id=?',id);
    const token=crypto.randomBytes(36).toString('base64url');accounts.store.run('INSERT INTO account_sessions VALUES (?,?,?,?,?,?,?)',sha256(token),id,kind,CSRF,JSON.stringify(accounts.vault.seal({accessToken:access,refreshToken:'fixture-refresh',expiresAt:now+3600000})),now+86400000,now);
    return{id,token,kind,raw};
  };
  const admin=seed({admin:true}),legacy=seed(),browser=seed({admin:true,kind:'browser'});
  const members=accounts.controlMembers=new ControlMembers(accounts),fresh=seed();
  const service={accounts,config},support=new PCSupport(service);
  const request=(who,{method='GET',body,csrf=CSRF,route='/api/account/session'}={})=>{
    const bytes=body===undefined?null:Buffer.from(JSON.stringify(body)),req=Readable.from(bytes?[bytes]:[]);
    Object.assign(req,{method,url:route,socket:{remoteAddress:'fixture'},headers:{...(who?(who.kind==='native'?{authorization:'Bearer '+who.token,'x-client-type':'native'}:{cookie:'__Host-cb_account='+who.token,origin:ORIGIN,'x-csrf-token':csrf}):{}),...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}});return req;
  };
  const call=async(module,who,options)=>{const req=request(who,options),res={writeHead(status,headers){this.status=status;this.headers=headers;},setHeader(name,value){this.headers||={};this.headers[name]=value;},end(value){this.raw=value;this.body=value?JSON.parse(String(value)):null;}};await module.handle(req,res);return res;};
  t.after(()=>{accounts.close();const full=path.resolve(directory);assert(full.startsWith(path.resolve(os.tmpdir())+path.sep+'control-accounts-test-'));fs.rmSync(full,{recursive:true,force:true});});
  return{accounts,members,support,admin,legacy,browser,fresh,seed,request,call};
}

test('real account approval gate preserves legacy access but denies protected requests for newly mirrored users',async t=>{
  const f=fixture(t);assert.equal(f.members.status(f.legacy.id).status,'approved');assert.equal(f.members.status(f.fresh.id).status,'pending');
  const existing=await f.accounts.authenticateRequest(f.request(f.legacy));assert.equal(existing.user.id,f.legacy.id);
  await assert.rejects(f.accounts.authenticateRequest(f.request(f.fresh)),error=>error.status===403&&/registration/.test(error.kind));
  const status=await f.call(f.members,f.fresh,{route:'/api/account/approval'});assert.equal(status.status,200);assert.equal(status.body.approval.status,'pending');
  const session=await f.call(f.accounts,f.fresh,{route:'/api/account/session'});assert.equal(session.status,200);assert.equal(session.body.user.id,f.fresh.id);
  const denied=await f.call(f.support,f.fresh,{route:'/api/account/pc-support',method:'POST',body:draft()});assert.equal(denied.status,403);
});
test('real administrator review allows the same pending session after approval and does not grant app or admin rights',async t=>{
  const f=fixture(t),review={expectedRevision:0,decision:'approve',reason:'',confirm:true};
  const approved=await f.call(f.members,f.admin,{route:'/api/admin/control-members/'+f.fresh.id+'/review',method:'POST',body:review});assert.equal(approved.status,200);assert.equal(approved.body.member.approval.status,'approved');assert.equal(approved.body.member.isAdmin,false);
  const context=await f.accounts.authenticateRequest(f.request(f.fresh));assert.equal(context.user.id,f.fresh.id);assert.throws(()=>f.accounts.appAllowed(context.user,'discord-app'),{status:403});
  const created=await f.call(f.support,f.fresh,{route:'/api/account/pc-support',method:'POST',body:draft()});assert.equal(created.status,201);
  const stale=await f.call(f.members,f.admin,{route:'/api/admin/control-members/'+f.fresh.id+'/review',method:'POST',body:review});assert.equal(stale.status,409);
});
test('real browser CSRF and current administrator flag protect reviews and private member lists',async t=>{
  const f=fixture(t),route='/api/admin/control-members/query';
  assert.equal((await f.call(f.members,f.browser,{route,method:'POST',body:{},csrf:'wrong'})).status,403);
  assert.equal((await f.call(f.members,f.legacy,{route,method:'POST',body:{}})).status,403);
  assert.equal((await f.call(f.members,null,{route,method:'POST',body:{}})).status,401);
  const current=await f.call(f.members,f.browser,{route,method:'POST',body:{}});assert.equal(current.status,200);assert.equal(current.body.members.length,4);
  f.accounts.store.run('UPDATE accounts SET is_admin=0 WHERE id=?',f.browser.id);assert.equal((await f.call(f.members,f.browser,{route,method:'POST',body:{}})).status,403);
});
test('rejected registration can see its decision and log out while all old app authorizers deny it',async t=>{
  const f=fixture(t),admin=await f.accounts.authenticateRequest(f.request(f.admin));f.members.review(admin,f.fresh.id,{expectedRevision:0,decision:'reject',reason:'Bitte Rückfrage klären',confirm:true});
  const status=await f.call(f.members,f.fresh,{route:'/api/account/approval'});assert.equal(status.status,200);assert.equal(status.body.approval.status,'rejected');
  f.accounts.store.run("INSERT INTO app_requests(id,user_id,app_id,status,note,created_at) VALUES (?,?,'discord-app','approved','',?)",crypto.randomUUID(),f.fresh.id,Date.now());
  const context=await f.accounts.verifySession(sha256(f.fresh.token),'native');
  assert.throws(()=>f.accounts.assertNativeAuthorization(context,'discord-app'),{kind:'registration_rejected'});
  assert.throws(()=>f.accounts.assertCurrent(context),{kind:'registration_rejected'});
  assert.throws(()=>f.accounts.appAllowed(context.user,'discord-app'),{kind:'registration_rejected'});
  await assert.rejects(f.accounts.authorizeNativeApp(f.fresh.token,'discord-app'),{status:403});
  const logout=await f.call(f.accounts,f.fresh,{route:'/api/account/logout',method:'POST',body:{}});assert.equal(logout.status,200);assert.equal(f.accounts.store.get('SELECT hash FROM account_sessions WHERE hash=?',sha256(f.fresh.token)),undefined);
});
