import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlExtras, EXTRA_ACTIONS } from '../src/control-extras.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT } from '../src/community-schema.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', CHANNEL='900000000000000036', OTHER='900000000000000012', USER='900000000000000027', ROLE='900000000000000029', RULE='900000000000000039', MESSAGE='900000000000000042';
const admin={admin:true,user:{id:'fixture-admin'}};
const defaultSettings=()=>({name:'Geprüfter Wortfilter',enabled:false,keywords:['testword'],allowList:[],exemptRoleIds:[],exemptChannelIds:[],alertChannelId:'',blockMessage:''});
const audio=()=>({channelId:CHANNEL,name:'clip.ogg',mime:'audio/ogg',dataBase64:Buffer.concat([Buffer.from('OggS'),Buffer.alloc(28)]).toString('base64'),requestId:randomUUID(),confirm:true});
function fixture() {
  const storage=new Map(),calls=[],rules=[];
  const state={now:1_790_000_000_000,revoked:false,hook:null,prepareHook:null,prepared:0,flags:1<<14};
  const guild={id:GUILD,owner_id:OTHER,roles:[{id:GUILD,permissions:'0'},{id:ROLE,permissions:String(P.ADMINISTRATOR)}]};
  const channels=[{id:CHANNEL,guild_id:GUILD,name:'Team',type:0,permission_overwrites:[]}];
  const store={setting:key=>storage.get(key),setSetting:(key,value)=>storage.set(key,value),transaction(fn){const old=new Map(storage);try{return fn();}catch(e){storage.clear();for(const [k,v] of old)storage.set(k,v);throw e;}}};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only'},accounts:{store,assertCurrent(context,{admin:required}){assert.equal(required,true);if(!context?.admin||state.revoked)throw new AppError('auth','Keine Anmeldung.',401);}},discord:{async request(method,route,options={}){
    calls.push({method,route,...options});const replacement=await state.hook?.(method,route,options);if(replacement!==undefined)return replacement;
    if(route==='/users/@me')return{id:BOT,bot:true};
    if(route==='/oauth2/applications/@me')return{id:BOT,flags:state.flags};
    if(route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(route===`/guilds/${GUILD}/members/${BOT}`)return{user:{id:BOT,bot:true},roles:[ROLE]};
    if(route===`/guilds/${GUILD}/channels`)return structuredClone(channels);
    if(route===`/channels/${CHANNEL}`)return structuredClone(channels[0]);
    if(route===`/guilds/${GUILD}/auto-moderation/rules`){if(method==='GET')return structuredClone(rules);const rule={id:RULE,guild_id:GUILD,creator_id:BOT,...structuredClone(options.payload)};rules.push(rule);return rule;}
    if(route===`/guilds/${GUILD}/auto-moderation/rules/${RULE}`&&method==='PATCH'){Object.assign(rules[0],structuredClone(options.payload));return structuredClone(rules[0]);}
    if(route===`/channels/${CHANNEL}/messages`&&method==='POST')return{id:MESSAGE,channel_id:CHANNEL,author:{id:BOT,bot:true},flags:1<<13};
    throw Error('Unexpected fixture request: '+method+' '+route);
  }},botGateway:{lastIntents:131,status:()=>({ready:true}),voiceMembers:()=>[{userId:USER,channelId:CHANNEL,name:'Mitglied'}]}};
  service.communityControl=new CommunityControl(service,{now:()=>state.now});
  const options={now:()=>state.now,prepareAudio:async input=>{state.prepared++;await state.prepareHook?.(input);return{bytes:Buffer.from('encoded voice fixture'),mime:'audio/ogg',durationSeconds:2,waveform:'AQID'};}};
  let extras=new ControlExtras(service,options);
  const run=(action,payload={},context=admin)=>extras.run(context,action,{guildId:GUILD,...payload});
  const view=()=>run('extras.state');
  const list=()=>run('extras.automod.list');
  const save=async(patch={},input={})=>run('extras.automod.save',{ruleId:'',settings:{...defaultSettings(),...patch},expectedRevision:(await list()).revision,confirm:true,...input});
  let sequence=0;
  const event=(type,data)=>extras.gatewayEvent({op:0,t:type,s:++sequence,d:{guild_id:GUILD,...data}});
  const restart=()=>{extras=new ControlExtras(service,options);return extras;};
  return{get extras(){return extras;},service,state,guild,channels,rules,calls,storage,run,view,list,save,event,restart,mutations:()=>calls.filter(row=>row.method!=='GET')};
}

test('extras expose real empty histories without creating rules or sending messages',async()=>{
  const f=fixture(),state=await f.view();assert.equal(EXTRA_ACTIONS.length,4);assert.equal(state.voiceMembers.length,0);assert.equal(state.memberHistory.length,0);assert.equal(state.audio.lastAttempt,null);assert.equal(f.calls.length,0);
  await assert.rejects(f.run('extras.state',{},null),{status:401});await assert.rejects(f.run('extras.state',{guildId:OTHER}),{status:403});await assert.rejects(f.run('extras.state',{token:'bad'}));
});
test('voice snapshot has unknown start, moves and leaves count only observed intervals',async()=>{
  const f=fixture();f.event('GUILD_CREATE',{id:GUILD,channels:[{id:CHANNEL,name:'ARK'}],members:[{user:{id:USER,username:'Batto'}}],voice_states:[{user_id:USER,channel_id:CHANNEL}]});
  f.state.now+=12_000;let state=await f.view();assert.equal(state.voiceMembers[0].startKnown,false);assert.equal(state.voiceMembers[0].elapsedSeconds,12);assert.equal(state.voiceMembers[0].name,'Batto');
  f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:CHANNEL,self_mute:true});f.state.now+=8_000;f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:OTHER});
  state=await f.view();assert.equal(state.voiceHistory[0].seconds,20);assert.equal(state.voiceHistory[0].endKnown,true);assert.equal(state.voiceMembers[0].startKnown,true);
  f.state.now+=5_000;f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:null});state=await f.view();assert.equal(state.voiceMembers.length,0);assert.equal(state.voiceHistory[0].seconds,5);
});
test('restart and gateway gaps never pretend that users stayed connected',async()=>{
  const f=fixture();f.extras.connectionState('online');f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:CHANNEL});f.state.now+=10_000;f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:CHANNEL});f.state.now+=600_000;f.restart();
  let state=await f.view();assert.equal(state.voiceMembers.length,0);assert.equal(state.voiceHistory[0].seconds,10);assert.equal(state.voiceHistory[0].endKnown,false);
  f.extras.connectionState('resumed');state=await f.view();assert.equal(state.voiceMembers[0].startKnown,false);assert.equal(state.voiceMembers[0].elapsedSeconds,0);
  f.state.now+=1000;f.extras.connectionState('reconnecting');f.state.now+=600_000;f.event('VOICE_STATE_UPDATE',{user_id:USER,channel_id:CHANNEL});assert.equal((await f.view()).voiceMembers.length,0);
});
test('member history deduplicates dispatches, ignores other guilds and does not infer kicks',async()=>{
  const f=fixture(),packet={op:0,t:'GUILD_MEMBER_REMOVE',s:50,d:{guild_id:GUILD,user:{id:USER,username:'Member'}}};
  f.extras.gatewayEvent(packet);f.extras.gatewayEvent(packet);f.extras.gatewayEvent({...packet,s:51,d:{...packet.d,guild_id:OTHER}});f.event('GUILD_MEMBER_ADD',{user:{id:USER,username:'Member'}});
  const state=await f.view();assert.equal(state.memberHistory.length,2);assert.equal(state.memberHistory[1].reason,'left_or_removed');assert.equal(state.memberHistory[0].type,'join');
  for(let i=0;i<510;i++)f.event('GUILD_MEMBER_REMOVE',{user:{id:USER}});assert.equal((await f.view()).memberHistory.length,500);
});
test('member intent is requested only when officially permitted, without changing feature settings',async()=>{
  const f=fixture();f.service.communityControl.gatewayIntents=async()=>129;assert.equal(await f.extras.gatewayIntents(),131);f.state.flags=0;assert.equal(await f.extras.gatewayIntents(),129);assert.equal(f.mutations().length,0);
});
test('AutoMod creation and edit use actual rules with exact revision and no unrequested actions',async()=>{
  const f=fixture();const first=await f.save();assert.equal(first.rules[0].enabled,false);assert.equal(first.rules[0].editable,true);assert.equal(f.mutations()[0].payload.trigger_type,1);assert.deepEqual(f.mutations()[0].payload.actions,[{type:1,metadata:{}}]);
  const updated=await f.save({enabled:true,alertChannelId:CHANNEL},{ruleId:RULE});assert.equal(updated.rules[0].enabled,true);assert.equal(f.mutations()[1].method,'PATCH');assert.equal(f.mutations()[1].payload.actions[1].metadata.channel_id,CHANNEL);
  await assert.rejects(f.save({}, {ruleId:RULE,expectedRevision:first.revision}),{status:409});assert.equal(f.mutations().length,2);
});
test('AutoMod unknown settings, roles, channels, ownership and complex rules cannot be silently overwritten',async()=>{
  const f=fixture();for(const patch of [{keywords:[]},{keywords:Array(101).fill('word')},{exemptRoleIds:[OTHER]},{exemptChannelIds:[OTHER]},{alertChannelId:OTHER},{timeout:60}])await assert.rejects(f.save(patch));
  await f.save();f.rules[0].creator_id=USER;assert.equal((await f.list()).rules[0].editable,false);await assert.rejects(f.save({}, {ruleId:RULE}),{status:403});f.rules[0].creator_id=BOT;f.rules[0].trigger_metadata.regex_patterns=['x'];assert.equal((await f.list()).rules[0].editable,false);await assert.rejects(f.save({}, {ruleId:RULE}),{status:403});assert.equal(f.mutations().length,1);
});
test('AutoMod catches revocation, permission loss and revisions changing during reads',async()=>{
  const a=fixture();a.state.hook=(m,r)=>{if(r.endsWith('/channels'))a.state.revoked=true;};await assert.rejects(a.save(),{status:401});assert.equal(a.mutations().length,0);
  const b=fixture();b.state.hook=(m,r)=>{if(r.endsWith('/channels'))b.guild.roles[1].permissions='0';};await assert.rejects(b.save(),{status:403});assert.equal(b.mutations().length,0);
  const c=fixture(),revision=(await c.list()).revision;await c.save();await assert.rejects(c.save({}, {expectedRevision:revision}),{status:409});assert.equal(c.mutations().length,1);
});
test('uncertain AutoMod creation cannot create another copy after restart',async()=>{
  const f=fixture();f.state.hook=m=>{if(m==='POST')throw Error('network lost');};await assert.rejects(f.save());f.restart();f.state.hook=null;await assert.rejects(f.save(),{kind:'uncertain'});assert.equal(f.mutations().length,1);
});
test('a recovered AutoMod creation returns the exact observed rule instead of creating a duplicate',async()=>{
  const f=fixture();f.state.hook=(method,route,{payload})=>{if(method==='POST'){f.rules.push({id:RULE,guild_id:GUILD,creator_id:BOT,...payload});throw Error('lost response');}};
  await assert.rejects(f.save());f.restart();f.state.hook=null;const result=await f.save();assert.equal(result.rules[0].id,RULE);assert.equal(f.mutations().length,1);
});
test('audio sends actual multipart voice metadata and replay is idempotent, including parallel clicks',async()=>{
  const f=fixture(),input=audio();const results=await Promise.all([f.run('extras.audio.send',input),f.run('extras.audio.send',input)]);assert.equal(f.mutations().length,1);assert.equal(f.state.prepared,1);assert(results.every(row=>row.messageId===MESSAGE));
  const sent=f.mutations()[0];assert.equal(sent.imageMeta.mime,'audio/ogg');assert(Buffer.isBuffer(sent.imageBytes));assert.equal(sent.payload.flags,1<<13);assert.equal(sent.payload.attachments[0].duration_secs,2);assert.equal(sent.payload.attachments[0].waveform,'AQID');assert.equal(sent.payload.content,undefined);assert.deepEqual(sent.payload.allowed_mentions.parse,[]);assert.equal(sent.payload.enforce_nonce,true);assert(!Object.hasOwn(results[0],'fingerprint'));
  f.restart();await f.run('extras.audio.send',input);assert.equal(f.mutations().length,1);await assert.rejects(f.run('extras.audio.send',{...input,channelId:OTHER}),{status:409});
});
test('audio checks exact payloads, target membership and voice permissions before processing',async()=>{
  for(const mutate of [f=>f.channels[0].guild_id=OTHER,f=>f.channels[0].type=15,f=>f.guild.roles[1].permissions=String(P.VIEW_CHANNEL|P.SEND_MESSAGES|P.ATTACH_FILES)]){const f=fixture();mutate(f);await assert.rejects(f.run('extras.audio.send',audio()));assert.equal(f.state.prepared,0);assert.equal(f.mutations().length,0);}
  const f=fixture();await assert.rejects(f.run('extras.audio.send',{...audio(),durationSeconds:20}));await assert.rejects(f.run('extras.audio.send',{...audio(),confirm:false}));assert.equal(f.calls.length,0);
});
test('audio rechecks administrator and permissions after expensive conversion',async()=>{
  const a=fixture();a.state.prepareHook=()=>{a.state.revoked=true;};await assert.rejects(a.run('extras.audio.send',audio()),{status:401});assert.equal(a.mutations().length,0);
  const b=fixture();b.state.prepareHook=()=>{b.guild.roles[1].permissions='0';};await assert.rejects(b.run('extras.audio.send',audio()),{status:403});assert.equal(b.mutations().length,0);
});
test('audio uncertain response remains blocked across restart; definite rejection permits explicit retry',async()=>{
  const a=fixture(),input=audio();a.state.hook=m=>{if(m==='POST')throw Error('secret=must-not-leak');};await assert.rejects(a.run('extras.audio.send',input));a.restart();a.state.hook=null;await assert.rejects(a.run('extras.audio.send',input),{kind:'uncertain'});assert.equal(a.mutations().length,1);assert.equal((await a.view()).audio.lastAttempt.status,'uncertain');assert.doesNotMatch((await a.view()).audio.lastAttempt.error,/must-not-leak/);
  const b=fixture(),retry=audio();b.state.hook=m=>{if(m==='POST')throw new AppError('forbidden','Verweigert',403);};await assert.rejects(b.run('extras.audio.send',retry));b.state.hook=null;await b.run('extras.audio.send',retry);assert.equal(b.mutations().length,2);
});
