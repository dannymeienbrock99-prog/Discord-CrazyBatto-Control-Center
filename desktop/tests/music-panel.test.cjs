const test=require('node:test');
const assert=require('node:assert/strict');
const model=import('../src/components/music-panel-state.mjs');
const trackA={id:'track-a',title:'Goldener Abend',artist:'Crazy_Batto'};
const trackB={id:'track-b',title:'Neue Welt',artist:'Community'};
function status(overrides={}) {
  return {ok:true,bot:{configured:true,enabled:true,connected:false,status:'stopped',currentTrack:null,gateway:{ready:true}},discord:{linked:true},permissions:{canControl:true},queue:[],library:{tracks:[trackA,trackB],playlists:[{id:'all',trackIds:['track-a','track-b']},{id:'favorites',trackIds:['track-a']}]},...overrides};
}

test('a member with voice permission can request bot join before selecting music',async()=>{
  const {musicControls}=await model;
  const actions=musicControls(status());
  assert.equal(actions.canJoin,true);
  assert.equal(actions.canNavigate,false);
  assert.equal(actions.canPause,false);
  assert.equal(actions.canStop,false);
});

test('empty queue after a confirmed join permits leave but not previous, next or pause',async()=>{
  const {musicControls,musicBotLabel}=await model;
  const data=status();data.bot.connected=true;data.bot.status='idle';
  const actions=musicControls(data);
  assert.equal(actions.canJoin,false);assert.equal(actions.canStop,true);
  assert.equal(actions.canNavigate,false);assert.equal(actions.canPause,false);
  assert.equal(musicBotLabel(data),'Im Sprachkanal · bereit');
});

test('unlinked accounts, missing permission and failed status refresh cannot activate voice controls',async()=>{
  const {musicControls}=await model;
  for(const [data,verified] of [[status({discord:{linked:false}}),true],[status({permissions:{canControl:false}}),true],[status(),false]]){
    const actions=musicControls(data,verified);
    assert.equal(actions.allowed,false);assert.equal(actions.canJoin,false);assert.equal(actions.canStop,false);assert.equal(actions.canNavigate,false);assert.equal(actions.canPause,false);
  }
  const connecting=status();connecting.bot.status='connecting';
  assert.equal(musicControls(connecting).canJoin,false,'Do not offer another join while connection is pending');
});

test('confirmed playback exposes pause and queue navigation and shows paused status honestly',async()=>{
  const {musicControls,musicBotLabel}=await model;
  const data=status({queue:[trackA]});data.bot.connected=true;data.bot.currentTrack=trackA;data.bot.paused=true;
  const actions=musicControls(data);
  assert.equal(actions.canPause,true);assert.equal(actions.canNavigate,true);assert.equal(actions.canJoin,false);
  assert.equal(musicBotLabel(data),'Pausiert im Sprachkanal');
});

test('search and playlist filters cannot turn two existing tracks into a falsely empty library',async()=>{
  const {filterMusicTracks}=await model;const data=status();
  assert.deepEqual(filterMusicTracks(data,'test','favorites'),[]);
  assert.equal(data.library.tracks.length,2,'Filtering never mutates the underlying loaded library');
  assert.deepEqual(filterMusicTracks(data,'','all'),[trackA,trackB]);
  assert.deepEqual(filterMusicTracks(data,' CRAZY_batto ','all'),[trackA]);
  assert.deepEqual(filterMusicTracks(data,'','favorites'),[trackA]);
  assert.deepEqual(filterMusicTracks(data,'','deleted-playlist'),[]);
});

test('returning after browser consent retains authorized link so the final poll can complete it',async()=>{
  const {pendingMusicLink}=await model;
  for(const state of ['pending','authorized']){
    const link={status:state,authorizePath:'/oauth/start/a'.padEnd(35,'x'),displayCode:'TEST'};
    assert.equal(pendingMusicLink(link),link);
  }
  assert.equal(pendingMusicLink({status:'expired',authorizePath:'/oauth/start/test'}),null);
  assert.equal(pendingMusicLink(null),null);
});

test('site identity changes reset music context and incomplete replies never become an allowed state',async()=>{
  const {musicContextKey,validMusicState}=await model;
  const site={connected:true,baseUrl:'https://crazybatto.de',profileId:'p1',user:{id:'u1'},expiresAt:123};
  for(const changed of [{...site,profileId:'p2'},{...site,user:{id:'u2'}},{...site,baseUrl:'https://other.example'},{...site,connected:false}])assert.notEqual(musicContextKey(site),musicContextKey(changed));
  assert.equal(validMusicState(status()),true);
  for(const invalid of [null,{},status({permissions:{}}),status({library:{tracks:[]}}),status({queue:null}),status({bot:{connected:'true'}})])assert.ok(!validMusicState(invalid));
});

test('cancelling while browser approval is pending waits for its response before mutation and final refresh',async()=>{
  const {afterMusicLinkPoll}=await model;
  let release;const calls=[];
  const pending=new Promise(resolve=>{release=resolve;}).then(()=>calls.push('approval settled'));
  const operation=afterMusicLinkPoll(pending,()=>true,async()=>{calls.push('cancel request');calls.push('confirmed status refresh');});
  await Promise.resolve();assert.deepEqual(calls,[]);
  release();await operation;
  assert.deepEqual(calls,['approval settled','cancel request','confirmed status refresh']);
});

test('waiting for a link poll cannot issue a later mutation under a replaced website context',async()=>{
  const {afterMusicLinkPoll}=await model;
  let release,current=true,calls=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const operation=afterMusicLinkPoll(pending,()=>current,async()=>{calls++;});
  current=false;release();await operation;assert.equal(calls,0);
});

test('a selected or buffering track is not reported as confirmed playback',async()=>{
  const {musicBotLabel}=await model;
  const data=status();data.bot.connected=true;data.bot.currentTrack=trackA;
  data.bot.status='buffering';assert.equal(musicBotLabel(data),'Im Sprachkanal · Titel wird geladen');
  data.bot.status='idle';assert.equal(musicBotLabel(data),'Im Sprachkanal · Titel ausgewählt');
  data.bot.status='playing';assert.equal(musicBotLabel(data),'Musik läuft im Sprachkanal');
});
