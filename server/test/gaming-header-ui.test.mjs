import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value='';this.attributes={};this.playCalls=0;this.pauseCalls=0;this.loadCalls=0;this.textContent='';this.classList={toggle(){}};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(name,callback){this.listeners[name]=callback;}
  setAttribute(name,value){this.attributes[name]=value;}
  removeAttribute(name){delete this[name];delete this.attributes[name];}
  play(){this.playCalls++;return Promise.resolve();}
  pause(){this.pauseCalls++;}
  load(){this.loadCalls++;}
  showModal(){this.open=true;}
  close(){this.open=false;}
  get childNodes(){return this.children;}
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
function fixture({reduced=false,saveData=false,apiResult={}}={}){
  const ids=new Map(),observers=[],motionListeners=new Map(),pageListeners=new Map(),apiCalls=[];
  const get=id=>{if(!ids.has(id))ids.set(id,new Element(id));return ids.get(id);};
  const motion={matches:reduced,addEventListener(name,fn){motionListeners.set(name,fn);},removeEventListener(name,fn){if(motionListeners.get(name)===fn)motionListeners.delete(name);}};
  const document={hidden:false,getElementById:get,createElement:tag=>new Element(tag),addEventListener(name,fn){pageListeners.set(name,fn);},removeEventListener(name,fn){if(pageListeners.get(name)===fn)pageListeners.delete(name);}};
  const context={api:async route=>{apiCalls.push(route);if(apiResult instanceof Error)throw apiResult;return apiResult;},errorText:error=>error.message,document,window:{addEventListener(){}},navigator:{connection:{saveData}},matchMedia:()=>motion,URL,URLSearchParams,location:{origin:'https://example.invalid',hash:'',search:''},IntersectionObserver:class{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(target){this.target=target;}disconnect(){this.disconnected=true;}}};
  const source=fs.readFileSync(new URL('../public/showcase/assets/gaming-setups.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/loadAccount\(\);\s*loadGallery\(\)\.then\(openLinkedSetup\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.renderFixture=entries=>{galleryEntries=entries;renderGallery();};globalThis.openLinkedFixture=openLinkedSetup;',context);
  return {get,motion,motionListeners,pageListeners,document,observers,apiCalls,location:context.location,openLinked:context.openLinkedFixture,render:context.renderFixture,nodes:()=>descendants(get('gs-gallery')),video:()=>descendants(get('gs-gallery')).find(node=>node.tag==='video')};
}
test('empty public gallery presents the supplied video, real submission link and approval explanation',()=>{
  const f=fixture();f.render([]);const video=f.video();
  assert.equal(video.src,'/assets/control/gaming-setups-header.mp4');assert.equal(video.poster,'/assets/control/gaming-setups-header.jpg');
  assert(video.controls&&video.muted&&video.defaultMuted&&video.playsInline&&video.loop);assert.equal(video.preload,'none');assert.equal(video.playCalls,0);
  assert(f.nodes().some(node=>node.tag==='a'&&node.href==='#mein-setup'));assert(f.nodes().some(node=>/Nach der Freigabe durch das Team/.test(node.textContent)));
  f.observers[0].callback([{isIntersecting:true}]);assert.equal(video.playCalls,1);assert.equal(f.observers[0].disconnected,true);
});
for(const options of [{reduced:true},{saveData:true}])test('motion or data-saving preference prevents automatic video fetching and playback '+JSON.stringify(options),()=>{
  const f=fixture(options);f.render([]);assert.equal(f.observers.length,0);assert.equal(f.video().playCalls,0);assert.equal(f.video().preload,'none');assert.equal(f.video().controls,true);
});
test('filtering removes the header, pauses playback and unregisters listeners without replacing real setup cards',()=>{
  const f=fixture();f.render([]);const old=f.video(),observer=f.observers[0];f.get('gs-search').value='Unbekannt';f.render([]);
  assert.equal(old.pauseCalls,1);assert.equal(old.loadCalls,1);assert.equal(old.src,undefined);assert(observer.disconnected);assert.equal(f.motionListeners.size,0);assert.equal(f.pageListeners.size,0);assert.equal(f.video(),undefined);
  assert(f.nodes().some(node=>node.textContent==='Noch kein passendes Setup gefunden'));
  f.get('gs-search').value='';f.render([{id:'public-example',authorName:'Beispiel',title:'Mein Setup',description:'Ein echter veröffentlichter Eintrag',specs:{},images:[]}]);
  assert.equal(f.video(),undefined);assert(f.nodes().some(node=>node.textContent==='Mein Setup'));
});
test('changing to reduced motion or hiding the page pauses the running video',()=>{
  const f=fixture();f.render([]);const video=f.video();f.motion.matches=true;f.motionListeners.get('change')();assert.equal(video.pauseCalls,1);
  f.document.hidden=true;f.pageListeners.get('visibilitychange')();assert.equal(video.pauseCalls,2);
});

test('community and submission section anchors never request a setup or show an unavailable error',async()=>{
  const f=fixture({apiResult:Error('Not public')});f.render([]);const video=f.video();
  for(const hash of ['#setup-galerie','#mein-setup','#setup-invalid','#setup-'+ 'a'.repeat(36)]){
    f.location.hash=hash;await f.openLinked();assert.equal(f.get('gs-gallery-status').textContent,'');assert.equal(f.get('gs-detail').open,undefined);assert.equal(f.video(),video);
  }
  assert.deepEqual(f.apiCalls,[]);
});

test('valid public setup links still open fetched or cached entries and section navigation wins over a query',async()=>{
  const id='17b2c3d4-1234-4567-89ab-123456789abc',setup={id,title:'Mein öffentlicher PC',authorName:'Beispiel',specs:{},images:[]};
  const f=fixture({apiResult:{setup}});f.location.hash='#setup-'+id.toUpperCase();await f.openLinked();
  assert.deepEqual(f.apiCalls,['/api/gaming-setups/'+id]);assert.equal(f.get('gs-detail').open,true);assert(descendants(f.get('gs-detail-content')).some(node=>node.textContent===setup.title));
  f.get('gs-detail').close();f.location.hash='';f.location.search='?setup='+id;f.render([setup]);await f.openLinked();assert.equal(f.get('gs-detail').open,true);assert.equal(f.apiCalls.length,1);
  f.get('gs-detail').close();f.location.hash='#setup-galerie';await f.openLinked();assert.equal(f.get('gs-detail').open,false);assert.equal(f.apiCalls.length,1);
});

test('a genuine unavailable setup link still gives a clear public availability error',async()=>{
  const f=fixture({apiResult:Error('Bitte später prüfen.')});f.location.hash='#setup-17b2c3d4-1234-4567-89ab-123456789abc';await f.openLinked();
  assert.equal(f.apiCalls.length,1);assert.match(f.get('gs-gallery-status').textContent,/Dieses Setup ist nicht öffentlich verfügbar/);assert.equal(f.get('gs-detail').open,undefined);
});
