const test=require('node:test');
const assert=require('node:assert/strict');
const model=import('../src/components/integration-state.mjs');

test('line-based plugin rules round-trip without collapsing separate words or changing unrelated values',async()=>{
  const {pluginDraft,pluginValues}=await model;
  const fields=[{key:'blockedWords',type:'words'},{key:'enabled',type:'boolean'}],saved={blockedWords:['böses Wort','wild*card'],enabled:false,mode:'local'};
  const draft=pluginDraft(fields,saved);
  assert.equal(draft.blockedWords,'böses Wort\nwild*card');
  draft.blockedWords+='\n';
  assert.deepEqual(pluginValues(fields,draft),saved,'A trailing line remains editable without changing saved rules');
  draft.blockedWords+=' dritte Regel \r\n\n';
  assert.deepEqual(pluginValues(fields,draft).blockedWords,['böses Wort','wild*card','dritte Regel']);
  assert.deepEqual(saved.blockedWords,['böses Wort','wild*card'],'Drafts never mutate backend data');
});

test('unknown plugin state and unknown voice durations are never described as confirmed activity',async()=>{
  const {pluginLabel,duration}=await model;
  assert.equal(pluginLabel({installed:true,enabled:null}),'Status noch nicht bestätigt');
  assert.equal(pluginLabel({installed:true}),'Status noch nicht bestätigt');
  assert.equal(pluginLabel({installed:false,enabled:true}),'Nicht installiert');
  assert.equal(duration(null),'Nicht bekannt');
  assert.equal(duration(-1),'Nicht bekannt');
  assert.equal(duration(3661.9),'1 Std. 1 Min. 1 Sek.');
});

test('ChatFilter word limits apply to each entry rather than to the whole text field',async()=>{
  const {wordListLimit,pluginProblem}=await model;
  const field={key:'blockedWords',label:'Wörter',type:'words',maxLength:60,max:100};
  const value='a'.repeat(40)+'\n'+'b'.repeat(40);
  assert.ok(wordListLimit(field)>value.length);
  assert.equal(pluginProblem([field],{blockedWords:value}),'');
  assert.match(pluginProblem([field],{blockedWords:'a'.repeat(61)}),/je 60/);
  assert.match(pluginProblem([field],{blockedWords:'same\nsame'}),/doppelte/);
});

test('new moderation rules are disabled and provider limits prevent invalid submissions',async()=>{
  const {newModerationRule,ruleProblem}=await model;
  const rule=newModerationRule();assert.equal(rule.enabled,false);assert.match(ruleProblem(rule),/1 bis 100/);
  rule.keywords=['blocked*'];assert.equal(ruleProblem(rule),'');
  assert.match(ruleProblem({...rule,keywords:['a'.repeat(61)]}),/60 Zeichen/);
  assert.match(ruleProblem({...rule,keywords:Array(101).fill('word')}),/100/);
  assert.match(ruleProblem({...rule,allowList:Array(101).fill('allowed')}),/Ausnahmen/);
  assert.match(ruleProblem({...rule,exemptRoleIds:Array(21).fill('id')}),/20 Rollen/);
  assert.match(ruleProblem({...rule,exemptChannelIds:Array(51).fill('id')}),/50 Kanäle/);
  assert.match(ruleProblem({...rule,blockMessage:'x'.repeat(151)}),/150 Zeichen/);
});

test('audio selection rejects unsupported, broken or oversized content before preview',async()=>{
  const {audioProblem,normalizeAudioMime}=await model;
  const clip={id:'clip',name:'voice.webm',mime:'audio/webm;codecs=opus',dataBase64:'YXVkaW8=',bytes:5};
  assert.equal(audioProblem(clip),'');
  assert.equal(normalizeAudioMime(' audio/x-wav '),'audio/wav');
  assert.match(audioProblem({...clip,mime:'application/javascript'}),/Unterstützt/);
  assert.match(audioProblem({...clip,bytes:8388609}),/8 MB/);
  assert.match(audioProblem({...clip,bytes:0}),/8 MB/);
  assert.match(audioProblem({...clip,dataBase64:'not ! base64'}),/Audiodaten/);
  assert.equal(audioProblem({...clip,bytes:8388608,dataBase64:Buffer.alloc(8388608).toString('base64')}),'','Maximum-size valid content must not overflow the regular expression stack');
});

test('uncertain audio retry keeps its request ID even when a different channel was reviewed in between',async()=>{
  const {audioRequestFor,audioIdentity}=await model;
  const requests=new Map(),clip={id:'same-clip'};let calls=0;const makeId=()=>`request-${++calls}`;
  const first=audioRequestFor(requests,clip,'channel-a',makeId);
  const other=audioRequestFor(requests,clip,'channel-b',makeId);
  assert.notEqual(first,other);
  assert.equal(audioRequestFor(requests,clip,'channel-a',makeId),first);
  assert.equal(calls,2);
  assert.notEqual(audioRequestFor(requests,{id:'new-clip'},'channel-a',makeId),first);
  requests.delete(audioIdentity(clip,'channel-a'));
  assert.notEqual(audioRequestFor(requests,clip,'channel-a',makeId),first,'An explicit repeat after successful send gets a new ID');
});

test('King and Moderator suggestions come only from real matching roles and review preserves its original revision',async()=>{
  const {suggestedRoleBadges,roleReview}=await model;
  const roles=[{id:'king',name:'KING'},{id:'mod',name:'Moderator'},{id:'unrelated',name:'Kingdom'}];
  const draft=suggestedRoleBadges(roles);
  assert.equal(draft[0].roleId,'king');assert.equal(draft[1].roleId,'mod');assert.equal(draft[0].color,'#D4AF37');
  assert.equal(suggestedRoleBadges([{id:'other',name:'Kingdom'}])[0].roleId,'');
  const snapshot=roleReview('guild','revision-a',true,draft);
  draft[0].roleId='other';
  const latestPoll={revision:'revision-b'};
  assert.equal(snapshot.expectedRevision,'revision-a');assert.notEqual(snapshot.expectedRevision,latestPoll.revision);
  assert.equal(snapshot.rules[0].roleId,'king','Review payload cannot change behind the confirmation');
});

test('Spotify configuration uses integer revisions and restricted devices cannot be selected for controls',async()=>{
  const {isSpotifyRevision,spotifyPlayableDevice}=await model;
  for(const value of [0,1,9007199254740991])assert.equal(isSpotifyRevision(value),true);
  for(const value of ['1','a'.repeat(64),-1,1.5,NaN,Infinity])assert.equal(isSpotifyRevision(value),false);
  const devices=[{id:'restricted',isRestricted:true},{id:'usable',isRestricted:false}];
  assert.equal(spotifyPlayableDevice(devices,'restricted'),null);
  assert.equal(spotifyPlayableDevice(devices,'missing'),null);
  assert.equal(spotifyPlayableDevice(devices,'usable').id,'usable');
});

test('account, website, session and guild changes each isolate outstanding requests and private drafts',async()=>{
  const {integrationScope}=await model;
  const site={connected:true,baseUrl:'https://crazybatto.de',profileId:'profile-a',user:{id:'user-a'},expiresAt:123};
  const scope=integrationScope(site,'guild-a');
  for(const changed of [{...site,connected:false},{...site,baseUrl:'https://another.example'},{...site,profileId:'profile-b'},{...site,user:{id:'user-b'}},{...site,expiresAt:124}])assert.notEqual(integrationScope(changed,'guild-a'),scope);
  assert.notEqual(integrationScope(site,'guild-b'),scope);
});
