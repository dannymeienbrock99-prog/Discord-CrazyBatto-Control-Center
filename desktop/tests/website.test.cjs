'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { WebsiteService, normalizeBaseUrl } = require('../electron/website.cjs');

const TOKEN = 'test_native_session_'.repeat(3);
const PASSWORD = 'test-password-only';
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin', email: 'admin@example.test', confirmed: true, isAdmin: true, canUpload: true, suspended: false };
const NOW = 1900000000000;
const BOT_ID = '900000000000000002';
function reply(value, status = 200, extra = {}) { return { status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => value, ...extra }; }
function loginReply(extra = {}) { return { user: USER, token: TOKEN, csrfToken: 'private-csrf-value', requests: [], expiresAt: NOW + 86400000, ...extra }; }
function connections() {
  const profiles = new Map(), secrets = new Map(), saved = [];
  return {
    profiles, secrets, saved,
    getProfile: id => profiles.get(id), getSecret: id => secrets.get(id),
    async run(action, data) {
      if (action === 'connections.clearSecret') { secrets.delete(data.id); return profiles.get(data.id); }
      assert.equal(action, 'connections.save'); saved.push({ ...data });
      const id = data.id || 'website-1', { accessKey, password, ...profile } = data;
      assert.equal(password, undefined, 'Website password must never be handed to connection storage');
      profiles.set(id, { ...profile, id }); secrets.set(id, { accessKey }); return profiles.get(id);
    }
  };
}
function fixture(handler, initial = {}) {
  const calls = [], storage = connections(); let now = NOW;
  if (initial.profile) { storage.profiles.set(initial.profile.id, initial.profile); storage.secrets.set(initial.profile.id, { accessKey: TOKEN }); }
  const service = new WebsiteService({ connections: storage, now: () => now, fetch: async (url, options) => { calls.push({ url, options }); return handler(url, options, calls.length); } });
  return { service, storage, calls, setNow: value => { now = value; }, login: () => service.run('website.login', { email: USER.email, password: PASSWORD, remember: true }) };
}
const basic = (url) => url.endsWith('/api/account/login') ? reply(loginReply()) : url.endsWith('/api/account/session') ? reply({ user: USER, csrfToken: 'private-csrf-value' }) : reply({ ok: true });

test('member approvals and PC-support decisions remain on fixed authenticated routes with exact revisions and prices',async()=>{
  const f=fixture(basic);await f.login();const id=USER.id;
  const operations=[
    ['members.query',{limit:100,cursor:null,status:'all',search:'Batto'},'POST','/api/admin/control-members/query'],
    ['members.review',{userId:id,expectedRevision:3,decision:'approve',reason:'',confirm:true},'POST',`/api/admin/control-members/${id}/review`],
    ['support.query',{limit:50,cursor:null,status:'all',kind:'order',search:''},'POST','/api/admin/pc-support/query'],
    ['support.detail',{id},'GET',`/api/admin/pc-support/${id}`],
    ['support.review',{id,expectedRevision:7,decision:'counter_offer',reason:'Mehr Aufwand',patch:{},offerCents:2500,confirm:true},'POST',`/api/admin/pc-support/${id}/review`],
    ['support.close',{id,expectedRevision:8,reason:'Erledigt',confirm:true},'POST',`/api/admin/pc-support/${id}/close`]
  ];
  for(const [operation,body,method,path] of operations){await f.service.run('website.request',{operation,body});const call=f.calls.at(-1);assert.equal(call.url,'https://crazybatto.de'+path);assert.equal(call.options.method,method);assert.equal(call.options.headers.Authorization,'Bearer '+TOKEN);if(body.expectedRevision!==undefined)assert.equal(JSON.parse(call.options.body).expectedRevision,body.expectedRevision);if(body.offerCents)assert.equal(JSON.parse(call.options.body).offerCents,2500);}
  const count=f.calls.length;
  for(const body of [{id,expectedRevision:7,decision:'counter_offer',reason:'Aufwand',patch:{},offerCents:999,confirm:true},{id,expectedRevision:7,decision:'edit',reason:'',patch:{subject:'Anderer Betreff'},offerCents:2500,confirm:true},{id,expectedRevision:7,decision:'approve',reason:'',patch:{},offerCents:1000,confirm:false}])await assert.rejects(f.service.run('website.request',{operation:'support.review',body}));
  await assert.rejects(f.service.run('website.request',{operation:'support.charge',body:{}}));
  await assert.rejects(f.service.run('website.request',{operation:'members.review',body:{userId:'../../account/session',expectedRevision:0,decision:'approve',reason:'',confirm:true}}));
  assert.equal(f.calls.length,count,'Invalid decisions never reach the server');
});

test('Robot queries safely encode text and tombstones, restores and conflicts carry the selected revision',async()=>{
  const f=fixture(basic);await f.login();const id=USER.id,q='A & cursor=other / ?';
  await f.service.run('website.request',{operation:'robot.orders',body:{state:'active',q,cursor:null}});
  const query=new URL(f.calls.at(-1).url);assert.equal(query.pathname,'/api/admin/robot/orders');assert.equal(query.searchParams.get('q'),q);assert.equal(query.searchParams.has('cursor'),false);
  for(const [operation,body,method,suffix] of [['robot.delete',{id,expectedRevision:4},'DELETE',''],['robot.restore',{id,expectedRevision:5},'POST','/restore'],['robot.resolve',{id,conflictId:id,expectedRevision:6,decision:'server'},'POST',`/conflicts/${id}/resolve`]]){await f.service.run('website.request',{operation,body});const call=f.calls.at(-1);assert.equal(call.options.method,method);assert.equal(call.url,`https://crazybatto.de/api/admin/robot/orders/${id}${suffix}`);assert.equal(JSON.parse(call.options.body).expectedRevision,body.expectedRevision);}
  const count=f.calls.length;
  await assert.rejects(f.service.run('website.request',{operation:'robot.orders',body:{state:'active',q:'',cursor:'x&other=1'}}));
  await assert.rejects(f.service.run('website.request',{operation:'robot.update',body:{id,expectedRevision:1,changes:{deleted:true}}}));
  await assert.rejects(f.service.transport('https://crazybatto.de','/api/account/session?arbitrary=1'));
  assert.equal(f.calls.length,count);
});

test('Robot photo pagination remains on its fixed authenticated detail route',async()=>{
  const f=fixture(basic);await f.login();const id=USER.id;
  await f.service.run('website.request',{operation:'robot.detail',body:{id,photoCursor:id}});
  assert.equal(f.calls.at(-1).url,`https://crazybatto.de/api/admin/robot/orders/${id}?photoCursor=${id}`);
  assert.equal(f.calls.at(-1).options.headers.Authorization,'Bearer '+TOKEN);
  const count=f.calls.length;
  for(const photoCursor of ['../secret','x&admin=true','',42])await assert.rejects(f.service.run('website.request',{operation:'robot.detail',body:{id,photoCursor}}));
  for(const suffix of [`?photoCursor=${id}&other=1`,`?photoCursor=${id}&photoCursor=${id}`,`?photoCursor=${id}#x`])await assert.rejects(f.service.transport('https://crazybatto.de',`/api/admin/robot/orders/${id}${suffix}`));
  assert.equal(f.calls.length,count);
});

test('private PC and Robot image previews retain bounded raster data but reject markup and oversized data',async()=>{
  let preview={mimeType:'image/png',dataUrl:'data:image/png;base64,'+Buffer.alloc(32000,1).toString('base64')};
  const f=fixture(url=>url.endsWith('/api/account/login')?reply(loginReply()):reply({...preview,token:TOKEN}));await f.login();
  for(const [operation,imageId] of [['support.image','gallery_'+'a'.repeat(64)],['robot.image',USER.id]]){const result=await f.service.run('website.request',{operation,body:{imageId}});assert.equal(result.dataUrl,preview.dataUrl);assert.equal(result.token,undefined);}
  preview={mimeType:'image/svg+xml',dataUrl:'data:image/svg+xml;base64,PHN2Zz4='};await assert.rejects(f.service.run('website.request',{operation:'robot.image',body:{imageId:USER.id}}),/Bildvorschau/);
  preview={mimeType:'image/png',dataUrl:'data:image/png;base64,'+Buffer.alloc(8388609).toString('base64')};await assert.rejects(f.service.run('website.request',{operation:'robot.image',body:{imageId:USER.id}}),/Bildvorschau/);
});

test('flat support and Robot errors remain useful and do not expose the native session',async()=>{
  let response={ok:false,kind:'conflict',message:'Stand geändert '+TOKEN};
  const f=fixture(url=>url.endsWith('/api/account/login')?reply(loginReply()):reply(response,409));await f.login();
  await assert.rejects(f.service.run('website.request',{operation:'support.detail',body:{id:USER.id}}),error=>error.code==='conflict'&&error.message.includes('Stand geändert')&&!error.message.includes(TOKEN));
  response={error:'preview_too_large',code:'preview_too_large'};
  await assert.rejects(f.service.run('website.request',{operation:'robot.image',body:{imageId:USER.id}}),/Original im Browser/);
});

test('community and TikTok actions stay on authenticated fixed bridge and unknown actions are refused', async () => {
  const f=fixture(url=>url.endsWith('/api/account/login')?reply(loginReply()):reply({ok:true,result:{accepted:true}}));
  await f.login();
  for(const action of ['community.state','community.save','community.publish','community.register','community.report.list','community.report.moderate','community.voice.list','community.voice.control','community.ticket.list','community.ticket.close','tiktok.state','tiktok.save','tiktok.check','joinrequests.list','joinrequests.review','admincrown.list','admincrown.lookup','admincrown.apply','admincrown.remove']) {
    const result=await f.service.run('website.request',{operation:'discord.action',body:{action,payload:{}}});
    assert.equal(result.result.accepted,true);
    const call=f.calls.at(-1); assert.equal(call.url,'https://crazybatto.de/api/admin/discord-control/action');
    assert.equal(call.options.headers.Authorization,'Bearer '+TOKEN);
  }
  const count=f.calls.length;
  await assert.rejects(f.service.run('website.request',{operation:'discord.action',body:{action:'community.shell',payload:{}}}));
  assert.equal(f.calls.length,count);
});

test('role and setup administration preserves revision and confirmation through the authenticated bridge', async () => {
  const f = fixture(url => url.endsWith('/api/account/login') ? reply(loginReply()) : reply({ ok: true, result: { revision: 8 } }));
  await f.login();
  const guildId = '900000000000000018';
  const requests = [
    ['roles.state', { guildId }],
    ['roles.save', { guildId, revision: 7, mapping: { pc: '900000000000000023' }, channelId: '900000000000000024', enabled: false, confirm: true }],
    ['roles.decorate', { guildId, confirm: true }],
    ['roles.publish', { guildId, confirm: true }],
    ['setup.state', { guildId }],
    ['setup.save', { guildId, expectedRevision: 7, settings: { enabled: true, forumChannelId: '900000000000000025', publicationMode: 'review' }, confirm: true }],
    ['setup.moderate', { guildId, id: 'setup-entry', expectedRevision: 4, operation: 'approve', confirm: true }],
    ['setup.retry', { guildId, id: 'setup-entry', expectedRevision: 5, confirm: true }],
  ];
  for (const [action, payload] of requests) {
    const result = await f.service.run('website.request', { operation: 'discord.action', body: { action, payload } });
    assert.equal(result.result.revision, 8);
    const call = f.calls.at(-1);
    assert.equal(call.url, 'https://crazybatto.de/api/admin/discord-control/action');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.deepEqual(JSON.parse(call.options.body), { action, payload });
  }
  const before = f.calls.length;
  for (const action of ['roles.assign', 'setup.delete', 'setup.shell']) {
    await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action, payload: { guildId } } }));
  }
  assert.equal(f.calls.length, before, 'Unlisted actions must not reach the website');
});

test('an authenticated setup preview survives a streamed 8 MiB image response without truncation or credential leakage', async () => {
  const dataUrl = 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024, 7).toString('base64');
  const f = fixture(url => url.endsWith('/api/account/login') ? reply(loginReply()) : new Response(JSON.stringify({
    ok: true, result: { dataUrl, mimeType: 'image/png', accessToken: TOKEN }, diagnostics: { sessionToken: TOKEN },
  }), { headers: { 'Content-Type': 'application/json' } }));
  await f.login();
  const payload = { guildId: '900000000000000018', id: 'setup-entry', imageId: 'setup-photo' };
  const result = await f.service.run('website.request', { operation: 'discord.action', body: { action: 'setup.image', payload } });
  assert.equal(result.result.dataUrl.length, dataUrl.length, 'The preview must keep every base64 byte');
  const digest = text => createHash('sha256').update(text).digest('hex');
  assert.equal(digest(result.result.dataUrl), digest(dataUrl));
  assert.equal(result.result.mimeType, 'image/png');
  assert.equal(result.result.accessToken, undefined);
  assert.equal(result.diagnostics.sessionToken, undefined);
  const call = f.calls.at(-1);
  assert.equal(call.url, 'https://crazybatto.de/api/admin/discord-control/action');
  assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(call.options.body), { action: 'setup.image', payload });
});

test('large image response allowance is restricted to setup previews and retains a hard transport limit', async () => {
  for (const [action, length] of [['setup.state', 4 * 1024 * 1024], ['setup.image', 12 * 1024 * 1024]]) {
    const f = fixture(url => url.endsWith('/api/account/login') ? reply(loginReply()) : new Response(JSON.stringify({ ok: true, result: { dataUrl: 'x'.repeat(length), mimeType: 'image/png' } })));
    await f.login();
    await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action, payload: {} } }), error => error.code === 'response' && error.status === 502);
  }
});

test('setup previews refuse non-raster data, malformed encoding and decoded images above 8 MiB', async () => {
  for (const result of [
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', mimeType: 'image/svg+xml' },
    { dataUrl: 'data:image/png;base64,invalid!', mimeType: 'image/png' },
    { dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/jpeg' },
    { dataUrl: 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'), mimeType: 'image/png' },
  ]) {
    const f = fixture(url => url.endsWith('/api/account/login') ? reply(loginReply()) : new Response(JSON.stringify({ ok: true, result })));
    await f.login();
    await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action: 'setup.image', payload: {} } }), error => error.code === 'response' && error.status === 502);
  }
});

test('native login pins origin, uses native account body, and exposes no credentials', async () => {
  const f = fixture(basic), state = await f.login();
  assert.deepEqual(state, { connected: true, user: USER, profileId: 'website-1', baseUrl: 'https://crazybatto.de', expiresAt: NOW + 86400000 });
  const request = f.calls[0];
  assert.equal(request.url, 'https://crazybatto.de/api/account/login');
  assert.deepEqual(JSON.parse(request.options.body), { email: USER.email, password: PASSWORD, native: true });
  assert.equal(request.options.headers['X-Client-Type'], 'native');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.headers.Origin, undefined);
  assert.equal(request.options.headers.Cookie, undefined);
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(f.storage.saved[0].accessKey, TOKEN);
  assert.equal(JSON.stringify(state).includes(TOKEN), false);
  assert.equal(JSON.stringify(state).includes('csrf'), false);
});

test('saved native session is reverified, without resending password or assuming expiry', async () => {
  const profile = { id: 'saved', kind: 'website', name: 'Website', baseUrl: 'https://admin.example.test', username: USER.email };
  const f = fixture(basic, { profile });
  const state = await f.service.run('website.reconnect', { profileId: 'saved' });
  assert.equal(state.connected, true); assert.equal(state.expiresAt, null);
  assert.equal(f.calls[0].url, 'https://admin.example.test/api/account/session');
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(f.calls[0].options.body, undefined);
  assert.equal(f.calls[0].options.headers['X-CSRF-Token'], undefined);
});

test('rejects unsafe origins before any request and never accepts renderer paths or methods', async () => {
  for (const url of ['http://crazybatto.de', 'https://user:password@crazybatto.de', 'https://crazybatto.de/api', 'https://crazybatto.de:8443', 'https://crazybatto.de/?next=x', 'https://127.0.0.1', 'https://localhost', 'https://server.local', 'https://crazybatto.de/#x', 'https://crazybatto.de\\@other.test']) assert.throws(() => normalizeBaseUrl(url));
  assert.equal(normalizeBaseUrl('https://CRAZYBATTO.de/'), 'https://crazybatto.de');
  const f = fixture(basic); await f.login(); const before = f.calls.length;
  await assert.rejects(f.service.run('website.request', { operation: 'https://evil.test' }));
  await assert.rejects(f.service.run('website.request', { operation: 'bot.get', url: 'https://evil.test' }));
  await assert.rejects(f.service.run('website.request', { operation: 'bot.get', body: { token: TOKEN } }));
  assert.equal(f.calls.length, before);
});

test('redirect and cross-origin responses cannot supply login tokens or module state', async () => {
  for (const extra of [{ status: 302 }, { redirected: true }, { url: 'https://evil.test/api/account/login' }]) {
    const f = fixture(() => reply(loginReply(), 200, extra));
    await assert.rejects(f.login(), error => error.code === 'redirect');
    assert.equal(f.service.state().connected, false); assert.equal(f.storage.saved.length, 0);
  }
});

test('non-admin login is rejected and its newly issued session is revoked', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply({ user: { ...USER, isAdmin: false } })) : reply({ ok: true }));
  await assert.rejects(f.login(), error => error.code === 'forbidden');
  assert.equal(f.calls[1].url, 'https://crazybatto.de/api/account/logout');
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(f.storage.saved.length, 0); assert.equal(f.service.state().connected, false);
});

test('known local expiry clears active auth without making another request', async () => {
  const f = fixture(basic); await f.login(); f.setNow(NOW + 86400001);
  await assert.rejects(f.service.run('website.request', { operation: 'bot.get' }), error => error.status === 401);
  assert.equal(f.calls.length, 1); assert.equal(f.service.state().connected, false);
});

test('server session expiry clears active auth; failed reconnect scrubs expired saved token', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ error: { code: 'auth', message: 'Bitte anmelden.' } }, 401));
  await f.login();
  await assert.rejects(f.service.run('website.request', { operation: 'bot.get' }), error => error.status === 401);
  assert.equal(f.service.state().connected, false);
  await assert.rejects(f.service.run('website.reconnect', { profileId: 'website-1' }));
  assert.equal(f.storage.secrets.has('website-1'), false);
});

test('upstream Discord credential failure does not revoke a valid website session', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ error: { code: 'discord', message: 'Der Bot-Zugang wurde von Discord abgelehnt.' } }, 401));
  await f.login();
  await assert.rejects(f.service.run('website.request', { operation: 'discord.state' }), error => error.code === 'discord' && error.status === 401);
  assert.equal(f.service.state().connected, true);
});

test('partial module load keeps supported modules and reports unavailable extension separately', async () => {
  const f = fixture(url => {
    if (/account\//.test(url)) return basic(url);
    if (url.endsWith('/bot')) return reply({ configured: true, enabled: true, music: { configured: true }, commands: ['/geburtstage'] });
    if (url.endsWith('/birthdays')) return reply({ settings: { enabled: false }, status: { configured: true }, deliveries: [] });
    if (url.endsWith('/channels')) return reply({ guildId: '900000000000000003', channels: [] });
    return reply({ error: { code: 'not_found', message: 'Erweiterung fehlt.' } }, 404);
  });
  await f.login(); const data = await f.service.run('website.load');
  assert.equal(data.state.connected, true); assert.equal(data.capabilities.bot, true); assert.equal(data.capabilities.music, true);
  assert.equal(data.capabilities.discordControl, false); assert.equal(data.errors.discordControl.status, 404);
  assert.deepEqual(data.birthdayChannels.channels, []);
  assert.equal(JSON.stringify(data).includes(TOKEN), false);
});

test('birthday settings and delivery actions enforce exact API schema before dispatch', async () => {
  const f = fixture(basic); await f.login();
  const settings = { enabled: true, channelId: '900000000000000003', reminderDays: 3, hour: 10, greetingTemplate: 'Hallo {name}', reminderTemplate: 'Noch {days} Tage: {date}. {website}', mentionMode: 'none' };
  await f.service.run('website.request', { operation: 'birthdays.update', body: settings });
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), settings);
  const images={...settings,greetingImageUrl:'https://crazybatto.de/assets/control/dragon-gold-birthday.png',reminderImageUrl:''};
  await f.service.run('website.request',{operation:'birthdays.update',body:images});
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body),images);
  const before = f.calls.length;
  for (const greetingImageUrl of ['http://example.com/a.png','https://user:secret@example.com/a.png','https://127.0.0.1/a.png','https://example.com/movie.mp4','https://example.com/'+ 'a'.repeat(2048)]) await assert.rejects(f.service.run('website.request',{operation:'birthdays.update',body:{...images,greetingImageUrl}}));
  for (const body of [{ ...settings, hour: 24 }, { ...settings, mentionMode: 'role' }, { ...settings, greetingTemplate: '{token}' }, { enabled: false }]) await assert.rejects(f.service.run('website.request', { operation: 'birthdays.update', body }));
  await assert.rejects(f.service.run('website.request', { operation: 'birthdays.delivery', body: { id: '../bot', action: 'retry' } }));
  assert.equal(f.calls.length, before);
  await f.service.run('website.request', { operation: 'birthdays.delivery', body: { id: 'a'.repeat(64), action: 'mark_sent' } });
  assert.equal(f.calls.at(-1).url, 'https://crazybatto.de/api/admin/birthdays/deliveries/' + 'a'.repeat(64));
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { action: 'mark_sent' });
});

test('music controls follow native API and strip nested tokens from response', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ ok: true, csrfToken: 'private', bot: { volume: 42, sessionToken: TOKEN }, token: TOKEN }));
  await f.login(); const data = await f.service.run('website.request', { operation: 'music.control', body: { action: 'volume', volume: 42 } });
  assert.equal(f.calls.at(-1).url, 'https://crazybatto.de/api/music-remote/control');
  assert.deepEqual(data, { ok: true, bot: { volume: 42 } });
  await assert.rejects(f.service.run('website.request', { operation: 'music.control', body: { action: 'volume', volume: 101 } }));
  await assert.rejects(f.service.run('website.request', { operation: 'music.control', body: { action: 'play', url: 'https://youtube.com' } }));
});

test('music join uses the authenticated voice route and rejects unrelated fields before network access', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ ok: true, bot: { connected: true }, sessionToken: TOKEN }));
  const request = body => f.service.run('website.request', { operation: 'music.control', body });
  await assert.rejects(request({ action: 'join' }));
  assert.equal(f.calls.length, 0);
  await f.login();
  assert.deepEqual(await request({ action: 'join' }), { ok: true, bot: { connected: true } });
  assert.equal(f.calls.at(-1).url, 'https://crazybatto.de/api/music-remote/control');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(f.calls.at(-1).options.body), { action: 'join' });
  const before = f.calls.length;
  for (const body of [{ action: 'join', url: 'https://outside.invalid/audio' }, { action: 'join', trackId: USER.id }, { action: 'join', volume: 80 }, { action: 'join', channelId: '../other' }, { action: 'join?override=1' }]) await assert.rejects(request(body));
  assert.equal(f.calls.length, before);
});

test('Discord bridge stays on same origin, restricts actions, and confirms exact bot identity', async () => {
  const f = fixture(url => url.endsWith('/login') ? reply(loginReply()) : url.endsWith('/capabilities') ? reply({ ok: true, version: 1, expectedBotId: BOT_ID, actions: ['guild.load'] }) : url.endsWith('/state') ? reply({ ok: true, state: { connected: true, bot: { id: BOT_ID } } }) : reply({ ok: true, result: { guildId: '900000000000000003' } }));
  await f.login();
  assert.equal((await f.service.run('website.request', { operation: 'discord.capabilities' })).expectedBotId, BOT_ID);
  assert.equal((await f.service.run('website.request', { operation: 'discord.state' })).state.bot.id, BOT_ID);
  await f.service.run('website.request', { operation: 'discord.action', body: { action: 'guild.load', payload: { guildId: '900000000000000003' } } });
  assert.equal(f.calls.at(-1).url, 'https://crazybatto.de/api/admin/discord-control/action');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer ' + TOKEN);
  await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action: 'bot.connect', payload: { token: TOKEN } } }));
  const bad = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ ok: true, version: 1, expectedBotId: 'wrong-bot', actions: [] })); await bad.login();
  await assert.rejects(bad.service.run('website.request', { operation: 'discord.capabilities' }), error => error.code === 'identity');
});

test('successful logout clears revoked stored session, while offline forget still erases it', async () => {
  const f = fixture(basic); await f.login();
  assert.equal((await f.service.run('website.disconnect')).connected, false);
  assert.equal(f.storage.secrets.has('website-1'), false);
  const offline = fixture(url => { if (url.endsWith('/login')) return reply(loginReply()); throw new Error('network'); }); await offline.login();
  const result = await offline.service.run('website.disconnect', { forget: true });
  assert.equal(result.connected, false); assert.ok(result.warning); assert.equal(offline.storage.secrets.has('website-1'), false);
});

test('bridge accepts separate 8 MiB icon and banner without truncation and rejects oversized UTF-8 envelope', async () => {
  const f = fixture(basic); await f.login();
  const image = 'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024, 7).toString('base64');
  await f.service.run('website.request', { operation: 'discord.action', body: { action: 'guild.update', payload: { guildId: '900000000000000003', icon: image, banner: image } } });
  const sent = JSON.parse(f.calls.at(-1).options.body);
  assert.equal(sent.payload.icon, image); assert.equal(sent.payload.banner, image);
  assert.ok(Buffer.byteLength(f.calls.at(-1).options.body) < 24 * 1024 * 1024);
  const before = f.calls.length;
  await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action: 'message.send', payload: { content: '🎂'.repeat(6 * 1024 * 1024) } } }), /zu groß/);
  assert.equal(f.calls.length, before);
});

test('network failures and server errors never disclose supplied password or native token', async () => {
  const f = fixture(() => reply({ error: { code: 'auth', message: 'Rejected ' + PASSWORD } }, 401));
  await assert.rejects(f.login(), error => !error.message.includes(PASSWORD));
  const f2 = fixture(url => url.endsWith('/login') ? reply(loginReply()) : reply({ error: { code: 'auth', message: 'Rejected ' + TOKEN } }, 401)); await f2.login();
  await assert.rejects(f2.service.run('website.request', { operation: 'bot.get' }), error => !error.message.includes(TOKEN));
});

test('late response cannot reconnect after user disconnected during login', async () => {
  let resolveLogin;
  const f = fixture(url => url.endsWith('/login') ? new Promise(resolve => { resolveLogin = resolve; }) : reply({ ok: true }));
  const pending = f.login();
  await f.service.run('website.disconnect'); resolveLogin(reply(loginReply()));
  await assert.rejects(pending, error => error.code === 'session_changed');
  assert.equal(f.service.state().connected, false); assert.equal(f.storage.saved.length, 0);
});

test('setup invitation and join-role operations preserve reviewed revisions on the fixed authenticated bridge', async () => {
  const f = fixture(url => url.endsWith('/api/account/login') ? reply(loginReply()) : reply({ ok: true, result: { revision: 19, token: TOKEN, csrfToken: 'private-csrf-value' } }));
  await f.login();
  const guildId = '900000000000000018';
  const operations = [
    ['setup.panel.state', { guildId }],
    ['setup.panel.save', { guildId, expectedRevision: 17, settings: { channelId: '900000000000000024', title: 'Eure Gaming Setups', description: 'Nach Admin-Freigabe auf Website und Discord.', imageUrl: '', buttonLabel: 'Mein Setup einreichen' }, confirm: true }],
    ['setup.panel.publish', { guildId, expectedRevision: 18, confirm: true }],
    ['joinrole.state', { guildId }],
    ['joinrole.save', { guildId, expectedRevision: 4, settings: { enabled: true, roleId: '900000000000000023' }, confirm: true }],
  ];
  for (const [action, payload] of operations) {
    const response = await f.service.run('website.request', { operation: 'discord.action', body: { action, payload } });
    assert.deepEqual(response, { ok: true, result: { revision: 19 } }, 'Native session secrets must not reach the editor');
    const call = f.calls.at(-1);
    assert.equal(call.url, 'https://crazybatto.de/api/admin/discord-control/action');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(JSON.parse(call.options.body), { action, payload }, 'Expected revision, reviewed settings and confirmation must survive unchanged');
  }
});

test('all new setup invitation and join-role actions require a live website session before any request', async () => {
  const f = fixture(() => { throw new Error('Unauthenticated action reached the network'); });
  for (const action of ['setup.panel.state', 'setup.panel.save', 'setup.panel.publish', 'joinrole.state', 'joinrole.save']) {
    await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action, payload: {} } }), error => error.status === 401);
  }
  assert.equal(f.calls.length, 0);
});

test('disconnecting while setup publishing or join-role state is pending rejects stale private responses without retrying', async () => {
  for (const action of ['setup.panel.publish', 'joinrole.state']) {
    let release;
    const started = new Promise(resolve => {
      release = { started: resolve, reply: null };
    });
    const f = fixture(url => {
      if (url.endsWith('/api/account/login')) return reply(loginReply());
      if (url.endsWith('/api/account/logout')) return reply({ ok: true });
      return new Promise(resolve => { release.reply = resolve; release.started(); });
    });
    await f.login();
    const request = f.service.run('website.request', { operation: 'discord.action', body: { action, payload: { guildId: '900000000000000018', expectedRevision: 3, confirm: true } } });
    const rejected = assert.rejects(request, error => error.code === 'session_changed' && error.status === 409);
    await started;
    await f.service.run('website.disconnect');
    release.reply(reply({ ok: true, result: { revision: 4, roles: [{ id: '900000000000000023', name: 'Private role' }], publication: { messageId: '900000000000000025' } } }));
    await rejected;
    assert.equal(f.service.state().connected, false);
    assert.equal(f.calls.filter(call => call.url.endsWith('/api/admin/discord-control/action')).length, 1, 'An uncertain publication must never be retried by the desktop transport');
  }
});

test('new module names cannot be used to inject query strings or override the authenticated bridge route', async () => {
  const f = fixture(basic); await f.login();
  const before = f.calls.length;
  for (const action of ['setup.panel.publish?confirm=true', 'joinrole.save/../../logout', 'setup.panel.delete', 'joinrole.assign']) {
    await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action, payload: {} } }));
  }
  await assert.rejects(f.service.run('website.request', { operation: 'discord.action', query: { guildId: '900000000000000018' }, body: { action: 'setup.panel.state', payload: {} } }));
  await assert.rejects(f.service.run('website.request', { operation: 'discord.action', body: { action: 'joinrole.save', payload: {}, url: 'https://other.example/api/admin/discord-control/action' } }));
  assert.equal(f.calls.length, before);
});

test('Spotify controller stays on fixed authenticated routes and only exposes a secret-present flag', async () => {
  const f=fixture(url=>url.endsWith('/api/account/login')?reply(loginReply()):reply({ok:true,secretConfigured:true,clientSecret:'hidden-app-secret',accessToken:'hidden-oauth-token',revision:3}));await f.login();
  for(const [operation,body,method,endpoint] of [['spotify.status',undefined,'GET','/api/spotify/status'],['spotify.player',undefined,'GET','/api/spotify/player'],['spotify.control',{action:'play',deviceId:'pc-one'},'POST','/api/spotify/control'],['spotify.admin.read',undefined,'GET','/api/admin/spotify'],['spotify.admin.save',{clientId:'a'.repeat(32),clientSecret:'b'.repeat(32),expectedRevision:3},'PUT','/api/admin/spotify'],['spotify.admin.check',{expectedRevision:3},'POST','/api/admin/spotify/check-credentials'],['spotify.disconnect',{},'POST','/api/spotify/disconnect']]) {
    const result=await f.service.run('website.request',{operation,body});const call=f.calls.at(-1);assert.equal(call.url,'https://crazybatto.de'+endpoint);assert.equal(call.options.method,method);assert.equal(call.options.headers.Authorization,'Bearer '+TOKEN);assert.equal(result.accessToken,undefined);assert.equal(result.clientSecret,undefined);if(['spotify.admin.read','spotify.admin.save'].includes(operation))assert.equal(result.secretConfigured,true);
  }
  const before=f.calls.length;
  for(const [operation,body] of [['spotify.token',{}],['spotify.control',{action:'play',deviceId:'pc-one',url:'https://evil.test'}],['spotify.control',{action:'volume',deviceId:'pc-one',volume:101}],['spotify.admin.save',{clientId:'a'.repeat(32),expectedRevision:-1}]])await assert.rejects(f.service.run('website.request',{operation,body}));
  assert.equal(f.calls.length,before);
});

test('Spotify shuffle repeat and seeking are typed and restricted to the authenticated control endpoint',async()=>{
  const f=fixture(url=>url.endsWith('/api/account/login')?reply(loginReply()):reply({ok:true}));await f.login();
  for(const body of [{action:'shuffle',deviceId:'pc-one',state:true},{action:'repeat',deviceId:'pc-one',state:'context'},{action:'seek',deviceId:'pc-one',positionMs:12000}]){
    await f.service.run('website.request',{operation:'spotify.control',body});const call=f.calls.at(-1);assert.equal(call.url,'https://crazybatto.de/api/spotify/control');assert.deepEqual(JSON.parse(call.options.body),body);
  }
  const before=f.calls.length;for(const body of [{action:'shuffle',deviceId:'pc-one',state:'yes'},{action:'repeat',deviceId:'pc-one',state:'all'},{action:'seek',deviceId:'pc-one',positionMs:-1},{action:'seek',deviceId:'pc-one',positionMs:1.5},{action:'seek',deviceId:'pc-one',positionMs:10,token:'no'}])await assert.rejects(f.service.run('website.request',{operation:'spotify.control',body}));assert.equal(f.calls.length,before);
});
