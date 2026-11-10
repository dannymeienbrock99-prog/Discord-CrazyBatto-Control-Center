import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AccountStore} from '../src/account-store.mjs';
import {CommunityControl} from '../src/community-control.mjs';
import {COMMUNITY_BOT_ID as BOT} from '../src/community-schema.mjs';
import {P} from '../src/permissions.mjs';
import {AppError} from '../src/errors.mjs';

const GUILD='900000000000000018',TARGET='900000000000000028',OWNER='900000000000000041',REPORTER='900000000000000027',CHANNEL='900000000000000036',INBOX='900000000000000012',DM='900000000000000011',BOTROLE='900000000000000038',ROLE='900000000000000030',STAFF='900000000000000029',MESSAGE='900000000000000039';
const context={user:{id:'00000000-0000-4000-8000-000000000001'}};
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cb-report-moderation-')),store=new AccountStore(dir);
  const state={now:1794300000000,revoked:false,ready:true,voice:CHANNEL,calls:[],hook:null,absent:false,targetBot:false,targetTimeout:null};
  const guild={id:GUILD,name:'Fixture server',owner_id:OWNER,roles:[{id:GUILD,permissions:String(P.VIEW_CHANNEL),position:0},{id:ROLE,permissions:'0',position:2},{id:STAFF,permissions:'0',position:3},{id:BOTROLE,permissions:String(P.ADMINISTRATOR),position:10}]};
  const channel={id:CHANNEL,guild_id:GUILD,type:2,permission_overwrites:[]};
  const inbox={id:INBOX,guild_id:GUILD,type:0,permission_overwrites:[{id:GUILD,type:0,allow:'0',deny:String(P.VIEW_CHANNEL)},{id:STAFF,type:0,allow:String(P.VIEW_CHANNEL),deny:'0'}]};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only-bot-access'},accounts:{store,assertCurrent(ctx){if(!ctx||state.revoked)throw new AppError('auth','Anmeldung geändert.',401);}},botGateway:{status:()=>({ready:state.ready}),voiceMembers:()=>state.voice?[{userId:TARGET,channelId:state.voice}]:[],applyVoiceControl:(userId,operation)=>state.voiceApplied={userId,operation}},discord:{async request(method,route,options={}){
    state.calls.push({method,route,...structuredClone(options)});
    const override=await state.hook?.(method,route,options);if(override!==undefined)return override;
    if(route==='/users/@me')return {id:BOT,bot:true};
    if(route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(method==='GET'&&route.startsWith(`/guilds/${GUILD}/members/`)){const id=route.split('/').at(-1);if(id===TARGET&&state.absent)throw new AppError('forbidden','Nicht vorhanden.',404);return {user:{id,username:id===TARGET?'Target':'Fixture',bot:id===BOT||id===TARGET&&state.targetBot},roles:id===BOT?[BOTROLE]:[ROLE],communication_disabled_until:id===TARGET?state.targetTimeout:null};}
    if(route==='/channels/'+CHANNEL)return structuredClone(channel);
    if(route==='/channels/'+INBOX)return structuredClone(inbox);
    if(method==='POST'&&route==='/users/@me/channels')return {id:DM,type:1,recipients:[{id:TARGET}]};
    if(method==='POST'&&route.endsWith('/messages'))return {id:MESSAGE,channel_id:route.split('/')[2]};
    if(method==='PATCH')return {user:{id:TARGET},roles:[ROLE],...options.payload};
    if(['DELETE','PUT'].includes(method))return null;
    throw Error('Unexpected fixture route');
  }}};
  let control=new CommunityControl(service,{now:()=>state.now});
  const id=randomUUID();control.mutate(data=>{data.settings.reports={...data.settings.reports,enabled:true,channelId:INBOX,staffRoleIds:[STAFF]};data.reports.push({id,targetId:TARGET,targetName:'Target',reporterId:REPORTER,reason:'Private original report',details:'Private evidence',category:'spam',status:'open',createdAt:state.now,revision:0,history:[]});});
  const row=()=>control.data().reports.find(r=>r.id===id);
  const invoke=(operation,extra={})=>control.moderate(context,{reportId:id,operation,reason:'Bewusst geprüfter Maßnahmen-Grund',confirm:true,revision:row().revision,...extra});
  t.after(async()=>{await control.stop();store.close();assert(dir.startsWith(path.join(os.tmpdir(),'cb-report-moderation-')));fs.rmSync(dir,{recursive:true,force:true});});
  return {get control(){return control},restart(){control=new CommunityControl(service,{now:()=>state.now});return control},service,store,state,guild,channel,id,row,invoke,writes:()=>state.calls.filter(c=>c.method!=='GET')};
}

test('all actions require explicit confirmation, reason, exact fields and version before side effects',async t=>{
  const f=fixture(t);
  for(const patch of [{confirm:false},{reason:'no'},{revision:-1},{revision:'0'},{revision:1},{operation:'unban'},{operation:'warn'},{operation:'mute',notifyUser:true},{operation:'timeout',durationSeconds:59},{operation:'timeout',durationSeconds:2419201},{operation:'timeout',durationSeconds:60.5},{operation:'kick',durationSeconds:60},{operation:'close',checkedDiscord:false},{admin:true}])await assert.rejects(f.invoke('kick',patch));
  assert.equal(f.writes().length,0);assert.equal(f.row().revision,0);assert.equal(f.row().history.length,0);
});
test('a confirmed warning sends only the administrator reason to exactly the target, with mentions disabled',async t=>{
  const f=fixture(t),result=await f.invoke('warn',{notifyUser:true,reason:'Bitte keine @everyone-Beleidigungen.'});
  assert.equal(result.report.status,'open');assert.equal(result.moderation.status,'succeeded');assert.equal(result.report.revision,2);
  const dm=f.writes().find(c=>c.route==='/users/@me/channels');assert.deepEqual(dm.payload,{recipient_id:TARGET});
  const sent=f.writes().find(c=>c.route===`/channels/${DM}/messages`);assert.match(sent.payload.content,/Bitte keine @everyone/);assert(!sent.payload.content.includes(REPORTER));assert(!sent.payload.content.includes('Private original'));assert(!sent.payload.content.includes('Private evidence'));assert.deepEqual(sent.payload.allowed_mentions,{parse:[],users:[],roles:[],replied_user:false});
});
test('multiple measures retain ordered history and stay open until the explicit close',async t=>{
  const f=fixture(t);
  for(const operation of ['warn','mute','unmute','timeout','untimeout','kick','ban']){
    await f.invoke(operation,operation==='warn'?{notifyUser:true}:operation==='timeout'?{durationSeconds:60}:{});assert.equal(f.row().status,'open');
  }
  await f.invoke('close');assert.equal(f.row().status,'resolved');assert.deepEqual(f.row().history.map(h=>h.operation),['warn','mute','unmute','timeout','untimeout','kick','ban','close']);assert(f.row().history.every(h=>h.status==='succeeded'&&h.actorId===context.user.id&&h.finishedAt===f.state.now));assert.equal(f.row().revision,15);
  assert.equal(f.writes().filter(c=>c.auditReason).length,6);assert.deepEqual(f.writes().find(c=>c.method==='PUT').payload,{delete_message_seconds:0});
});
test('timeouts use a server-computed expiry up to exactly 28 days, and removal uses null',async t=>{
  const f=fixture(t);await f.invoke('timeout',{durationSeconds:2419200});let write=f.writes().at(-1);assert.deepEqual(write.payload,{communication_disabled_until:new Date(f.state.now+2419200000).toISOString()});assert.equal(f.row().history[0].timeoutUntil,write.payload.communication_disabled_until);
  await f.invoke('untimeout');assert.deepEqual(f.writes().at(-1).payload,{communication_disabled_until:null});
});
test('resolved cases permit lifting voice mute or timeout but never a new punishment',async t=>{
  const f=fixture(t);await f.invoke('timeout',{durationSeconds:300});await f.invoke('close');await f.invoke('untimeout');assert.equal(f.row().status,'resolved');await f.invoke('unmute');assert.equal(f.row().status,'resolved');await assert.rejects(f.invoke('kick'),{kind:'conflict'});await assert.rejects(f.invoke('warn',{notifyUser:true}),{kind:'conflict'});
});
test('owner, own bot, other bot and equal or higher roles are protected',async t=>{
  for(const variant of ['owner','own-bot','other-bot','equal','higher']){
    const f=fixture(t);if(variant==='owner'||variant==='own-bot')f.control.mutate(d=>d.reports[0].targetId=variant==='owner'?OWNER:BOT);if(variant==='other-bot')f.state.targetBot=true;if(variant==='equal'||variant==='higher')f.guild.roles.find(r=>r.id===ROLE).position=variant==='equal'?10:11;
    await assert.rejects(f.invoke('ban'),{status:403});assert.equal(f.writes().length,0);
  }
});
test('timeout and timeout removal reject administrators even below the bot role',async t=>{
  const f=fixture(t);f.guild.roles.find(r=>r.id===ROLE).permissions=String(P.ADMINISTRATOR);
  await assert.rejects(f.invoke('timeout',{durationSeconds:60}),{status:403});await assert.rejects(f.invoke('untimeout'),{status:403});assert.equal(f.writes().length,0);
});
test('each native action requires its actual bot permission',async t=>{
  const f=fixture(t);f.guild.roles.find(r=>r.id===BOTROLE).permissions='0';
  for(const operation of ['mute','unmute','timeout','untimeout','kick','ban'])await assert.rejects(f.invoke(operation,operation==='timeout'?{durationSeconds:60}:{}),{status:403});assert.equal(f.writes().length,0);
});
test('voice measures require fresh presence and effective permissions in that exact voice channel',async t=>{
  const f=fixture(t);f.state.ready=false;await assert.rejects(f.invoke('mute'),{kind:'conflict'});f.state.ready=true;f.state.voice=null;await assert.rejects(f.invoke('unmute'),{kind:'conflict'});f.state.voice=CHANNEL;
  f.guild.roles.find(r=>r.id===BOTROLE).permissions=String(1n<<22n);f.channel.permission_overwrites=[{id:BOTROLE,type:0,deny:String(1n<<22n),allow:'0'}];await assert.rejects(f.invoke('mute'),{status:403});assert.equal(f.writes().length,0);
});
test('a voice move during fresh permission reads cannot mute a different channel',async t=>{
  const f=fixture(t);f.state.hook=(m,r)=>{if(r===`/guilds/${GUILD}/members/${TARGET}`)f.state.voice=INBOX;};await assert.rejects(f.invoke('mute'),{kind:'conflict'});assert.equal(f.writes().length,0);
});
test('an absent member may be banned after a kick; other actions still reject absence',async t=>{
  const f=fixture(t);await f.invoke('kick');f.state.absent=true;await f.invoke('ban');assert.equal(f.writes().at(-1).method,'PUT');await assert.rejects(f.invoke('timeout',{durationSeconds:60}),{status:404});
});
test('revocation during authority reads causes no action or history claim',async t=>{
  const f=fixture(t);f.state.hook=(m,r)=>{if(r===`/guilds/${GUILD}/members/${TARGET}`)f.state.revoked=true;};await assert.rejects(f.invoke('kick'),{kind:'auth'});assert.equal(f.writes().length,0);assert.equal(f.row().revision,0);
});
test('revocation after DM-channel creation never sends a message and records nondelivery',async t=>{
  const f=fixture(t);f.state.hook=(m,r)=>{if(r==='/users/@me/channels')f.state.revoked=true;};await assert.rejects(f.invoke('warn',{notifyUser:true}),{kind:'auth'});assert.equal(f.writes().length,1);assert.equal(f.row().status,'open');assert.equal(f.row().history[0].status,'failed');assert.match(f.row().history[0].message,/nicht zugestellt/);
});
test('concurrent same-target actions are rejected while a write is in flight',async t=>{
  const f=fixture(t),entered=defer(),release=defer();f.state.hook=async m=>{if(m==='DELETE'){entered.resolve();await release.promise;}};
  const first=f.invoke('kick');await entered.promise;assert.equal(f.row().status,'processing');await assert.rejects(f.invoke('ban'),{kind:'conflict'});
  const second=randomUUID();f.control.mutate(d=>d.reports.push({...f.row(),id:second,revision:0,status:'open',history:[]}));await assert.rejects(f.control.moderate(context,{reportId:second,operation:'ban',reason:'Zweite bewusste Prüfung',confirm:true,revision:0}),{kind:'conflict'});
  release.resolve();await first;assert.equal(f.writes().length,1);
});
test('a competing revision changed during authority reads cannot reserve or send',async t=>{
  const f=fixture(t);f.state.hook=(m,r)=>{if(r===`/guilds/${GUILD}/members/${TARGET}`)f.control.mutate(d=>d.reports[0].revision++);};await assert.rejects(f.invoke('kick'),{kind:'conflict'});assert.equal(f.writes().length,0);
});
test('a definite rejection is durable, increments version and requires a fresh explicit attempt',async t=>{
  const f=fixture(t);f.state.hook=m=>{if(m==='DELETE')throw new AppError('forbidden','Discord hat die Aktion abgelehnt.',403);};await assert.rejects(f.invoke('kick'),{status:403});assert.equal(f.row().revision,2);assert.equal(f.row().status,'open');assert.equal(f.row().history[0].status,'failed');await assert.rejects(f.invoke('kick',{revision:0}),{kind:'conflict'});assert.equal(f.writes().length,1);f.state.hook=null;await f.invoke('kick');assert.equal(f.writes().length,2);
});
test('uncertain writes are never retried and close requires an explicit Discord check',async t=>{
  const f=fixture(t);f.state.hook=m=>{if(m==='DELETE')throw new AppError('uncertain','Keine eindeutige Antwort.',502);};await assert.rejects(f.invoke('kick'),{kind:'uncertain'});assert.equal(f.row().status,'uncertain');await assert.rejects(f.invoke('ban'),{kind:'conflict'});await assert.rejects(f.invoke('close'));await f.invoke('close',{checkedDiscord:true});assert.equal(f.row().status,'resolved');assert.equal(f.row().history[0].status,'uncertain');assert.equal(f.writes().length,1);
});
test('unavailable DMs never claim a successful warning or silently retry',async t=>{
  for(const kind of ['forbidden','uncertain']){const f=fixture(t);f.state.hook=(m,r)=>{if(r==='/users/@me/channels')throw new AppError(kind,'Privatkanal nicht verfügbar.',403);};await assert.rejects(f.invoke('warn',{notifyUser:true}));assert.equal(f.row().status,'open');assert.equal(f.row().history[0].status,'failed');assert.match(f.row().history[0].message,/nicht zugestellt/);assert.equal(f.writes().length,1);}
});
test('a mismatched private recipient is rejected before sending any warning',async t=>{
  const f=fixture(t);f.state.hook=(m,r)=>r==='/users/@me/channels'?{id:DM,type:1,recipients:[{id:REPORTER}]}:undefined;await assert.rejects(f.invoke('warn',{notifyUser:true}));assert.equal(f.writes().length,1);assert.equal(f.row().history[0].status,'failed');
});
test('uncertain or malformed DM-message acknowledgments block a second warning',async t=>{
  for(const invalid of [false,true]){const f=fixture(t);f.state.hook=(m,r)=>{if(r===`/channels/${DM}/messages`){if(invalid)return{id:MESSAGE,channel_id:INBOX};throw new AppError('uncertain','Unklar.',502);}};await assert.rejects(f.invoke('warn',{notifyUser:true}),{kind:'uncertain'});await assert.rejects(f.invoke('warn',{notifyUser:true}),{kind:'conflict'});assert.equal(f.row().history[0].status,'uncertain');assert.equal(f.writes().length,2);}
});
test('restarting with an interrupted attempt preserves uncertainty and performs no Discord request',async t=>{
  const f=fixture(t);f.control.mutate(d=>{const r=d.reports[0];r.status='processing';r.revision=1;r.history.push({id:randomUUID(),operation:'warn',reason:'Prüfgrund',actorId:context.user.id,status:'processing',startedAt:f.state.now});});f.restart();assert.equal(f.row().status,'uncertain');assert.equal(f.row().revision,2);assert.equal(f.row().history[0].status,'uncertain');assert.equal(f.state.calls.length,0);await assert.rejects(f.invoke('warn',{notifyUser:true}),{kind:'conflict'});
});
test('legacy processing and completed history are retained, not treated as new actionable cases',async t=>{
  const f=fixture(t);f.control.mutate(d=>{const r=d.reports[0];delete r.revision;delete r.history;r.status='processing';r.action='kick';r.reviewReason='Alter geprüfter Grund';});f.restart();assert.equal(f.row().history[0].operation,'kick');assert.equal(f.row().history[0].status,'uncertain');assert.equal(f.row().status,'uncertain');
});
test('old desktop kick/ban remains one-shot, but old clients cannot act after another attempt',async t=>{
  const f=fixture(t),payload={reportId:f.id,operation:'kick',reason:'Bewusst geprüfter Grund',confirm:true};await f.control.moderate(context,payload);assert.equal(f.row().status,'resolved');await assert.rejects(f.control.moderate(context,payload));assert.equal(f.writes().length,1);
  const g=fixture(t);await g.invoke('mute');await assert.rejects(g.control.moderate(context,{...payload,reportId:g.id}),{kind:'conflict'});
});
test('successful Discord mutation survives revoked session and optional audit failure without duplicate retry',async t=>{
  const f=fixture(t);f.state.hook=m=>{if(m==='DELETE')f.state.revoked=true;};f.store.audit=()=>{throw Error('audit unavailable');};await f.invoke('kick');assert.equal(f.row().history[0].status,'succeeded');assert.equal(f.writes().length,1);
});
test('multiline review reasons are retained in history and encoded as one audit-header line',async t=>{
  const f=fixture(t),reason='Geprüfte erste Zeile\nund zweite Zeile';await f.invoke('mute',{reason});assert.equal(f.row().history[0].reason,reason);assert.equal(f.writes()[0].auditReason,'Geprüfte erste Zeile und zweite Zeile');
});
test('local voice-cache errors cannot turn confirmed success into a repeatable failure',async t=>{
  const f=fixture(t);f.service.botGateway.applyVoiceControl=()=>{throw Error('cache unavailable');};await f.invoke('mute');assert.equal(f.row().history[0].status,'succeeded');assert.equal(f.writes().length,1);
});
test('malformed member-update acknowledgments become uncertain and are not repeated',async t=>{
  const f=fixture(t);f.state.hook=m=>m==='PATCH'?{user:{id:REPORTER}}:undefined;await assert.rejects(f.invoke('timeout',{durationSeconds:60}),{kind:'uncertain'});assert.equal(f.row().status,'uncertain');await assert.rejects(f.invoke('timeout',{durationSeconds:60}),{kind:'conflict'});assert.equal(f.writes().length,1);
});
test('if success persistence fails, the processing record survives for crash recovery',async t=>{
  const f=fixture(t),save=f.store.setSetting.bind(f.store);let reject=false;f.store.setSetting=(key,value)=>{if(reject)throw Error('disk unavailable');return save(key,value);};f.state.hook=m=>{if(m==='DELETE')reject=true;};await assert.rejects(f.invoke('kick'),{kind:'uncertain'});assert.equal(f.row().status,'processing');reject=false;f.restart();assert.equal(f.row().status,'uncertain');assert.equal(f.writes().length,1);
});
test('report submission atomically records a durable one-time generic push receipt',async t=>{
  const f=fixture(t);await f.control.submitReport({member:{user:{id:REPORTER}}},TARGET,'Testmeldung mit Pflichtgrund','Zusatzangaben','spam');const created=f.control.data().reports[0];assert.equal(f.store.get('SELECT COUNT(*) n FROM community_report_notice_receipts WHERE report_id=?',created.id).n,1);const event=f.store.get('SELECT * FROM control_notice_events WHERE target_id=?',created.id);assert.equal(event.type,'community_report');assert.equal(event.revision,0);assert.equal(event.created_at,created.createdAt);assert(!JSON.stringify(event).includes('Testmeldung'));
  f.control.backfillReportNotices();f.store.run('DELETE FROM control_notice_events WHERE target_id=?',created.id);f.control.backfillReportNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events WHERE target_id=?',created.id).n,0);
});
test('push event storage failure rolls back both new report and receipt',async t=>{
  const f=fixture(t),run=f.store.run.bind(f.store);f.store.run=(sql,...args)=>{if(sql.startsWith('INSERT OR IGNORE INTO control_notice_events'))throw Error('event unavailable');return run(sql,...args);};await assert.rejects(f.control.submitReport({member:{user:{id:REPORTER}}},TARGET,'Testmeldung mit Pflichtgrund','','spam'));assert.equal(f.control.data().reports.length,1);assert.equal(f.store.get('SELECT COUNT(*) n FROM community_report_notice_receipts').n,0);assert.equal(f.writes().length,0);
});
test('backfill only handles open enabled reports and delivery state follows current case status',async t=>{
  const f=fixture(t),event={type:'community_report',target_id:f.id,revision:0};assert.equal(f.control.reportNoticeState(event),'ready');f.control.backfillReportNotices();assert.equal(f.store.get('SELECT COUNT(*) n FROM control_notice_events').n,1);
  for(const status of ['processing','uncertain']){f.control.mutate(d=>d.reports[0].status=status);assert.equal(f.control.reportNoticeState(event),'paused');}
  f.control.mutate(d=>d.reports[0].status='resolved');assert.equal(f.control.reportNoticeState(event),'obsolete');f.control.mutate(d=>{d.reports[0].status='open';d.settings.reports.enabled=false;});assert.equal(f.control.reportNoticeState(event),'paused');assert.equal(f.control.reportNoticeState({...event,revision:1}),'obsolete');
});
