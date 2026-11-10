'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMessage, imageData, externalUrl, cleanDraft } = require('../electron/validation.cjs');
const { DiscordClient } = require('../electron/discord-client.cjs');
const { AdminService } = require('../electron/service.cjs');
const { LocalStorage } = require('../electron/storage.cjs');

const GUILD = '900000000000000003';
const CHANNEL = '900000000000000004';
const ROLE = '900000000000000005';
const TOKEN = 'test-only-token-which-is-never-a-real-discord-secret';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB4QAAAAASUVORK5CYII=';
function memoryStorage() {
  const data = {}, secrets = {};
  return {data,read:(key,fallback)=>data[key] ?? fallback,write:(key,value)=>{data[key]=value;},hasToken:()=>Boolean(secrets.token),readToken:()=>secrets.token,saveToken:token=>{secrets.token=token;},deleteToken:()=>{delete secrets.token;}};
}
function response(status,data,headers={}) { return {status,ok:status>=200&&status<300,headers:new Headers(headers),json:async()=>data}; }

test('notification preference changes preserve saved website selection and reject unrelated incoming fields',async()=>{
  const storage=memoryStorage(),service=new AdminService(storage);
  storage.write('settings',{lastWebsiteProfile:'private-profile',lastGuildId:GUILD,compact:true});
  const result=await service.run('settings.save',{settings:{joinRequestNotifications:true,token:'never-save'}});
  assert.equal(result.lastWebsiteProfile,'private-profile');assert.equal(result.lastGuildId,GUILD);assert.equal(result.compact,true);assert.equal(result.joinRequestNotifications,true);assert.equal(result.token,undefined);
});

test('mentions are disabled except the explicit role whitelist',()=>{
  const {payload} = buildMessage({draft:{content:'@everyone @here <@900000000000000006>',title:'Hallo'},roleIds:[ROLE,ROLE]});
  assert.deepEqual(payload.allowed_mentions,{parse:[],users:[],roles:[ROLE],replied_user:false});
  assert.equal(payload.content,`<@&${ROLE}>\n@everyone @here <@900000000000000006>`);
});
test('combined content length includes generated role mentions',()=>{
  assert.throws(()=>buildMessage({draft:{content:'x'.repeat(1990)},roleIds:[ROLE]}),/einschließlich/);
});
test('enforces total embed character budget in addition to individual fields',()=>{
  assert.throws(()=>buildMessage({draft:{description:'x'.repeat(4096),footer:'y'.repeat(2048)}}),/6.000/);
  assert.throws(()=>buildMessage({draft:{title:'x'.repeat(257)}}),/Titel/);
  assert.throws(()=>buildMessage({draft:{fields:Array.from({length:26},()=>({name:'x',value:'y'}))}}),/25 Felder/);
  assert.throws(()=>buildMessage({draft:{fields:[{name:'x',value:''}]}}),/Feldinhalt/);
});
test('empty messages fail; saved empty drafts are allowed',()=>{
  assert.throws(()=>buildMessage({draft:{color:'#d9b770'}}),/Text oder ein Bild/);
  assert.equal(cleanDraft({title:''}).title,'');
});
test('valid local images produce a multipart attachment embed and sanitized name',()=>{
  const {payload,image} = buildMessage({draft:{},image:{name:'../../my image.png',dataUrl:png}});
  assert.equal(image.name,'------my-image.png');
  assert.equal(payload.embeds[0].image.url,`attachment://${image.name}`);
  assert.deepEqual(payload.attachments,[{id:0,filename:image.name}]);
  assert.equal(image.mime,'image/png');
});
test('rejects file URLs, script URLs, credentials and spoofed image types',()=>{
  for (const url of ['file:///C:/secret','javascript:alert(1)','https://user:secret@example.com/a']) assert.throws(()=>buildMessage({draft:{title:'Test',imageUrl:url}}),/HTTPS/);
  assert.throws(()=>imageData('data:image/png;base64,'+Buffer.from('not a PNG').toString('base64')),/kein gültiges Bild/);
  assert.throws(()=>imageData('data:image/svg+xml;base64,PHN2Zz4='),/PNG/);
});
test('external link opener accepts only intended official origins and paths',()=>{
  assert.equal(externalUrl('https://crazybatto.de/geburtstage.html'),'https://crazybatto.de/geburtstage.html');
  assert.equal(externalUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/${ROLE}`),`https://discord.com/channels/${GUILD}/${CHANNEL}/${ROLE}`);
  for (const url of ['https://discord.com.evil.test/developers','https://discord.com/login','https://crazybatto.de:444/a','file:///a','https://evil.test']) assert.throws(()=>externalUrl(url));
});
test('TikTok live opener permits only canonical creator live URLs',()=>{
  const live = 'https://www.tiktok.com/@crazy_batto.official/live';
  assert.equal(externalUrl(live), live);
  for (const value of ['https://www.tiktok.com.evil.test/@creator/live','https://www.tiktok.com/login','https://www.tiktok.com/@creator/live?redirect=https://evil.test','https://www.tiktok.com/@creator/live#other','https://user:pass@www.tiktok.com/@creator/live','https://www.tiktok.com:444/@creator/live','http://www.tiktok.com/@creator/live','https://www.tiktok.com/@creator%2flive','https://www.tiktok.com/@creator/live/video','https://www.tiktok.com/@a/live']) assert.throws(()=>externalUrl(value));
});

test('REST requests are constrained and never follow credential-bearing redirects',async()=>{
  let called;
  const client = new DiscordClient(TOKEN,{fetch:async(url,options)=>{called={url,options};return response(200,{id:GUILD});}});
  await client.request('GET','/users/@me');
  assert.equal(called.url,'https://discord.com/api/v10/users/@me');
  assert.equal(called.options.redirect,'error');
  assert.equal(called.options.headers.Authorization,`Bot ${TOKEN}`);
  await assert.rejects(client.request('GET','https://evil.test/'),/Ungültige/);
});
test('REST retries 429 only after the declared delay',async()=>{
  let count=0; const waits=[];
  const client = new DiscordClient(TOKEN,{fetch:async()=>++count===1?response(429,{retry_after:0.5}):response(200,{ok:true}),sleep:async ms=>waits.push(ms)});
  assert.deepEqual(await client.request('GET','/users/@me'),{ok:true});
  assert.equal(count,2); assert.deepEqual(waits,[600]);
});
test('REST does not retry uncertain writes and does not expose response text',async()=>{
  let count=0;
  const client = new DiscordClient(TOKEN,{fetch:async()=>{count++;throw new Error(TOKEN);}});
  await assert.rejects(client.request('POST',`/channels/${CHANNEL}/messages`,{content:'Hello'}),error=>error.message.includes('zuerst in Discord prüfen')&&!error.message.includes(TOKEN));
  assert.equal(count,1);
  const denied = new DiscordClient(TOKEN,{fetch:async()=>response(403,{message:TOKEN,code:50013})});
  await assert.rejects(denied.request('GET','/users/@me'),error=>error.message.includes('Berechtigungen')&&!error.message.includes(TOKEN));
});
test('connecting returns no credentials and remembering is explicitly opt-in',async()=>{
  class Client { async request(_method,path) {return path==='/users/@me'?{id:ROLE,username:'TestBot',bot:true,token:TOKEN}:[{id:GUILD,name:'Community'}];} }
  const storage = memoryStorage();
  const service = new AdminService(storage,{Client});
  let state = await service.run('bot.connect',{token:TOKEN});
  assert.equal(state.connected,true); assert.equal(state.remembered,false);
  assert.ok(!JSON.stringify(state).includes(TOKEN));
  state = await service.run('bot.connect',{token:TOKEN,remember:true});
  assert.equal(state.remembered,true);
  await service.run('bot.disconnect',{});
  assert.equal((await service.run('bot.connect',{})).connected,true);
  await service.run('bot.disconnect',{forget:true});
  assert.equal(service.state().remembered,false);
  assert.ok(!JSON.stringify(storage.data).includes(TOKEN));
});
test('rejects non-bot accounts and cross-server channels before any write',async()=>{
  class Human { async request(){return {id:ROLE,username:'Person',bot:false};} }
  await assert.rejects(new AdminService(memoryStorage(),{Client:Human}).run('bot.connect',{token:TOKEN}),/Bot-Konten/);
  let writes=0;
  const service = new AdminService(memoryStorage());
  service.guilds=[{id:GUILD}]; service.client={request:async(method)=>{if(method!=='GET')writes++;return {id:CHANNEL,guild_id:'900000000000000007',type:0};}};
  await assert.rejects(service.run('message.send',{guildId:GUILD,channelId:CHANNEL,draft:{title:'Hallo'}}),/gehört nicht/);
  assert.equal(writes,0);
});
test('everyone role and foreign roles cannot be selected for message ping',async()=>{
  let writes=0;
  const service=new AdminService(memoryStorage()); service.guilds=[{id:GUILD}];
  service.client={request:async(method,path)=>{if(method!=='GET')writes++;return path.startsWith('/channels')?{id:CHANNEL,guild_id:GUILD,type:0}:[{id:GUILD,name:'@everyone'}];}};
  for(const roleId of [GUILD,ROLE]) await assert.rejects(service.run('message.send',{guildId:GUILD,channelId:CHANNEL,draft:{title:'Hallo'},roleIds:[roleId]}),/Rolle ist ungültig/);
  assert.equal(writes,0);
});
test('role updates cannot change managed roles or the everyone role',async()=>{
  const service=new AdminService(memoryStorage()); service.guilds=[{id:GUILD}];
  service.client={request:async()=>[{id:ROLE,managed:true},{id:GUILD,managed:false}]};
  for(const roleId of [ROLE,GUILD]) await assert.rejects(service.run('role.update',{guildId:GUILD,roleId,name:'No',color:'#ffffff'}),/nicht bearbeitet/);
});
test('template persistence strips arbitrary keys and never overwrites credentials',async()=>{
  const storage=memoryStorage(); const service=new AdminService(storage);
  const saved=await service.run('templates.save',{name:'Welcome',token:TOKEN,draft:{title:'Hello',token:TOKEN}});
  assert.equal(saved.draft.title,'Hello'); assert.ok(!JSON.stringify(storage.data).includes(TOKEN));
  await service.run('templates.save',{id:saved.id,name:'Changed',draft:{title:'World'}});
  assert.equal(storage.data.templates.length,1);
  assert.equal(storage.data.templates[0].name,'Changed');
});

test('template images survive save, export validation, import validation and reload',async()=>{
  const storage=memoryStorage(); const service=new AdminService(storage);
  const saved=await service.run('templates.save',{name:'Mit Bild',draft:{title:'Hello',attachment:{name:'../welcome.png',dataUrl:png,token:TOKEN},token:TOKEN}});
  assert.equal(saved.draft.attachment.dataUrl,png);
  assert.equal(saved.draft.attachment.name,'---welcome.png');
  assert.ok(!JSON.stringify(saved).includes(TOKEN));
  const exported=JSON.parse(JSON.stringify({draft:cleanDraft(saved.draft)}));
  const imported=await service.run('templates.save',{name:'Importiert',draft:cleanDraft(exported.draft)});
  assert.deepEqual(imported.draft.attachment,saved.draft.attachment);
  const sent=buildMessage({draft:imported.draft,image:imported.draft.attachment});
  assert.equal(sent.payload.embeds[0].image.url,'attachment://---welcome.png');
  assert.throws(()=>cleanDraft({attachment:{name:'image.png',dataUrl:'data:image/svg+xml;base64,PHN2Zz4='}}),/PNG/);
  assert.throws(()=>cleanDraft({fields:{}}),/Liste/);
});

test('template storage accepts the bundled image above the previous two-megabyte JSON limit',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crazybatto-test-'));
  try {
    const bytes=fs.readFileSync(path.join(__dirname,'../public/assets/community-banner.png'));
    const draft=cleanDraft({title:'Welcome',attachment:{name:'community-banner.png',dataUrl:`data:image/png;base64,${bytes.toString('base64')}`}});
    const storage=new LocalStorage(dir,{});
    storage.write('templates',[{id:'test',name:'Banner',draft}]);
    assert.ok(fs.statSync(storage.filename('templates')).size>2*1024*1024);
    assert.equal(storage.read('templates',[])[0].draft.attachment.dataUrl,draft.attachment.dataUrl);
  } finally {
    const resolved=path.resolve(dir),expectedRoot=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(expectedRoot)||!path.basename(resolved).startsWith('crazybatto-test-'))throw new Error('Unexpected test directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('successful Discord mutations remain successful when local activity storage fails',async()=>{
  const storage=memoryStorage();
  storage.write=(key)=>{if(key==='logs')throw new Error('Disk unavailable');};
  const service=new AdminService(storage);service.guilds=[{id:GUILD}];
  let writes=0;
  service.client={request:async(method)=>method==='GET'?{id:CHANNEL,guild_id:GUILD,type:0,name:'announcements'}:(writes++,{id:ROLE})};
  const result=await service.run('message.send',{guildId:GUILD,channelId:CHANNEL,draft:{title:'Hello'}});
  assert.equal(result.id,ROLE);assert.equal(writes,1);
  assert.equal((await service.run('log.list'))[0].status,'success');
});
test('Windows encryption storage never writes token plaintext and refuses unavailable encryption',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crazybatto-test-'));
  const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value.split('').reverse().join('')),decryptString:buffer=>buffer.toString().split('').reverse().join('')};
  try {
    const storage=new LocalStorage(dir,crypto);
    storage.saveToken(TOKEN); assert.equal(storage.readToken(),TOKEN);
    assert.ok(!fs.readFileSync(storage.tokenFile(),'utf8').includes(TOKEN));
    storage.deleteToken(); assert.equal(storage.hasToken(),false);
    const unavailable=new LocalStorage(dir,{isEncryptionAvailable:()=>false});
    assert.throws(()=>unavailable.saveToken(TOKEN),/verschlüsseln/);
    assert.equal(unavailable.hasToken(),false);
    assert.throws(()=>storage.write('../secret',{}),/Unbekannter/);
  } finally {
    const resolved = path.resolve(dir), expectedRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(expectedRoot) || !path.basename(resolved).startsWith('crazybatto-test-')) throw new Error('Unexpected test directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

test('voice channels omit unsupported topic and empty event descriptions are omitted',async()=>{
  const writes=[];
  const service=new AdminService(memoryStorage()); service.guilds=[{id:GUILD}];
  service.client={request:async(method,path,body)=>{writes.push({method,path,body});return {id:CHANNEL,name:body.name};}};
  await service.run('channel.create',{guildId:GUILD,name:'Voice',type:2,topic:'unsupported'});
  assert.equal(writes[0].body.topic,undefined);
  await service.run('event.create',{guildId:GUILD,name:'Party',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+90000000).toISOString(),location:'Discord',description:''});
  assert.equal(writes[1].body.description,undefined);
  assert.equal(writes[1].body.entity_type,3);
});
