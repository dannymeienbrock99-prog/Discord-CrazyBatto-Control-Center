const test=require('node:test');
const assert=require('node:assert/strict');
const model=import('../src/components/tiktok-preview.mjs');
const slot={id:'1',username:'creator_one',title:'{name} ist live!',description:'Schau bei {name} vorbei.',imageUrl:'',roleId:''};
const cover='https://p16-sign.tiktokcdn.com/live/cover.jpeg?token=public-image';
const avatar='https://p16.tiktokcdn-us.com/avatar.jpeg';
const runtime={slotId:'1',status:'live',name:'Creator Eins',coverUrl:cover,avatarUrl:avatar,startedAt:'2026-11-09T12:00:00Z',startEstimated:false,lastCheckedAt:'2026-11-09T13:00:00Z'};

test('confirmed live cover matches the selected creator and Discord draft',async()=>{
 const {tikTokPreview}=await model;
 const result=tikTokPreview({slot,runtime});
 assert.equal(result.isLive,true);assert.equal(result.kind,'live-cover');assert.equal(result.imageUrl,cover);
 assert.equal(result.embed.imageUrl,cover);assert.equal(result.embed.title,'Creator Eins ist live!');
 assert.equal(result.liveUrl,'https://www.tiktok.com/@creator_one/live');assert.equal(result.startEstimated,false);
});

test('unknown, failed, disabled and offline states never become live because a cover exists',async()=>{
 const {tikTokPreview}=await model;
 for(const status of ['unknown','error','disabled','offline']){
  const result=tikTokPreview({slot,runtime:{...runtime,status}});
  assert.equal(result.isLive,false);assert.equal(result.status,status);assert.equal(result.label,'Zuletzt geladenes Live-Cover');
 }
});

test('editing a creator name or using another slot cannot reuse the old creator cover or status',async()=>{
 const {tikTokPreview}=await model;
 for(const [draft,record] of [[{...slot,username:'new_creator'},runtime],[slot,{...runtime,slotId:'2'}]]){
  const result=tikTokPreview({slot:draft,savedSlot:slot,runtime:record});
  assert.equal(result.accountMatches,false);assert.equal(result.isLive,false);assert.equal(result.imageUrl,null);
  assert.equal(result.avatarUrl,null);assert.equal(result.lastCheckedAt,null);assert.equal(result.status,'unknown');
 }
});

test('fallback order is cover, custom image, avatar, then an honest empty state',async()=>{
 const {tikTokPreview}=await model;
 const custom={...slot,imageUrl:'https://crazybatto.de/assets/my-live.jpg'};
 assert.equal(tikTokPreview({slot:custom,runtime}).kind,'live-cover');
 assert.equal(tikTokPreview({slot:custom,runtime:{...runtime,coverUrl:null}}).kind,'custom-image');
 const profile=tikTokPreview({slot,runtime:{...runtime,coverUrl:null}});
 assert.equal(profile.kind,'creator-avatar');assert.match(profile.note,/kein Bild aus dem Stream/);
 const empty=tikTokPreview({slot,runtime:{...runtime,coverUrl:null,avatarUrl:null}});
 assert.equal(empty.kind,'unavailable');assert.equal(empty.imageUrl,null);assert.match(empty.note,/kein verwendbares Cover/);
});

test('backend preview field is accepted only when its kind and CDN image are valid',async()=>{
 const {tikTokPreview}=await model;
 const result=tikTokPreview({slot,runtime:{slotId:'1',status:'live',preview:{kind:'live-cover',imageUrl:cover}}});
 assert.equal(result.imageUrl,cover);
 const denied=tikTokPreview({slot,runtime:{slotId:'1',status:'live',preview:{kind:'live-cover',imageUrl:'https://untrusted.invalid/cover.jpg'}}});
 assert.equal(denied.imageUrl,null);
});

test('image validation rejects unsafe origins, URLs and video resources without weakening custom HTTPS images',async()=>{
 const {safePreviewImage}=await model;
 for(const url of ['http://p16.tiktokcdn.com/cover.jpg','https://tiktokcdn.com.evil.invalid/image.jpg','https://evil-tiktokcdn.com/image.jpg','https://name:secret@p16.tiktokcdn.com/image.jpg','https://p16.tiktokcdn.com:8443/image.jpg','https://p16.tiktokcdn.com/image.jpg#fragment','https://p16.tiktokcdn.com/space image.jpg','https://p16.tiktokcdn.com\\image.jpg','https://p16.tiktokcdn.com/live.m3u8','https://p16.tiktokcdn.com/live.MP4?token=public','data:image/png;base64,AAAA','file:///C:/private.png'])assert.equal(safePreviewImage(url,{tiktokOnly:true}),null,url);
 assert.equal(safePreviewImage(avatar,{tiktokOnly:true}),avatar);
 assert.equal(safePreviewImage('https://crazybatto.de/custom.png'),'https://crazybatto.de/custom.png');
 assert.equal(safePreviewImage('https://crazybatto.de/custom.png',{tiktokOnly:true}),null);
});

test('outbound live link is canonical and ignores arbitrary URLs in backend data',async()=>{
 const {tikTokLiveUrl,tikTokPreview}=await model;
 assert.equal(tikTokLiveUrl('@Creator.One'),'https://www.tiktok.com/@creator.one/live');
 for(const username of ['', 'a', 'hello/other', 'user?url=evil', 'https://evil.invalid','a'.repeat(25)])assert.equal(tikTokLiveUrl(username),null);
 assert.equal(tikTokPreview({slot,runtime:{...runtime,liveUrl:'https://evil.invalid'}}).liveUrl,'https://www.tiktok.com/@creator_one/live');
});

test('sidebar and account heading use the same saved-creator identity guard as the cover',async()=>{
 const {isSameTikTokAccount}=await model;
 assert.equal(isSameTikTokAccount(slot,slot,runtime),true);
 assert.equal(isSameTikTokAccount({...slot,username:'@CREATOR_ONE'},slot,runtime),true);
 assert.equal(isSameTikTokAccount({...slot,username:'another_creator'},slot,runtime),false);
 assert.equal(isSameTikTokAccount({...slot,username:''},slot,runtime),false);
 assert.equal(isSameTikTokAccount(slot,slot,{...runtime,slotId:'8'}),false);
});

test('custom fallback applies the same public-image rules and length limit as the server',async()=>{
 const {safePreviewImage}=await model;
 for(const url of ['https://127.0.0.1/image.png','https://[::1]/image.png','https://router.local/image.png','https://media.internal/image.png','https://sample.test/image.png','https://example.com/movie.%6dp4','https://example.com/live.webm','https://example.com/image\u007f.png','https://example.com/image.png?x='+'x'.repeat(2048)])assert.equal(safePreviewImage(url),null,url);
 assert.equal(safePreviewImage('https://images.example.com/image.png'),'https://images.example.com/image.png');
});
