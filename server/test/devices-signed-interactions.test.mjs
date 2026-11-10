import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {BotService} from '../src/bot.mjs';

const APP='900000000000000002',GUILD='900000000000000018',USER='900000000000000047';
test('device buttons reach their handler only after the official signature and application checks',()=>{
 const keys=crypto.generateKeyPairSync('ed25519'),now=Date.now(),calls=[];
 const service={config:{clientId:APP,discordGuildId:GUILD,discordPublicKey:keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex')},deviceRoles:{interaction:data=>{calls.push(data);return {type:5,data:{flags:64}};}}};
 const bot=new BotService(service,{now:()=>now});
 const data={application_id:APP,type:3,guild_id:GUILD,member:{user:{id:USER}},data:{custom_id:'cbdevices:pc'}};
 const signed=value=>{const bytes=Buffer.from(JSON.stringify(value)),timestamp=String(Math.floor(now/1000));return {bytes,headers:{'x-signature-timestamp':timestamp,'x-signature-ed25519':crypto.sign(null,Buffer.concat([Buffer.from(timestamp),bytes]),keys.privateKey).toString('hex')}};};
 let request=signed(data);
 assert.throws(()=>bot.interaction(request.bytes,{}),e=>e.status===401);
 assert.throws(()=>bot.interaction(Buffer.from(request.bytes.toString().replace('cbdevices:pc','cbdevices:king')),request.headers),e=>e.status===401);
 request=signed({...data,application_id:USER});assert.throws(()=>bot.interaction(request.bytes,request.headers),e=>e.status===403);
 assert.equal(calls.length,0);
 request=signed(data);assert.deepEqual(bot.interaction(request.bytes,request.headers),{type:5,data:{flags:64}});
 assert.equal(calls.length,1);assert.equal(calls[0].member.user.id,USER);
});
