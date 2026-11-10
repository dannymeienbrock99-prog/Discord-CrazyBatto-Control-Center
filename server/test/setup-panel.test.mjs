import test from 'node:test';
import {withCommunitySqlite} from './helpers/community-fixture-store.mjs';
import assert from 'node:assert/strict';
import { SetupPanel, SETUP_PANEL_ACTIONS } from '../src/setup-panel.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID as BOT } from '../src/community-schema.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018',CHANNEL='900000000000000036',OTHER_CHANNEL='900000000000000012',BOTROLE='900000000000000051',MESSAGE='900000000000000039';
const KEY='setup_panel_v1', LINK='https://crazybatto.de/eure-gaming-setups.html#mein-setup';
const admin={user:{id:'admin-fixture'},admin:true}, ordinary={user:{id:'member-fixture'},admin:false};
function fixture() {
  const storage=new Map(),calls=[],messages=new Map();
  const state={hook:null,revoked:false,now:1794250000000,nextMessage:BigInt(MESSAGE)};
  const guild={id:GUILD,owner_id:'900000000000000041',roles:[{id:GUILD,permissions:'0',position:0},{id:BOTROLE,permissions:String(P.ADMINISTRATOR),position:20}]};
  const channels=new Map([CHANNEL,OTHER_CHANNEL].map(id=>[id,{id,guild_id:GUILD,type:0,name:'test-channel',permission_overwrites:[]}]));
  const store={setting:key=>storage.get(key),setSetting:(key,value)=>storage.set(key,value),transaction(fn){const before=new Map(storage);try{return fn();}catch(error){storage.clear();for(const [k,v]of before)storage.set(k,v);throw error;}}};
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fixture-token-not-real'},accounts:{store,assertCurrent(context,{admin:requireAdmin}={}){assert.equal(requireAdmin,true);if(!context||!context.admin||state.revoked)throw new AppError('auth','Bitte als Administrator anmelden.',401);}},discord:{async request(method,route,{payload}={}){
    calls.push({method,route,payload:structuredClone(payload)});
    const overridden=await state.hook?.(method,route,payload);if(overridden!==undefined)return overridden;
    if(route==='/users/@me')return {id:BOT,bot:true};
    if(method==='GET'&&route===`/guilds/${GUILD}?with_counts=true`)return structuredClone(guild);
    if(method==='GET'&&route===`/guilds/${GUILD}/members/${BOT}`)return {user:{id:BOT,bot:true},roles:[BOTROLE]};
    const channel=/^\/channels\/(\d+)$/.exec(route);
    if(method==='GET'&&channel)return structuredClone(channels.get(channel[1]));
    const create=/^\/channels\/(\d+)\/messages$/.exec(route);
    if(method==='POST'&&create){const message={id:String(state.nextMessage++),channel_id:create[1],author:{id:BOT,bot:true},...structuredClone(payload)};messages.set(message.id,message);return structuredClone(message);}
    const existing=/^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route);
    if(existing){const message=messages.get(existing[2]);if(!message)throw new AppError('forbidden','Nachricht fehlt.',404);if(method==='GET')return structuredClone(message);if(method==='PATCH'){Object.assign(message,structuredClone(payload));return structuredClone(message);}}
    throw Error('Unexpected fixture request '+method+' '+route);
  }}};
  withCommunitySqlite(service.accounts.store);
  service.communityControl=new CommunityControl(service,{now:()=>state.now});
  let panel=new SetupPanel(service,{now:()=>++state.now});
  const run=(action,payload={},ctx=admin)=>panel.run(ctx,action,{guildId:GUILD,...payload});
  const save=(patch={},revision=panel.data().revision)=>run('setup.panel.save',{expectedRevision:revision,settings:{...panel.data().settings,channelId:CHANNEL,...patch},confirm:true});
  const publish=(revision=panel.data().revision)=>run('setup.panel.publish',{expectedRevision:revision,confirm:true});
  const mutations=()=>calls.filter(call=>call.method!=='GET');
  const seed=async()=>{await save();await publish();calls.length=0;};
  const restart=()=>{panel=new SetupPanel(service,{now:()=>++state.now});return panel;};
  return{get panel(){return panel;},service,guild,channels,storage,state,calls,messages,run,save,publish,mutations,seed,restart};
}

test('state is private, defaults describe the review flow, and reading creates nothing',async()=>{
  const f=fixture();const result=await f.run('setup.panel.state');
  assert.deepEqual(SETUP_PANEL_ACTIONS,['setup.panel.state','setup.panel.save','setup.panel.publish']);
  assert.equal(result.revision,0);assert.equal(result.settings.title,'Eure Gaming Setups');assert.match(result.settings.description,/Registriere.*Bilder.*Hardware.*Admin-Freigabe/s);
  assert.equal(result.publication,null);assert.equal(result.publishAttempt,null);assert.equal(f.storage.size,0);assert.equal(f.mutations().length,0);
  await assert.rejects(f.run('setup.panel.state',{},ordinary),{status:401});await assert.rejects(f.panel.run(null,'setup.panel.state'),{status:401});
});

test('saving requires the reviewed server, confirmation, exact revision and only supported fields',async()=>{
  const f=fixture(),value={...f.panel.data().settings,channelId:CHANNEL};
  for(const payload of [{confirm:false},{guildId:OTHER_CHANNEL},{expectedRevision:-1},{expectedRevision:1},{settings:{...value,buttonUrl:'https://attacker.org'}},{settings:{...value,roleIds:[BOTROLE]}},{settings:{...value,title:''}},{settings:{...value,title:'x'.repeat(257)}},{settings:{...value,description:''}},{settings:{...value,buttonLabel:'x'.repeat(81)}},{settings:{...value,title:'Titel\u202e'}}])await assert.rejects(f.run('setup.panel.save',{expectedRevision:0,settings:value,confirm:true,...payload}));
  assert.equal(f.panel.data().revision,0);assert.equal(f.mutations().length,0);
  const saved=await f.save();assert.equal(saved.revision,1);assert.equal(saved.publication,null);assert.equal(f.mutations().length,0);
  await assert.rejects(f.save({},0),{status:409});
});

test('image links reject local/private addresses, credentials, ports, controls and video URLs without fetching them',async()=>{
  const f=fixture();
  for(const imageUrl of ['http://crazybatto.de/x.png','https://localhost/x.png','https://pc.local/x.png','https://pc.home.arpa/x.png','https://internal/x.png','https://127.0.0.1/x.png','https://2130706433/x.png','https://[::1]/x.png','https://user:secret@crazybatto.de/x.png','https://crazybatto.de:444/x.png','https://crazybatto.de/x.png#section','https://crazybatto.de/\nimage.png','https://crazybatto.de\\@internal/x.png','https://crazybatto.de/%6div.mp4','https://crazybatto.de/%FF.png'])await assert.rejects(f.save({imageUrl}));
  assert.equal(f.calls.length,0);
  assert.equal((await f.save({imageUrl:'https://crazybatto.de/assets/control/setup.png'})).settings.imageUrl,'https://crazybatto.de/assets/control/setup.png');
});

test('foreign channels, non-text channels and insufficient permissions cannot be saved or published',async()=>{
  for(const mutate of [f=>f.channels.get(CHANNEL).guild_id=OTHER_CHANNEL,f=>f.channels.get(CHANNEL).type=15,f=>f.guild.roles[1].permissions=String(P.VIEW_CHANNEL|P.SEND_MESSAGES|P.EMBED_LINKS)]){
    const f=fixture();mutate(f);await assert.rejects(f.save());assert.equal(f.panel.data().revision,0);assert.equal(f.mutations().length,0);
  }
  const f=fixture();await f.save();f.guild.roles[1].permissions='0';await assert.rejects(f.publish(),{status:403});assert.equal(f.mutations().length,0);
});

test('publishing uses saved data, fixed link, no mentions and a creation nonce',async()=>{
  const f=fixture();await f.save({title:'@everyone · Setups',description:'Hardware und <@&900000000000000051>',imageUrl:'https://crazybatto.de/setup.png'});
  await assert.rejects(f.run('setup.panel.publish',{expectedRevision:1,confirm:true,settings:{title:'Unerlaubter Entwurf'}}));
  const result=await f.publish(),write=f.mutations()[0];
  assert.equal(write.method,'POST');assert.equal(write.route,`/channels/${CHANNEL}/messages`);assert.equal(write.payload.embeds[0].title,'@everyone · Setups');
  assert.equal(write.payload.embeds[0].image.url,'https://crazybatto.de/setup.png');assert.deepEqual(write.payload.allowed_mentions,{parse:[],users:[],roles:[],replied_user:false});
  assert.equal(write.payload.components[0].components.length,1);assert.equal(write.payload.components[0].components[0].url,LINK);assert.equal(write.payload.components[0].components[0].style,5);assert.equal(write.payload.enforce_nonce,true);assert.match(write.payload.nonce,/^[a-f0-9]{24}$/);
  assert.equal(result.publication.messageId,MESSAGE);assert.equal(result.publication.revision,1);assert.equal(result.publishAttempt.status,'published');assert.equal(result.publishAttempt.operation,'create');assert(!Object.hasOwn(result.publishAttempt,'nonce'));
});

test('replaying a confirmed revision is idempotent and a saved revision edits only the known bot message',async()=>{
  const f=fixture();await f.seed();await f.publish();assert.equal(f.mutations().length,0);
  await f.save({title:'Neu',imageUrl:''});const result=await f.publish();
  assert.deepEqual(f.mutations().map(call=>call.method),['PATCH']);assert.equal(f.mutations()[0].route,`/channels/${CHANNEL}/messages/${MESSAGE}`);assert.equal(result.publication.messageId,MESSAGE);assert.equal(result.publication.revision,2);
  assert.equal(f.messages.get(MESSAGE).embeds[0].title,'Neu');assert.equal(f.messages.get(MESSAGE).embeds[0].image,undefined);assert.deepEqual(f.messages.get(MESSAGE).attachments,[]);
  const readIndex=f.calls.findIndex(call=>call.method==='GET'&&call.route.endsWith('/messages/'+MESSAGE));assert(readIndex>=0);assert(f.calls.slice(readIndex+1).some(call=>call.route==='/users/@me'));
});

test('parallel publish clicks create only one card and concurrent stale saves fail',async()=>{
  const f=fixture();await f.save();const values=await Promise.all([f.publish(1),f.publish(1),f.publish(1)]);
  assert.equal(f.mutations().length,1);assert(values.every(value=>value.publication.messageId===MESSAGE));
  const saves=await Promise.allSettled([f.save({title:'A'},1),f.save({title:'B'},1)]);assert.equal(saves.filter(row=>row.status==='fulfilled').length,1);assert.equal(f.panel.data().revision,2);
});

test('replaying a published revision still verifies the current message and permissions without recreating it',async()=>{
  const missing=fixture();await missing.seed();missing.messages.clear();await assert.rejects(missing.publish(),{status:404});assert.equal(missing.mutations().length,0);
  const denied=fixture();await denied.seed();denied.guild.roles[1].permissions='0';await assert.rejects(denied.publish(),{status:403});assert.equal(denied.mutations().length,0);
});

test('session revocation during awaited authority reads stops saves and first publication',async()=>{
  const a=fixture();a.state.hook=(method,route)=>{if(route==='/channels/'+CHANNEL)a.state.revoked=true;};await assert.rejects(a.save(),{status:401});assert.equal(a.panel.data().revision,0);assert.equal(a.mutations().length,0);
  const b=fixture();await b.save();b.state.hook=(method,route)=>{if(route==='/channels/'+CHANNEL)b.state.revoked=true;};await assert.rejects(b.publish(),{status:401});assert.equal(b.mutations().length,0);
});

test('a version changed during channel lookup cannot publish the previous draft',async()=>{
  const f=fixture();await f.save();f.state.hook=(method,route)=>{if(route==='/channels/'+CHANNEL){f.panel.mutate(data=>{data.revision++;data.settings.title='Neuer Entwurf';});f.state.hook=null;}};
  await assert.rejects(f.publish(1),{status:409});assert.equal(f.mutations().length,0);assert.equal(f.panel.data().settings.title,'Neuer Entwurf');
});

test('known-message author, webhook identity, channel and existence are checked before any edit',async()=>{
  for(const mutate of [m=>m.author.id=BOTROLE,m=>m.author.bot=false,m=>m.webhook_id=BOTROLE,m=>m.channel_id=OTHER_CHANNEL,m=>m.id=OTHER_CHANNEL]){
    const f=fixture();await f.seed();await f.save({title:'Neuer Titel'});mutate(f.messages.get(MESSAGE));await assert.rejects(f.publish());assert.equal(f.mutations().length,0);
  }
  const missing=fixture();await missing.seed();await missing.save({title:'Neuer Titel'});missing.messages.clear();await assert.rejects(missing.publish(),{status:404});assert.equal(missing.mutations().length,0);
});

test('permissions and session are checked again after the known message is read',async()=>{
  const a=fixture();await a.seed();await a.save({title:'Neu'});a.state.hook=(method,route)=>{if(method==='GET'&&route.endsWith('/messages/'+MESSAGE))a.guild.roles[1].permissions='0';};await assert.rejects(a.publish(),{status:403});assert.equal(a.mutations().length,0);
  const b=fixture();await b.seed();await b.save({title:'Neu'});b.state.hook=(method,route)=>{if(method==='GET'&&route.endsWith('/messages/'+MESSAGE))b.state.revoked=true;};await assert.rejects(b.publish(),{status:401});assert.equal(b.mutations().length,0);
});

test('uncertain first POST survives restart and cannot be bypassed by saving or choosing another channel',async()=>{
  const f=fixture();await f.save();f.state.hook=method=>{if(method==='POST')throw Error('Lost response containing token=fixture-sensitive');};
  await assert.rejects(f.publish());assert.equal(f.panel.data().publishAttempt.status,'uncertain');assert.doesNotMatch(f.panel.data().publishAttempt.error,/fixture-sensitive/);
  f.state.hook=null;f.restart();await f.save({channelId:OTHER_CHANNEL,title:'Weiterer Entwurf'});await assert.rejects(f.publish(),{kind:'uncertain',status:409});assert.equal(f.mutations().length,1);assert.equal(f.panel.data().publication,null);
});

test('interrupted sending becomes uncertain on restart without network access',async()=>{
  const f=fixture();await f.save();f.panel.mutate(data=>{data.publishAttempt={id:'attempt',status:'sending',revision:1,channelId:CHANNEL,operation:'create',messageId:null,at:1,error:''};});f.calls.length=0;
  f.restart();assert.equal(f.panel.data().publishAttempt.status,'uncertain');await assert.rejects(f.publish(),{kind:'uncertain'});assert.equal(f.calls.length,0);
});

test('definite rejected POST permits an explicit retry but malformed successful response stays uncertain',async()=>{
  const f=fixture();await f.save();f.state.hook=method=>{if(method==='POST')throw new AppError('forbidden','Discord verweigert.',403);};await assert.rejects(f.publish(),{status:403});assert.equal(f.panel.data().publishAttempt.status,'failed');
  f.state.hook=null;await f.publish();assert.equal(f.panel.data().publishAttempt.status,'published');assert.equal(f.messages.size,1);
  const g=fixture();await g.save();g.state.hook=method=>method==='POST'?{id:MESSAGE,channel_id:CHANNEL,author:{id:BOTROLE,bot:true}}:undefined;await assert.rejects(g.publish(),{kind:'uncertain'});await assert.rejects(g.publish(),{kind:'uncertain'});assert.equal(g.mutations().length,1);
});

test('uncertain edits can retry only the same known message and cannot create in another channel',async()=>{
  const f=fixture();await f.seed();await f.save({title:'Neu'});f.state.hook=method=>{if(method==='PATCH')throw Error('Lost edit response');};await assert.rejects(f.publish());assert.equal(f.panel.data().publishAttempt.status,'uncertain');
  f.state.hook=null;f.restart();await f.publish();assert.deepEqual(f.mutations().map(call=>call.method),['PATCH','PATCH']);assert.equal(f.panel.data().publishAttempt.status,'published');
  await f.save({title:'Noch neuer'});f.state.hook=method=>{if(method==='PATCH')throw Error('Lost edit response');};await assert.rejects(f.publish());f.state.hook=null;await f.save({channelId:OTHER_CHANNEL});const previous=f.mutations().length;await assert.rejects(f.publish(),{kind:'uncertain'});assert.equal(f.mutations().length,previous);
});

test('a confirmed delivery is retained if the session is revoked while awaiting Discord',async()=>{
  const f=fixture();await f.save();f.state.hook=method=>{if(method==='POST')f.state.revoked=true;};await assert.rejects(f.publish(),{status:401});assert.equal(f.panel.data().publication.messageId,MESSAGE);assert.equal(f.panel.data().publishAttempt.status,'published');
  f.state.revoked=false;f.state.hook=null;await f.publish();assert.equal(f.mutations().length,1);
});

test('changing a confirmed destination creates one explicitly requested card and preserves the old message',async()=>{
  const f=fixture();await f.seed();await f.save({channelId:OTHER_CHANNEL});const result=await f.publish();assert.equal(f.mutations().length,1);assert.equal(f.mutations()[0].method,'POST');assert.equal(f.mutations()[0].route,`/channels/${OTHER_CHANNEL}/messages`);assert.equal(result.publication.channelId,OTHER_CHANNEL);assert.equal(f.messages.size,2);await f.publish();assert.equal(f.mutations().length,1);
});

test('malformed stored state fails closed without replacing configuration',async()=>{
  const f=fixture();f.storage.set(KEY,'{broken');assert.throws(()=>f.restart(),{kind:'storage',status:503});assert.equal(f.storage.get(KEY),'{broken');assert.equal(f.mutations().length,0);
});
