import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MusicBot } from '../src/music-bot.mjs';
import { BotGateway } from '../src/bot-gateway.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', USER='900000000000000027', BOT='900000000000000002', ROLE='900000000000000029', CHANNEL='900000000000000039', OTHER='900000000000000040';
const CONNECT=1n<<20n,SPEAK=1n<<21n;
function fixture() {
  const state={ready:true,enabled:true,revoked:false,storageCalls:0,playlistCalls:0,spawns:0,loads:0,waits:0,loadHook:null,enterHook:null,requestHook:null};
  const guild={id:GUILD,owner_id:'900000000000000041',roles:[{id:GUILD,permissions:String(P.VIEW_CHANNEL|CONNECT|SPEAK)},{id:ROLE,permissions:'0'}]};
  const member={user:{id:USER},roles:[],pending:false},members=new Map([[USER,member]]),botMember={user:{id:BOT,bot:true},roles:[ROLE],pending:false,mute:false};
  const channel={id:CHANNEL,guild_id:GUILD,type:2,name:'Musikraum',permission_overwrites:[]},voiceStates=new Map([[USER,CHANNEL]]),connections=[];
  const voice={VoiceConnectionStatus:{Ready:'ready',Destroyed:'destroyed',Disconnected:'disconnected'},AudioPlayerStatus:{Idle:'idle'},NoSubscriberBehavior:{Pause:'pause'},
    joinVoiceChannel(options){const connection=new EventEmitter();connection.joinConfig=options;connection.state={status:'connecting'};connection.destroyed=0;
      connection.destroy=()=>{connection.destroyed++;const old=connection.state;connection.state={status:'destroyed'};voiceStates.delete(BOT);connection.emit('stateChange',old,connection.state);};
      connection.subscribe=player=>{connection.subscribed=player;return{};};connections.push(connection);return connection;},
    async entersState(connection){state.waits++;if(state.enterHook)await state.enterHook(connection);const old=connection.state;connection.state={status:'ready'};voiceStates.set(BOT,connection.joinConfig.channelId);connection.emit('stateChange',old,connection.state);return connection;},
    createAudioPlayer(){const player=new EventEmitter();player.state={status:'idle'};player.stops=0;player.stop=()=>{player.stops++;return true;};player.play=resource=>{player.resource=resource;player.state.status='playing';};player.pause=()=>{player.state.status='paused';return true;};player.unpause=()=>{player.state.status='playing';return true;};return player;},
  };
  const service={config:{musicBotEnabled:true,discordGuildId:GUILD,clientId:BOT},now:()=>1900000000000,bot:async()=>({id:BOT}),botAdmin:{settings:()=>({enabled:state.enabled})},
    botGateway:{botUserId:BOT,lastIntents:131,status:()=>({ready:state.ready}),voiceChannel:id=>voiceStates.get(id)||null,voiceAdapter:()=>()=>({sendPayload:()=>true,destroy(){}})},
    accounts:{storageStatus:async()=>{state.storageCalls++;return{online:false,message:'Musikspeicher offline'};},playlists:{tracks:()=>{state.playlistCalls++;return[];}},store:{get:()=>false}},
    discord:{async request(method,route){await state.requestHook?.(method,route);if(route===`/guilds/${GUILD}`)return structuredClone(guild);if(route.startsWith(`/guilds/${GUILD}/members/`)&&members.has(route.split('/').at(-1)))return structuredClone(members.get(route.split('/').at(-1)));if(route===`/guilds/${GUILD}/members/${BOT}`)return structuredClone(botMember);if(route===`/guilds/${GUILD}/channels`)return[structuredClone(channel)];throw Error('Unexpected route '+route);}},
  };
  const bot=new MusicBot(service,{loadVoice:async()=>{state.loads++;await state.loadHook?.();return voice;},spawnImpl:()=>{state.spawns++;throw Error('Join must not spawn FFmpeg');}});
  const authorize=()=>{if(state.revoked)throw new AppError('auth','Die Sitzung wurde beendet.',401);};
  const join=(input={})=>bot.enqueue(()=>bot.control(USER,{action:'join',...input},authorize));
  return{bot,service,state,guild,member,members,botMember,channel,voiceStates,connections,voice,join,authorize};
}

async function attachGateway(f) {
  const sockets=[];
  class Socket {
    constructor(){this.readyState=1;this.listeners=new Map();this.sent=[];sockets.push(this);}
    addEventListener(name,callback){this.listeners.set(name,callback);}
    send(value){this.sent.push(JSON.parse(value));}
    close(){this.readyState=3;}
    packet(value){this.listeners.get('message')?.({data:JSON.stringify(value)});}
  }
  const gateway=new BotGateway({...f.service.config,botToken:'fixture-only'}, {
    fetchImpl:async()=>({ok:true,status:200,json:async()=>({url:'wss://gateway.discord.gg'})}),WebSocketImpl:Socket,
    setTimer:(callback,delay)=>({callback,delay,unref(){}}),clearTimer(){},
    onDispatch:packet=>f.bot.gatewayEvent(packet),onConnectionState:phase=>f.bot.connectionState(phase)
  });
  gateway.voiceStates=f.voiceStates;f.service.botGateway=gateway;gateway.running=true;
  const connect=async(resumed=false)=>{await gateway.connect();const socket=sockets.at(-1);socket.packet({op:10,d:{heartbeat_interval:45000}});if(!resumed)socket.packet({op:0,t:'READY',s:1,d:{application:{id:BOT},user:{id:BOT,bot:true},session_id:'fixture-session',resume_gateway_url:'wss://gateway.discord.gg'}});return socket;};
  await connect();
  const joinVoice=f.voice.joinVoiceChannel;
  f.voice.joinVoiceChannel=options=>{
    const connection=joinVoice(options),adapter=options.adapterCreator({onVoiceStateUpdate(){},onVoiceServerUpdate(){},destroy:()=>connection.destroy()});
    adapter.sendPayload({op:4,d:{guild_id:GUILD,channel_id:options.channelId,self_deaf:true,self_mute:false}});
    const destroy=connection.destroy;connection.destroy=()=>{const cached=f.voiceStates.get(BOT);adapter.sendPayload({op:4,d:{guild_id:GUILD,channel_id:null,self_deaf:true,self_mute:false}});adapter.destroy();destroy();if(cached)f.voiceStates.set(BOT,cached);};
    return connection;
  };
  const event=(type,data)=>sockets.at(-1).packet({op:0,t:type,s:2,d:data});
  const voice=(userId,channelId,extra={})=>event('VOICE_STATE_UPDATE',{guild_id:GUILD,user_id:userId,channel_id:channelId,...extra});
  return{gateway,sockets,connect,event,voice};
}
function enablePlayback(f,{stream}={}) {
  const children=[];let cancelled=0;
  f.service.accounts.storageStatus=async()=>({online:true});
  f.service.accounts.playlists.tracks=()=>[{id:'fixture-track',title:'Fixture track'}];
  f.service.accounts.store.get=()=>true;
  f.service.accounts.storage={stream:stream||(async()=>({status:200,body:new ReadableStream({cancel(){cancelled++;}})}))};
  f.voice.StreamType={Raw:'raw'};
  f.voice.createAudioResource=()=>({playbackDuration:1000,volume:{setVolume(){}}});
  f.bot.spawn=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;};children.push(child);return child;};
  return{children,cancelled:()=>cancelled};
}

test('join connects the authenticated current voice channel without tracks, storage or FFmpeg',async t=>{
  const f=fixture();t.after(()=>f.bot.stop());const result=await f.join();
  assert.match(result,/beigetreten/);assert.equal(f.bot.status().connected,true);assert.equal(f.bot.status().status,'idle');assert.equal(f.bot.status().currentTrack,null);assert.deepEqual(f.bot.queueView(),[]);
  assert.equal(f.connections.length,1);assert.equal(f.connections[0].joinConfig.channelId,CHANNEL);assert.equal(f.connections[0].joinConfig.guildId,GUILD);
  assert.equal(f.connections[0].joinConfig.selfDeaf,true);assert.equal(f.connections[0].joinConfig.selfMute,false);assert.equal(f.connections[0].joinConfig.daveEncryption,true);
  assert.equal(f.state.storageCalls,0);assert.equal(f.state.playlistCalls,0);assert.equal(f.state.spawns,0);
});

test('join refuses a forged channel, absent user, Stage channel, missing rights and muted bot',async()=>{
  const changes=[f=>f.voiceStates.delete(USER),f=>f.channel.type=13,f=>f.channel.permission_overwrites=[{type:1,id:USER,deny:String(CONNECT),allow:'0'}],
    f=>f.channel.permission_overwrites=[{type:0,id:ROLE,deny:String(SPEAK),allow:'0'}],f=>f.botMember.mute=true,f=>f.member.pending=true,f=>f.state.ready=false,f=>f.state.enabled=false];
  for(const change of changes){const f=fixture();change(f);await assert.rejects(f.join());assert.equal(f.connections.length,0);assert.equal(f.state.loads,0);}
  const f=fixture();await assert.rejects(f.join({channelId:OTHER}),{status:403});assert.equal(f.connections.length,0);
});

test('join rechecks session, channel and role permissions after asynchronous voice loading',async()=>{
  for(const change of [f=>f.state.revoked=true,f=>f.voiceStates.set(USER,OTHER),f=>f.channel.permission_overwrites=[{type:0,id:ROLE,deny:String(CONNECT),allow:'0'}]]){
    const f=fixture();f.state.loadHook=()=>change(f);await assert.rejects(f.join());assert.equal(f.connections.length,0);
  }
});

test('session revocation during handshake destroys the newly started connection and never claims success',async()=>{
  const f=fixture();f.state.enterHook=()=>{f.state.revoked=true;};
  await assert.rejects(f.join(),{status:401});assert.equal(f.connections[0].destroyed,1);assert.equal(f.bot.status().connected,false);assert.equal(f.bot.status().channelId,null);
});

test('duplicate joins serialize and preserve an existing playlist and player',async t=>{
  const f=fixture();t.after(()=>f.bot.stop());const result=await Promise.all([f.join(),f.join()]);assert.equal(f.connections.length,1);assert.equal(f.state.waits,1);assert.match(result[1],/bereits/);
  const player=f.bot.player,track={id:'track-id',title:'Existing Track'};f.bot.queue=[track];f.bot.index=0;player.state.status='playing';
  await f.join();assert.equal(f.bot.player,player);assert.deepEqual(f.bot.queue,[track]);assert.equal(f.bot.index,0);assert.equal(player.state.status,'playing');assert.equal(f.connections.length,1);
});

test('a non-ready existing connection is awaited and failure is cleaned up before another join',async t=>{
  const f=fixture();t.after(()=>f.bot.stop());await f.join();f.connections[0].state={status:'connecting'};
  f.state.enterHook=()=>{throw Error('handshake timeout');};await assert.rejects(f.join(),{kind:'voice_connection'});
  assert.equal(f.connections[0].destroyed,1);assert.equal(f.bot.status().connected,false);assert.match(f.bot.status().message,/nicht bereit/);
  f.state.enterHook=null;await f.join();assert.equal(f.connections.length,2);assert.equal(f.bot.status().connected,true);assert.equal(f.bot.status().message,null);
});

test('missing dependencies and unconfirmed handshakes expose useful errors without raw secrets',async()=>{
  for(const [stage,text,kind] of [['load','Cannot find package davey at /secret/path token=fixture-secret','voice_dependency'],['join','unsupported encryption mode token=fixture-secret','voice_dependency'],['handshake','timeout token=fixture-secret','voice_connection']]){
    const f=fixture();if(stage==='load')f.state.loadHook=()=>{throw Error(text);};if(stage==='join')f.voice.joinVoiceChannel=()=>{throw Error(text);};if(stage==='handshake')f.state.enterHook=()=>{throw Error(text);};
    await assert.rejects(f.join(),error=>error.kind===kind&&!error.message.includes('fixture-secret'));assert.equal(f.bot.status().connected,false);assert.ok(f.bot.status().message);assert.equal(f.bot.status().message.includes('fixture-secret'),false);
  }
});

test('player preparation failure destroys the voice connection and reports the failed setup',async()=>{
  const f=fixture();f.voice.createAudioPlayer=()=>{throw Error('missing Opus binding');};await assert.rejects(f.join(),{kind:'voice_dependency'});assert.equal(f.connections[0].destroyed,1);assert.equal(f.bot.status().connected,false);
  const subscription=fixture();subscription.state.enterHook=connection=>{connection.subscribe=()=>{throw Error('subscription rejected');};};await assert.rejects(subscription.join(),{kind:'voice_connection'});assert.equal(subscription.connections[0].destroyed,1);assert.equal(subscription.bot.status().connected,false);
});

test('existing pause, resume, volume, stop and playback storage checks keep their behavior',async()=>{
  const f=fixture();await f.join();await f.bot.control(USER,{action:'pause'},f.authorize);assert.equal(f.bot.status().paused,true);
  await f.bot.control(USER,{action:'resume'},f.authorize);assert.equal(f.bot.status().paused,false);
  await f.bot.control(USER,{action:'volume',volume:31},f.authorize);assert.equal(f.bot.status().volume,31);
  f.service.accounts.playlists.tracks=()=>[{id:'track-id',title:'Test'}];await assert.rejects(f.bot.control(USER,{action:'play'},f.authorize),/Musikspeicher offline/);assert.equal(f.state.storageCalls,1);
  await f.bot.control(USER,{action:'stop'},f.authorize);assert.equal(f.bot.status().connected,false);
});

test('voice handshake adapter still sends and receives voice packets with member intent 131',()=>{
  const sent=[],received=[];
  const gateway=new BotGateway({clientId:BOT,discordGuildId:GUILD,botToken:'fixture-only',musicBotEnabled:true});gateway.phase='online';gateway.botUserId=BOT;gateway.lastIntents=131;gateway.ws={readyState:1,send:body=>sent.push(JSON.parse(body))};
  const adapter=gateway.voiceAdapter(GUILD)({onVoiceStateUpdate:packet=>received.push(packet),onVoiceServerUpdate:packet=>received.push(packet),destroy(){}});
  assert.equal(adapter.sendPayload({op:4,d:{guild_id:GUILD,channel_id:CHANNEL,self_deaf:true,self_mute:false}}),true);
  gateway.voiceDispatch({op:0,t:'VOICE_STATE_UPDATE',d:{guild_id:GUILD,user_id:BOT,channel_id:CHANNEL,session_id:'fixture-session'}});
  gateway.voiceDispatch({op:0,t:'VOICE_SERVER_UPDATE',d:{guild_id:GUILD,endpoint:'fixture.discord.gg',token:'fixture-only'}});
  assert.equal(sent[0].op,4);assert.equal(received.length,2);assert.equal(gateway.voiceChannel(BOT),CHANNEL);adapter.destroy();
});

test('initiator exit through the real Gateway stops idle, playing and paused sessions and sends leave once',async t=>{
  for(const playback of ['idle','playing','paused']){
    const f=fixture(),g=await attachGateway(f),audio=enablePlayback(f);t.after(()=>{f.bot.stop();g.gateway.stop();});
    if(playback==='idle')await f.join();else await f.bot.control(USER,{action:'play'},f.authorize);
    if(playback==='paused')await f.bot.control(USER,{action:'pause'},f.authorize);
    const player=f.bot.player,connection=f.bot.connection;assert.equal(f.bot.voiceOwnerId,USER);g.voice(USER,null);
    assert.equal(connection.destroyed,1);assert.equal(f.bot.status().status,'stopped');assert.equal(f.bot.channelId,null);assert.equal(f.bot.voiceOwnerId,null);assert.deepEqual(f.bot.queueView(),[]);assert.equal(f.bot.resource,null);assert.equal(f.bot.process,null);assert.equal(f.bot.input,null);assert(player.stops>=1);
    if(playback!=='idle')assert.equal(audio.children[0].killed,true);
    assert.equal(g.sockets[0].sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);
    g.voice(USER,null);g.voice(USER,CHANNEL);assert.equal(connection.destroyed,1);assert.equal(f.connections.length,1);assert.equal(f.bot.status().connected,false);
  }
});

test('initiator moving leaves the original channel and only an explicit new join opens the new channel',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.voice(USER,OTHER);
  assert.equal(f.bot.status().connected,false);assert.equal(f.connections.length,1);f.channel.id=OTHER;
  await f.join({channelId:OTHER});assert.equal(f.connections.length,2);assert.equal(f.bot.channelId,OTHER);assert.equal(f.bot.voiceOwnerId,USER);
});

test('another member cannot take ownership by joining or controlling the shared player',async t=>{
  const f=fixture(),g=await attachGateway(f),otherUser='900000000000000028';t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();
  f.members.set(otherUser,{user:{id:otherUser},roles:[],pending:false});g.voice(otherUser,CHANNEL);
  await f.bot.control(otherUser,{action:'join'},f.authorize);await f.bot.control(otherUser,{action:'volume',volume:30},f.authorize);assert.equal(f.bot.voiceOwnerId,USER);
  g.voice(otherUser,null);g.voice(USER,CHANNEL,{self_mute:true,self_deaf:true});g.voice(USER,null,{guild_id:'900000000000000044'});g.voice(USER,undefined);
  assert.equal(f.bot.status().connected,true);assert.equal(f.connections[0].destroyed,0);g.voice(USER,null);assert.equal(f.bot.status().connected,false);
});

test('leaving and rejoining during the handshake cannot resurrect the cancelled voice session',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});f.state.enterHook=()=>{entered();return new Promise(resolve=>{release=resolve;});};
  const joining=f.join();await started;g.voice(USER,null);g.voice(USER,CHANNEL);release();await assert.rejects(joining,{kind:'conflict'});
  assert.equal(f.connections[0].destroyed,1);assert.equal(f.bot.channelId,null);assert.equal(f.bot.voiceOwnerId,null);
});

test('late audio reads from a departed initiator cannot play or destroy a newly started session',async t=>{
  for(const reject of [false,true]){
    const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});let release,entered,cancelled=0;
    const started=new Promise(resolve=>{entered=resolve;});enablePlayback(f,{stream:()=>{entered();return new Promise((resolve,fail)=>{release=()=>reject?fail(Error('storage timeout')):resolve({status:200,body:new ReadableStream({cancel(){cancelled++;}})});});}});
    const playing=f.bot.control(USER,{action:'play'},f.authorize);await started;g.voice(USER,null);g.voice(USER,CHANNEL);await f.bot.control(USER,{action:'join'},f.authorize);const current=f.bot.connection;
    release();await assert.rejects(playing);assert.equal(f.bot.connection,current);assert.equal(f.bot.status().connected,true);assert.equal(f.bot.status().message,null);assert.equal(current.destroyed,0);if(!reject)assert.equal(cancelled,1);
  }
});

test('fresh identify waits for a complete guild voice snapshot before deciding to leave',async t=>{
  for(const ownerPresent of [false,true]){
    const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.gateway.retry(0,{reset:true});
    f.voiceStates.delete(USER);assert.equal(f.bot.connection.destroyed,0);await g.connect();assert.equal(f.bot.status().connected,true);
    g.event('GUILD_CREATE',{id:GUILD,voice_states:[{user_id:BOT,channel_id:CHANNEL},...(ownerPresent?[{user_id:USER,channel_id:CHANNEL}]:[])]});
    assert.equal(f.bot.status().connected,ownerPresent);assert.equal(f.connections[0].destroyed,ownerPresent?0:1);
  }
});

test('resume replay keeps a present initiator and reconciles an actual missed departure',async t=>{
  for(const ownerPresent of [false,true]){
    const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.gateway.retry(0);await g.connect(true);
    if(!ownerPresent)f.voiceStates.delete(USER);assert.equal(f.connections[0].destroyed,0);
    g.event('RESUMED',{});assert.equal(f.bot.status().connected,ownerPresent);assert.equal(f.connections[0].destroyed,ownerPresent?0:1);
  }
});

test('bot removal, forced moves, guild loss and terminal gateway shutdown clean up ownership',async t=>{
  const changes=[g=>g.voice(BOT,null),g=>g.voice(BOT,OTHER),g=>g.event('GUILD_DELETE',{id:GUILD}),g=>g.gateway.stop(),g=>g.gateway.fatal('Fixture failure')];
  for(const change of changes){const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();change(g);assert.equal(f.bot.status().connected,false);assert.equal(f.bot.voiceOwnerId,null);assert.deepEqual(f.bot.queueView(),[]);assert.equal(f.connections[0].destroyed,1);}
});

test('an explicit stop clears ownership and stale voice connection callbacks cannot stop a later join',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();const first=f.bot.connection;
  await f.bot.control(USER,{action:'stop'},f.authorize);assert.equal(f.bot.voiceOwnerId,null);await f.join();const second=f.bot.connection;
  first.emit('stateChange',{status:'disconnected'},{status:'destroyed'});first.emit('error',Error('stale connection failure'));
  assert.equal(f.bot.connection,second);assert.equal(f.bot.voiceOwnerId,USER);assert.equal(f.bot.status().connected,true);assert.equal(f.bot.status().message,null);
});

test('a replayed departure cleans audio immediately and sends the deferred leave only after RESUMED',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.gateway.retry(0);const socket=await g.connect(true);
  g.voice(USER,null);assert.equal(f.bot.status().connected,false);assert.notEqual(f.bot.pendingLeaveEpoch,null);assert.equal(socket.sent.filter(p=>p.op===4).length,0);
  g.event('RESUMED',{});assert.equal(socket.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);assert.equal(f.bot.pendingLeaveEpoch,null);
  g.event('RESUMED',{});assert.equal(socket.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);
});

test('failed deferred leave waits for the next ready replay without spamming voice updates',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.gateway.retry(0);const socket=await g.connect(true);g.voice(USER,null);
  let failedSends=0;const send=socket.send.bind(socket);socket.send=value=>{if(JSON.parse(value).op===4){failedSends++;throw Error('Fixture socket failure');}send(value);};
  g.event('RESUMED',{});assert.equal(failedSends,1);assert.notEqual(f.bot.pendingLeaveEpoch,null);
  g.voice(USER,null);g.voice(USER,null);assert.equal(failedSends,1);
  g.gateway.retry(0);const recovered=await g.connect(true);g.event('RESUMED',{});assert.equal(recovered.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);assert.equal(f.bot.pendingLeaveEpoch,null);
});

test('a pending leave after a fresh identify waits for the snapshot and cannot cut off a new explicit join',async t=>{
  for(const newJoin of [false,true]){
    const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();g.gateway.retry(0,{reset:true});f.bot.stop();assert.notEqual(f.bot.pendingLeaveEpoch,null);
    const socket=await g.connect();assert.equal(socket.sent.filter(p=>p.op===4).length,0);
    if(newJoin)await f.join();
    g.event('GUILD_CREATE',{id:GUILD,voice_states:[{user_id:BOT,channel_id:CHANNEL},{user_id:USER,channel_id:CHANNEL}]});
    assert.equal(socket.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,newJoin?0:1);assert.equal(f.bot.status().connected,newJoin);assert.equal(f.bot.pendingLeaveEpoch,null);
  }
});

test('gateway leave is limited to its configured guild and refuses offline or failed sockets',()=>{
  const sent=[],gateway=new BotGateway({clientId:BOT,discordGuildId:GUILD,musicBotEnabled:true});gateway.ws={readyState:1,send:value=>sent.push(JSON.parse(value))};
  assert.equal(gateway.leaveVoice(),false);gateway.phase='online';assert.equal(gateway.leaveVoice(),true);
  assert.deepEqual(sent,[{op:4,d:{guild_id:GUILD,channel_id:null,self_deaf:true,self_mute:false}}]);gateway.ws.readyState=3;assert.equal(gateway.leaveVoice(),false);gateway.ws.readyState=1;gateway.config.discordGuildId='invalid';assert.equal(gateway.leaveVoice(),false);
});

test('an already queued join cannot resurrect music after the initiator leaves; a later fresh click can',async t=>{
  const f=fixture(),g=await attachGateway(f),otherUser='900000000000000028';t.after(()=>{f.bot.stop();g.gateway.stop();});await f.join();
  f.members.set(otherUser,{user:{id:otherUser},roles:[],pending:false});g.voice(otherUser,CHANNEL);
  let release;const blocking=f.bot.enqueue(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
  const staleJoin=f.bot.enqueue(()=>f.bot.control(otherUser,{action:'join'},f.authorize));g.voice(USER,null);release();await blocking;
  await assert.rejects(staleJoin,{kind:'conflict'});assert.equal(f.connections.length,1);assert.equal(f.bot.status().connected,false);
  await f.bot.enqueue(()=>f.bot.control(otherUser,{action:'join'},f.authorize));assert.equal(f.connections.length,2);assert.equal(f.bot.voiceOwnerId,otherUser);assert.equal(f.bot.status().connected,true);
});

test('a fresh process removes its orphaned bot voice entry once after a complete snapshot without joining or playing',async t=>{
  const f=fixture(),g=await attachGateway(f);t.after(()=>{f.bot.stop();g.gateway.stop();});const socket=g.sockets[0],snapshot={id:GUILD,voice_states:[{user_id:BOT,channel_id:CHANNEL}]};
  g.event('GUILD_CREATE',snapshot);g.event('GUILD_CREATE',snapshot);assert.equal(socket.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);assert.equal(f.connections.length,0);assert.equal(f.state.spawns,0);assert.equal(f.bot.voiceOwnerId,null);
  // A send accepted by the old socket may have been lost. A new completed
  // replay is fresh evidence and may retry once while duplicate events may not.
  g.gateway.retry(0);const next=await g.connect(true);g.event('RESUMED',{});g.event('RESUMED',{});assert.equal(next.sent.filter(p=>p.op===4&&p.d.channel_id===null).length,1);
});

test('orphan cleanup is limited to the enabled music module and its own confirmed bot state',async t=>{
  for(const disable of [f=>f.service.config.musicBotEnabled=false,f=>f.state.enabled=false]){
    const f=fixture(),g=await attachGateway(f);t.after(()=>g.gateway.stop());disable(f);g.event('GUILD_CREATE',{id:GUILD,voice_states:[{user_id:BOT,channel_id:CHANNEL}]});assert.equal(g.sockets[0].sent.filter(p=>p.op===4).length,0);
  }
  const f=fixture(),g=await attachGateway(f);t.after(()=>g.gateway.stop());g.event('GUILD_CREATE',{id:'900000000000000044',voice_states:[{user_id:BOT,channel_id:CHANNEL}]});assert.equal(g.sockets[0].sent.filter(p=>p.op===4).length,0);
});
