export const REPORT_ACTIONS = Object.freeze({
  warn:{label:'Verwarnen',effect:'Der Bot sendet diesem Mitglied deine Begründung als private Verwarnung. Die meldende Person wird nicht genannt.'},
  mute:{label:'Sprach-Stummschaltung',effect:'Das Mitglied wird im Sprachkanal serverseitig stummgeschaltet. Es kann dort nicht mehr sprechen.'},
  unmute:{label:'Stummschaltung aufheben',effect:'Die serverseitige Sprach-Stummschaltung wird aufgehoben. Eine eigene Mikrofon-Stummschaltung bleibt bestehen.'},
  timeout:{label:'Zeitweise sperren',effect:'Discord schränkt Nachrichten, Reaktionen und Sprach-/Video-Teilnahme für die gewählte Dauer ein.'},
  untimeout:{label:'Zeitsperre aufheben',effect:'Der derzeitige Discord-Timeout dieses Mitglieds wird aufgehoben.'},
  kick:{label:'Kicken',effect:'Das Mitglied wird vom Server entfernt. Mit einer gültigen Einladung kann es wieder beitreten.'},
  ban:{label:'Bannen',effect:'Das Mitglied wird vom Server ausgeschlossen und kann bis zur Entbannung nicht wieder beitreten. Nachrichten werden nicht gelöscht.'},
  close:{label:'Fall abschließen',effect:'Die Meldung wird abgeschlossen. Es wird keine weitere Discord-Maßnahme ausgeführt.'},
});
export const TIMEOUT_DURATIONS = Object.freeze([[60,'1 Minute'],[300,'5 Minuten'],[600,'10 Minuten'],[3600,'1 Stunde'],[86400,'1 Tag'],[604800,'7 Tage'],[2419200,'28 Tage']]);
export const REPORT_STATUS = Object.freeze({open:'Offen',processing:'Wird bearbeitet',resolved:'Abgeschlossen',uncertain:'Ergebnis prüfen'});
export function reportRevision(report){return Number.isSafeInteger(report?.revision)&&report.revision>=0?report.revision:0;}
export function canModerateReport(report,operation){return Object.hasOwn(REPORT_ACTIONS,operation)&&(report?.status==='open'||(report?.status==='uncertain'&&operation==='close')||(report?.status==='resolved'&&['unmute','untimeout'].includes(operation)));}
export function reportDecision(report,operation){
  if(!canModerateReport(report,operation)||typeof report.id!=='string'||!report.targetId)throw Error('Dieser Fall kann so nicht mehr bearbeitet werden. Bitte neu laden.');
  return Object.freeze({reportId:report.id,targetId:report.targetId,targetName:String(report.targetName||report.targetId),operation,revision:reportRevision(report),status:report.status});
}
export function reportPayload(decision,{reason,confirmed,durationSeconds=600,notifyUser=false,checkedDiscord=false}){
  if(confirmed!==true||!Object.hasOwn(REPORT_ACTIONS,decision?.operation))throw Error('Bitte Ziel und Maßnahme ausdrücklich bestätigen.');
  if(typeof reason!=='string'||reason.trim().length<5||reason.length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason))throw Error('Bitte einen nachvollziehbaren Grund mit 5 bis 500 Zeichen angeben.');
  const payload={reportId:decision.reportId,operation:decision.operation,revision:decision.revision,reason:reason.trim(),confirm:true};
  if(decision.status==='uncertain'&&decision.operation==='close'){if(checkedDiscord!==true)throw Error('Bitte das tatsächliche Ergebnis zuerst in Discord prüfen.');payload.checkedDiscord=true;}
  if(decision.operation==='timeout'){
    if(!Number.isSafeInteger(durationSeconds)||!TIMEOUT_DURATIONS.some(([seconds])=>seconds===durationSeconds))throw Error('Bitte eine zulässige Dauer auswählen.');
    payload.durationSeconds=durationSeconds;
  }
  if(decision.operation==='warn'){if(notifyUser!==true)throw Error('Bitte das Senden der privaten Verwarnung bestätigen.');payload.notifyUser=true;}
  return payload;
}
