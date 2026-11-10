const test=require('node:test');
const assert=require('node:assert/strict');
const birthday=import('../src/components/birthday-images.mjs');
const theme=import('../src/components/theme-preview.mjs');
const requests=import('../src/components/join-request-monitor.mjs');

test('legacy birthday settings receive optional fields without losing texts or schedule',async()=>{
 const {withBirthdayImages}=await birthday;
 const old={enabled:true,channelId:'900000000000000008',greetingTemplate:'Hallo {name}',reminderTemplate:'In {days} Tagen',hour:10};
 assert.deepEqual(withBirthdayImages(old),{...old,greetingImageUrl:'',reminderImageUrl:''});
 assert.equal(withBirthdayImages({...old,greetingImageUrl:'https://example.com/greeting.png'}).greetingImageUrl,'https://example.com/greeting.png');
});
test('birthday quick images are separate and example text uses the selected reminder interval',async()=>{
 const {BIRTHDAY_IMAGES,birthdayExample,birthdayImageError}=await birthday;
 assert.notEqual(BIRTHDAY_IMAGES.greeting,BIRTHDAY_IMAGES.reminder);
 for(const url of Object.values(BIRTHDAY_IMAGES))assert.equal(birthdayImageError(url),'');
 assert.equal(birthdayImageError(''),'');
 assert.match(birthdayExample('{name}: in {days} Tagen am {date}',7),/Beispiel-Mitglied: in 7 Tagen am 12\.11\./);
});
test('birthday image fields reject credentials, local addresses, video and invalid encodings',async()=>{
 const {birthdayImageError}=await birthday;
 for(const url of ['http://example.com/image.png','https://user:secret@example.com/image.png','https://127.0.0.1/p.png','https://machine.local/p.png','https://example.com/video.%6dp4','https://example.com/%GG','https://example.com/p.png#part','https://example.com/a b.png','https://example.com/'+ 'x'.repeat(2048)])assert.ok(birthdayImageError(url),url);
});
test('theme preview constrains CSS properties and rejects code-bearing background strings',async()=>{
 const {themePreviewModel,themeBackgroundUrl}=await theme;
 const view=themePreviewModel({accentColor:'red; color:evil',backgroundIntensity:1000,borderRadius:-30,fontSize:50,backgroundUrl:'javascript:alert(1)'});
 assert.equal(view.style['--theme-accent'],'#D4AF37');assert.equal(view.style['--theme-intensity'],.8);assert.equal(view.style['--theme-radius'],'0px');assert.equal(view.style['--theme-font'],'22px');assert.equal(view.imageUrl,null);
 for(const url of ['https://example.com/a);x.png','https://example.com/a\".png','https://example.com/{x}.png','https://localhost/image.png','https://example.com/video.webm'])assert.equal(themeBackgroundUrl(url),null,url);
 assert.equal(themeBackgroundUrl('https://crazybatto.de/assets/control/marble-gold.webp'),'https://crazybatto.de/assets/control/marble-gold.webp');
});
test('full pending snapshots start silently and detect an older request newly submitted later',async()=>{
 const {observeJoinRequests}=await requests;
 const result=ids=>({available:true,snapshotComplete:true,requests:ids.map(id=>({id}))});
 let state=observeJoinRequests(null,result(['900000000000000009','900000000000000010','900000000000000011']));assert.deepEqual(state.newIds,[]);
 state=observeJoinRequests(state.baseline,result(['900000000000000010','900000000000000011']));assert.deepEqual(state.newIds,[]);
 state=observeJoinRequests(state.baseline,result(['900000000000000012','900000000000000012','900000000000000010','900000000000000011']));assert.deepEqual(state.newIds,['900000000000000012']);
 assert.deepEqual(observeJoinRequests(state.baseline,result(['900000000000000012'])).newIds,[]);
});
test('unavailable join API never becomes an empty verified queue or resets the notification baseline',async()=>{
 const {observeJoinRequests,joinRequestCount}=await requests;
 const baseline={seen:['900000000000000009']};
 assert.equal(observeJoinRequests(baseline,{available:false,requests:null}).baseline,baseline);
 assert.equal(joinRequestCount({available:false,requests:null}),null);
 assert.equal(joinRequestCount({available:true,requests:[],total:0}),0);
 assert.deepEqual(observeJoinRequests(null,{available:false,requests:null}).newIds,[]);
});
test('an initially empty join queue detects the first new snowflake and ignores malformed identities',async()=>{
 const {observeJoinRequests}=await requests;
 const first=observeJoinRequests(null,{available:true,snapshotComplete:true,requests:[]});
 const next=observeJoinRequests(first.baseline,{available:true,snapshotComplete:true,requests:[{id:'not-an-id'},{id:'900000000000000013'}]});
 assert.deepEqual(next.newIds,['900000000000000013']);
});

test('pending monitor follows all pages before establishing its notification baseline',async()=>{
 const {readPendingJoinSnapshot,observeJoinRequests}=await requests;const calls=[];
 const response=await readPendingJoinSnapshot(async payload=>{calls.push(payload);return calls.length===1?{available:true,requests:[{id:'900000000000000014'}],total:2,pagination:{hasMore:true,nextBefore:'900000000000000014'}}:{available:true,requests:[{id:'900000000000000012'}],pagination:{hasMore:false}};},'900000000000000008');
 assert.equal(calls.length,2);assert.equal(calls[1].before,'900000000000000014');assert.equal(response.snapshotComplete,true);assert.equal(response.requests.length,2);
 assert.deepEqual(observeJoinRequests(null,response).baseline.seen,['900000000000000014','900000000000000012']);
});

test('truncated snapshots stop after 10 pages and never emit false new alerts',async()=>{
 const {readPendingJoinSnapshot,observeJoinRequests}=await requests;let calls=0;
 const response=await readPendingJoinSnapshot(async()=>{calls++;return {available:true,requests:[{id:String(900000000000000015n-BigInt(calls))}],pagination:{hasMore:true,nextBefore:String(900000000000000015n-BigInt(calls))}};},'900000000000000008');
 assert.equal(calls,10);assert.equal(response.snapshotComplete,false);assert.ok(response.snapshotMessage);
 const baseline={seen:['900000000000000016']};assert.equal(observeJoinRequests(baseline,response).baseline,baseline);assert.deepEqual(observeJoinRequests(baseline,response).newIds,[]);
});

test('notification failure codes are shown as understandable messages',async()=>{
 const {notificationReason}=await requests;
 assert.match(notificationReason('rate_limit'),/begrenzt/);assert.match(notificationReason('unsupported'),/nicht unterstützt/);assert.doesNotMatch(notificationReason('unknown_code'),/unknown_code/);
});
