import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the shipped controller with a small DOM/transport fixture. This keeps
// the race checks tied to the actual handlers, without a network or browser.
class Element {
  constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.value='';this.listeners={};this.hidden=false;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(name,handler){this.listeners[name]=handler;}
  setAttribute(){} scrollIntoView(){} close(){this.open=false;} showModal(){this.open=true;}
}
const children=node=>node.children.flatMap(child=>[child,...children(child)]);
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const ticket=(id,subject=id)=>({id,subject,revision:7,status:'submitted',category:'hardware',symptoms:'Computer startet nicht',author:{name:'Mitglied'},specs:{cpu:'CPU'},drivers:'unknown',images:[],adminNote:'',order:{requested:true,contact:{email:'private@example.invalid',phone:''},offerCents:1000,acceptedCents:1000,proposedCents:null}});
function fixture(api){
  const elements=new Map(),$=key=>{if(!elements.has(key))elements.set(key,new Element(key));return elements.get(key);};
  const el=(tag,text,className)=>Object.assign(new Element(tag,text),{className}),button=(text,run)=>Object.assign(el('button',text),{run});
  const imported={$,el,button,api,notify(){},loadSession(){},login(){},currentSession:()=>({user:{id:'admin'}}),clearSession(){},cents:value=>Math.round(Number(value)*100),money:value=>value==null?'–':String(value),date:String,statuses:{}};
  const context={URL,URLSearchParams,location:{href:'https://example.invalid/control-center/?view=support'},history:{replaceState(){}},document:{querySelectorAll:()=>[],addEventListener(){}},navigator:{},window:{},...imported};
  const source=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.testHandlers={supportDetail,robotDetail,memberDetail,privateReset,invalidateDetail};',context);
  return {...context.testHandlers,$,find:(tag)=>children($('#detail')).find(node=>node.tag===tag),action:text=>children($('#detail')).find(node=>node.tag==='button'&&node.textContent===text)};
}
test('mobile detail reads ignore old responses after selection changes or a private reset',async()=>{
  const a=defer(),b=defer(),c=defer(),f=fixture(url=>url.endsWith('/a')?a.promise:url.endsWith('/b')?b.promise:c.promise);
  const first=f.supportDetail('a'),second=f.supportDetail('b');b.resolve({ticket:ticket('b','Aktuelle Auswahl')});await second;a.resolve({ticket:ticket('a','Alte Auswahl')});await first;
  assert.equal(f.find('h2').textContent,'Aktuelle Auswahl');
  const last=f.supportDetail('c');f.privateReset();c.resolve({ticket:ticket('c','Private Daten')});await last;assert.equal(f.$('#detail').children.length,0);assert.equal(f.$('#detail').hidden,true);
});
test('mobile paid rejection sends null price and exactly the reason shown for confirmation',async()=>{
  const requests=[],saved=defer(),f=fixture((url,options)=>{if(options){requests.push(options.body);return saved.promise;}return Promise.resolve({ticket:ticket('a')});});
  await f.supportDetail('a');f.find('textarea').value='Prüfung vor Ablehnung';f.find('input').value='';const running=f.action('Ablehnen').run();
  assert.match(f.$('#confirm-text').textContent,/Prüfung vor Ablehnung/);f.find('textarea').value='Unbestätigte Änderung';f.$('#confirm-yes').onclick();await Promise.resolve();
  assert.equal(requests.length,1);assert.equal(requests[0].offerCents,null);assert.equal(requests[0].reason,'Prüfung vor Ablehnung');assert.equal(requests[0].expectedRevision,7);
  f.privateReset();saved.resolve({ticket:ticket('a')});await running;
});
test('changing mobile detail cancels an open confirmation without submitting its stale action',async()=>{
  let mutations=0;const f=fixture((url,options)=>{if(options)mutations++;return Promise.resolve({ticket:ticket('a')});});
  await f.supportDetail('a');f.find('textarea').value='Nicht mehr bestätigen';const running=f.action('Ablehnen').run();assert.equal(f.$('#confirm-dialog').open,true);f.privateReset();await running;assert.equal(mutations,0);assert.equal(f.$('#confirm-dialog').open,false);
});
test('member rejection submits its reviewed snapshot and blocks suspended approvals',async()=>{
  const requests=[],saved=defer(),f=fixture((url,options)=>{requests.push(options.body);return saved.promise;});
  f.memberDetail({id:'member',name:'Mitglied',email:'member@example.invalid',confirmed:true,suspended:true,approval:{status:'pending',revision:3}});
  assert.equal(f.action('Mitglied bestätigen').disabled,true);f.find('textarea').value='Geprüfter Ablehnungsgrund';const running=f.action('Ablehnen').run();f.find('textarea').value='Anderer Text';f.$('#confirm-yes').onclick();await Promise.resolve();assert.equal(requests[0].reason,'Geprüfter Ablehnungsgrund');f.privateReset();saved.resolve({});await running;
});
