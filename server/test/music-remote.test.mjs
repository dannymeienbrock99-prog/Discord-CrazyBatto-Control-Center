import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicRemote } from '../src/music-remote.mjs';
import { AppError } from '../src/errors.mjs';

const USER='900000000000000027',CHANNEL='900000000000000039';
const auth={user:{id:'website-user'},session:{hash:'website-session'},csrfToken:'private-csrf'};
function fixture() {
  const state={revoked:false,approved:true,link:{session:{hash:'discord-session',userId:USER}},controlHook:null},calls=[];
  let queue=Promise.resolve();
  const service={now:()=>1900000000000,accounts:{store:{db:{exec(){}}},vault:{},assertCurrent(context){if(context!==auth||state.revoked)throw new AppError('auth','Bitte erneut anmelden.',401);return context.user;},appAllowed(){if(!state.approved)throw new AppError('forbidden','App-Zugang gesperrt.',403);}},
    musicBot:{enqueue(task){const result=queue.then(task);queue=result.catch(()=>{});return result;},async control(userId,input,authorize){authorize();calls.push({userId,input});await state.controlHook?.();authorize();return 'Der Bot ist deinem Sprachkanal beigetreten.';},status:()=>({connected:true,channelId:CHANNEL,status:'idle'}),queueView:()=>[]},
  };
  const remote=new MusicRemote(service);remote.linked=()=>state.link;
  return{remote,state,calls,service};
}

test('join is a bounded music action and forwards only the linked Discord identity',async()=>{
  const f=fixture(),body={action:'join',channelId:CHANNEL},result=await f.remote.control(auth,body);
  assert.deepEqual(f.calls,[{userId:USER,input:body}]);assert.equal(result.ok,true);assert.equal(result.bot.connected,true);assert.deepEqual(result.queue,[]);
  assert.equal(JSON.stringify(result).includes('discord-session'),false);
});

test('join rejects arbitrary targets, tokens, tracks and unsupported action fields before dispatch',async()=>{
  const f=fixture();for(const body of [{action:'join',userId:USER},{action:'join',token:'anything'},{action:'join',playlistId:'all'},{action:'join',trackId:'bad'},{action:'join',channelId:'bad'},{action:'arbitrary'},null])await assert.rejects(f.remote.control(auth,body));
  assert.equal(f.calls.length,0);
});

test('unapproved, revoked and unlinked users cannot request a voice join',async()=>{
  for(const change of [f=>f.state.revoked=true,f=>f.state.approved=false,f=>f.state.link=null]){const f=fixture();change(f);await assert.rejects(f.remote.control(auth,{action:'join'}));assert.equal(f.calls.length,0);}
});

test('queued join rechecks an unlink or account revocation before reaching the player',async()=>{
  for(const change of [f=>f.state.revoked=true,f=>f.state.link=null,f=>f.state.link={session:{hash:'replacement',userId:USER}}]){
    const f=fixture();let release;f.service.musicBot.enqueue(()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();
    const request=f.remote.control(auth,{action:'join'});change(f);release();await assert.rejects(request);assert.equal(f.calls.length,0);
  }
});

test('authorization loss during the asynchronous join is not returned as success',async()=>{
  for(const change of [f=>f.state.revoked=true,f=>f.state.approved=false,f=>f.state.link=null]){
    const f=fixture();f.state.controlHook=()=>change(f);await assert.rejects(f.remote.control(auth,{action:'join'}));assert.equal(f.calls.length,1);
  }
});

test('existing music actions remain restricted to their own payload schema',()=>{
  const f=fixture();for(const action of ['play','queue','pause','resume','next','previous','stop'])assert.equal(f.remote.validateControl({action}).action,action);
  assert.equal(f.remote.validateControl({action:'volume',volume:70}).volume,70);
  assert.throws(()=>f.remote.validateControl({action:'volume',volume:101}));assert.throws(()=>f.remote.validateControl({action:'stop',playlistId:'all'}));
});
