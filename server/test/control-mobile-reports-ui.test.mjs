import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element{
  constructor(tag,text=''){Object.assign(this,{tag,textContent:text,children:[],value:'',listeners:{},hidden:false,checked:false});}
  append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}
  addEventListener(name,fn){this.listeners[name]=fn;}setAttribute(){}scrollIntoView(){}close(){this.open=false;}showModal(){this.open=true;}
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const report=(extra={})=>({id:'report-1',targetId:'900000000000000019',targetName:'Gemeldete Person',reporterId:'900000000000000062',category:'spam',categoryLabel:'Spam',reason:'Vertraulicher Pflichtgrund',details:'Zeitpunkt und weitere Angaben',status:'open',revision:7,createdAt:1,history:[],...extra});
function fixture({data={reports:[report()]},apiOverride}={}){
  const nodes=new Map(),notices=[],requests=[],$=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  const el=(tag,text,className)=>Object.assign(new Element(tag,text),{className}),button=(text,run)=>Object.assign(el('button',text),{run});
  const api=async(url,options)=>{requests.push({url,...options});return apiOverride?apiOverride(url,options):{result:data};};
  const context={URL,URLSearchParams,location:{href:'https://example.invalid/control-center/?view=reports'},history:{replaceState(){}},document:{querySelectorAll:()=>[],addEventListener(){}},navigator:{},window:{},$,el,button,api,notify:(...value)=>notices.push(value),loadSession(){},login(){},currentSession:()=>({user:{id:'admin'}}),clearSession(){},cents:Number,money:String,date:String,statuses:{}};
  const source=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.handlers={load,reportDetail,privateReset,invalidateDetail};',context);
  return {...context.handlers,$,requests,notices,setData:value=>{data=value;},control:id=>descendants($('#detail')).find(node=>node.id===id),find:tag=>descendants($('#detail')).find(node=>node.tag===tag),action:text=>descendants($('#detail')).find(node=>node.tag==='button'&&node.textContent===text),mutations:()=>requests.filter(call=>call.body?.action==='community.report.moderate')};
}
function choose(f,operation){f.control('report-operation').value=operation;f.control('report-operation').listeners.change();f.control('report-reason').value='Geprüfter Moderationsgrund';}

test('report push destination opens active reports with filter and search',async()=>{
  const f=fixture({data:{reports:[report(),report({id:'report-2',status:'resolved',targetName:'Erledigter Fall'}),report({id:'report-3',status:'uncertain'})]}});await f.load();
  assert.equal(f.requests[0].body.action,'community.report.list');assert.equal(f.$('#report-filter-label').hidden,false);assert.equal(f.$('#records').children.length,2);assert.match(f.$('#summary').textContent,/2 Meldungen zu prüfen/);
  f.$('#report-filter').value='all';f.$('#search').value='Erledigter';await f.load();assert.equal(f.$('#records').children.length,1);assert.equal(f.$('#records').children[0].children[0].textContent,'Erledigter Fall');
});

test('private report details and action history render as text, including server outcome',async()=>{
  const malicious='<img src=x onerror=alert(1)>',f=fixture({data:{reports:[report({reason:malicious,history:[{id:'event',operation:'warn',reason:malicious,actorId:'admin',startedAt:1,finishedAt:2,status:'failed',message:'Discord erlaubt die Nachricht nicht.'}]})]}});await f.reportDetail('report-1');
  const all=descendants(f.$('#detail'));assert.ok(all.some(node=>node.textContent===malicious));assert.ok(all.some(node=>node.textContent==='Discord erlaubt die Nachricht nicht.'));assert.equal(all.some(node=>node.tag==='img'),false);assert.ok(all.some(node=>node.textContent==='Vertraulicher Pflichtgrund')===false);
});

test('every moderation operation requires a reviewed reason and uses a fresh versioned confirmation',async t=>{
  for(const operation of ['warn','mute','unmute','timeout','untimeout','kick','ban','close'])await t.test(operation,async()=>{
    const saved=defer(),f=fixture({apiOverride:async(url,{body})=>body.action==='community.report.moderate'?saved.promise:{result:{reports:[report()]}}});await f.reportDetail('report-1');choose(f,operation);if(operation==='timeout')f.control('report-duration').value='300';
    const running=f.action('Maßnahme prüfen').run();await settle();assert.equal(f.$('#confirm-dialog').open,true);assert.equal(f.mutations().length,0);assert.ok(f.requests.filter(call=>call.body.action==='community.report.list').length>=2);
    const shown=f.$('#confirm-text').textContent;assert.match(shown,/Geprüfter Moderationsgrund/);assert.match(shown,/900000000000000019/);if(operation==='warn')assert.match(shown,/echte private Discord-Nachricht/);if(operation==='timeout')assert.match(shown,/5 Minuten/);
    f.control('report-reason').value='Nicht bestätigter anderer Grund';f.control('report-operation').value='ban';f.$('#confirm-yes').onclick();await settle();const payload=f.mutations()[0].body.payload;
    assert.equal(payload.operation,operation);assert.equal(payload.reason,'Geprüfter Moderationsgrund');assert.equal(payload.revision,7);assert.equal(payload.confirm,true);assert.equal(payload.reportId,'report-1');if(operation==='warn')assert.equal(payload.notifyUser,true);else assert.equal(payload.notifyUser,undefined);if(operation==='timeout')assert.equal(payload.durationSeconds,300);
    f.privateReset();saved.resolve({result:{reports:[report({revision:8})]}});await running;assert.equal(f.$('#detail').children.length,0);
  });
});

test('missing operation, short reason and invalid timeout are refused before API mutation',async()=>{
  const f=fixture();await f.reportDetail('report-1');await assert.rejects(f.action('Maßnahme prüfen').run(),/Maßnahme auswählen/);choose(f,'kick');f.control('report-reason').value='kurz';await assert.rejects(f.action('Maßnahme prüfen').run(),/5 bis 500/);choose(f,'timeout');f.control('report-duration').value='99999999';await assert.rejects(f.action('Maßnahme prüfen').run(),/Sperrdauer/);assert.equal(f.mutations().length,0);
});

test('changed revision reloads the current case and requires a completely new decision',async()=>{
  const f=fixture();await f.reportDetail('report-1');choose(f,'ban');f.setData({reports:[report({revision:8,targetName:'Aktueller Fallstand'})]});await assert.rejects(f.action('Maßnahme prüfen').run(),/inzwischen geändert/);assert.equal(f.find('h2').textContent,'Aktueller Fallstand');assert.equal(f.control('report-reason').value,'');assert.equal(f.mutations().length,0);
});

test('changing selection or signing out cancels a pending report confirmation',async()=>{
  const f=fixture();await f.reportDetail('report-1');choose(f,'kick');const running=f.action('Maßnahme prüfen').run();await settle();f.privateReset();await running;assert.equal(f.mutations().length,0);assert.equal(f.$('#confirm-dialog').open,false);
});

test('uncertain outcomes permit only documented closing after explicit Discord inspection',async()=>{
  const saved=defer(),f=fixture({apiOverride:async(url,{body})=>body.action==='community.report.moderate'?saved.promise:{result:{reports:[report({status:'uncertain'})]}}});await f.reportDetail('report-1');assert.deepEqual(f.control('report-operation').children.map(node=>node.value),['','close']);choose(f,'close');await assert.rejects(f.action('Maßnahme prüfen').run(),/Discord prüfen/);f.control('report-discord-checked').checked=true;
  const running=f.action('Maßnahme prüfen').run();await settle();assert.match(f.$('#confirm-text').textContent,/zuvor in Discord geprüft/);f.$('#confirm-yes').onclick();await settle();assert.equal(f.mutations()[0].body.payload.checkedDiscord,true);f.privateReset();saved.resolve({result:{reports:[]}});await running;
});

test('processed and unversioned cases cannot trigger external actions; resolved cases only lift restrictions',async()=>{
  for(const changes of [{status:'processing'},{revision:undefined}]){const f=fixture({data:{reports:[report(changes)]}});await f.reportDetail('report-1');assert.equal(f.action('Maßnahme prüfen'),undefined);assert.equal(f.control('report-operation'),undefined);}
  const f=fixture({data:{reports:[report({status:'resolved'})]}});await f.reportDetail('report-1');assert.deepEqual(f.control('report-operation').children.map(node=>node.value),['','unmute','untimeout']);
});

test('server rejection is shown unchanged and only read requests refresh the case',async()=>{
  let data={reports:[report()]};const f=fixture({apiOverride:async(url,{body})=>{if(body.action==='community.report.moderate'){data={reports:[report({status:'uncertain',revision:8})]};throw Error('Der Ausgang der Discord-Aktion ist unklar.');}return {result:data};}});await f.reportDetail('report-1');choose(f,'ban');const running=f.action('Maßnahme prüfen').run();await settle();f.$('#confirm-yes').onclick();await assert.rejects(running,/Der Ausgang der Discord-Aktion ist unklar\./);assert.equal(f.mutations().length,1);assert.deepEqual(f.control('report-operation').children.map(node=>node.value),['','close']);
});

test('a failed refresh after mutation removes all action controls and offers a read-only reload',async()=>{
  let mutated=false;const f=fixture({apiOverride:async(url,{body})=>{if(body.action==='community.report.moderate'){mutated=true;throw Error('Keine eindeutige Serverbestätigung.');}if(mutated)throw Error('Offline');return {result:{reports:[report()]}};}});await f.reportDetail('report-1');choose(f,'kick');const running=f.action('Maßnahme prüfen').run();await settle();f.$('#confirm-yes').onclick();await assert.rejects(running,/Keine eindeutige Serverbestätigung/);assert.equal(f.action('Maßnahme prüfen'),undefined);assert.ok(f.action('Nur Fall neu laden'));assert.equal(f.mutations().length,1);
});

test('late report reads cannot reinsert private data after logout',async()=>{
  const pending=defer(),f=fixture({apiOverride:()=>pending.promise});const running=f.reportDetail('report-1');f.privateReset();pending.resolve({result:{reports:[report()]}});await running;assert.equal(f.$('#detail').children.length,0);assert.equal(f.$('#detail').hidden,true);
});

test('successful moderation preserves the open case and displays the confirmed action history',async()=>{
  let data={reports:[report()]};const f=fixture({apiOverride:async(url,{body})=>{if(body.action==='community.report.moderate')data={reports:[report({revision:8,history:[{id:'step',operation:'mute',reason:body.payload.reason,status:'succeeded',startedAt:1,finishedAt:2}]})]};return {result:data};}});await f.reportDetail('report-1');choose(f,'mute');const running=f.action('Maßnahme prüfen').run();await settle();f.$('#confirm-yes').onclick();await running;assert.ok(descendants(f.$('#detail')).some(node=>node.textContent==='Vom Server bestätigt'));assert.ok(f.action('Maßnahme prüfen'));assert.equal(f.mutations().length,1);
});

test('mobile markup exposes private reports and status filters without publishing report contents',()=>{
  const html=fs.readFileSync(new URL('../public/showcase/control-mobile.html',import.meta.url),'utf8');assert.match(html,/data-view="reports"/);assert.match(html,/id="report-filter"/);assert.match(html,/Meldungen vertraulich prüfen/);assert.match(html,/value="uncertain"/);
});
