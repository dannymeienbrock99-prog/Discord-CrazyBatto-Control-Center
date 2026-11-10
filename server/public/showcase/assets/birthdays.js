import {api,getSession,errorText} from './account-client.js';
const $=id=>document.getElementById(id);
const months=['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
let data={entries:[],today:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin'}).format(new Date()),reminderDays:3};
let month=Number(data.today.slice(5,7))-1, year=Number(data.today.slice(0,4));
const node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
const dateText=e=>`${String(e.day).padStart(2,'0')}.${String(e.month).padStart(2,'0')}.`;
function matches(e){return e.name.toLocaleLowerCase('de').includes($('birthdaySearch').value.trim().toLocaleLowerCase('de'));}
function render(){
  $('monthTitle').textContent=months[month]+' '+year;
  const entries=data.entries.filter(matches), grid=document.createDocumentFragment();
  const offset=(new Date(Date.UTC(year,month,1)).getUTCDay()+6)%7;
  const count=new Date(Date.UTC(year,month+1,0)).getUTCDate();
  const leap=new Date(Date.UTC(year,1,29)).getUTCMonth()===1;
  const inMonth=entries.filter(e=>e.month===month+1);
  for(let i=0;i<offset;i++)grid.append(node('div','','birthday-day is-empty'));
  for(let day=1;day<=count;day++){
    const iso=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const people=inMonth.filter(e=>(e.month===2&&e.day===29&&!leap?28:e.day)===day);
    const cell=node('div','','birthday-day'+(iso===data.today?' is-today':'')+(people.length?' has-birthday':''));
    const time=node('time',String(day));time.dateTime=iso;cell.append(time);
    cell.setAttribute('aria-label',`${day}. ${months[month]} ${year}${iso===data.today?', heute':''}${people.length?': '+people.map(e=>e.name).join(', '):''}`);
    for(const person of people){const label=node('span',person.name,'birthday-person');label.title=person.name+' · '+dateText(person);cell.append(label);}
    grid.append(cell);
  }
  $('birthdayGrid').replaceChildren(grid);
  $('monthSummary').textContent=inMonth.length?`${inMonth.length} ${inMonth.length===1?'Geburtstag':'Geburtstage'} in diesem Monat`:'In diesem Monat sind noch keine passenden Geburtstage freigegeben.';
  const list=document.createDocumentFragment();
  for(const e of entries){const row=node('article','','birthday-list-item'),badge=node('div','','birthday-date-badge');badge.append(node('strong',String(e.day)),node('span',months[e.month-1].slice(0,3)));const copy=node('div','','birthday-list-copy');copy.append(node('strong',e.name),node('small',e.daysUntil===0?'Heute · Alles Gute!':e.daysUntil===1?'Morgen':'In '+e.daysUntil+' Tagen'));row.append(badge,copy);list.append(row);}
  if(!entries.length)list.append(node('p',data.entries.length?'Kein Mitglied mit diesem Namen gefunden.':'Noch keine Geburtstage freigegeben. Trage deinen Geburtstag ein und entscheide, ob er hier erscheint.','birthday-muted'));
  $('upcomingList').replaceChildren(list);
  const soon=data.entries.filter(e=>e.daysUntil===0||e.daysUntil<=data.reminderDays);
  $('birthdayAlerts').hidden=!soon.length;
  $('birthdayAlertList').replaceChildren(...soon.map(e=>node('p',e.daysUntil===0?`🎉 ${e.name} hat heute Geburtstag!`:`${e.name} hat ${e.daysUntil===1?'morgen':'in '+e.daysUntil+' Tagen'} Geburtstag (${dateText(e)}).`)));
}
async function load(){const result=await api('/api/birthdays/calendar');if(!Array.isArray(result.entries))throw Error('Der Kalender konnte nicht gelesen werden.');data=result;render();$('calendarFeedback').textContent='Nur freigegebene Geburtstage · ohne Geburtsjahr';}
$('previousMonth').addEventListener('click',()=>{if(--month<0){month=11;year--;}render();});
$('nextMonth').addEventListener('click',()=>{if(++month>11){month=0;year++;}render();});
$('currentMonth').addEventListener('click',()=>{month=Number(data.today.slice(5,7))-1;year=Number(data.today.slice(0,4));render();});
$('birthdaySearch').addEventListener('input',render);
$('birthdayProfileForm').addEventListener('submit',async event=>{
  event.preventDefault();if(!event.currentTarget.reportValidity())return;
  const button=event.currentTarget.querySelector('button');button.disabled=true;
  try{const result=await api('/api/account/birthday',{method:'PUT',body:{birthDate:$('birthdayDate').value,shared:$('birthdayShared').checked}});$('birthdayProfileFeedback').textContent=result.shared?'Gespeichert. Dein Geburtstag ist für den Kalender und Discord freigegeben.':'Gespeichert. Dein Geburtstag bleibt privat; neue Geburtstagsnachrichten sind ausgeschaltet.';await load();}
  catch(e){$('birthdayProfileFeedback').textContent=errorText(e);}finally{button.disabled=false;}
});
await Promise.allSettled([
  load().catch(e=>{$('calendarFeedback').textContent=errorText(e);$('calendarFeedback').classList.add('is-error');}),
  (async()=>{try{const session=await getSession();$('birthdayAdminLink').hidden=!session.user?.isAdmin;if(!session.user){$('birthdayLogin').hidden=false;return;}const profile=await api('/api/account/birthday');$('birthdayDate').value=profile.birthDate;$('birthdayDate').max=data.today;$('birthdayShared').checked=profile.shared;$('birthdayProfileForm').hidden=false;}catch(e){$('birthdayProfileFeedback').textContent=errorText(e);}})()
]);
