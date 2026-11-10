import test from 'node:test';
import assert from 'node:assert/strict';
import { JoinRequests, JOIN_REQUEST_ACTIONS } from '../src/join-requests.mjs';
import { AppError } from '../src/errors.mjs';

const BOT = '900000000000000002', GUILD = '900000000000000018', OTHER = '900000000000000044';
const USER = '900000000000000045', REQUEST = '900000000000000046', NEXT = '900000000000000055', ROLE = '900000000000000047';
const TOKEN = 'fixture-bot-secret-never-output', NOW = Date.parse('2026-11-09T15:00:00Z');
const nativeRequest = (patch = {}) => ({ id: REQUEST, guild_id: GUILD, user_id: USER, created_at: '2026-11-09T14:00:00Z', reviewed_at: null,
  application_status: 'SUBMITTED', rejection_reason: null, user: { id: USER, username: 'FixtureApplicant', global_name: 'Fixture Person', avatar: 'a'.repeat(32) }, form_responses: [], ...patch });
function fixture() {
  const values = new Map(), writes = [], audit = [];
  const store = { setting: key => values.get(key), setSetting(key, value) { values.set(key, value); writes.push(key); },
    transaction(fn) { const before = new Map(values); try { return fn(); } catch (e) { values.clear(); for (const [k,v] of before) values.set(k,v); throw e; } },
    audit(...args) { audit.push(args); } };
  const context = { user: { id: 'fixture-admin' } }, f = { calls: [], writes, audit, values, store, valid: true, now: NOW, permissions: 2n, features: ['MEMBER_VERIFICATION_MANUAL_APPROVAL'], requests: [nativeRequest()], hook: null };
  const service = { config: { clientId: BOT, discordGuildId: GUILD, botToken: TOKEN }, accounts: { store, assertCurrent(ctx, rights) {
    assert.deepEqual(rights, {admin:true}); if (ctx !== context || !f.valid) throw new AppError('auth', 'Website-Anmeldung wurde beendet.', 401);
  } }, discord: { async request(method, route, options = {}) {
    f.calls.push({ method, route, payload: structuredClone(options.payload) });
    const value = await f.hook?.(method, route, options); if (value !== undefined) return value;
    if (route === '/users/@me') return { id: BOT, bot: true };
    if (route === '/guilds/' + GUILD) return { id: GUILD, owner_id: OTHER, features: f.features, roles: [{id:GUILD,permissions:'0',position:0},{id:ROLE,permissions:String(f.permissions),position:5}] };
    if (route === `/guilds/${GUILD}/members/${BOT}`) return { user: {id:BOT}, roles:[ROLE] };
    if (method === 'GET' && route.startsWith(`/guilds/${GUILD}/requests?`)) {
      const query = new URL(route, 'https://discord.fixture').searchParams;
      const all = f.requests.filter(row => row.application_status === query.get('status'));
      const rows = all.filter(row => (!query.has('before') || BigInt(row.id) < BigInt(query.get('before'))) && (!query.has('after') || BigInt(row.id) > BigInt(query.get('after')))).sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1).slice(0, Number(query.get('limit')));
      return structuredClone({ total: all.length, guild_join_requests: rows });
    }
    if (method === 'PATCH' && route.startsWith(`/guilds/${GUILD}/requests/`)) {
      const row = f.requests.find(row=>row.id===route.split('/').at(-1));
      if (!row) throw new AppError('forbidden', 'Missing fixture request.', 404);
      row.application_status = options.payload.action; row.reviewed_at = new Date(f.now).toISOString(); row.rejection_reason = options.payload.rejection_reason || null;
      return structuredClone(row);
    }
    throw new Error('Unexpected fixture route');
  } } };
  f.context = context; f.service = service; f.model = new JoinRequests(service, {now:()=>f.now});
  f.list = payload => f.model.run(context, 'joinrequests.list', payload);
  f.review = payload => f.model.run(context, 'joinrequests.review', {requestId:REQUEST, action:'APPROVED', confirm:true, ...payload});
  f.mutations = () => f.calls.filter(call=>call.method!=='GET');
  f.restart = () => { f.model = new JoinRequests(service, {now:()=>f.now}); };
  return f;
}

test('only two explicit native actions exist and class has no polling, registration or gateway lifecycle', () => {
  const f = fixture(); assert.deepEqual(JOIN_REQUEST_ACTIONS,['joinrequests.list','joinrequests.review']); assert.equal(f.model.start,undefined); assert.equal(f.model.stop,undefined); assert.equal(f.calls.length,0); assert.equal(f.writes.length,0);
});
test('admin authorization and fixed bot/guild identity fail before side effects', async () => {
  const f=fixture(); await assert.rejects(f.model.run(null,'joinrequests.list'),{status:401}); f.valid=false; await assert.rejects(f.list(),{status:401}); f.valid=true;
  await assert.rejects(f.list({guildId:OTHER}),{status:403}); f.service.config.clientId=OTHER; await assert.rejects(f.list(),{status:503}); assert.equal(f.calls.length,0);
});
test('wrong live bot, wrong guild and wrong bot member cannot inspect or decide applications', async () => {
  for (const [target,value] of [['/users/@me',{id:OTHER,bot:true}],['/users/@me',{id:BOT,bot:false}],['/guilds/'+GUILD,{id:OTHER,roles:[]}],[`/guilds/${GUILD}/members/${BOT}`,{user:{id:OTHER},roles:[]}]]) {
    const f=fixture(); f.hook=(_m,r)=>r===target?value:undefined; await assert.rejects(f.list(),{status:503}); assert.equal(f.mutations().length,0);
  }
});
test('missing Kick Members or native Apply to Join reports unavailable without a fake empty queue', async () => {
  const f=fixture(); f.permissions=0n; let result=await f.list(); assert.equal(result.available,false); assert.equal(result.requests,null); assert.match(result.message,/Mitglieder kicken/);
  f.permissions=2n; f.features=[]; result=await f.list(); assert.equal(result.code,'mode_disabled'); assert.match(result.message,/Apply to Join/);
  await assert.rejects(f.review(),{kind:'mode_disabled'}); assert(!f.calls.some(c=>c.route.includes('/requests'))); assert.equal(f.mutations().length,0);
});
test('strict list and review parameters cannot inject routes, actions, cursors or credentials', async () => {
  const f=fixture();
  for(const payload of [[],{status:'STARTED'},{status:'SUBMITTED&limit=999'},{limit:0},{limit:101},{limit:'50'},{before:USER,after:REQUEST},{before:'../other'},{token:'x'},{path:'/users/@me'}]) await assert.rejects(f.list(payload),{status:400});
  for(const payload of [{confirm:false},{requestId:'../users'},{action:'BAN'},{action:'REJECTED',rejectionReason:'x'.repeat(161)},{action:'REJECTED',rejectionReason:'bad\nreason'},{rejectionReason:'Only rejection'},{headers:{}}]) await assert.rejects(f.review(payload),{status:400});
  await assert.rejects(f.model.run(f.context,'joinrequests.delete',{}),{status:400}); assert.equal(f.calls.length,0);
});
test('official form response variants normalize to bounded plain strings and canonical Discord avatars', async () => {
  const f=fixture(); f.requests[0].form_responses=[
    {field_type:'TEXT_INPUT',label:'Name',response:'<b>Plain text</b>\u202e'},
    {field_type:'PARAGRAPH',label:'Why',response:TOKEN+' '+'x'.repeat(2100)},
    {field_type:'MULTIPLE_CHOICE',label:'Choice',choices:['First','Second'],response:1},
    {field_type:'TERMS',label:'Rules',values:['Be respectful'],response:true},
    {field_type:'UNRECOGNIZED',label:'Other',response:{token:TOKEN}}
  ];
  const result=await f.list(),row=result.requests[0]; assert.equal(result.available,true); assert.equal(result.preview,true); assert.equal(row.id,REQUEST); assert.notEqual(row.id,row.userId);
  assert.equal(row.answers[0].value,'<b>Plain text</b>'); assert.equal(row.answers[1].value.length,2000); assert.equal(row.answers[2].value,'Second'); assert.equal(row.answers[3].value,'Zugestimmt'); assert.match(row.answers[4].value,/nicht verfügbar/);
  assert.match(row.user.avatarUrl,/^https:\/\/cdn\.discordapp\.com\/avatars\//); assert(!JSON.stringify(result).includes(TOKEN)); assert.equal(f.writes.length,0);
});
test('form and profile bounds remain explicit and invalid avatar strings never become URLs', async () => {
  const f=fixture(); f.requests[0].user.avatar='https://evil.example/token'; f.requests[0].user.global_name='x'.repeat(500); f.requests[0].form_responses=Array.from({length:30},()=>({field_type:'TEXT_INPUT',label:'y'.repeat(400),response:'z'}));
  const row=(await f.list()).requests[0]; assert.equal(row.answers.length,25); assert.equal(row.answersTruncated,true); assert.equal(row.answers[0].label.length,256); assert.equal(row.user.globalName.length,100); assert.match(row.user.avatarUrl,/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/);
});
test('missing optional user and answers are valid; missing required request ID never falls back to user ID', async () => {
  const f=fixture(); f.requests[0].user=null; f.requests[0].form_responses=null; const row=(await f.list()).requests[0]; assert.equal(row.id,REQUEST); assert.equal(row.userId,USER); assert.deepEqual(row.answers,[]);
  f.hook=(_m,r)=>r.includes('/requests?')?{total:1,guild_join_requests:[{...nativeRequest(),id:undefined}]}:undefined;
  const invalid=await f.list(); assert.equal(invalid.available,false); assert.equal(invalid.requests,null);
});
test('missing array, malformed rows, foreign guilds and inconsistent totals never masquerade as an empty list', async () => {
  for(const value of [{},{total:0},{total:3},{guild_join_requests:null},{total:0,guild_join_requests:[nativeRequest()]},{total:'1',guild_join_requests:[]},{guild_join_requests:[nativeRequest({guild_id:OTHER})]},{guild_join_requests:[nativeRequest({user:{id:OTHER}})]},{guild_join_requests:[nativeRequest({reviewed_at:'invalid'})]}]) {
    const f=fixture(); f.hook=(_m,r)=>r.includes('/requests?')?value:undefined; const result=await f.list(); assert.equal(result.available,false); assert.equal(result.requests,null); assert.equal(f.mutations().length,0);
  }
  const f=fixture(); f.requests=[]; const empty=await f.list(); assert.equal(empty.available,true); assert.deepEqual(empty.requests,[]); assert.equal(empty.total,0);
});
test('pagination exposes snowflake bounds, follows before/after and does not invent optional totals', async () => {
  const f=fixture(); f.requests=[nativeRequest(),nativeRequest({id:NEXT})]; const first=await f.list({limit:1}); assert.equal(first.requests[0].id,NEXT); assert.equal(first.pagination.hasMore,true); assert.equal(first.pagination.nextBefore,NEXT);
  const older=await f.list({limit:1,before:first.pagination.nextBefore}); assert.equal(older.requests[0].id,REQUEST); const newer=await f.list({limit:1,after:REQUEST}); assert.equal(newer.requests[0].id,NEXT);
  f.hook=(_m,r)=>r.includes('/requests?')?{guild_join_requests:[nativeRequest()]}:undefined;
  const unknown=await f.list({limit:1}); assert.equal(unknown.total,null); assert.equal(unknown.pagination.hasMore,null); assert.equal(unknown.pagination.nextBefore,REQUEST);
  const wrongCursor=await f.list({limit:1,before:REQUEST}); assert.equal(wrongCursor.available,false); assert.equal(wrongCursor.code,'protocol');
});
test('remote API denials and raw exception messages are sanitized into informative unavailability', async () => {
  for(const status of [400,401,403,404,405,429,500]) {
    const f=fixture(); f.hook=()=>{throw new AppError('network',TOKEN+' private remote body',status);}; const result=await f.list(); assert.equal(result.available,false); assert.equal(result.requests,null); assert(!JSON.stringify(result).includes(TOKEN)); assert(!result.message.includes('private remote body'));
  }
});
test('revoked website admin during list cannot receive pending applications or a successful unavailable response', async () => {
  const f=fixture(); f.hook=(_m,r)=>{if(r.includes('/requests?'))f.valid=false;}; await assert.rejects(f.list(),{status:401}); assert.equal(f.writes.length,0);
});
test('approval verifies a currently submitted request and stores metadata only before the exact PATCH', async () => {
  const f=fixture(); f.requests[0].form_responses=[{field_type:'PARAGRAPH',label:'Private answer',response:'private-fixture-application'}];
  f.hook=(m)=>{if(m==='PATCH')assert.match(f.store.setting('native_join_request_reviews_v1'),/sending/);};
  const result=await f.review(); assert.equal(result.request.status,'APPROVED'); assert.deepEqual(f.mutations()[0],{method:'PATCH',route:`/guilds/${GUILD}/requests/${REQUEST}`,payload:{action:'APPROVED'}});
  assert(!f.store.setting('native_join_request_reviews_v1').includes('private-fixture-application')); assert(!f.store.setting('native_join_request_reviews_v1').includes(TOKEN)); assert.equal(f.audit.length,1);
});
test('rejection sends only an optional bounded rejection reason and never bans or kicks', async () => {
  const f=fixture(); const result=await f.review({action:'REJECTED',rejectionReason:'Bitte eine nachvollziehbare Vorstellung ergänzen.'});
  assert.equal(result.request.status,'REJECTED'); assert.deepEqual(f.mutations()[0].payload,{action:'REJECTED',rejection_reason:'Bitte eine nachvollziehbare Vorstellung ergänzen.'}); assert.equal(f.mutations().length,1); assert(!f.calls.some(c=>/\/bans\/|\/roles\//.test(c.route)));
});
test('stale, unknown or already completed request cannot be approved and cached views are refreshed', async () => {
  const f=fixture(); await f.list(); f.requests[0].application_status='APPROVED'; await assert.rejects(f.review(),{status:409}); assert.equal(f.mutations().length,0);
  const g=fixture(); await assert.rejects(g.review({requestId:NEXT}),{status:409}); assert.equal(g.mutations().length,0);
});
test('review finds an application on a later bounded page and checks guild on every response', async () => {
  const f=fixture(); f.requests=Array.from({length:101},(_,i)=>nativeRequest({id:String(BigInt(REQUEST)+BigInt(i))})); await f.review(); assert.equal(f.mutations().length,1); assert(f.calls.filter(c=>c.route.includes('/requests?')).length>=2);
});
test('admin revocation during review lookups prevents PATCH and persistent reservation', async () => {
  const f=fixture(); f.hook=(_m,r)=>{if(r.includes('/requests?'))f.valid=false;}; await assert.rejects(f.review(),{status:401}); assert.equal(f.mutations().length,0); assert.equal(f.writes.length,0);
});
test('confirmed action is not turned into retry failure by in-flight revocation or audit storage failure', async () => {
  const f=fixture(); f.hook=m=>{if(m==='PATCH')f.valid=false;}; f.store.audit=()=>{throw new Error('fixture audit unavailable');};
  const result=await f.review(); assert.equal(result.request.status,'APPROVED'); assert.equal(f.mutations().length,1);
});
test('ambiguous PATCH is persisted and blocks replay after restart', async () => {
  const f=fixture(); f.hook=m=>{if(m==='PATCH')throw new AppError('uncertain',TOKEN,502);};
  await assert.rejects(f.review(),error=>error.kind==='uncertain'&&!error.message.includes(TOKEN)); assert.match(f.store.setting('native_join_request_reviews_v1'),/uncertain/);
  f.restart(); await assert.rejects(f.review(),{status:409}); assert.equal(f.mutations().length,1);
});
test('mismatched PATCH acknowledgement remains uncertain and cannot target another application', async () => {
  for(const change of [{id:NEXT},{user_id:OTHER,user:null},{guild_id:OTHER},{application_status:'SUBMITTED'},{id:undefined}]) {
    const f=fixture(); f.hook=m=>m==='PATCH'?nativeRequest({application_status:'APPROVED',reviewed_at:new Date(NOW).toISOString(),...change}):undefined;
    await assert.rejects(f.review(),{kind:'uncertain'}); assert.match(f.store.setting('native_join_request_reviews_v1'),/uncertain/); assert.equal(f.mutations().length,1);
  }
});
test('definitive API rejection does not report success and completed approvals cannot be duplicated concurrently', async () => {
  const denied=fixture(); denied.hook=m=>{if(m==='PATCH')throw new AppError('forbidden','remote secret '+TOKEN,403);}; await assert.rejects(denied.review(),{status:403}); assert.match(denied.store.setting('native_join_request_reviews_v1'),/failed/);
  const f=fixture(); const results=await Promise.allSettled([f.review(),f.review()]); assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(f.mutations().length,1); f.restart(); await assert.rejects(f.review(),{status:409});
});
