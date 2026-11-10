import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MusicBot } from '../src/music-bot.mjs';
import { BotGateway } from '../src/bot-gateway.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const GUILD='900000000000000018', USER='900000000000000027', BOT='900000000000000002', ROLE='900000000000000029', CHANNEL='900000000000000039', OTHER='900000000000000040';
const CONNECT=1n<<20n,SPEAK=1n<<21n;
function fixture() {
  const state={ready:true,enabled:true,revoked:false,storageCalls:0,playlistCalls:0,spawns:0,loads:0,waits:0,loadHook:null,enterHook:null,requestHook:null};
  const guild={id:GUILD,owner_id:'900000000000000041',roles:[{id:GUILD,permissions:String(P.VIEW_CHANNEL|CONNECT|SPEAK)},{id:ROLE,permissions:'0'}]};
  const member={user:{id:USER},roles:[],pending:false},botMember={user:{id:BOT,bot:true},roles:[ROLE],pending:false,mute:false};
  const channel={id:CHANNEL,guild_id:GUILD,type:2,name:'Musikraum',permission_overwrites:[]},voiceStates=new Map([[USER,CHANNEL]]),connections=[];
  const voice={VoiceConnectionStatus:{Ready:'ready',Destroyed:'destroyed',Disconnected:'disconnected'},AudioPlayerStatus:{Idle:'idle'},NoSubscriberBehavior:{Pause:'pause'},
    joinVoiceChannel(options){const connection=new EventEmitter();connection.joinConfig=options;connection.state={status:'connecting'};connection.destroyed=0;
      connection.destroy=()=>{connection.destroyed++;const old=connection.state;connection.state={status:'destroyed'};voiceStates.delete(BOT);connection.emit('stateChange',old,connection.state);};
      connection.subscribe=player=>{connection.subscribed=player;return{};};connections.push(connection);return connection;},
    async entersState(connection){state.waits++;if(state.enterHook)await state.enterHook(connection);const old=connection.state;connection.state={status:'ready'};voiceStates.set(BOT,connection.joinConfig.channelId);connection.emit('stateChange',old,connection.state);return connection;},
    createAudioPlayer(){const player=new EventEmitter();player.state={status:'idle'};player.stop=()=>true;player.pause=()=>{player.state.status='paused';return true;};player.unpause=()=>{player.state.status='playing';return true;};return player;},
  };
  const service={config:{musicBotEnabled:true,discordGuildId:GUILD,clientId:BOT},now:()=>1900000000000,bot:async()=>({id:BOT}),botAdmin:{settings:()=>({enabled:state.enabled})},
    botGateway:{botUserId:BOT,lastIntents:131,status:()=>({ready:state.ready}),voiceChannel:id=>voiceStates.get(id)||null,voiceAdapter:()=>()=>({sendPayload:()=>true,destroy(){}})},
    accounts:{storageStatus:async()=>{state.storageCalls++;return{online:false,message:'Musikspeicher offline'};},playlists:{tracks:()=>{state.playlistCalls++;return[];}},store:{get:()=>false}},
    discord:{async request(method,route){await state.requestHook?.(method,route);if(route===`/guilds/${GUILD}`)return structuredClone(guild);if(route===`/guilds/${GUILD}/members/${USER}`)return structuredClone(member);if(route===`/guilds/${GUILD}/members/${BOT}`)return structuredClone(botMember);if(route===`/guilds/${GUILD}/channels`)return[structuredClone(channel)];throw Error('Unexpected route '+route);}},
  };
  const bot=new MusicBot(service,{loadVoice:async()=>{state.loads++;await state.loadHook?.();return voice;},spawnImpl:()=>{state.spawns++;throw Error('Join must not spawn FFmpeg');}});
  const authorize=()=>{if(state.revoked)throw new AppError('auth','Die Sitzung wurde beendet.',401);};
  const join=(input={})=>bot.enqueue(()=>bot.control(USER,{action:'join',...input},authorize));
  return{bot,service,state,guild,member,botMember,channel,voiceStates,connections,voice,join,authorize};
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
