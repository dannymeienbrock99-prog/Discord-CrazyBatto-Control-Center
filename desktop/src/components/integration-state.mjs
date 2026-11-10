export const integrationScope=(site,guildId='')=>[site?.connected===true,site?.baseUrl,site?.profileId,site?.user?.id,site?.expiresAt,guildId].join('|');
export const lines=value=>String(value||'').split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
export function pluginDraft(fields,values){return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,fields.some(field=>field.key===key&&field.type==='words')&&Array.isArray(value)?value.join('\n'):value]));}
export function pluginValues(fields,values){return Object.fromEntries(Object.entries(values).map(([key,value])=>[key,fields.some(field=>field.key===key&&field.type==='words')?lines(value):value]));}
export function wordListLimit(field){return ((field.maxLength||60)+1)*(field.max||100);}
export function pluginProblem(fields,values){for(const field of fields){if(field.type!=='words')continue;const words=lines(values[field.key]);if(words.length>(field.max||100)||words.some(word=>word.length>(field.maxLength||60)))return `${field.label}: höchstens ${field.max||100} Einträge mit je ${field.maxLength||60} Zeichen.`;if(new Set(words).size!==words.length)return `${field.label}: Bitte doppelte Einträge entfernen.`;}return '';}
export const when=value=>value&&Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString('de-DE'):'Nicht bekannt';
export function duration(seconds){
  if(!Number.isFinite(seconds)||seconds<0)return 'Nicht bekannt';
  const total=Math.floor(seconds),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60;
  return `${h?`${h} Std. `:''}${m} Min. ${s} Sek.`;
}
export function newModerationRule(){return {name:'Wortfilter',enabled:false,keywords:[],allowList:[],exemptRoleIds:[],exemptChannelIds:[],alertChannelId:'',blockMessage:'Diese Nachricht wurde durch die Serverregeln blockiert.'};}
export function ruleProblem(rule){
  if(!rule?.name?.trim()||rule.name.length>100)return 'Gib der Regel einen Namen mit höchstens 100 Zeichen.';
  if(!rule.keywords.length||rule.keywords.length>100||rule.keywords.some(word=>word.length>60))return 'Trage 1 bis 100 Begriffe mit jeweils höchstens 60 Zeichen ein.';
  if(rule.allowList.length>100||rule.allowList.some(word=>word.length>60))return 'Die Ausnahmen dürfen höchstens 100 Begriffe mit je 60 Zeichen enthalten.';
  if(rule.exemptRoleIds.length>20||rule.exemptChannelIds.length>50)return 'Wähle höchstens 20 Rollen und 50 Kanäle als Ausnahmen.';
  if(rule.blockMessage.length>150)return 'Der Hinweis zur Blockierung darf höchstens 150 Zeichen enthalten.';
  return '';
}
export function selectedValues(select){return Array.from(select.selectedOptions,item=>item.value);}
export function normalizeAudioMime(value){const mime=String(value||'').split(';')[0].trim().toLowerCase();return mime==='audio/x-wav'?'audio/wav':mime;}
export function audioProblem(clip){
  if(!clip||typeof clip.dataBase64!=='string'||!clip.dataBase64)return 'Wähle eine Audiodatei oder nimm eine Nachricht auf.';
  const encoded=clip.dataBase64,padding=encoded.indexOf('=');
  if(encoded.length%4!==0||/[^A-Za-z0-9+/=]/.test(encoded)||(padding>=0&&(padding<encoded.length-2||!/^={1,2}$/.test(encoded.slice(padding)))))return 'Die Audiodaten konnten nicht gelesen werden. Bitte die Datei erneut auswählen.';
  if(!['audio/ogg','audio/webm','audio/mpeg','audio/wav'].includes(normalizeAudioMime(clip.mime)))return 'Unterstützt werden OGG, WebM, MP3 und WAV.';
  if(!Number.isFinite(clip.bytes)||clip.bytes<=0||clip.bytes>8388608)return 'Die Audiodatei darf höchstens 8 MB groß sein.';
  return '';
}
export function audioIdentity(clip,channelId){return `${clip?.id||''}|${channelId||''}`;}
export function audioRequestFor(requests,clip,channelId,makeId){const identity=audioIdentity(clip,channelId);if(!requests.has(identity))requests.set(identity,makeId());return requests.get(identity);}
export function suggestedRoleBadges(roles){return [{roleId:roles?.find(role=>role.name?.trim().toLowerCase()==='king')?.id||'',label:'King',icon:'crown',color:'#D4AF37'},{roleId:roles?.find(role=>role.name?.trim().toLowerCase()==='moderator')?.id||'',label:'Moderator',icon:'shield',color:'#D4AF37'}];}
export function roleReview(guildId,expectedRevision,enabled,rules){return {guildId,expectedRevision,enabled,rules:rules.filter(rule=>rule.roleId).map(rule=>({...rule}))};}
export function isSpotifyRevision(value){return Number.isSafeInteger(value)&&value>=0;}
export function spotifyPlayableDevice(devices,id){return devices?.find(item=>item.id===id&&!item.isRestricted)||null;}
export function pluginLabel(plugin){return !plugin.installed?'Nicht installiert':plugin.enabled===true?'Aktiv':plugin.enabled===false?'Ausgeschaltet':'Status noch nicht bestätigt';}
