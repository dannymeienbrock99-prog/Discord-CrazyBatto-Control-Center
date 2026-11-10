import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRoles, DEVICE_ROLES } from '../src/device-roles.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT } from '../src/community-schema.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', CHANNEL='900000000000000036', USER='900000000000000027', BOTROLE='900000000000000051', MESSAGE='900000000000000039';
const context={user:{id:'admin-fixture'}}, keys=Object.keys(DEVICE_ROLES), roleIds=Object.fromEntries(keys.map((key,i)=>[key,String(900000000000000029n+BigInt(i))]));
function fixture() {
  const storage=new Map(), calls=[], members=new Map([[USER,{user:{id:USER},roles:[],pending:false}]]);
  const state={hook:null,revoked:false,failPatch:false};
  const guild={id:GUILD,name:'Test',owner_id:'900000000000000041',features:[],roles:[{id:GUILD,name:'@everyone',permissions:String(P.VIEW_CHANNEL),position:0},...keys.map((key,i)=>({id:roleIds[key],name:DEVICE_ROLES[key].label,permissions:'0',position:i+1,managed:false,icon:null,unicode_emoji:null})),{id:BOTROLE,name:'Bot',permissions:String(P.ADMINISTRATOR),position:20,managed:true}]};
  const channel={id:CHANNEL,guild_id:GUILD,type:0,name:'geräte',permission_overwrites:[]};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only'},accounts:{store:{setting:key=>storage.get(key),setSetting:(key,value)=>storage.set(key,value),transaction:fn=>fn()},assertCurrent(ctx,{admin}={}){assert.equal(admin,true);if(!ctx||state.revoked)throw new AppError('auth','Bitte anmelden.',401);}},discord:{async request(method,route,{payload}={}){
    calls.push({method,route,payload:structuredClone(payload)});
    const override=await state.hook?.(method,route,payload);if(override!==undefined)return override;
    if(route==='/users/@me')return{id:BOT,bot:true};
    if(method==='GET'&&route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(method==='GET'&&route===`/guilds/${GUILD}/members/${BOT}`)return{user:{id:BOT,bot:true},roles:[BOTROLE]};
    if(method==='GET'&&route===`/channels/${CHANNEL}`)return structuredClone(channel);
    if(method==='GET'&&route===`/guilds/${GUILD}/members/${USER}`)return structuredClone(members.get(USER));
    if(['PUT','DELETE'].includes(method)&&route.includes(`/members/${USER}/roles/`)){const roleId=route.split('/').at(-1),member=members.get(USER);member.roles=method==='PUT'?[...new Set([...member.roles,roleId])]:member.roles.filter(id=>id!==roleId);return null;}
    if(method==='PATCH'&&route.startsWith(`/guilds/${GUILD}/roles/`)){if(state.failPatch)throw new Error('Network response lost');const role=guild.roles.find(row=>row.id===route.split('/').at(-1));Object.assign(role,payload);return structuredClone(role);}
    if(method==='POST'&&route===`/channels/${CHANNEL}/messages`)return{id:MESSAGE,channel_id:CHANNEL};
    if(method==='PATCH'&&route===`/channels/${CHANNEL}/messages/${MESSAGE}`)return{id:MESSAGE,channel_id:CHANNEL};
    if(method==='PATCH'&&route.startsWith('/webhooks/'))return null;
    throw Error('Unexpected fixture request '+method+' '+route);
  }}};
  const community=service.communityControl=new CommunityControl(service),roles=service.deviceRoles=new DeviceRoles(service);
  const config=()=>({revision:roles.data().revision,mapping:{...roleIds},channelId:CHANNEL,enabled:true,confirm:true});
  const setup=async()=>{await roles.run(context,'roles.save',config());await roles.run(context,'roles.publish',{confirm:true});calls.length=0;};
  let seq=900000000000000042n;
  const interaction=(key='pc',overrides={})=>({id:String(seq++),application_id:BOT,guild_id:GUILD,channel_id:CHANNEL,member:{user:{id:USER}},message:{id:MESSAGE},token:'fixture-interaction-token-12345678',type:3,data:{custom_id:'cbdevices:'+key},...overrides});
  const drain=()=>Promise.allSettled([...community.pending]);
  const mutations=()=>calls.filter(call=>['POST','PUT','PATCH','DELETE'].includes(call.method)&&!call.route.startsWith('/webhooks/'));
  return{roles,community,service,guild,channel,state,storage,calls,members,config,setup,interaction,drain,mutations};
}

test('role state suggests only unique normalized names and describes icon availability accurately',async()=>{
  const f=fixture();f.guild.roles.find(r=>r.id===roleIds.pc).name='🖥️ PC';
  let value=await f.roles.run(context,'roles.state');assert.equal(value.suggestions.pc,roleIds.pc);assert.equal(value.iconFeature,false);assert.equal(value.iconMode,'role-name');assert.match(value.iconMessage,/nicht automatisch/);
  f.guild.features=['ROLE_ICONS'];f.guild.roles.push({...f.guild.roles.find(r=>r.id===roleIds.pc),id:'900000000000000052'});
  value=await f.roles.run(context,'roles.state');assert.equal(value.suggestions.pc,'');assert.equal(value.iconMode,'role-icon');assert.equal(f.mutations().length,0);
});
test('save requires current admin, confirmation, revision and complete unique mapping',async()=>{
  const f=fixture();await assert.rejects(f.roles.run(null,'roles.state'),{status:401});
  await assert.rejects(f.roles.run(context,'roles.save',{...f.config(),confirm:false}));
  await assert.rejects(f.roles.run(context,'roles.save',{...f.config(),guildId:CHANNEL}),{status:403});
  await assert.rejects(f.roles.run(context,'roles.save',{...f.config(),mapping:{...roleIds,xbox:roleIds.pc}}));
  await assert.rejects(f.roles.run(context,'roles.save',{...f.config(),mapping:{...roleIds,extra:''}}));
  await f.roles.run(context,'roles.save',f.config());await assert.rejects(f.roles.run(context,'roles.save',{...f.config(),revision:0}),{status:409});
  assert.equal(f.mutations().length,0);
});
test('device mappings reject any rights, special names, managed or above-bot roles and foreign channels',async()=>{
  for(const mutate of [f=>f.guild.roles.find(r=>r.id===roleIds.pc).permissions='1024',f=>f.guild.roles.find(r=>r.id===roleIds.pc).name='👑 King',f=>f.guild.roles.find(r=>r.id===roleIds.pc).name='🛡️ Moderator',f=>f.guild.roles.find(r=>r.id===roleIds.pc).managed=true,f=>f.guild.roles.find(r=>r.id===roleIds.pc).position=21,f=>f.channel.guild_id=CHANNEL]){
    const f=fixture();mutate(f);await assert.rejects(f.roles.run(context,'roles.save',f.config()));assert.equal(f.roles.data().revision,0);assert.equal(f.mutations().length,0);
  }
});
test('revocation during configuration reads prevents saved changes',async()=>{
  const f=fixture();f.state.hook=(method,route)=>{if(route==='/channels/'+CHANNEL)f.state.revoked=true;};
  await assert.rejects(f.roles.run(context,'roles.save',f.config()),{status:401});assert.equal(f.roles.data().revision,0);
});
test('decoration preserves permissions and other attributes and reports above-bot moderator separately',async()=>{
  const f=fixture();const king=f.guild.roles.find(r=>r.id===roleIds.king),mod=f.guild.roles.find(r=>r.id===roleIds.moderator);king.permissions='8';king.color=1234;king.hoist=true;mod.position=27;
  await f.roles.run(context,'roles.save',f.config());let value=await f.roles.run(context,'roles.decorate',{confirm:true});
  assert.equal(value.applied,6);assert.equal(value.decorations.find(r=>r.key==='moderator').status,'not-applied');assert.equal(king.name,'👑 King');assert.equal(king.permissions,'8');assert.equal(king.color,1234);assert.equal(king.hoist,true);
  for(const write of f.mutations())assert.deepEqual(Object.keys(write.payload),['name']);
  f.calls.length=0;value=await f.roles.run(context,'roles.decorate',{confirm:true});assert.equal(value.applied,0);assert.equal(f.mutations().length,0);assert.equal(value.decorations.find(r=>r.key==='king').status,'unchanged');
});
test('real icon decoration only sends supported icon fields; unconfirmed mutation is never called applied',async()=>{
  const f=fixture();f.guild.features=['ROLE_ICONS'];await f.roles.run(context,'roles.save',f.config());
  let value=await f.roles.run(context,'roles.decorate',{confirm:true});assert.equal(value.applied,7);
  assert.deepEqual(f.mutations()[0].payload,{unicode_emoji:'🖥️',icon:null});assert.equal(f.guild.roles.find(r=>r.id===roleIds.king).name,'King');
  f.guild.roles.find(r=>r.id===roleIds.pc).unicode_emoji=null;f.state.failPatch=true;
  value=await f.roles.run(context,'roles.decorate',{confirm:true});assert.equal(value.applied,0);assert.equal(value.decorations.find(r=>r.key==='pc').status,'uncertain');
});
test('published panel has exactly five fixed device buttons, and republication edits its own known message',async()=>{
  const f=fixture();await f.roles.run(context,'roles.save',f.config());await f.roles.run(context,'roles.publish',{confirm:true});
  const sent=f.mutations().find(c=>c.method==='POST');assert.equal(sent.payload.components[0].components.length,5);assert.deepEqual(sent.payload.components[0].components.map(b=>b.custom_id),['pc','playstation','xbox','smartphone','switch'].map(k=>'cbdevices:'+k));assert.deepEqual(sent.payload.allowed_mentions.parse,[]);
  f.calls.length=0;await f.roles.run(context,'roles.publish',{confirm:true});assert.equal(f.mutations().length,1);assert.equal(f.mutations()[0].method,'PATCH');assert.equal(f.mutations()[0].route,`/channels/${CHANNEL}/messages/${MESSAGE}`);
});
test('device toggle adds and removes only its configured role; replay does not repeat mutation',async()=>{
  const f=fixture();await f.setup();f.members.get(USER).roles=[roleIds.king,roleIds.xbox];
  const event=f.interaction();assert.equal(f.roles.interaction(event).type,5);f.roles.interaction(event);await f.drain();
  assert.deepEqual(f.members.get(USER).roles,[roleIds.king,roleIds.xbox,roleIds.pc]);assert.equal(f.mutations().length,1);assert.equal(f.mutations()[0].method,'PUT');
  f.roles.interaction(f.interaction());await f.drain();assert.deepEqual(f.members.get(USER).roles,[roleIds.king,roleIds.xbox]);assert.equal(f.mutations()[1].method,'DELETE');
});
test('forged key, another message/channel/guild, DM or wrong type cannot toggle roles',async()=>{
  const f=fixture();await f.setup();
  for(const event of [f.interaction('king'),f.interaction('moderator'),f.interaction(roleIds.king),f.interaction('pc',{message:{id:CHANNEL}}),f.interaction('pc',{channel_id:MESSAGE}),f.interaction('pc',{guild_id:CHANNEL}),f.interaction('pc',{member:null}),f.interaction('pc',{type:2})])assert.equal(f.roles.interaction(event).type,4);
  assert.equal(f.roles.interaction({data:{custom_id:'another:module'}}),null);await f.drain();assert.equal(f.mutations().length,0);
});
test('pending membership screening blocks signed or freshly fetched member without bypass',async()=>{
  const f=fixture();await f.setup();assert.equal(f.roles.interaction(f.interaction('pc',{member:{user:{id:USER},pending:true}})).type,4);
  f.members.get(USER).pending=true;f.roles.interaction(f.interaction());await f.drain();assert.equal(f.mutations().length,0);assert(f.calls.some(c=>c.route.startsWith('/webhooks/')&&c.payload.content.includes('Beitrittsprüfung')));
});
test('stale panel is invalid after saving and permissions changed during lookup prevent grants',async()=>{
  const f=fixture();await f.setup();await f.roles.run(context,'roles.save',f.config());assert.equal(f.roles.interaction(f.interaction()).type,4);
  await f.roles.run(context,'roles.publish',{confirm:true});f.calls.length=0;
  f.state.hook=(method,route)=>{if(method==='GET'&&route===`/guilds/${GUILD}/members/${USER}`)f.guild.roles.find(r=>r.id===roleIds.pc).permissions='8';};
  f.roles.interaction(f.interaction());await f.drain();assert.equal(f.mutations().length,0);
});
test('mapping changed during lookup cannot grant previous configured role',async()=>{
  const f=fixture();await f.setup();f.state.hook=(method,route)=>{if(method==='GET'&&route===`/guilds/${GUILD}/members/${USER}`)f.roles.mutate(d=>{d.revision++;d.enabled=false;});};
  f.roles.interaction(f.interaction());await f.drain();assert.equal(f.mutations().length,0);
});
test('parallel interactions for one actor serialize toggles and preserve unrelated roles',async()=>{
  const f=fixture();await f.setup();f.members.get(USER).roles=[roleIds.king];
  f.roles.interaction(f.interaction());f.roles.interaction(f.interaction());await f.drain();
  assert.deepEqual(f.mutations().map(c=>c.method),['PUT','DELETE']);assert.deepEqual(f.members.get(USER).roles,[roleIds.king]);
});
test('role operation whose readback disagrees is privately uncertain, never claimed selected',async()=>{
  const f=fixture();await f.setup();f.state.hook=(method,route)=>method==='PUT'&&route.includes('/roles/')?null:undefined;
  f.roles.interaction(f.interaction());await f.drain();const response=f.calls.find(c=>c.route.startsWith('/webhooks/'));
  assert.match(response.payload.content,/nicht eindeutig bestätigt/);assert.doesNotMatch(response.payload.content,/ausgewählt/);
});
test('uncertain publication never automatically posts a second panel',async()=>{
  const f=fixture();await f.roles.run(context,'roles.save',f.config());f.state.hook=(method,route)=>{if(method==='POST'&&route.endsWith('/messages'))throw Error('Response lost');};
  await assert.rejects(f.roles.run(context,'roles.publish',{confirm:true}));assert.equal(f.roles.data().publishAttempt.status,'uncertain');
  const writes=f.mutations().length;await assert.rejects(f.roles.run(context,'roles.publish',{confirm:true}),{status:409});assert.equal(f.mutations().length,writes);
});
