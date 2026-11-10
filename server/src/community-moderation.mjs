import { randomUUID } from 'node:crypto';
import { AppError, assert, safeMessage } from './errors.mjs';
import { P, has, basePermissions, channelPermissions } from './permissions.mjs';
import { CID, text, safeName, REPORT_MODERATION_OPERATIONS, REPORT_TIMEOUT_MAX_SECONDS } from './community-schema.mjs';

const FLAGS={kick:1n<<1n,ban:1n<<2n,mute:1n<<22n,unmute:1n<<22n,timeout:1n<<40n,untimeout:1n<<40n};
const REVERSE=new Set(['unmute','untimeout']);
const MAX_HISTORY=100;
export function reportRecord(row){
  const history=Array.isArray(row.history)?row.history:row.action?[{id:'legacy',operation:row.action,reason:row.reviewReason||'',actorId:null,startedAt:row.reviewedAt||row.createdAt||0,finishedAt:row.reviewedAt||null,status:row.status==='resolved'?'succeeded':row.status==='processing'?'processing':row.status==='uncertain'?'uncertain':'failed',message:'Frühere Maßnahme aus der bisherigen Verwaltung.'}]:[];
  return {...row,revision:Number.isSafeInteger(row.revision)&&row.revision>=0?row.revision:0,history};
}
export function recoverInterruptedReports(control){
  if(!control.data().reports.some(row=>row.status==='processing'))return;
  control.mutate(data=>{for(const row of data.reports){
    if(row.status!=='processing')continue;
    row.status='uncertain';row.revision++;
    for(const attempt of row.history)if(attempt.status==='processing'){attempt.status='uncertain';attempt.finishedAt=control.now();attempt.message='Die Verwaltung wurde während der Maßnahme neu gestartet. Ergebnis in Discord prüfen; keine automatische Wiederholung.';}
  }});
}
function checkRow(row,revision,operation,{legacy=false,checkedDiscord=false}={}){
  assert(row,'Diese Meldung wurde nicht gefunden.','validation',404);
  assert(row.revision===revision,'Die Meldung wurde inzwischen bearbeitet. Bitte neu laden und erneut prüfen.','conflict',409);
  if(legacy)assert(row.revision===0&&row.history.length===0,'Bitte das Control Center aktualisieren und den aktuellen Fall erneut laden.','conflict',409);
  const allowed=row.status==='open'||(row.status==='uncertain'&&operation==='close')||(row.status==='resolved'&&REVERSE.has(operation));
  assert(allowed,row.status==='uncertain'?'Das Ergebnis der letzten Maßnahme ist unklar. Bitte zuerst in Discord prüfen und den Fall ausdrücklich abschließen.':'Diese Meldung wird bereits bearbeitet oder ist abgeschlossen.','conflict',409);
  if(row.status==='uncertain')assert(checkedDiscord===true,'Bitte bestätigen, dass das unklare Ergebnis in Discord geprüft wurde.');
  assert(row.history.length<MAX_HISTORY,'Die Maßnahmenhistorie dieses Falls ist voll. Bitte die Serververwaltung verwenden.','capacity',409);
  assert(row.revision<Number.MAX_SAFE_INTEGER-2,'Die Fallversion kann nicht weiter erhöht werden.','capacity',409);
}
function voiceMember(control,userId){
  const voice=control.voiceList(),member=voice.members.find(row=>row.userId===userId);
  assert(voice.ready&&member&&CID.test(member.channelId||''),'Das Mitglied ist aktuell in keinem zuverlässig bekannten Sprachkanal. Bitte aktualisieren.','conflict',409);
  return member;
}
async function prepare(control,context,report,operation){
  const voice=['mute','unmute'].includes(operation)?voiceMember(control,report.targetId):null;
  const auth=await control.authority(context,FLAGS[operation]||0n,voice?.channelId||'');
  let target;
  try{target=await control.target(context,auth,report.targetId);}
  catch(error){if(operation!=='ban'||error.status!==404)throw error;/* An absent member can still be banned after a kick. */}
  assert(!target?.user?.bot,'Andere Bot-Konten werden über diesen Meldefall nicht moderiert.','forbidden',403);
  if(['timeout','untimeout'].includes(operation))assert(!has(basePermissions(auth.guild,target,control.now()),P.ADMINISTRATOR),'Discord erlaubt keinen Timeout für Administratoren.','forbidden',403);
  if(voice){
    assert([2,13].includes(auth.channel?.type)&&has(channelPermissions(auth.guild,auth.member,auth.channel,control.now()),P.VIEW_CHANNEL|FLAGS.mute),'Dem Bot fehlen die erforderlichen Rechte in diesem Sprachkanal.','forbidden',403);
    assert(voiceMember(control,report.targetId).channelId===voice.channelId,'Das Mitglied hat inzwischen den Sprachkanal gewechselt. Bitte neu laden.','conflict',409);
  }
  return {auth,voice};
}
export async function moderateReport(control,context,payload){
  control.current(context);control.identity();assert(!control.stopping,'Die Verwaltung wird gerade neu gestartet. Bitte später erneut prüfen.','conflict',409);
  assert(payload&&typeof payload==='object'&&!Array.isArray(payload),'Ungültige Moderationsangaben.');
  const allowed=['reportId','operation','reason','confirm','revision','durationSeconds','notifyUser','checkedDiscord','guildId'];
  assert(Object.keys(payload).every(k=>allowed.includes(k)),'Unbekannte Moderationsangaben.');
  assert(payload.confirm===true&&REPORT_MODERATION_OPERATIONS.includes(payload.operation),'Bitte die Moderationsaktion ausdrücklich bestätigen.');
  assert(typeof payload.reportId==='string'&&payload.reportId.length>0&&payload.reportId.length<=100,'Bitte eine gültige Meldung auswählen.');
  assert(!payload.guildId||payload.guildId===control.config.discordGuildId,'Falscher Discord-Server.','forbidden',403);
  const operation=payload.operation,reason=text(payload.reason,500,'Moderationsgrund',5),legacy=!Object.hasOwn(payload,'revision');
  assert(reason.isWellFormed(),'Der Moderationsgrund enthält ungültige Schriftzeichen.');
  if(legacy)assert(['kick','ban'].includes(operation),'Bitte das Control Center aktualisieren und die aktuelle Fallversion laden.','conflict',409);
  else assert(Number.isSafeInteger(payload.revision)&&payload.revision>=0,'Bitte eine gültige Fallversion laden.');
  if(operation==='timeout')assert(Number.isSafeInteger(payload.durationSeconds)&&payload.durationSeconds>=60&&payload.durationSeconds<=REPORT_TIMEOUT_MAX_SECONDS,'Der Timeout muss zwischen einer Minute und 28 Tagen liegen.');
  else assert(payload.durationSeconds===undefined,'Eine Dauer ist nur für einen Timeout erlaubt.');
  if(operation==='warn')assert(payload.notifyUser===true,'Bitte das Senden der privaten Verwarnung ausdrücklich bestätigen.');
  else assert(payload.notifyUser===undefined,'Eine private Nachricht ist nur bei einer Verwarnung vorgesehen.');
  assert(payload.checkedDiscord===undefined||(operation==='close'&&payload.checkedDiscord===true),'Ungültige Discord-Prüfbestätigung.');
  const report=control.data().reports.find(row=>row.id===payload.reportId),revision=legacy?0:payload.revision;
  checkRow(report,revision,operation,{legacy,checkedDiscord:payload.checkedDiscord});
  const attempt={id:randomUUID(),operation,reason,actorId:context.user.id,startedAt:control.now(),finishedAt:null,status:'processing',...(operation==='timeout'?{durationSeconds:payload.durationSeconds}:{})};
  if(operation==='close'){
    control.current(context);control.mutate(data=>{
      const row=data.reports.find(r=>r.id===report.id);checkRow(row,revision,operation,{checkedDiscord:payload.checkedDiscord});
      row.history.push({...attempt,status:'succeeded',finishedAt:control.now(),message:'Fall ausdrücklich abgeschlossen. Vorherige unklare Ergebnisse bleiben in der Historie sichtbar.'});
      row.revision++;row.status='resolved';row.action=operation;row.reviewReason=reason;row.reviewedAt=control.now();
    });return result(control,report.id);
  }
  control.moderationTargets ||= new Set();
  assert(!control.moderationTargets.has(report.targetId),'Für dieses Mitglied läuft bereits eine Maßnahme. Bitte warten und neu laden.','conflict',409);
  control.moderationTargets.add(report.targetId);
  let claimed=false,phase='before-send';
  try{
    const {auth,voice}=await prepare(control,context,report,operation);
    control.current(context);
    control.mutate(data=>{
      const row=data.reports.find(r=>r.id===report.id);checkRow(row,revision,operation,{legacy});
      assert(!data.reports.some(r=>r.id!==row.id&&r.targetId===row.targetId&&r.status==='processing'),'Für dieses Mitglied läuft bereits eine Maßnahme.','conflict',409);
      if(operation==='timeout')attempt.timeoutUntil=new Date(control.now()+payload.durationSeconds*1000).toISOString();
      row.history.push(attempt);row.revision++;row.status='processing';row.action=operation;row.reviewReason=reason;claimed=true;
    });
    const auditReason=reason.replace(/[\r\n\t]+/g,' ');
    if(operation==='warn'){
      phase='dm-channel';
      const channel=await control.request(context,'POST','/users/@me/channels',{recipient_id:report.targetId});
      assert(CID.test(channel?.id||'')&&channel.type===1&&Array.isArray(channel.recipients)&&channel.recipients.length===1&&channel.recipients[0]?.id===report.targetId,'Der Empfänger der privaten Verwarnung konnte nicht bestätigt werden.','permanent',502);
      control.current(context);phase='warning-send';
      const sent=await control.request(context,'POST',`/channels/${channel.id}/messages`,{content:`Verwarnung · ${safeName(auth.guild.name)}\n\n${reason}\n\nBitte beachte die Serverregeln. Fall: ${report.id}`,allowed_mentions:{parse:[],users:[],roles:[],replied_user:false}});
      assert(CID.test(sent?.id||'')&&sent.channel_id===channel.id,'Die private Verwarnung konnte nicht eindeutig bestätigt werden. Bitte in Discord prüfen.','uncertain',502);
    }else{
      if(voice)assert(voiceMember(control,report.targetId).channelId===voice.channelId,'Das Mitglied hat inzwischen den Sprachkanal gewechselt. Bitte neu laden.','conflict',409);
      control.current(context);phase='mutation';
      if(operation==='kick')await control.request(context,'DELETE',`/guilds/${auth.guild.id}/members/${report.targetId}`,undefined,{auditReason});
      else if(operation==='ban')await control.request(context,'PUT',`/guilds/${auth.guild.id}/bans/${report.targetId}`,{delete_message_seconds:0},{auditReason});
      else {
        const updated=await control.request(context,'PATCH',`/guilds/${auth.guild.id}/members/${report.targetId}`,['mute','unmute'].includes(operation)?{mute:operation==='mute'}:{communication_disabled_until:operation==='timeout'?attempt.timeoutUntil:null},{auditReason});
        assert(updated?.user?.id===report.targetId,'Die Mitgliedsänderung konnte nicht eindeutig bestätigt werden. Bitte in Discord prüfen.','uncertain',502);
      }
    }
    finish(control,report,attempt,'succeeded',legacy?'resolved':report.status==='resolved'?'resolved':'open',operation==='warn'?'Private Verwarnung wurde von Discord bestätigt.':'Maßnahme wurde von Discord bestätigt.');
    if(voice)try{control.service.botGateway?.applyVoiceControl?.(report.targetId,operation);}catch{/* A local display cache failure does not undo the confirmed Discord action. */}
    try{control.store.audit(context.user.id,'community.'+operation,report.targetId,{reportId:report.id,attemptId:attempt.id});}catch{/* The durable case history already records success. */}
    return result(control,report.id);
  }catch(error){
    if(!claimed)throw error;
    const uncertain=phase!=='dm-channel'&&phase!=='before-send'&&(!(error instanceof AppError)||error.kind==='uncertain');
    const detail=error instanceof AppError?safeMessage(error.message):'Die Discord-Antwort konnte nicht sicher verarbeitet werden.';
    const message=operation==='warn'?(uncertain?'Die Zustellung der privaten Verwarnung ist unklar. Nicht erneut senden; zuerst in Discord prüfen.':'Die private Verwarnung wurde nicht zugestellt. '+detail):(uncertain?'Das Ergebnis ist unklar. Nicht wiederholen; zuerst in Discord prüfen.':detail);
    try{finish(control,report,attempt,uncertain?'uncertain':'failed',uncertain?'uncertain':report.status,message);}catch{throw new AppError('uncertain','Die Maßnahme konnte nicht sicher protokolliert werden. Bitte in Discord prüfen; nicht wiederholen.',502);}
    throw new AppError(uncertain?'uncertain':error instanceof AppError?error.kind:'network',message,uncertain?502:error instanceof AppError?error.status:502);
  }finally{control.moderationTargets.delete(report.targetId);}
}
function finish(control,report,attempt,status,caseStatus,message){
  control.mutate(data=>{
    const row=data.reports.find(r=>r.id===report.id),stored=row?.history.find(h=>h.id===attempt.id);
    assert(row?.status==='processing'&&stored?.status==='processing','Der Maßnahmenstatus konnte nicht sicher zugeordnet werden.','uncertain',502);
    Object.assign(stored,{status,finishedAt:control.now(),message});row.revision++;row.status=caseStatus;row.reviewedAt=control.now();
  });
}
function result(control,id){const reports=control.data().reports;const report=reports.find(r=>r.id===id);return {reports:reports.slice(0,200),report,moderation:report.history.at(-1)};}
