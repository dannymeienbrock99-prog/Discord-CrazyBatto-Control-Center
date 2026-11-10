import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.value='';this.textContent='';this.dataset={};this.classList={toggle(){}};this.hidden=false;}
  addEventListener(name,callback){this.listeners[name]=callback;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  setAttribute(){} focus(){} reportValidity(){return true;}
}
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
function fixture(state){
  const elements=new Map(),created=[],calls=[],redirects=[],get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const document={getElementById:get,createElement(tag){const node=new Element(tag);created.push(node);return node;},createDocumentFragment:()=>new Element('fragment'),querySelectorAll:selector=>created.filter(node=>selector==='[data-suite-license]'?node.dataset.suiteLicense:node.tag==='button'),addEventListener(){}};
  const context={document,window:{addEventListener(){}},location:{hash:'',search:'?returnTo=chat',pathname:'/registrierung.html',assign:url=>redirects.push(url)},history:{replaceState(){}},URLSearchParams,setTimeout,clearTimeout,api:async(url,options)=>{calls.push({url,options});return{apps:[]};},getSession:async()=>state,login:async()=>state,register:async()=>({}),logout:async()=>({}),errorText:error=>error.message,statusLabel:String,formatDate:String};
  const source=fs.readFileSync(new URL('../public/showcase/assets/account-page.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/,'').replace(/void refresh\(\);\s*$/,'');
  vm.runInNewContext(source+'\nglobalThis.showFixture=value=>{session=value;apps=[{id:"discord-app",name:"Discord"},{id:"batto-3-in-1",name:"Suite"}];render();};',context);
  context.showFixture(state);return {get,calls,redirects,render:context.showFixture,history:()=>descendants(get('requestHistory'))};
}
const account=status=>({user:{id:'member',name:'Mitglied',email:'private@example.invalid',confirmed:true,suspended:false,isAdmin:false},approval:{status,reason:status==='rejected'?'Bitte Rückfrage klären':''},profileComplete:false,requests:[{id:'one',appId:'discord-app',status:'approved'},{id:'two',appId:'batto-3-in-1',status:'approved'}]});
for(const status of ['pending','rejected'])test('registration '+status+' hides protected actions and suppresses login redirects',async()=>{
  const state=account(status),f=fixture(state);assert.equal(f.get('memberApproval').hidden,false);assert.equal(f.get('requestArea').hidden,true);assert.equal(f.get('profileLink').hidden,true);assert.equal(f.get('pcSupportLink').hidden,true);assert.equal(f.get('profileCompletionNote').hidden,true);
  assert.equal(f.history().some(node=>node.tag==='a'||node.textContent==='Lizenzschlüssel anzeigen'),false);
  assert.match(f.get('memberApprovalTitle').textContent,status==='rejected'?/nicht freigegeben/:/steht noch aus/);if(status==='rejected')assert.match(f.get('memberApprovalText').textContent,/Rückfrage/);
  await f.get('requestForm').listeners.submit({preventDefault(){},currentTarget:f.get('requestForm')});assert.equal(f.calls.length,0);
  await f.get('loginForm').listeners.submit({preventDefault(){},currentTarget:f.get('loginForm')});assert.deepEqual(f.redirects,[]);
});
test('approved registration restores permitted controls while preserving profile completion requirement',()=>{
  const state=account('approved'),f=fixture(state);assert.equal(f.get('memberApproval').hidden,true);assert.equal(f.get('profileLink').hidden,false);assert.equal(f.get('pcSupportLink').hidden,false);assert.equal(f.get('requestArea').hidden,true);assert.equal(f.get('profileCompletionNote').hidden,false);assert(f.history().some(node=>node.tag==='a'));assert(f.history().some(node=>node.textContent==='Lizenzschlüssel anzeigen'));
  state.profileComplete=true;f.render(state);assert.equal(f.get('requestArea').hidden,false);
});
test('the owner retains protected controls even when the administrative approval record is pending',()=>{
  const state=account('pending');state.user.isAdmin=true;const f=fixture(state);assert.equal(f.get('memberApproval').hidden,true);assert.equal(f.get('requestArea').hidden,false);assert.equal(f.get('profileLink').hidden,false);
});
