'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const vm=require('node:vm');
const c=require('../electron/local-discord-core.cjs');
const {LocalDiscordService}=require('../electron/local-discord.cjs');
const {renderCompanion}=require('../electron/local-build-companion.cjs');
const {fs,path}=c;
const ACCOUNT='900000000000000017',GUILD='900000000000000003',ROLE='900000000000000004';
async function fixture(t,{restricted=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'crazybatto-local-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const appDataDirectory=path.join(root,'AppData'),folder=path.join(appDataDirectory,'BetterDiscord','plugins');fs.mkdirSync(folder,{recursive:true});
  const service=new LocalDiscordService({directory:path.join(root,'userData'),appDataDirectory,requestTimeout:1800});
  for(const spec of Object.values(c.catalog))fs.writeFileSync(path.join(folder,spec.file),`/**\n * @name ${spec.id}\n * @version ${spec.version}\n */\nthrow new Error('Third-party files must never execute');`);
  await service.run('localdiscord.install',{confirm:true});
  const enabled=new Set(['BDFDB','StaffTag','ShowSpectators']);const data=new Map();const store={};const calls=[];
  store.UserStore={getCurrentUser:()=>({id:ACCOUNT}),getUser:id=>({id,username:`Member ${id.slice(-2)}`})};
  store.SelectedChannelStore={getChannelId:()=> '900000000000000005',getVoiceChannelId:()=> '900000000000000005'};
  store.ChannelStore={getChannel:()=>({guild_id:GUILD,name:'Sprachkanal'})};store.GuildMemberStore={getMember:()=>({roles:[ROLE]})};
  const staff={getUserType:()=>null,injectStaffTag:(children)=>children.push({key:'original'}),forceUpdateAll(){}};
  function persist(id,key,value){data.set(`${id}:${key}`,JSON.parse(JSON.stringify(value)));let current={};const file=path.join(folder,`${id}.config.json`);if(fs.existsSync(file))current=JSON.parse(fs.readFileSync(file));current[key]=value;fs.writeFileSync(file,JSON.stringify(current));}
  const api={Plugins:{folder,isEnabled:id=>enabled.has(id),get:id=>id==='StaffTag'?{instance:staff}:{name:id},enable:async id=>{calls.push(['enable',id]);enabled.add(id);return true;},disable:async id=>{calls.push(['disable',id]);enabled.delete(id);return true;},reload:async id=>{calls.push(['reload',id]);return true;}},Data:{load:(id,key)=>data.get(`${id}:${key}`),save:persist},Webpack:{getStore:name=>store[name]},React:{createElement:(type,props,...children)=>({type,...props,props:{...props,children}})},Patcher:{after(_caller,object,key,callback){const original=object[key];object[key]=function(...args){const result=original.apply(this,args);return callback(this,args,result)??result;};return()=>object[key]=original;},instead(_caller,object,key,callback){const original=object[key];object[key]=function(...args){return callback(this,args,original.bind(this));};return()=>object[key]=original;}}};
  const library={DataUtils:{load:id=>data.get(`${id}:bdfdb`)||{},save:(value,id)=>{data.set(`${id}:bdfdb`,JSON.parse(JSON.stringify(value)));fs.writeFileSync(path.join(folder,`${id}.config.json`),JSON.stringify({all:value}));}}};
  let Companion,coreRuntime=c,polyfillFs=null;const requestedModules=[];
  if(restricted){
    const restrictedFs=Object.fromEntries(['existsSync','realpathSync','mkdirSync','readdirSync','renameSync','unlinkSync','writeFileSync'].map(key=>[key,fs[key].bind(fs)]));
    polyfillFs=restrictedFs;
    restrictedFs.lstatSync=restrictedFs.statSync=file=>{const stat=fs.statSync(file);return {...stat,isFile:stat.isFile.bind(stat),isDirectory:stat.isDirectory.bind(stat),isSymbolicLink:stat.isSymbolicLink.bind(stat)};};
    restrictedFs.readFileSync=(file,options='utf8')=>fs.readFileSync(file,options);
    const restrictedCrypto={createHash(type){const hash=c.crypto.createHash(type);const context={update(value){hash.update(value);return context;},digest(encoding){return hash.digest(encoding);}};return context;},randomBytes:count=>Buffer.from(c.crypto.randomBytes(count))};
    const cache=new Map();function load(file){if(cache.has(file))return cache.get(file);const module={exports:{}};cache.set(file,module.exports);vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(file,'utf8')}\n})`,{filename:file})(restrictedRequire,module,module.exports,file,path.dirname(file));cache.set(file,module.exports);return module.exports;}
    function restrictedRequire(name){requestedModules.push(name);if(name==='fs')return restrictedFs;if(name==='path')return path;if(name==='crypto')return restrictedCrypto;throw new TypeError('BetterDiscord external helper compiler: options argument must be an object');}
    Companion=load(path.join(folder,'CrazyBattoControl.plugin.js'));
    coreRuntime=load(path.resolve(__dirname,'../electron/local-discord-core.cjs'));
  }else Companion=require(path.join(folder,'CrazyBattoControl.plugin.js'));
  const companion=new Companion({}, {api,folder,library});companion.start();t.after(()=>companion.stop());
  const rawRun=service.run.bind(service);
  service.run=(action,payload={})=>{const heartbeat=service.heartbeat();return rawRun(action,['localdiscord.state','localdiscord.install'].includes(action)?payload:{expectedBinding:heartbeat?c.digest({bootId:heartbeat.bootId,accountId:heartbeat.accountId}):null,...payload});};
  return {root,folder,service,rawRun,companion,data,enabled,store,calls,staff,api,library,coreRuntime,polyfillFs,requestedModules};
}
test('Discovery only parses exact allowlisted metadata and never executes third-party code',async t=>{
  const f=await fixture(t);const state=await f.service.run('localdiscord.state');assert.equal(state.bridge.connected,true);assert.equal(state.plugins.length,9);assert.equal(state.plugins.find(x=>x.id==='StaffTag').version,'1.7.4');
  fs.writeFileSync(path.join(f.folder,'StaffTag.plugin.js'),'/** @name DifferentPlugin\n @version 1.7.4 */');
  const found=c.discover(f.folder).find(x=>x.id==='StaffTag');assert.equal(found.installed,false);
});
test('Live toggle checks real API state and dependency order',async t=>{
  const f=await fixture(t);await assert.rejects(f.service.run('localdiscord.toggle',{pluginId:'BDFDB',enabled:false}),/zuerst StaffTag/);
  let state=await f.service.run('localdiscord.toggle',{pluginId:'VoiceMessages',enabled:true});assert.equal(state.plugins.find(x=>x.id==='VoiceMessages').enabled,true);
  f.api.Plugins.disable=async()=>false;await assert.rejects(f.service.run('localdiscord.toggle',{pluginId:'VoiceMessages',enabled:false}),/nicht herstellen/);
  await assert.rejects(f.service.run('localdiscord.toggle',{pluginId:'../escape',enabled:true}),/nicht unterstützt/);
});
test('Settings use optimistic concurrency, backup, safe schemas and preserve unexposed options',async t=>{
  const f=await fixture(t);f.api.Data.save('VoiceMessages','settings',{skipMetadata:false,voiceDownload:true,other:'preserved'});
  const initial=await f.service.run('localdiscord.settings',{pluginId:'VoiceMessages'});
  const saved=await f.service.run('localdiscord.save',{pluginId:'VoiceMessages',expectedRevision:initial.revision,values:{voiceDownload:false}});
  assert.equal(saved.values.voiceDownload,false);assert.equal(f.data.get('VoiceMessages:settings').other,'preserved');
  assert.ok(fs.readdirSync(path.join(f.companion.bridge,'backups')).some(name=>name.startsWith('VoiceMessages.config.json.')));
  await assert.rejects(f.service.run('localdiscord.save',{pluginId:'VoiceMessages',expectedRevision:initial.revision,values:{voiceDownload:true}}),/zwischenzeitlich/);
  await assert.rejects(f.service.run('localdiscord.save',{pluginId:'VoiceMessages',expectedRevision:saved.revision,values:{arbitraryCommand:'no'}}),/Unbekannte/);
});
test('BDFDB schema updates its cache through DataUtils; advanced ChatFilter rules survive',async t=>{
  const f=await fixture(t);f.data.set('ChatFilter:bdfdb',{words:{blocked:{existing:{regex:false,exact:true,replace:''},advanced:{regex:true,replace:'custom'}}},general:{targetMessages:true}});
  const state=await f.service.run('localdiscord.settings',{pluginId:'ChatFilter'});assert.deepEqual(state.values.blockedWords,['existing']);
  await f.service.run('localdiscord.save',{pluginId:'ChatFilter',expectedRevision:state.revision,values:{blockedWords:['new']}});
  assert.ok(f.data.get('ChatFilter:bdfdb').words.blocked.advanced);assert.ok(f.data.get('ChatFilter:bdfdb').words.blocked.new);assert.equal(f.data.get('ChatFilter:bdfdb').words.blocked.existing,undefined);
});
test('Spotify changes disable the unsupported listen-along patch without exposing credentials',async t=>{
  const f=await fixture(t);f.api.Data.save('SpotifyEnhance','settings',{enableListenAlong:true,player:true});
  await f.service.run('localdiscord.toggle',{pluginId:'SpotifyEnhance',enabled:true});assert.equal(f.data.get('SpotifyEnhance:settings').enableListenAlong,false);
  const settings=await f.service.run('localdiscord.settings',{pluginId:'SpotifyEnhance'});assert.equal(settings.fields.some(field=>field.key==='enableListenAlong'),false);
});
test('Role badge patches match roles without rights or nickname changes and undo cleanly',async t=>{
  const f=await fixture(t);const state=await f.service.run('localdiscord.state');
  const saved=await f.service.run('localdiscord.roles.save',{expectedRevision:state.roleBadges.revision,enabled:true,guildId:GUILD,rules:[{roleId:ROLE,label:'King',icon:'crown',color:'#d4af37'}]});
  assert.equal(saved.roleBadges.active,true);assert.equal(f.staff.getUserType({id:ACCOUNT}),'crazybatto-role');
  const children=[];f.staff.injectStaffTag(children,{id:ACCOUNT},'crazybatto-role',0,{});assert.equal(children[0].title,'King');assert.equal(children[0].props.style.color,'#d4af37');
  f.companion.stop();assert.equal(f.staff.getUserType({id:ACCOUNT}),null);assert.equal(f.calls.some(call=>/nick|role|permission/.test(call[0])),false);
});
test('Spectators are only from current own or explicitly watched stream',async t=>{
  const f=await fixture(t);f.store.ApplicationStreamingStore={getCurrentUserActiveStream:()=>({ownerId:ACCOUNT,channelId:'900000000000000005'}),getViewerIds:()=>[ACCOUNT]};
  let result=await f.service.run('localdiscord.spectators');assert.equal(result.source,'own');assert.equal(result.viewers[0].id,ACCOUNT);
  f.store.ApplicationStreamingStore.getCurrentUserActiveStream=()=>null;result=await f.service.run('localdiscord.spectators');assert.equal(result.active,false);assert.deepEqual(result.viewers,[]);
});
test('History only loads the current account and returns minimum bounded display fields',async t=>{
  const f=await fixture(t);f.data.set(`RemovedConnectionAlerts_${ACCOUNT}:savedData`,{friendCache:[{private:'not returned'}],removedFriendHistory:[{id:'900000000000000004',globalName:'Example',timeRemoved:1700000000000,avatarURL:'private'}],removedGuildHistory:[]});
  const result=await f.service.run('localdiscord.history',{limit:1});assert.equal(result.entries.length,1);assert.deepEqual(Object.keys(result.entries[0]).sort(),['id','kind','name','removedAt']);assert.equal(JSON.stringify(result).includes('private'),false);
  await assert.rejects(f.service.run('localdiscord.history',{accountId:'900000000000000007'}),/Unbekannte/);
});
test('Heartbeat expiry and stopped companion do not pretend the client is connected',async t=>{
  const f=await fixture(t);f.companion.stop();const state=await f.service.run('localdiscord.state');assert.equal(state.bridge.connected,false);assert.equal(state.plugins[0].enabled,null);
  await assert.rejects(f.service.run('localdiscord.settings',{pluginId:'StaffTag'}),/nicht verbunden/);
});
test('Authenticated requests execute at most once; stale and forged requests never execute',async t=>{
  const f=await fixture(t);clearInterval(f.companion.timer);const secret=f.service.pair().secret;
  const id=c.crypto.randomUUID(),time=Date.now(),request={protocol:1,id,issuedAt:time,expiresAt:time+1000,bootId:f.companion.bootId,accountId:ACCOUNT,operation:'toggle',payload:{pluginId:'VoiceMessages',enabled:true}};
  const file=`${id}.json`,target=path.join(f.companion.bridge,'requests',file);
  c.jsonAtomic(target,c.signed(request,secret));await f.companion.consume(file);c.jsonAtomic(target,c.signed(request,secret));await f.companion.consume(file);assert.equal(f.calls.filter(([action,id])=>action==='enable'&&id==='VoiceMessages').length,1);
  const stale={...request,id:c.crypto.randomUUID(),issuedAt:time-40000,expiresAt:time-1000};c.jsonAtomic(path.join(f.companion.bridge,'requests',`${stale.id}.json`),c.signed(stale,secret));await f.companion.consume(`${stale.id}.json`);
  const forged={...request,id:c.crypto.randomUUID()};c.jsonAtomic(path.join(f.companion.bridge,'requests',`${forged.id}.json`),c.signed(forged,'incorrect'));await f.companion.consume(`${forged.id}.json`);assert.equal(f.calls.length,1);
});
test('Hardlinks and symlinks are rejected before configuration writes',async t=>{
  const f=await fixture(t);const victim=path.join(f.root,'outside.json');fs.writeFileSync(victim,'{"sentinel":true}');fs.linkSync(victim,path.join(f.folder,'VoiceMessages.config.json'));
  await assert.rejects(f.service.run('localdiscord.settings',{pluginId:'VoiceMessages'}),/nicht sicher/);assert.equal(fs.readFileSync(victim,'utf8'),'{"sentinel":true}');
  const link=path.join(f.root,'bridge-link');try{fs.symlinkSync(f.companion.bridge,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>c.checkPath(path.join(link,'auth.json')),/Verknüpfte/);}catch(error){if(error.code!=='EPERM')throw error;}
});
test('Installer refuses another pairing and never overwrites an unrelated same-name plugin',async t=>{
  const f=await fixture(t);f.companion.stop();fs.writeFileSync(path.join(f.folder,'CrazyBattoControl.plugin.js'),'unrelated plugin');
  await assert.rejects(f.service.run('localdiscord.install',{confirm:true}),/fremde Datei/);
});
test('Forged and stale acknowledgements are rejected; responses cannot survive a client account switch',async t=>{
  const f=await fixture(t);clearInterval(f.companion.timer);
  async function rejectResponse(kind){
    const request=f.service.request('spectators',{});const requests=path.join(f.companion.bridge,'requests');
    const filename=fs.readdirSync(requests).find(name=>name.endsWith('.json'));assert.ok(filename);
    const input=c.readJson(path.join(requests,filename));let response={protocol:1,id:input.id,bootId:input.bootId,accountId:input.accountId,time:input.issuedAt,ok:true,result:{never:'displayed'}};
    if(kind==='stale')response.time=input.issuedAt-1;
    c.jsonAtomic(path.join(f.companion.bridge,'responses',filename),c.signed(response,kind==='forged'?'invalid':f.service.pair().secret));
    if(kind==='account'){f.store.UserStore.getCurrentUser=()=>({id:'900000000000000007'});f.companion.heartbeat();}
    await assert.rejects(request,kind==='account'?/Konto gewechselt/:/nicht sicher bestätigt/);
  }
  await rejectResponse('forged');await rejectResponse('stale');await rejectResponse('account');
});
test('Expired heartbeat and incompatible plugin versions are blocked without mutation',async t=>{
  const f=await fixture(t);clearInterval(f.companion.timer);const secret=f.service.pair().secret;
  fs.writeFileSync(path.join(f.folder,'VoiceMessages.plugin.js'),'/**\n * @name VoiceMessages\n * @version 99.0.0\n */');
  await assert.rejects(f.companion.dispatch('toggle',{pluginId:'VoiceMessages',enabled:true}),/noch nicht geprüft/);assert.equal(f.enabled.has('VoiceMessages'),false);
  c.jsonAtomic(path.join(f.companion.bridge,'heartbeat.json'),c.signed({protocol:1,bootId:f.companion.bootId,accountId:ACCOUNT,time:Date.now()-9000},secret));
  assert.equal(f.service.heartbeat(),null);
});
test('Companion runs with actual BetterDiscord module and filesystem restrictions',async t=>{
  const f=await fixture(t,{restricted:true});
  const state=await f.service.run('localdiscord.state');assert.equal(state.bridge.connected,true);assert.match(state.bridge.binding,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(state).includes(ACCOUNT),false);
  const before=await f.service.run('localdiscord.settings',{pluginId:'VoiceMessages'});
  const after=await f.service.run('localdiscord.save',{pluginId:'VoiceMessages',expectedRevision:before.revision,values:{voiceDownload:false}});assert.equal(after.values.voiceDownload,false);
  const toggled=await f.service.run('localdiscord.toggle',{pluginId:'VoiceMessages',enabled:true});assert.equal(toggled.plugins.find(item=>item.id==='VoiceMessages').enabled,true);
  assert.ok(f.requestedModules.every(name=>['fs','path','crypto'].includes(name)));assert.equal(fs.existsSync(path.join(f.folder,'.crazybatto-control','local-discord-core.js')),false);
  await assert.rejects(f.rawRun('localdiscord.toggle',{expectedBinding:'0'.repeat(64),pluginId:'VoiceMessages',enabled:false}),/gewechselt/);assert.equal(f.enabled.has('VoiceMessages'),true);
  for(const secret of ['short','a'.repeat(64),'b'.repeat(100)]){const message={unicode:'Krone 👑',value:27};assert.deepEqual(f.coreRuntime.signed(message,secret),c.signed(message,secret));}
  const originalRealpath=f.polyfillFs.realpathSync,target=path.join(f.folder,'VoiceMessages.config.json');f.polyfillFs.realpathSync=file=>file===target?path.join(f.root,'redirected.json'):originalRealpath(file);
  assert.throws(()=>f.companion.settings('VoiceMessages'),/Verknüpfte/);f.polyfillFs.realpathSync=originalRealpath;
});
test('Single-file companion exactly embeds our current sources without external imports or dynamic compilation',()=>{
  const core=fs.readFileSync(path.resolve(__dirname,'../electron/local-discord-core.cjs'),'utf8');
  const runtime=fs.readFileSync(path.resolve(__dirname,'../electron/local-companion-runtime.cjs'),'utf8');
  const actual=fs.readFileSync(path.resolve(__dirname,'../electron/betterdiscord/CrazyBattoControl.plugin.js'),'utf8');
  assert.equal(actual,renderCompanion(core,runtime));
  const imports=[...actual.matchAll(/\brequire\s*\(([^)]*)\)/g)].map(match=>match[1]);assert.deepEqual(imports,["'fs'","'path'","'crypto'"]);
  assert.equal(/\beval\s*\(|\bnew\s+Function\s*\(/.test(actual),false);
  assert.throws(()=>renderCompanion(core+"\nrequire('/external/helper.js');",runtime),/built-ins/);
});
test('Account change between queued binding check and actual dispatch cannot redirect a saved action',async t=>{
  const f=await fixture(t),state=await f.service.run('localdiscord.state');
  const original=f.service.heartbeat.bind(f.service);let checks=0;
  f.service.heartbeat=(...args)=>{if(++checks===2){f.store.UserStore.getCurrentUser=()=>({id:'900000000000000007'});f.companion.heartbeat();}return original(...args);};
  await assert.rejects(f.rawRun('localdiscord.toggle',{expectedBinding:state.bridge.binding,pluginId:'VoiceMessages',enabled:true}),/gewechselt/);
  assert.equal(f.enabled.has('VoiceMessages'),false);assert.equal(f.calls.length,0);
});
test('Oversized existing ChatFilter lists cannot be silently truncated on an unrelated setting save',async t=>{
  const f=await fixture(t),words=Object.fromEntries(Array.from({length:101},(_,index)=>[`word${index}`,{replace:'',exact:true,regex:false}]));
  const config={words:{blocked:words},general:{targetMessages:true}};f.data.set('ChatFilter:bdfdb',config);
  await assert.rejects(f.service.run('localdiscord.settings',{pluginId:'ChatFilter'}),/mehr als 100/);
  await assert.rejects(f.service.run('localdiscord.save',{pluginId:'ChatFilter',expectedRevision:c.digest(config),values:{'general.targetMessages':false}}),/mehr als 100/);
  assert.equal(Object.keys(f.data.get('ChatFilter:bdfdb').words.blocked).length,101);assert.equal(f.data.get('ChatFilter:bdfdb').general.targetMessages,true);
});
