import test from 'node:test';
import {withCommunitySqlite} from './helpers/community-fixture-store.mjs';
import assert from 'node:assert/strict';
import { AdminCrowns } from '../src/admin-crowns.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT } from '../src/community-schema.mjs';
import { AppError } from '../src/errors.mjs';
const GUILD='900000000000000018', USER='900000000000000027', OWNER='900000000000000028', ROLE='900000000000000029', BOTROLE='900000000000000030';
const context={user:{id:'fixture-admin'}};
function setup() {
  const state={revoked:false,calls:[],hook:null,settings:{},audits:[]};
  const guild={id:GUILD,owner_id:OWNER,roles:[{id:GUILD,permissions:'0',position:0},{id:ROLE,permissions:'8',position:5},{id:BOTROLE,permissions:String(1n<<27n),position:10}]};
  const member={user:{id:USER,username:'Testadmin'},roles:[ROLE],nick:null};
  const owner={user:{id:OWNER,username:'Owner'},roles:[ROLE],nick:null};
  const store={setting:k=>state.settings[k],setSetting:(k,v)=>state.settings[k]=v,transaction(fn){const backup=structuredClone(state.settings);try{return fn();}catch(error){state.settings=backup;throw error;}},audit:(...args)=>state.audits.push(args)};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only'},accounts:{store,assertCurrent(ctx,{admin}){assert.equal(admin,true);if(!ctx||state.revoked)throw new AppError('auth','Anmeldung erforderlich.',401);}},discord:{async request(method,route,{payload}={}){
    state.calls.push({method,route,payload}); const override=await state.hook?.(method,route,payload);if(override!==undefined)return override;
    if(route==='/users/@me')return{id:BOT,bot:true};
    if(route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(route===`/guilds/${GUILD}/members/${BOT}`)return{user:{id:BOT,bot:true},roles:[BOTROLE]};
    if(method==='GET'&&route===`/guilds/${GUILD}/members/${USER}`)return structuredClone(member);
    if(method==='GET'&&route===`/guilds/${GUILD}/members/${OWNER}`)return structuredClone(owner);
    if(method==='GET'&&route.startsWith(`/guilds/${GUILD}/members?`))return structuredClone([member,owner]);
    if(method==='PATCH'&&route===`/guilds/${GUILD}/members/${USER}`){member.nick=payload.nick;return structuredClone(member);}
    throw Error('Unexpected fixture route');
  }}};
  withCommunitySqlite(service.accounts.store);
  service.communityControl=new CommunityControl(service);
  return{module:new AdminCrowns(service),service,state,guild,member,owner,writes:()=>state.calls.filter(row=>row.method!=='GET')};
}
test('crown list is read-only, admins visible and owner is honestly blocked',async()=>{
  const f=setup(),result=await f.module.run(context,'admincrown.list');
  assert.equal(result.members.length,2);assert.equal(result.members[0].canApply,true);assert.equal(result.members[1].canApply,false);assert.match(result.members[1].reason,/Serverbesitzer/);assert.equal(f.writes().length,0);
});
test('apply and removal restore a null original nickname and record audit',async()=>{
  const f=setup();const result=await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});
  assert.equal(result.member.name,'👑 Testadmin');assert.equal(result.member.managed,true);assert.equal(f.writes().length,1);
  const removed=await f.module.run(context,'admincrown.remove',{userId:USER,confirm:true});assert.equal(removed.member.nickname,null);assert.equal(f.writes()[1].payload.nick,null);assert.equal(f.state.audits.length,2);
});
test('missing confirmation, unknown action, invalid ID and cross-guild requests fail before changes',async()=>{
  const f=setup();await assert.rejects(f.module.run(null,'admincrown.list'),{status:401});
  for(const [action,payload] of [['admincrown.unknown',{}],['admincrown.apply',{userId:USER}],['admincrown.apply',{userId:'../x',confirm:true}],['admincrown.list',{guildId:USER}]])await assert.rejects(f.module.run(context,action,payload));
  assert.equal(f.writes().length,0);assert.equal(f.state.calls.length,0);
});
test('roles, owner, human administrator requirement and 32 codepoint limit are enforced',async()=>{
  const f=setup();await assert.rejects(f.module.run(context,'admincrown.apply',{userId:OWNER,confirm:true}));
  f.guild.roles[2].position=4;await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}));
  f.guild.roles[2].position=10;f.guild.roles[2].permissions='0';await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}));
  f.guild.roles[2].permissions=String(1n<<27n);f.member.roles=[];await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}));
  f.member.roles=[ROLE];f.member.user.bot=true;await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}));
  f.member.user.bot=false;f.member.nick='A'.repeat(31);await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}));assert.equal(f.writes().length,0);
});
test('existing crowns are not adopted or removed; external edits are preserved',async()=>{
  const f=setup();f.member.nick='👑 Existing';const result=await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});assert.equal(result.changed,false);
  await assert.rejects(f.module.run(context,'admincrown.remove',{userId:USER,confirm:true}));assert.equal(f.writes().length,0);
  f.member.nick='Own nickname';await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});f.member.nick='Changed elsewhere';
  await assert.rejects(f.module.run(context,'admincrown.remove',{userId:USER,confirm:true}));assert.equal(f.member.nick,'Changed elsewhere');assert.equal(f.writes().length,1);
});
test('revocation during the last read prevents PATCH and malformed responses are not success',async()=>{
  const f=setup();f.state.hook=(m,r)=>{if(m==='GET'&&r.endsWith('/'+USER))f.state.revoked=true;};
  await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}),{status:401});assert.equal(f.writes().length,0);
  f.state.revoked=false;f.state.hook=(m)=>m==='PATCH'?{user:{id:OWNER},nick:'👑 Wrong'}:undefined;
  await assert.rejects(f.module.run(context,'admincrown.apply',{userId:USER,confirm:true}),{status:502});assert.equal(Object.keys(f.state.settings).length,0);
});
test('revocation during a confirmed mutation does not claim failure or encourage retries',async()=>{
  const f=setup();f.state.hook=(m)=>{if(m==='PATCH')f.state.revoked=true;};
  const result=await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});assert.equal(result.changed,true);assert.equal(f.writes().length,1);
});
test('stored crown can be removed after admin privileges are removed',async()=>{
  const f=setup();await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});f.member.roles=[];
  const result=await f.module.run(context,'admincrown.remove',{userId:USER,confirm:true});assert.equal(result.changed,true);assert.equal(result.member.name,'Testadmin');
});
test('audit failure cannot discard the original nickname after a confirmed Discord change',async()=>{
  const f=setup();f.member.nick='Original';f.service.accounts.store.audit=()=>{throw Error('Audit unavailable');};
  const applied=await f.module.run(context,'admincrown.apply',{userId:USER,confirm:true});assert.equal(applied.member.managed,true);
  const removed=await f.module.run(context,'admincrown.remove',{userId:USER,confirm:true});assert.equal(removed.member.nickname,'Original');assert.equal(f.writes().length,2);
});
