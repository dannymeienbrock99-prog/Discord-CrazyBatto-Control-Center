import test from 'node:test';
import {withCommunitySqlite} from './helpers/community-fixture-store.mjs';
import assert from 'node:assert/strict';
import { JoinRole, JOIN_ROLE_ACTIONS } from '../src/join-role.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT } from '../src/community-schema.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', USER='900000000000000027', OTHER='900000000000000028', ROLE='900000000000000029', BOTROLE='900000000000000051', HIGH='900000000000000056';
const context={user:{id:'fixture-admin'}};
function fixture() {
  let clock=1900000000000;
  const storage=new Map(),calls=[],members=new Map(),timers=new Set();
  const state={hook:null,revoked:false,applicationFlags:1<<15,ready:true};
  const guild={id:GUILD,owner_id:OTHER,features:['MEMBER_VERIFICATION_GATE_ENABLED'],roles:[
    {id:GUILD,name:'@everyone',permissions:String(P.VIEW_CHANNEL),position:0},
    {id:ROLE,name:'Mitglied',permissions:'1236920587112001',position:19,managed:false},
    {id:BOTROLE,name:'Crazy Bot',permissions:String(P.ADMINISTRATOR),position:21,managed:true},
    {id:HIGH,name:'High',permissions:'0',position:22,managed:false},
  ]};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only'},guildSettings:()=>({moderatorRoleId:null}),deviceRoles:{data:()=>({mapping:{}})},
    accounts:{store:{setting:key=>storage.get(key),setSetting:(key,value)=>storage.set(key,value),transaction:fn=>fn()},assertCurrent(ctx,{admin}={}){assert.equal(admin,true);if(!ctx||state.revoked)throw new AppError('auth','Bitte anmelden.',401);}},
    discord:{async request(method,route,{payload}={}){
      calls.push({method,route,payload:structuredClone(payload)});
      const override=await state.hook?.(method,route,payload);if(override!==undefined)return override;
      if(route==='/users/@me')return{id:BOT,bot:true};
      if(route==='/oauth2/applications/@me')return{id:BOT,flags:state.applicationFlags};
      if(method==='GET'&&route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
      if(method==='GET'&&route===`/guilds/${GUILD}/members/${BOT}`)return{user:{id:BOT,bot:true},roles:[BOTROLE]};
      const userId=route.match(/\/members\/(\d+)/)?.[1];
      if(method==='GET'&&members.has(userId))return structuredClone(members.get(userId));
      if(method==='GET'&&userId)throw new AppError('forbidden','Nicht mehr auf dem Server.',404);
      if(method==='PUT'&&route===`/guilds/${GUILD}/members/${userId}/roles/${ROLE}`){const member=members.get(userId);member.roles=[...new Set([...member.roles,ROLE])];return null;}
      throw Error('Unexpected fixture request '+method+' '+route);
    }},botGateway:{running:true,lastIntents:131,membersIntentRejected:false,status:()=>({ready:state.ready}),retries:[],retry(delay,options){state.ready=false;this.retries.push({delay,options});}},
  };
  withCommunitySqlite(service.accounts.store);
  const community=service.communityControl=new CommunityControl(service,{now:()=>clock});community.runtime.membersIntentAllowed=true;
  const make=()=>new JoinRole(service,{now:()=>clock,setTimer(callback){const timer={callback,unref(){}};timers.add(timer);return timer;},clearTimer:timer=>timers.delete(timer)});
  const join=service.autoJoinRole=make();
  const config=(overrides={})=>({guildId:GUILD,expectedRevision:join.data().revision,settings:{enabled:true,roleId:ROLE},confirm:true,...overrides});
  const enable=async()=>{await join.run(context,'joinrole.save',config());calls.length=0;};
  const add=(userId=USER,overrides={})=>{const member={user:{id:userId,username:'New Member'},roles:[],pending:false,joined_at:new Date(clock).toISOString(),...overrides};members.set(userId,member);return{op:0,t:'GUILD_MEMBER_ADD',d:{guild_id:GUILD,...structuredClone(member)}};};
  const update=(userId=USER,overrides={})=>({op:0,t:'GUILD_MEMBER_UPDATE',d:{guild_id:GUILD,...structuredClone(members.get(userId)),...overrides}});
  const puts=()=>calls.filter(call=>call.method==='PUT');
  const drain=()=>Promise.allSettled([...join.pending]);
  return{service,join,community,state,guild,storage,calls,members,timers,make,config,enable,add,update,puts,drain,advance:ms=>{clock+=ms;},now:()=>clock};
}

test('default state is disabled, lists role eligibility, and never assigns existing members',async()=>{
  const f=fixture(),before=await f.join.run(context,'joinrole.state');
  assert.deepEqual(JOIN_ROLE_ACTIONS,['joinrole.state','joinrole.save']);assert.equal(before.settings.enabled,false);assert.equal(before.runtime.phase,'disabled');assert.equal(f.join.requiredMembers(),false);
  assert.equal(before.roles.find(r=>r.id===ROLE).eligible,true);assert.equal(before.roles.find(r=>r.id===HIGH).eligible,false);
  await f.join.gatewayEvent(f.add());await f.join.tick();assert.equal(f.puts().length,0);assert.equal(f.join.data().records.length,0);
});

test('only a current administrator with confirmation and current revision may change settings',async()=>{
  const f=fixture();await assert.rejects(f.join.run(null,'joinrole.state'),{status:401});
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({confirm:false})));
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({guildId:USER})),{status:403});
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({unexpected:true})));
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({settings:{enabled:true,roleId:''}})));
  await f.enable();assert.equal(f.join.requiredMembers(),true);
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({expectedRevision:0})),{status:409});assert.equal(f.puts().length,0);
  f.state.hook=(method,route)=>{if(route===`/guilds/${GUILD}?with_counts=true`)f.state.revoked=true;};
  await assert.rejects(f.join.run(context,'joinrole.save',f.config({settings:{enabled:false,roleId:ROLE}})),{status:401});assert.equal(f.join.data().settings.enabled,true);
});

test('privileged, managed, high, King, Moderator and configured rules or staff roles are ineligible',async()=>{
  const changes=[f=>f.guild.roles[1].permissions='8',f=>f.guild.roles[1].permissions=String(1n<<60n),f=>f.guild.roles[1].managed=true,f=>f.guild.roles[1].position=21,
    f=>f.guild.roles[1].name='👑 King',f=>f.guild.roles[1].name='🛡️ Moderator',f=>f.service.deviceRoles.data=()=>({mapping:{king:ROLE}}),f=>f.service.guildSettings=()=>({moderatorRoleId:ROLE}),
    f=>f.community.mutate(d=>{d.settings.rules.roleId=ROLE;}),f=>f.community.mutate(d=>{d.settings.tickets.staffRoleIds=[ROLE];}),f=>f.community.mutate(d=>{d.settings.reports.staffRoleIds=[ROLE];})];
  for(const change of changes){const f=fixture();change(f);await assert.rejects(f.join.run(context,'joinrole.save',f.config()),{status:403});assert.equal(f.join.data().revision,0);assert.equal(f.puts().length,0);}
});

test('settings can still be disabled after the bot loses role permissions',async()=>{
  const f=fixture();await f.enable();f.guild.roles.find(r=>r.id===BOTROLE).permissions='0';
  const checked=await f.join.run(context,'joinrole.state');assert.equal(checked.runtime.phase,'attention');assert.equal(checked.runtime.roleEligible,false);assert.match(checked.runtime.message,/Rollen verwalten/);
  const value=await f.join.run(context,'joinrole.save',f.config({settings:{enabled:false,roleId:ROLE}}));assert.equal(value.settings.enabled,false);assert.equal(f.puts().length,0);
});

test('intent status is honest and changing configuration requests only a controlled reconnect',async()=>{
  const f=fixture();f.state.applicationFlags=0;f.community.runtime.membersIntentAllowed=false;f.service.botGateway.lastIntents=129;await f.enable();
  let value=await f.join.run(context,'joinrole.state');assert.equal(value.runtime.phase,'intent_required');assert.equal(value.runtime.membersIntentActive,false);
  await f.join.gatewayEvent(f.add());assert.equal(f.puts().length,0);
  f.community.runtime.membersIntentAllowed=true;f.state.applicationFlags=1<<15;
  f.community.gatewayIntents=async()=>131;
  await f.join.run(context,'joinrole.save',f.config());assert.equal(f.service.botGateway.retries.length,1);assert.equal(f.service.botGateway.retries[0].options.reset,true);
  f.service.botGateway.membersIntentRejected=true;f.service.botGateway.lastIntents=131;
  value=await f.join.run(context,'joinrole.state');assert.equal(value.runtime.phase,'connecting');assert.equal(value.runtime.membersIntentActive,false);assert.equal(f.service.botGateway.membersIntentRejected,false);
  f.service.botGateway.membersIntentRejected=true;
  value=await f.join.run(context,'joinrole.state');assert.equal(value.runtime.phase,'intent_required');assert.equal(f.service.botGateway.retries.length,2,'Repeated status reads must not bypass the retry cooldown');
});

test('a confirmed fresh new join receives only the selected role and a readback confirms success',async()=>{
  const f=fixture();await f.enable();const event=f.add(USER,{roles:['900000000000000057']});await f.join.gatewayEvent(event);
  assert.equal(f.puts().length,1);assert.equal(f.puts()[0].route,`/guilds/${GUILD}/members/${USER}/roles/${ROLE}`);assert.equal(f.puts()[0].payload,undefined);
  assert.deepEqual(f.members.get(USER).roles,['900000000000000057',ROLE]);assert.equal(f.join.data().records[0].status,'assigned');assert.equal(f.join.data().lastSuccessAt,f.now());
  await f.join.gatewayEvent(event);await f.join.gatewayEvent(f.update());assert.equal(f.puts().length,1);
  f.members.get(USER).roles=[];await f.join.gatewayEvent(f.update());await f.join.tick();assert.equal(f.puts().length,1,'A later manual role removal must not be reversed');
});

test('pending members wait, only a known join update can continue, and fresh REST pending wins',async()=>{
  const f=fixture();await f.enable();const event=f.add(USER,{pending:true});await f.join.gatewayEvent(event);assert.equal(f.puts().length,0);assert.equal(f.join.data().records[0].status,'waiting');
  await f.join.gatewayEvent(f.update(USER,{pending:false}));assert.equal(f.puts().length,0,'A gateway claim cannot override fresh REST screening');
  f.members.get(USER).pending=false;await f.join.gatewayEvent(f.update());assert.equal(f.puts().length,1);assert.equal(f.join.data().records[0].status,'assigned');
  f.add(OTHER,{pending:false});await f.join.gatewayEvent(f.update(OTHER));assert.equal(f.puts().length,1,'An untracked member update is never a join');
});

test('missing pending fields stay unconfirmed and cannot silently become a membership grant',async()=>{
  const f=fixture();await f.enable();const event=f.add(USER,{pending:undefined});await f.join.gatewayEvent(event);await f.join.tick();
  assert.equal(f.puts().length,0);assert.equal(f.join.data().records[0].status,'waiting');
  await f.join.gatewayEvent(f.update(USER,{pending:false}));assert.equal(f.puts().length,0);
});

test('foreign guilds, bots, owner, high members, old joins, future timestamps and GUILD_CREATE cannot trigger grants',async()=>{
  const f=fixture();await f.enable();
  for(const event of [f.add(USER,{joined_at:new Date(f.now()-1).toISOString()}),f.add(USER,{joined_at:new Date(f.now()+60000).toISOString()}),f.add(USER,{user:{id:USER,bot:true}}),{...f.add(),d:{...f.add().d,guild_id:OTHER}},{...f.add(),t:'GUILD_CREATE'}])await f.join.gatewayEvent(event);
  assert.equal(f.puts().length,0);assert.equal(f.join.data().records.length,0);
  await f.join.gatewayEvent(f.add(OTHER));assert.equal(f.puts().length,0);
  await f.join.gatewayEvent(f.add(USER,{roles:[HIGH]}));assert.equal(f.puts().length,0);
  const stale=fixture();await stale.enable();stale.advance(10*60000);await stale.join.gatewayEvent(stale.add(USER,{joined_at:new Date(stale.now()-6*60000).toISOString()}));assert.equal(stale.puts().length,0);assert.equal(stale.join.data().records.length,0);
});

test('leaving cancels a waiting join and an actual rejoin has a distinct tracked identity',async()=>{
  const f=fixture();await f.enable();await f.join.gatewayEvent(f.add(USER,{pending:true}));
  await f.join.gatewayEvent({op:0,t:'GUILD_MEMBER_REMOVE',d:{guild_id:GUILD,user:{id:USER}}});f.members.get(USER).pending=false;
  await f.join.gatewayEvent(f.update());assert.equal(f.puts().length,0);assert.equal(f.join.data().records[0].status,'departed');
  f.advance(1000);await f.join.gatewayEvent(f.add());assert.equal(f.puts().length,1);
});

test('role or target changes during reads prevent stale grants',async()=>{
  for(const change of [f=>f.guild.roles[1].permissions='8',f=>f.members.get(USER).pending=true,f=>f.members.get(USER).joined_at=new Date(f.now()+1000).toISOString(),f=>f.service.deviceRoles.data=()=>({mapping:{moderator:ROLE}})]){
    const f=fixture();await f.enable();f.state.hook=(method,route)=>{if(method==='GET'&&route===`/guilds/${GUILD}/members/${USER}`)change(f);};
    await f.join.gatewayEvent(f.add());assert.equal(f.puts().length,0);
  }
});

test('configuration changes in flight cancel the older role policy',async()=>{
  const f=fixture();await f.enable();let changed=false;
  f.state.hook=async(method,route)=>{if(!changed&&route===`/guilds/${GUILD}/members/${USER}`){changed=true;await f.join.run(context,'joinrole.save',f.config({settings:{enabled:false,roleId:ROLE}}));}};
  await f.join.gatewayEvent(f.add());assert.equal(f.puts().length,0);assert.equal(f.join.data().records[0].status,'cancelled');
});

test('already present roles are unchanged and overlapping duplicate events perform one PUT',async()=>{
  const present=fixture();await present.enable();await present.join.gatewayEvent(present.add(USER,{roles:[ROLE]}));assert.equal(present.puts().length,0);assert.equal(present.join.data().records[0].status,'already_present');
  const f=fixture();await f.enable();const event=f.add();await Promise.all([f.join.gatewayEvent(event),f.join.gatewayEvent(event),f.join.gatewayEvent(f.update())]);assert.equal(f.puts().length,1);
});

test('lost role confirmation and failed readback remain uncertain and are never blindly repeated',async()=>{
  for(const mode of ['timeout','readback','missing','malformed']){
    const f=fixture();await f.enable();let sent=false;
    f.state.hook=(method,route)=>{if(method==='PUT'){sent=true;if(mode==='timeout')throw new AppError('uncertain','Response lost',502);if(mode==='missing')return null;}if(sent&&route===`/guilds/${GUILD}/members/${USER}`){if(mode==='readback')throw new AppError('network','Readback failed',502);if(mode==='malformed')return{...f.members.get(USER),roles:ROLE};}};
    await f.join.gatewayEvent(f.add());assert.equal(f.join.data().records[0].status,'uncertain');assert.equal(f.join.data().lastSuccessAt,null);
    f.advance(3600000);await f.join.tick();await f.join.gatewayEvent(f.update());assert.equal(f.puts().length,1);
  }
});

test('portal permission changes are picked up by state and periodic checks without saving the role again',async()=>{
  for(const refresh of ['state','tick']){
    const f=fixture();f.state.applicationFlags=0;f.community.runtime.membersIntentAllowed=false;f.service.botGateway.lastIntents=129;await f.enable();
    const revision=f.join.data().revision;f.state.applicationFlags=1<<15;f.service.botGateway.membersIntentRejected=true;f.advance(60000);
    if(refresh==='state')await f.join.run(context,'joinrole.state');else await f.join.tick();
    assert.equal(f.join.data().revision,revision);assert.equal(f.community.runtime.membersIntentAllowed,true);assert.equal(f.service.botGateway.membersIntentRejected,false);assert.equal(f.service.botGateway.retries.length,1);assert.equal(f.puts().length,0);
  }
});

test('bounded retries only retry requests known not to have changed the role',async()=>{
  const f=fixture();await f.enable();f.state.hook=(method,route)=>{if(route===`/guilds/${GUILD}/members/${USER}`)throw new AppError('network','Lookup failed',502);};
  await f.join.gatewayEvent(f.add());assert.equal(f.join.data().records[0].status,'queued');
  for(let i=0;i<3;i++){f.advance(60000);await f.join.tick();}
  assert.equal(f.join.data().records[0].status,'failed');assert.equal(f.join.data().records[0].attempts,3);assert.equal(f.puts().length,0);
});

test('restart retains known waiting joins but converts an interrupted write to uncertain',async()=>{
  const f=fixture();await f.enable();await f.join.gatewayEvent(f.add(USER,{pending:true}));
  const restarted=f.make();f.members.get(USER).pending=false;restarted.start();await Promise.allSettled([...restarted.pending]);
  assert.equal(f.puts().length,1);await restarted.stop();assert.equal(f.timers.size,0);
  const interrupted=fixture();await interrupted.enable();await interrupted.join.gatewayEvent(interrupted.add(USER,{pending:true}));interrupted.join.mutate(data=>{data.records[0].status='assigning';});
  const recovered=interrupted.make();recovered.start();await Promise.allSettled([...recovered.pending]);assert.equal(recovered.data().records[0].status,'uncertain');assert.equal(interrupted.puts().length,0);await recovered.stop();
});

test('shutdown and retention expiry prevent unfinished role jobs from being applied',async()=>{
  const f=fixture();await f.enable();await f.join.gatewayEvent(f.add(USER,{pending:true}));await f.join.stop();f.members.get(USER).pending=false;await f.join.gatewayEvent(f.update());assert.equal(f.puts().length,0);
  const old=fixture();await old.enable();await old.join.gatewayEvent(old.add(USER,{pending:true}));old.advance(8*86400000);old.members.get(USER).pending=false;await old.join.tick();assert.equal(old.puts().length,0);assert.equal(old.join.data().records[0].status,'expired');
});
