import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag,text=''){Object.assign(this,{tag,textContent:text,children:[],value:'',listeners:{},hidden:false,attributes:{}});}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  addEventListener(name,handler){this.listeners[name]=handler;}
  setAttribute(name,value){this.attributes[name]=value;}
  scrollIntoView(){} close(){this.open=false;} showModal(){this.open=true;}
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const entry=(id='setup',extra={})=>({id,title:'Gaming Setup',authorName:'Mitglied',description:'Mein Spielplatz',specs:{cpu:'CPU',gpu:'Grafikkarte'},images:[],revision:7,status:'pending',contentKind:'submitted',discordStatus:'none',...extra});
const state=(entries=[entry()],settings={enabled:true})=>({revision:2,settings,entries});
function fixture(run){
  const elements=new Map(),notices=[],requests=[],$=key=>{if(!elements.has(key))elements.set(key,new Element(key));return elements.get(key);};
  const el=(tag,text,className)=>Object.assign(new Element(tag,text),{className}),button=(text,run)=>Object.assign(el('button',text),{run});
  const api=async(url,options)=>{requests.push({url,...options});return run(url,options);};
  const context={URL,URLSearchParams,location:{href:'https://example.invalid/control-center/?view=setups'},history:{replaceState(){}},document:{querySelectorAll:()=>[],addEventListener(){}},navigator:{},window:{},$,el,button,api,notify:(...args)=>notices.push(args),loadSession(){},login(){},currentSession:()=>({user:{id:'admin'}}),clearSession(){},cents:Number,money:String,date:String,statuses:{}};
  const source=fs.readFileSync(new URL('../public/showcase/assets/control-mobile.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void start\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.handlers={load,setupDetail,privateReset,invalidateDetail};',context);
  return {...context.handlers,$,requests,notices,find:tag=>descendants($('#detail')).find(node=>node.tag===tag),action:text=>descendants($('#detail')).find(node=>node.tag==='button'&&node.textContent===text)};
}

test('setup push URL selects pending submissions and allows all/search filters',async()=>{
  const data=state([entry('pending'),entry('published',{title:'Already public',status:'published'}),entry('draft',{status:'draft',contentKind:'draft'})]);
  const f=fixture(async()=>({ok:true,result:data}));await f.load();
  assert.equal(f.requests[0].url,'/api/admin/discord-control/action');assert.equal(f.requests[0].method,'POST');assert.equal(f.requests[0].body.action,'setup.state');
  assert.equal(f.$('#setup-filter-label').hidden,false);assert.equal(f.$('#more').hidden,true);assert.equal(f.$('#records').children.length,1);assert.match(f.$('#summary').textContent,/1 warten auf Freigabe/);
  f.$('#setup-filter').value='all';f.$('#search').value='Already';await f.load();assert.equal(f.$('#records').children.length,1);assert.equal(f.$('#records').children[0].children[0].textContent,'Already public');
});

test('setup details ignore stale responses after selection and account reset',async()=>{
  const first=defer(),second=defer(),last=defer();let n=0;const f=fixture(()=>[first.promise,second.promise,last.promise][n++]);
  const a=f.setupDetail('a'),b=f.setupDetail('b');second.resolve({result:state([entry('b',{title:'Aktuelle Auswahl'})])});await b;first.resolve({result:state([entry('a',{title:'Alte Auswahl'})])});await a;assert.equal(f.find('h2').textContent,'Aktuelle Auswahl');
  const c=f.setupDetail('c');f.privateReset();last.resolve({result:state([entry('c')])});await c;assert.equal(f.$('#detail').children.length,0);assert.equal(f.$('#detail').hidden,true);
});

test('only submitted pending/hidden entries can be approved and server capability flags win',async()=>{
  let data=state([entry('setup',{contentKind:'draft',status:'draft'})]);const f=fixture(async()=>({result:data}));await f.setupDetail('setup');assert.equal(f.action('Setup freigeben').disabled,true);assert.equal(f.action('Ausblenden / ablehnen').disabled,true);
  data=state([entry('setup')],{enabled:false});await f.setupDetail('setup');assert.equal(f.action('Setup freigeben').disabled,true);
  data=state([entry('setup',{canApprove:false})]);await f.setupDetail('setup');assert.equal(f.action('Setup freigeben').disabled,true);
  data=state([entry('setup',{status:'hidden'})]);await f.setupDetail('setup');assert.equal(f.action('Setup freigeben').disabled,false);
});

test('moderation sends reviewed reason, revision and operation snapshot only after confirmation',async()=>{
  const pending=defer(),f=fixture(async(url,options)=>options.body.action==='setup.moderate'?pending.promise:{result:state()});await f.setupDetail('setup');
  f.find('textarea').value='Geprüfter Grund';const running=f.action('Ausblenden / ablehnen').run();assert.match(f.$('#confirm-text').textContent,/Geprüfter Grund/);assert.match(f.$('#confirm-text').textContent,/bleibt gespeichert/);assert.equal(f.requests.length,1);
  f.find('textarea').value='Spätere Änderung';f.$('#confirm-yes').onclick();await Promise.resolve();
  const submitted=f.requests.find(item=>item.body.action==='setup.moderate');assert.deepEqual(JSON.parse(JSON.stringify(submitted.body.payload)),{id:'setup',expectedRevision:7,operation:'hide',reason:'Geprüfter Grund',confirm:true});
  f.privateReset();pending.resolve({result:state([entry('setup',{status:'hidden',revision:8})])});await running;assert.equal(f.$('#detail').children.length,0);
});

test('empty hide reason is refused and switching detail cancels confirmation',async()=>{
  const f=fixture(async()=>({result:state()}));await f.setupDetail('setup');await assert.rejects(f.action('Ausblenden / ablehnen').run(),/Grund/);assert.equal(f.requests.length,1);
  f.find('textarea').value='Prüfen';const running=f.action('Ausblenden / ablehnen').run();f.invalidateDetail();await running;assert.equal(f.requests.length,1);assert.equal(f.$('#confirm-dialog').open,false);
});

test('private setup images use authenticated admin API and reject non-image payloads',async()=>{
  const data=state([entry('setup',{images:[{id:'image-1',name:'Bild',url:'https://attacker.invalid/image'}]})]);let imageValue={dataUrl:'https://attacker.invalid/image'};
  const f=fixture(async(url,options)=>({result:options.body.action==='setup.image'?imageValue:data}));await f.setupDetail('setup');assert.equal(f.find('img'),undefined);
  await assert.rejects(f.action('Bild 1 ansehen').run(),/Bildvorschau/);assert.equal(f.find('img'),undefined);
  imageValue={dataUrl:'data:image/png;base64,YWJj',mimeType:'image/png'};await f.action('Bild 1 ansehen').run();assert.equal(f.find('img').src,imageValue.dataUrl);
  assert.equal(f.requests.at(-1).body.action,'setup.image');assert.deepEqual(JSON.parse(JSON.stringify(f.requests.at(-1).body.payload)),{id:'setup',imageId:'image-1'});
});

test('private image response cannot repopulate a closed or logged-out detail',async()=>{
  const pending=defer(),data=state([entry('setup',{images:[{id:'image-1'}]})]),f=fixture(async(url,options)=>options.body.action==='setup.image'?pending.promise:{result:data});await f.setupDetail('setup');
  const running=f.action('Bild 1 ansehen').run();f.privateReset();pending.resolve({result:{dataUrl:'data:image/png;base64,YWJj'}});await running;assert.equal(f.$('#detail').children.length,0);
});

test('revision conflict refreshes the reviewed setup without retrying approval',async()=>{
  let changes=0,data=state();const f=fixture(async(url,options)=>{if(options.body.action==='setup.moderate'){changes++;data=state([entry('setup',{title:'Neuer eingereichter Stand',revision:8})]);throw Object.assign(Error('conflict'),{status:409});}return {result:data};});
  await f.setupDetail('setup');const running=f.action('Setup freigeben').run();f.$('#confirm-yes').onclick();await assert.rejects(running,/erneut prüfen/);assert.equal(changes,1);assert.equal(f.find('h2').textContent,'Neuer eingereichter Stand');assert.equal(f.$('#confirm-dialog').open,false);
});

test('successful approval reports the separate Discord delivery state and refreshes the list',async()=>{
  let data=state();const f=fixture(async(url,options)=>{if(options.body.action==='setup.moderate')data=state([entry('setup',{status:'published',revision:8,discordStatus:'queued'})]);return {result:data};});await f.setupDetail('setup');const running=f.action('Setup freigeben').run();f.$('#confirm-yes').onclick();await running;
  assert.equal(f.action('Setup freigeben').disabled,true);assert.match(f.$('#summary').textContent,/0 warten auf Freigabe/);assert.ok(f.notices.some(([text])=>/Discord-Versand/.test(text)));assert.ok(descendants(f.$('#detail')).some(node=>node.textContent==='Für Discord vorgemerkt'));
});

test('mobile markup provides setup navigation, filter and private operator language',()=>{
  const html=fs.readFileSync(new URL('../public/showcase/control-mobile.html',import.meta.url),'utf8');assert.match(html,/data-view="setups"/);assert.match(html,/id="setup-filter"/);assert.match(html,/Gaming Setups freigeben/);
});
