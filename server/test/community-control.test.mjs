import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountStore } from '../src/account-store.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT, communityDefaults, validateSection } from '../src/community-schema.mjs';
import { DiscordControl } from '../src/discord-control.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', CHANNEL='900000000000000036', INBOX='900000000000000012', CATEGORY='900000000000000011';
const USER='900000000000000027', TARGET='900000000000000028', STAFF='900000000000000029', ROLE='900000000000000030', BOTROLE='900000000000000038';
const MESSAGE='900000000000000039', COMMAND='900000000000000040';
const context={user:{id:'admin-fixture'}};
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'community-v3-test-')), store=new AccountStore(dir);
  const state={now:Date.parse('2026-11-09T10:00:00Z'), revoked:false, calls:[], hook:null, flags:16384, calendar:[{name:'Alex',day:10,month:11,daysUntil:1}], ready:true};
  const guild={id:GUILD,name:'Fixture Community',owner_id:'900000000000000041',approximate_member_count:42,roles:[{id:GUILD,permissions:String(P.VIEW_CHANNEL),position:0},{id:STAFF,permissions:'0',position:3},{id:ROLE,permissions:'0',position:2},{id:BOTROLE,permissions:String(P.ADMINISTRATOR),position:10}]};
  const channels={
    [CHANNEL]:{id:CHANNEL,guild_id:GUILD,type:0,name:'community',permission_overwrites:[]},
    [INBOX]:{id:INBOX,guild_id:GUILD,type:0,name:'private-inbox',permission_overwrites:[{id:GUILD,type:0,allow:'0',deny:String(P.VIEW_CHANNEL)},{id:STAFF,type:0,allow:String(P.VIEW_CHANNEL),deny:'0'}]},
    [CATEGORY]:{id:CATEGORY,guild_id:GUILD,type:4,name:'tickets',permission_overwrites:[]},
  };
  const accounts={store,assertCurrent(ctx,{admin}={}){assert.equal(admin,true);if(!ctx||state.revoked)throw new AppError('auth','Bitte anmelden.',401);},async authenticateRequest(req,{requireAdmin}){assert.equal(requireAdmin,true);if(!req.headers.authorization)throw new AppError('auth','Bitte anmelden.',401);this.assertCurrent(context,{admin:true});return context;},limit(){}};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-bot-token-never-output'},accounts,birthdays:{calendar:()=>({entries:state.calendar})},botGateway:{status:()=>({ready:state.ready,phase:state.ready?'online':'waiting'}),voiceMembers:()=>[{userId:TARGET,name:'Target',channelId:CHANNEL,mute:false}],applyVoiceControl(userId,operation){state.voiceOperation={userId,operation};}},discord:{async request(method,route,{payload}={}){
    state.calls.push({method,route,payload:structuredClone(payload)});
    const override=await state.hook?.(method,route,payload);if(override!==undefined)return override;
    if(route==='/users/@me')return {id:BOT,username:'Crazy_Batto',bot:true};
    if(route==='/oauth2/applications/@me')return{id:BOT,flags:state.flags};
    if(route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(method==='GET'&&route.startsWith(`/guilds/${GUILD}/members/`)){const id=route.split('/').at(-1);return{user:{id,username:id===TARGET?'Target':'Member',avatar:'a'.repeat(32)},roles:id===BOT?[BOTROLE]:[ROLE]};}
    if(method==='GET'&&route.startsWith('/channels/'))return structuredClone(channels[route.split('/').at(-1)]);
    if(method==='POST'&&route.endsWith('/commands'))return{id:COMMAND,name:payload.name};
    if(method==='POST'&&route.endsWith('/messages'))return{id:MESSAGE,channel_id:route.split('/')[2]};
    if(method==='POST'&&route===`/guilds/${GUILD}/channels`){channels['900000000000000014']={id:'900000000000000014',guild_id:GUILD,...payload};return structuredClone(channels['900000000000000014']);}
    if(['PUT','PATCH','DELETE'].includes(method))return null;
    throw new Error('Unexpected fixture request');
  }}};
  const community=service.communityControl=new CommunityControl(service,{now:()=>state.now});
  t.after(async()=>{await community.stop();store.close();assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'community-v3-test-'));fs.rmSync(dir,{recursive:true,force:true});});
  const seed=(section,values)=>community.mutate(d=>{Object.assign(d.settings[section],values);});
  const writes=()=>state.calls.filter(c=>c.method!=='GET');
  const interaction=(data,type=3)=>({id:'900000000000000042',application_id:BOT,guild_id:GUILD,channel_id:CHANNEL,member:{user:{id:USER}},message:{id:MESSAGE},token:'fixture_interaction_token_123456789',type,data});
  const panel=section=>community.mutate(d=>{d.publications[section]={channelId:CHANNEL,messageId:MESSAGE,roleId:ROLE};});
  const reportPicker=()=>community.interaction(interaction({custom_id:'cb3:report:select',values:[TARGET]}));
  const reportForm=(category='beleidigung')=>{const picker=reportPicker();return community.interaction(interaction({custom_id:picker.data.components[0].components[0].custom_id,component_type:3,values:[category]}));};
  const drain=()=>Promise.allSettled([...community.pending]);
  return{service,community,state,guild,channels,seed,writes,interaction,panel,reportPicker,reportForm,drain,store};
}

test('defaults separate Welcome, safe image, meaningful rules and reject inherited/unknown fields',()=>{
  const d=communityDefaults();assert.match(d.welcome.imageUrl,/dragon-gold-welcome\.png$/);assert.equal(d.welcome.enabled,false);assert.match(d.rules.description,/8\. Respektiere/);
  assert.throws(()=>validateSection('__proto__',{}));assert.throws(()=>validateSection('welcome',{botToken:'x'}));assert.throws(()=>validateSection('birthday',{limit:21}));assert.throws(()=>validateSection('welcome',{imageUrl:'https://user:password@example.test/x'}));
});
test('admin context, fixed identity, guild and operation fail closed without Discord changes',async t=>{
  const f=setup(t);await assert.rejects(f.community.run(null,'community.state'),{status:401});await assert.rejects(f.community.run(context,'community.unknown'));
  await assert.rejects(f.community.run(context,'community.state',{guildId:CHANNEL}),{status:403});f.service.config.clientId=TARGET;await assert.rejects(f.community.run(context,'community.state'),{status:503});assert.equal(f.writes().length,0);
});
test('save rechecks real atomic revision and revoked admin after network reads',async t=>{
  const f=setup(t);await f.community.run(context,'community.save',{section:'birthday',settings:{channelId:CHANNEL},revision:0});assert.equal(f.community.state().revision,1);
  await assert.rejects(f.community.run(context,'community.save',{section:'birthday',settings:{},revision:0}),{status:409});
  f.state.hook=(m,r)=>{if(r==='/channels/'+CHANNEL)f.state.revoked=true;};
  await assert.rejects(f.community.run(context,'community.save',{section:'birthday',settings:{channelId:CHANNEL,title:'Revoked'},revision:1}),{status:401});assert.notEqual(f.community.state().settings.birthday.title,'Revoked');
});
test('private report inbox rejects public access and foreign channels',async t=>{
  const f=setup(t);await assert.rejects(f.community.save(context,{section:'reports',settings:{enabled:true,channelId:CHANNEL,staffRoleIds:[STAFF]},revision:0}),{status:403});
  f.channels[INBOX].guild_id=CHANNEL;await assert.rejects(f.community.save(context,{section:'reports',settings:{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]},revision:0}),{status:403});assert.equal(f.writes().length,0);
});
test('rules button refuses all moderation, server-management and unknown permissions',async t=>{
  const f=setup(t),auth=await f.community.authority(context),role=auth.guild.roles.find(r=>r.id===ROLE);
  for(const bit of [1,2,3,4,5,7,8,13,17,19,22,23,24,27,28,29,30,33,34,40,41,43,44,47,48,51,52,63]) {
    role.permissions=String(1n<<BigInt(bit));
    assert.throws(()=>f.community.roleAssignable(auth,ROLE),{status:403},'unsafe permission bit '+bit);
  }
  role.permissions=String(P.VIEW_CHANNEL|P.SEND_MESSAGES|P.READ_MESSAGE_HISTORY|(1n<<20n)|(1n<<21n));
  assert.doesNotThrow(()=>f.community.roleAssignable(auth,ROLE));assert.equal(f.writes().length,0);
  f.guild.roles.find(r=>r.id===ROLE).permissions=String(1n<<40n);
  f.seed('rules',{enabled:true,channelId:CHANNEL,roleId:ROLE});f.panel('rules');
  f.community.interaction(f.interaction({custom_id:'cb3:rules:yes'}));await f.drain();assert(!f.writes().some(c=>c.method==='PUT'));
});
test('private inbox rejects a human role shared with the bot; only tagged dedicated bot role is exempt',async t=>{
  const f=setup(t),auth=await f.community.authority(context,0n,INBOX);
  auth.member.roles.push(ROLE);auth.channel.permission_overwrites.push({id:ROLE,type:0,allow:String(P.VIEW_CHANNEL),deny:'0'});
  assert.throws(()=>f.community.privateInbox(auth,[STAFF]),{status:403});
  const role=auth.guild.roles.find(r=>r.id===ROLE);role.managed=true;
  assert.throws(()=>f.community.privateInbox(auth,[STAFF]),{status:403});
  role.tags={bot_id:TARGET};assert.throws(()=>f.community.privateInbox(auth,[STAFF]),{status:403});
  role.tags={bot_id:BOT};assert.doesNotThrow(()=>f.community.privateInbox(auth,[STAFF]));
  assert.equal(f.writes().length,0);
});
test('member intent only added after matching application flag, always preserves Voice129',async t=>{
  const f=setup(t);assert.equal(await f.community.gatewayIntents(),129);assert.equal(f.state.calls.length,0);f.seed('welcome',{enabled:true,channelId:CHANNEL});
  for(const flags of [0,16384,32768]){f.state.flags=flags;assert.equal(await f.community.gatewayIntents(),flags?131:129);}
  f.state.hook=(m,r)=>r==='/oauth2/applications/@me'?{id:TARGET,flags:16384}:undefined;assert.equal(await f.community.gatewayIntents(),129);
  f.state.hook=()=>{throw new Error('fixture-secret');};assert.equal(await f.community.gatewayIntents(),129);assert(!JSON.stringify(f.community.state()).includes('fixture-secret'));
});
test('automatic Welcome uses actual avatar and deduplicates joins across reload',async t=>{
  const f=setup(t);f.seed('welcome',{enabled:true,channelId:CHANNEL});const packet={op:0,t:'GUILD_MEMBER_ADD',d:{guild_id:GUILD,joined_at:'2026-11-09T10:00:00Z',user:{id:USER,username:'Joined',avatar:'a'.repeat(32)}}};
  f.community.gatewayEvent(packet);f.community.gatewayEvent(packet);await f.drain();const posts=f.writes();assert.equal(posts.length,1);assert.match(posts[0].payload.embeds[0].thumbnail.url,new RegExp(USER));assert.deepEqual(posts[0].payload.allowed_mentions.users,[USER]);
  new CommunityControl(f.service).gatewayEvent(packet);f.community.gatewayEvent({...packet,d:{...packet.d,guild_id:CHANNEL}});assert.equal(f.writes().length,1);
});
test('rules No is private without kick; Yes grants only configured safe role',async t=>{
  const f=setup(t);f.seed('rules',{enabled:true,channelId:CHANNEL,roleId:ROLE});f.panel('rules');
  const no=f.community.interaction(f.interaction({custom_id:'cb3:rules:no'}));assert.equal(no.data.flags,64);assert.equal(f.writes().length,0);
  const yes=f.community.interaction(f.interaction({custom_id:'cb3:rules:yes'}));assert.equal(yes.type,5);await f.drain();assert(f.writes().some(c=>c.method==='PUT'&&c.route.endsWith(`/members/${USER}/roles/${ROLE}`)));assert(!f.writes().some(c=>c.method==='DELETE'));
});
test('rules changed during network reads cannot grant old role',async t=>{
  const f=setup(t);f.seed('rules',{enabled:true,channelId:CHANNEL,roleId:ROLE});f.panel('rules');f.state.hook=(m,r)=>{if(r.endsWith('/members/'+USER))f.seed('rules',{enabled:false});};
  f.community.interaction(f.interaction({custom_id:'cb3:rules:yes'}));await f.drain();assert(!f.writes().some(c=>c.method==='PUT'));
});
test('report modal has mandatory reason, bound actor and per-person form rate',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');
  const picker=f.reportPicker();assert.equal(picker.type,4);assert.equal(picker.data.flags,64);assert.equal(picker.data.components[0].components[0].type,3);
  const form=f.community.interaction(f.interaction({custom_id:picker.data.components[0].components[0].custom_id,component_type:3,values:['beleidigung']}));assert.equal(form.type,9);assert.equal(form.data.components[0].components[0].required,true);
  const blank=f.community.interaction(f.interaction({custom_id:form.data.custom_id,components:[]},5));assert.equal(blank.type,4);assert.equal(f.community.data().reports.length,0);
  for(let i=0;i<4;i++)assert.equal(f.reportPicker().data.components[0].components[0].type,3);assert.equal(f.reportPicker().data.components,undefined);assert.equal(f.community.data().forms.length,5);
});
test('valid report submission is private, stores reason and duplicate interaction cannot create twice',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');const form=f.reportForm('spam');
  const event=f.interaction({custom_id:form.data.custom_id,components:[{components:[{custom_id:'reason',value:'Wiederholte gezielte Beleidigung im Chat.'}]}]},5);
  assert.equal(f.community.interaction(event).type,5);f.community.interaction(event);await f.drain();const reports=f.community.data().reports;assert.equal(reports.length,1);assert.match(reports[0].reason,/Beleidigung/);assert.equal(reports[0].category,'spam');assert.equal(reports[0].categoryLabel,'Spam');assert(f.writes().some(c=>c.route===`/channels/${INBOX}/messages`&&c.payload.embeds[0].fields.some(field=>field.name==='Art des Vorfalls'&&field.value==='Spam')));assert(!JSON.stringify(f.community.state()).includes(event.token));
});
test('report categories persist across restart and cannot be changed through forged modal fields',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');const picker=f.reportPicker(),select=picker.data.components[0].components[0];
  assert.deepEqual(select.options.map(item=>item.value),['beleidigung','belaestigung','spam','betrug','regelverstoss','sonstiges']);assert.deepEqual(picker.data.allowed_mentions,{parse:[]});
  const restarted=new CommunityControl(f.service,{now:()=>f.state.now});const form=restarted.interaction(f.interaction({custom_id:select.custom_id,component_type:3,values:['betrug']}));assert.equal(form.type,9);
  const stored=restarted.data().forms[0];assert.equal(stored.targetId,TARGET);assert.equal(stored.actorId,USER);assert.equal(stored.guildId,GUILD);assert.equal(stored.channelId,CHANNEL);assert.equal(stored.category,'betrug');
  const values=[{custom_id:'reason',value:'Ein nachvollziehbarer vertraulicher Grund.'},{custom_id:'category',value:'spam'}];
  const refused=restarted.interaction(f.interaction({custom_id:form.data.custom_id,components:[{components:values}]},5));assert.equal(refused.type,4);assert.equal(restarted.data().reports.length,0);assert.equal(f.writes().length,0);await restarted.stop();
});
test('report category choices reject foreign actors, channels, guilds, unknown values, bypass and replay',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');const select=f.reportPicker().data.components[0].components[0],choice={custom_id:select.custom_id,component_type:3,values:['spam']};
  const attempts=[{...f.interaction(choice),member:{user:{id:TARGET}}},{...f.interaction(choice),channel_id:INBOX},{...f.interaction(choice),guild_id:CHANNEL},f.interaction({...choice,values:['constructor']}),f.interaction({...choice,values:['spam','betrug']}),f.interaction({...choice,component_type:5}),f.interaction({custom_id:'cb3:form:'+select.custom_id.split(':').at(-1),components:[{components:[{custom_id:'reason',value:'Dies ist ein erfundener direkter Einstieg.'}]}]},5)];
  for(const attempt of attempts){const refused=f.community.interaction(attempt);assert.equal(refused.type,4);assert.equal(refused.data.components,undefined);assert.equal(f.community.data().forms[0].kind,'report-category');}
  assert.equal(f.community.interaction(f.interaction(choice)).type,9);assert.equal(f.community.interaction(f.interaction(choice)).type,4);assert.equal(f.community.data().forms.length,1);assert.equal(f.writes().length,0);
});
test('expired category choices and replaced report panels cannot open or submit stale modals',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');const picker=f.reportPicker(),choice={custom_id:picker.data.components[0].components[0].custom_id,component_type:3,values:['regelverstoss']};
  f.state.now+=15*60_000;assert.equal(f.community.interaction(f.interaction(choice)).type,4);
  const form=f.reportForm('sonstiges');f.community.mutate(d=>d.publications.reports.messageId=COMMAND);
  const result=f.community.interaction(f.interaction({custom_id:form.data.custom_id,components:[{components:[{custom_id:'reason',value:'Diese frühere Karte wurde inzwischen ersetzt.'}]}]},5));assert.equal(result.type,4);await f.drain();assert.equal(f.community.data().reports.length,0);assert.equal(f.writes().length,0);
});
test('legacy in-flight report forms keep their reason without inventing a category',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});const nonce='a'.repeat(24);
  f.community.mutate(d=>{d.forms.push({nonce,actorId:USER,targetId:TARGET,kind:'report',expiresAt:f.state.now+60000});d.reports.push({id:'old-record',targetId:TARGET,reason:'Bestehende Meldung',status:'open'});});
  assert.equal(f.community.interaction(f.interaction({custom_id:'cb3:form:'+nonce,components:[{components:[{custom_id:'reason',value:'Dieses Formular wurde vor dem Update geöffnet.'}]}]},5)).type,5);await f.drain();
  const records=f.community.data().reports;assert.equal(records.length,2);assert.equal(records[0].category,null);assert.equal(records[0].categoryLabel,'Nicht angegeben');assert.equal(records[1].reason,'Bestehende Meldung');assert.equal(records[1].category,undefined);
});
test('report expiry and inbox disablement are rechecked before deferred work can persist a report',async t=>{
  const f=setup(t);f.seed('reports',{enabled:true,channelId:INBOX,staffRoleIds:[STAFF]});f.panel('reports');let form=f.reportForm('belaestigung');
  const submit=form=>f.interaction({custom_id:form.data.custom_id,components:[{components:[{custom_id:'reason',value:'Ein ausreichender Grund mit konkreten Angaben.'}]}]},5);
  assert.equal(f.community.interaction(submit(form)).type,5);f.state.now+=15*60_000;await f.drain();assert.equal(f.community.data().reports.length,0);
  form=f.reportForm('spam');f.state.hook=(method,route)=>{if(method==='GET'&&route===`/guilds/${GUILD}/members/${TARGET}`)f.seed('reports',{enabled:false});};
  const event=submit(form);event.id='900000000000000043';assert.equal(f.community.interaction(event).type,5);await f.drain();assert.equal(f.community.data().reports.length,0);assert.equal(f.writes().filter(call=>call.method==='POST').length,0);
});
test('moderation requires confirmation and hierarchy, succeeds even if audit write fails',async t=>{
  const f=setup(t);f.community.mutate(d=>d.reports.push({id:'r1',targetId:TARGET,status:'open'}));const payload={reportId:'r1',operation:'ban',reason:'Geprüfter schwerer Regelverstoß',confirm:true};
  await assert.rejects(f.community.moderate(context,{...payload,confirm:false}));f.guild.roles.find(r=>r.id===ROLE).position=20;await assert.rejects(f.community.moderate(context,payload),{status:403});assert.equal(f.writes().length,0);
  f.guild.roles.find(r=>r.id===ROLE).position=2;f.store.audit=()=>{throw new Error('fixture audit unavailable');};await f.community.moderate(context,payload);assert.equal(f.community.data().reports[0].status,'resolved');const ban=f.writes().find(c=>c.method==='PUT');assert.deepEqual(ban.payload,{delete_message_seconds:0});await assert.rejects(f.community.moderate(context,payload));assert.equal(f.writes().length,1);
});
test('uncertain moderation remains visible and blocks repeated mutation',async t=>{
  const f=setup(t);f.community.mutate(d=>d.reports.push({id:'r2',targetId:TARGET,status:'open'}));f.state.hook=m=>{if(m==='DELETE')throw new AppError('uncertain','Unklar.',502);};const p={reportId:'r2',operation:'kick',reason:'Geprüfter Grund',confirm:true};
  await assert.rejects(f.community.moderate(context,p));await assert.rejects(f.community.moderate(context,p));assert.equal(f.community.data().reports[0].status,'uncertain');assert.equal(f.writes().length,1);
});
test('tickets explicitly restrict everyone, deduplicate per member and close retains read-only channel',async t=>{
  const f=setup(t);f.seed('tickets',{enabled:true,channelId:CHANNEL,categoryId:CATEGORY,staffRoleIds:[STAFF]});await f.community.openTicket(f.interaction({}),'Hilfe','Ich brauche bitte Unterstützung.');await f.community.openTicket(f.interaction({}),'Hilfe','Ich brauche bitte Unterstützung.');
  const created=f.writes().filter(c=>c.route===`/guilds/${GUILD}/channels`);assert.equal(created.length,1);assert.equal(created[0].payload.permission_overwrites.find(o=>o.id===GUILD).deny,String(P.VIEW_CHANNEL));
  const ticket=f.community.data().tickets[0];await f.community.closeTicket(context,{ticketId:ticket.id,reason:'Erledigt',confirm:true});const closed=f.writes().find(c=>c.method==='PATCH');const deny=BigInt(closed.payload.permission_overwrites.find(o=>o.id===USER).deny);assert(deny&P.SEND_MESSAGES);assert(deny&(1n<<38n));assert(!f.writes().some(c=>c.method==='DELETE'));assert.equal(f.community.data().tickets[0].status,'closed');
});
test('uncertain ticket channel creation is persistent and never automatically duplicated',async t=>{
  const f=setup(t);f.seed('tickets',{enabled:true,channelId:CHANNEL,staffRoleIds:[STAFF]});f.state.hook=(m,r)=>{if(r===`/guilds/${GUILD}/channels`)throw new AppError('uncertain','Unklar.',502);};await assert.rejects(f.community.openTicket(f.interaction({}),'Hilfe','Bitte um Unterstützung.'));await f.community.openTicket(f.interaction({}),'Hilfe','Bitte um Unterstützung.');assert.equal(f.community.data().tickets[0].status,'uncertain');assert.equal(f.writes().length,1);
});
test('voice actions require live membership, explicit confirmation, authority, and return updated cache',async t=>{
  const f=setup(t),p={userId:TARGET,operation:'disconnect',reason:'Abwesenheit',confirm:true};f.state.ready=false;await assert.rejects(f.community.voiceControl(context,p));f.state.ready=true;await f.community.voiceControl(context,p);assert.deepEqual(f.writes()[0].payload,{channel_id:null});assert.deepEqual(f.state.voiceOperation,{userId:TARGET,operation:'disconnect'});
});
test('birthday publication refreshes opted-in calendar after six hours without birthday years',async t=>{
  const f=setup(t);f.seed('birthday',{channelId:CHANNEL});await f.community.publish(context,{section:'birthday'});f.state.now+=6*3600_000;f.state.calendar=[{name:'Sam',day:9,month:11,daysUntil:0,year:1900}];await f.community.tick();const edited=f.writes().find(c=>c.method==='PATCH');assert.match(edited.payload.embeds[0].description,/Sam/);assert(!edited.payload.embeds[0].description.includes('Alex'));assert(!JSON.stringify(edited.payload).includes('1900'));assert.match(edited.payload.embeds[0].footer.text,/Aktualisiert/);assert.equal(edited.payload.components[0].components[0].url,'https://crazybatto.de/registrierung.html');
});
test('events show relative countdown, expire and validate limits before any POST',async t=>{
  const f=setup(t);f.seed('event',{channelId:CHANNEL,startAt:'2026-11-09T11:00:00Z',endAt:'2026-11-09T12:00:00Z'});await f.community.publish(context,{section:'event'});assert.match(f.writes()[0].payload.embeds[0].fields[1].value,/:R>/);f.state.now=Date.parse('2026-11-09T13:00:00Z');await f.community.tick();assert.equal(f.community.data().events[0].status,'expired');assert(f.writes().some(c=>c.method==='PATCH'&&c.payload.embeds[0].title.endsWith('beendet')));
  f.community.mutate(d=>{d.events=Array.from({length:200},()=>({status:'expired'}));});f.state.calls=[];await assert.rejects(f.community.publish(context,{section:'event'}));assert.equal(f.writes().length,0);
});
test('final aggregate embed budget and mismatched delivery confirmation fail safely',async t=>{
  const f=setup(t);f.seed('event',{channelId:CHANNEL,title:'X'.repeat(256),description:'X'.repeat(4000),footer:'X'.repeat(1700),startAt:'2026-11-09T11:00:00Z',endAt:'2026-11-09T12:00:00Z',location:'X'.repeat(200)});await assert.rejects(f.community.publish(context,{section:'event'}));assert.equal(f.writes().length,0);
  f.seed('welcome',{channelId:CHANNEL});f.state.hook=(m,r)=>m==='POST'&&r.endsWith('/messages')?{id:MESSAGE,channel_id:INBOX}:undefined;await assert.rejects(f.community.publish(context,{section:'welcome'}),{kind:'uncertain'});await assert.rejects(f.community.publish(context,{section:'welcome'}),{kind:'uncertain'});assert.equal(f.writes().length,1);
});
test('explicit command registration uses additive upserts and member counter uses real guild count',async t=>{
  const f=setup(t);assert.equal(f.writes().length,0);await f.community.register(context);assert.deepEqual(f.writes().map(c=>c.payload.name),['melden','Mitglied melden','ticket']);assert(f.writes().every(c=>c.method==='POST'));f.seed('counter',{enabled:true,channelId:CHANNEL});await f.community.updateCounter(context,true);assert.equal(f.writes().at(-1).payload.name,'👥 Mitglieder: 42');
});
test('protected common action route preserves local validation status and removes secret error text',async t=>{
  const f=setup(t),control=new DiscordControl(f.service);
  async function call(action,payload,authorization='fixture'){const req=Readable.from([Buffer.from(JSON.stringify({action,payload}))]);Object.assign(req,{url:'/api/admin/discord-control/action',method:'POST',headers:{'content-type':'application/json',authorization}});const res={writeHead(s){this.status=s;},end(raw){this.body=JSON.parse(raw);}};await control.handle(req,res);return res;}
  assert.equal((await call('community.state',{},'')).status,401);assert.equal((await call('community.state',{token:'bad'})).status,400);assert.equal((await call('community.unknown',{})).status,400);assert.equal((await call('community.save',{section:'birthday',settings:{},revision:99})).status,409);
  f.community.run=async()=>{throw new Error('fixture-bot-token-never-output raw secret');};const reply=await call('community.state',{});assert.equal(reply.status,500);assert(!JSON.stringify(reply.body).includes('secret'));assert.equal(control.capabilities().version,1);
});
