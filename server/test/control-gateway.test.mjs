import test from 'node:test';
import assert from 'node:assert/strict';
import { BotGateway } from '../src/bot-gateway.mjs';
import { ControlExtras } from '../src/control-extras.mjs';

const BOT='900000000000000002',GUILD='900000000000000018',USER='900000000000000027',CHANNEL='900000000000000029';
test('real gateway retry and resume split observed sessions without counting downtime',async()=>{
  let now=1_790_000_000_000;const data=new Map(),sockets=[];
  class Socket {constructor(){this.listeners={};this.readyState=1;sockets.push(this);}addEventListener(name,fn){this.listeners[name]=fn;}send(){}close(){this.readyState=3;}packet(packet){this.listeners.message({data:JSON.stringify(packet)});}}
  const service={config:{clientId:BOT,discordGuildId:GUILD,botToken:'fake'},accounts:{store:{setting:key=>data.get(key),setSetting:(key,value)=>data.set(key,value),transaction:fn=>fn()},assertCurrent(){}},communityControl:{current(){},identity(){}}};
  const extras=new ControlExtras(service,{now:()=>now});
  const gateway=service.botGateway=new BotGateway(service.config,{WebSocketImpl:Socket,now:()=>now,setTimer:()=>({unref(){}}),clearTimer(){},fetchImpl:async()=>({ok:true,json:async()=>({url:'wss://gateway.discord.gg'})}),intentResolver:async()=>131,onDispatch:packet=>extras.gatewayEvent(packet),onConnectionState:phase=>extras.connectionState(phase)});
  gateway.running=true;await gateway.connect();let socket=sockets.at(-1);
  socket.packet({op:10,d:{heartbeat_interval:45000}});socket.packet({op:0,t:'READY',s:1,d:{application:{id:BOT},user:{id:BOT,bot:true},session_id:'fixture',resume_gateway_url:'wss://gateway.discord.gg'}});
  socket.packet({op:0,t:'GUILD_CREATE',s:2,d:{id:GUILD,members:[{user:{id:USER,username:'Member'}}],voice_states:[{user_id:USER,channel_id:CHANNEL}]}});
  now+=3000;socket.packet({op:0,t:'VOICE_STATE_UPDATE',s:3,d:{guild_id:GUILD,user_id:USER,channel_id:CHANNEL}});
  now+=60000;gateway.retry();assert.equal(extras.data().active.length,0);assert.equal(extras.data().voiceHistory[0].seconds,3);assert.equal(extras.data().voiceHistory[0].endKnown,false);
  now+=60000;await gateway.connect();socket=sockets.at(-1);socket.packet({op:10,d:{heartbeat_interval:45000}});socket.packet({op:0,t:'RESUMED',s:4,d:{}});
  assert.equal(extras.data().active[0].observedSince,now);assert.equal(extras.data().active[0].startKnown,false);assert.equal(gateway.status().ready,true);
  gateway.stop();assert.equal(extras.data().active.length,0);assert.equal(gateway.status().phase,'stopped');
});
test('tracking callback failure does not break gateway retry, fatal error or stop',()=>{
  const gateway=new BotGateway({clientId:BOT,botToken:'fake'},{WebSocketImpl:class{},setTimer:()=>({unref(){}}),clearTimer(){},onConnectionState(){throw Error('fixture storage failure');}});
  gateway.running=true;assert.doesNotThrow(()=>gateway.retry());assert.equal(gateway.phase,'reconnecting');assert.doesNotThrow(()=>gateway.fatal('offline'));assert.equal(gateway.phase,'error');assert.doesNotThrow(()=>gateway.stop());
});
