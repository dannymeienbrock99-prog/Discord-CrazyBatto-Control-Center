import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.mjs';
import { TikTokLive, defaultSlots, validateSlots, parseTikTokStatus, fetchTikTokStatus, tiktokImageUrl, tiktokPreview } from '../src/tiktok-live.mjs';

const GUILD = '900000000000000018', OTHER_GUILD = '900000000000000044';
const CHANNEL = '900000000000000045', OTHER_CHANNEL = '900000000000000046';
const ROLE = '900000000000000047', MESSAGE = '900000000000000048';
const ROOM = '900000000000000058', NEXT_ROOM = '900000000000000059';
const SETTINGS = 'control_tiktok_slots_v1', RUNTIME = 'control_tiktok_runtime_v1';
const START = Date.UTC(2026, 10, 9, 18, 0, 0);
const COVER = 'https://p16-webcast.tiktokcdn.com/tos-live/fixture-cover.image?x-expires=9999999999&x-signature=fixture-signature';
const AVATAR = 'https://p19-sign.tiktokcdn-us.com/tos-avt/fixture-avatar.jpeg';
const CUSTOM = 'https://crazybatto.de/assets/control/dragon-gold-welcome.png';
const activeSlots = (override = {}) => defaultSlots().map((slot, index) => index ? slot : { ...slot, enabled: true, username: 'fixture_live', channelId: CHANNEL, roleId: ROLE, ...override });
const live = (override = {}) => ({ status: 'live', roomId: ROOM, startedAt: new Date(START - 60000).toISOString(), name: 'Fixture Creator', ...override });
const offline = () => ({ status: 'offline', roomId: null, startedAt: null, name: 'Fixture Creator' });
function memoryStore() {
  const values = new Map(), writes = [];
  return { values, writes, setting: key => values.get(key), setSetting(key, value) { values.set(key, value); writes.push([key, value]); }, transaction(fn) {
    const before = new Map(values); const count = writes.length;
    try { return fn(); } catch (error) { values.clear(); for (const [key, value] of before) values.set(key, value); writes.length = count; throw error; }
  } };
}
function fixture(options = {}) {
  let now = START;
  const store = options.store || memoryStore();
  if (!store.setting(SETTINGS)) store.values.set(SETTINGS, JSON.stringify(options.slots || activeSlots()));
  const calls = [], adminCalls = [], lookups = [];
  const context = { session: 'fixture-session-not-real', user: { id: 'fixture-admin' } };
  const f = { store, calls, adminCalls, lookups, context, valid: true, current: live(), channelGuild: GUILD, channelType: 0, advance: millis => { now += millis; }, now: () => now };
  const service = {
    config: { discordGuildId: GUILD },
    accounts: { store, assertCurrent(value, rights) { assert.equal(value, context); assert.deepEqual(rights, { admin: true }); if (!f.valid) throw new AppError('forbidden', 'Test session revoked.', 403); } },
    discordControl: { async admin() { return { client: { async request(method, route) {
      adminCalls.push({ method, route });
      await options.onAdmin?.(f, method, route);
      if (route === `/guilds/${GUILD}/channels`) return [{ id: CHANNEL, guild_id: GUILD, type: f.channelType }];
      if (route === `/guilds/${GUILD}/roles`) return [{ id: ROLE }, { id: GUILD }];
      throw new Error('Unexpected fixture admin route.');
    } } }; } },
    discord: { async request(method, route, data) {
      calls.push({ method, route, ...(data ? structuredClone(data) : {}) });
      const overridden = await options.onDiscord?.(f, method, route, data);
      if (overridden !== undefined) return overridden;
      if (method === 'GET' && route.startsWith('/channels/')) return { id: route.slice('/channels/'.length), guild_id: f.channelGuild, type: f.channelType };
      if (method === 'POST') return { id: MESSAGE, channel_id: CHANNEL };
      if (method === 'PATCH') return { id: MESSAGE, channel_id: CHANNEL };
      throw new Error('Unexpected fixture Discord route.');
    } },
    moderation: new Proxy({}, { get() { throw new Error('TikTok must not access moderation.'); } })
  };
  f.service = service;
  f.lookup = async (...args) => { lookups.push(args); return options.lookup ? options.lookup(f, ...args) : structuredClone(f.current); };
  f.model = new TikTokLive(service, { now: f.now, lookup: f.lookup });
  f.slot = () => f.model.settings()[0];
  f.record = () => JSON.parse(store.setting(RUNTIME) || '{}')['1'];
  f.poll = async () => { f.model.running = true; return f.model.enqueue(() => f.model.checkSlot(f.slot(), true)); };
  f.restart = () => { f.model = new TikTokLive(service, { now: f.now, lookup: f.lookup }); };
  return f;
}

test('slots enforce exactly 20 stable IDs, strict fields, usernames and unique enabled accounts', () => {
  const slots = activeSlots({ username: '@Fixture.Live' });
  assert.equal(validateSlots(slots)[0].username, 'fixture.live');
  assert.equal(defaultSlots().length, 20);
  for (const value of [null, {}, slots.slice(1), [...slots, defaultSlots()[0]]]) assert.throws(() => validateSlots(value));
  for (const change of [{ id: '2' }, { enabled: 'yes' }, { username: 'https://127.0.0.1/' }, { username: 'user/name' }, { username: 'a'.repeat(25) }, { channelId: '../channels' }, { roleId: 'invalid' }, { title: '' }, { imageUrl: 'http://example.test/image.png' }, { imageUrl: 'https://user:password@example.test/image.png' }, { cookie: 'fixture' }, { moderation: { ban: true } }]) {
    assert.throws(() => validateSlots(activeSlots(change)), JSON.stringify(change));
  }
  const duplicate = activeSlots(); duplicate[1] = { ...duplicate[0], id: '2', username: 'FIXTURE_LIVE' };
  assert.throws(() => validateSlots(duplicate), /nur einmal/);
  duplicate[1].enabled = false; assert.equal(validateSlots(duplicate).length, 20);
});

test('status parser recognizes explicit live/offline states and preserves verified start time', () => {
  const started = Math.floor((START - 120000) / 1000);
  const positive = parseTikTokStatus({ statusCode: 0, data: { user: { roomId: ROOM, nickname: 'Fixture' }, liveRoom: { status: 2, createTime: started } } }, START);
  assert.deepEqual(positive, { status: 'live', roomId: ROOM, name: 'Fixture', startedAt: new Date(started * 1000).toISOString(), coverUrl: null, avatarUrl: null });
  assert.equal(parseTikTokStatus({ status_code: 0, data: { user: { status: 4, roomId: ROOM } } }, START).status, 'offline');
  assert.equal(parseTikTokStatus({ data: { user: { status: 0, roomId: '0' } } }, START).status, 'offline');
  for (const created of [undefined, 'bad', START / 1000 + 100, START / 1000 - 8 * 86400]) {
    assert.equal(parseTikTokStatus({ data: { user: { roomId: ROOM }, liveRoom: { status: 2, createTime: created } } }, START).startedAt, null);
  }
  for (const value of [null, {}, { statusCode: 403, data: { user: { status: 4 } } }, { data: { user: {} } }, { data: { user: { status: 2, roomId: '0' } } }, { data: { user: { status: 1, roomId: ROOM } } }]) assert.throws(() => parseTikTokStatus(value, START));
});

test('preview parser reads supplied optional room covers and profile avatars without inventing a stream frame', () => {
  for (const image of [{ coverUrl: COVER }, { cover: { url_list: ['https://evil.example/image.jpg', COVER] } }, { cover: { urlList: [COVER] } }, { cover_url: COVER }, { coverUrl: '', squareCoverImg: COVER }]) {
    const parsed = parseTikTokStatus({ data: { user: { status: 2, roomId: ROOM, avatarLarger: AVATAR }, liveRoom: image } }, START);
    assert.equal(parsed.coverUrl, COVER); assert.equal(parsed.avatarUrl, AVATAR);
  }
  const avatarOnly = parseTikTokStatus({ data: { user: { status: 2, roomId: ROOM, avatar_medium: { url_list: [AVATAR] } } } }, START);
  assert.equal(avatarOnly.coverUrl, null); assert.equal(avatarOnly.avatarUrl, AVATAR);
  const missing = parseTikTokStatus({ data: { user: { status: 2, roomId: ROOM } } }, START);
  assert.equal(missing.coverUrl, null); assert.equal(missing.avatarUrl, null);
});

test('TikTok image URLs reject foreign hosts, credentials, IPs, unsafe schemes, ports and video resources', () => {
  assert.equal(tiktokImageUrl(COVER), COVER); assert.equal(tiktokImageUrl(AVATAR), AVATAR);
  for (const value of [null, {}, '', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///fixture.jpg', 'http://p16.tiktokcdn.com/a.jpg', 'https://tiktokcdn.com.evil.example/a.jpg', 'https://evil-tiktokcdn.com/a.jpg', 'https://tiktokcdn.com@evil.example/a.jpg', 'https://user:pass@p16.tiktokcdn.com/a.jpg', 'https://p16.tiktokcdn.com:8443/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://localhost/a.jpg', 'https://p16.tiktokcdn.com/a.jpg#fragment', 'https://p16.tiktokcdn.com/a\n.jpg', 'https://p16.tiktokcdn.com\\@evil.example/a.jpg', 'https://p16.tiktokcdn.com/live.m3u8', 'https://p16.tiktokcdn.com/live.mp4', 'https://p16.tiktokcdn.com/live%2emp4', 'https://p16.tiktokcdn.com/live.webm', 'https://p16.tiktokcdn.com/'+'x'.repeat(2048)]) assert.equal(tiktokImageUrl(value), null, String(value));
  const parsed = parseTikTokStatus({ data: { user: { status: 2, roomId: ROOM, avatarLarger: 'https://evil.example/avatar.jpg' }, liveRoom: { coverUrl: 'https://127.0.0.1/cover.jpg' } } }, START);
  assert.equal(parsed.coverUrl, null); assert.equal(parsed.avatarUrl, null);
  for (const imageUrl of ['https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://example.com:8443/a.png', 'https://example.com/live.mp4']) assert.throws(() => validateSlots(activeSlots({ imageUrl })));
});

test('preview source priority and labels distinguish cover, design fallback, avatar and missing image', () => {
  const slot = activeSlots({ imageUrl: CUSTOM })[0];
  const cover = tiktokPreview(slot, live({ coverUrl: COVER, avatarUrl: AVATAR })); assert.equal(cover.preview.kind, 'live-cover'); assert.equal(cover.preview.imageUrl, COVER); assert.match(cover.preview.label, /Standbild, kein Live-Video/);
  const design = tiktokPreview(slot, live({ avatarUrl: AVATAR })); assert.equal(design.preview.kind, 'custom-image'); assert.equal(design.preview.imageUrl, CUSTOM); assert.match(design.preview.label, /Ersatzbild/);
  const avatar = tiktokPreview({ ...slot, imageUrl: '' }, live({ avatarUrl: AVATAR })); assert.equal(avatar.preview.kind, 'creator-avatar'); assert.match(avatar.preview.label, /Profilbild.*kein Livebild/);
  assert.equal(tiktokPreview({ ...slot, imageUrl: '' }, live()).preview.kind, 'unavailable');
  assert.match(tiktokPreview(slot, { ...offline(), coverUrl: COVER }).preview.label, /^Letztes/);
  assert.match(tiktokPreview(slot, { status: 'error', coverUrl: COVER }).preview.label, /^Letztes/);
});

test('actual notification prefers TikTok cover, adds canonical stream button and no video field', async () => {
  const f = fixture({ slots: activeSlots({ imageUrl: CUSTOM }) }); f.current = live({ coverUrl: COVER, avatarUrl: AVATAR }); await f.poll();
  const payload = f.calls.find(c => c.method === 'POST').payload, embed = payload.embeds[0];
  assert.equal(embed.image.url, COVER); assert.equal(embed.thumbnail.url, AVATAR); assert.equal(embed.url, 'https://www.tiktok.com/@fixture_live/live');
  assert.equal(payload.components[0].components[0].url, embed.url); assert.match(embed.footer.text, /Standbild, kein Live-Video/);
  assert.equal(embed.video, undefined); assert.equal(embed.provider, undefined);
  assert(f.calls.every(c => c.route.startsWith('/channels/'))); assert.equal(f.lookups.length, 1);
});

test('manual check exposes safe preview state while never publishing a live message', async () => {
  const f = fixture(); f.current = live({ coverUrl: COVER, avatarUrl: AVATAR, liveUrl: 'https://evil.example/', preview: { kind: 'video', imageUrl: 'file:///bad' } }); f.model.running = true;
  const result = await f.model.run(f.context, 'tiktok.check', { slotId: '1' });
  assert.equal(result.runtime[0].coverUrl, COVER); assert.equal(result.runtime[0].avatarUrl, AVATAR); assert.equal(result.runtime[0].preview.kind, 'live-cover'); assert.equal(result.runtime[0].liveUrl, 'https://www.tiktok.com/@fixture_live/live'); assert.equal(f.calls.length, 0);
  f.restart(); assert.equal(f.model.state().runtime[0].preview.imageUrl, COVER);
});

test('new room without a supplied cover never inherits the previous live cover', async () => {
  const f = fixture(); f.current = live({ coverUrl: COVER, avatarUrl: AVATAR }); await f.poll();
  f.current = live({ roomId: NEXT_ROOM, coverUrl: null, avatarUrl: null }); f.advance(300000); await f.poll();
  assert.equal(f.record().coverUrl, null); assert.equal(f.model.state().runtime[0].preview.kind, 'creator-avatar');
  const posted = f.calls.filter(c => c.method === 'POST').at(-1).payload;
  assert.equal(posted.embeds[0].image.url, AVATAR); assert.match(posted.embeds[0].footer.text, /Profilbild.*kein Livebild/);
});

test('changed cover refreshes Control Center state without editing Discord or another role ping', async () => {
  const f = fixture(); f.current = live({ coverUrl: COVER }); await f.poll();
  const changed = COVER.replace('fixture-cover', 'fresh-cover'); f.current = live({ coverUrl: changed }); f.advance(300000); await f.poll();
  assert.equal(f.model.state().runtime[0].preview.imageUrl, changed); assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  f.restart(); f.advance(300000); await f.poll(); assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
});

test('manual preview refresh and later lookup errors retain honestly labeled last images without Discord edits', async () => {
  const f = fixture(); f.current = live({ coverUrl: COVER }); await f.poll();
  const changed = COVER.replace('fixture-cover', 'fresh-cover'); f.current = live({ coverUrl: changed }); f.advance(300000); await f.model.run(f.context, 'tiktok.check', { slotId: '1' }); assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0);
  f.model.lookup=async()=>{throw new Error('TikTok schränkt die Abfrage ein.');}; await f.poll(); assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0); assert.equal(f.model.state().runtime[0].status,'error'); assert.equal(f.model.state().runtime[0].preview.imageUrl,changed); assert.match(f.model.state().runtime[0].preview.label,/^Letztes/);
});

test('lookup uses only the fixed HTTPS TikTok endpoint, no authentication, cookies or redirects', async () => {
  const calls = [];
  const result = await fetchTikTokStatus('fixture_live', { now: () => START, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: { user: { status: 2, roomId: ROOM } } }));
  } });
  assert.equal(result.status, 'live');
  const url = new URL(calls[0].url), options = calls[0].options;
  assert.equal(url.origin, 'https://www.tiktok.com'); assert.equal(url.pathname, '/api-live/user/room/');
  assert.equal(url.searchParams.get('uniqueId'), 'fixture_live');
  assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(new Headers(options.headers).has('cookie'), false);
  assert.equal(new Headers(options.headers).has('authorization'), false);
  assert.equal(options.body, undefined);
  for (const name of ['https://evil.test', '127.0.0.1:80', '//evil.test', 'user?source=http://localhost', 'user\nCookie:value']) await assert.rejects(fetchTikTokStatus(name, { fetchImpl: () => { throw new Error('Must not be called.'); } }));
  assert.equal(calls.length, 1);
});

test('refused, throttled, invalid and oversized responses remain errors rather than offline', async () => {
  for (const status of [403, 429, 500]) {
    let canceled = false;
    await assert.rejects(fetchTikTokStatus('fixture_live', { fetchImpl: async () => ({ ok: false, status, body: { cancel: async () => { canceled = true; } } }) }));
    assert.equal(canceled, true);
  }
  for (const body of ['<html>Access denied</html>', JSON.stringify({ statusCode: 10221 }), 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(fetchTikTokStatus('fixture_live', { fetchImpl: async () => new Response(body) }));
  }
  await assert.rejects(fetchTikTokStatus('fixture_live', { fetchImpl: async () => { throw new Error('fixture-private-token'); } }), error => !error.message.includes('fixture-private-token'));
});

test('saving verifies channel type, channel membership, role membership and guild fence', async () => {
  const f = fixture();
  await f.model.run(f.context, 'tiktok.save', { slots: activeSlots(), guildId: GUILD });
  assert.deepEqual(f.adminCalls.map(call => call.route), [`/guilds/${GUILD}/channels`, `/guilds/${GUILD}/roles`]);
  assert.equal(f.calls.length, 0);
  for (const slots of [activeSlots({ channelId: OTHER_CHANNEL }), activeSlots({ roleId: GUILD }), activeSlots({ roleId: OTHER_CHANNEL })]) await assert.rejects(f.model.run(f.context, 'tiktok.save', { slots }));
  f.channelType = 2;
  await assert.rejects(f.model.run(f.context, 'tiktok.save', { slots: activeSlots() }), /Textkanal/);
  const before = f.adminCalls.length;
  for (const action of ['tiktok.state', 'tiktok.save', 'tiktok.check']) await assert.rejects(f.model.run(f.context, action, { guildId: OTHER_GUILD, slots: activeSlots(), slotId: '1' }));
  assert.equal(f.adminCalls.length, before);
  assert.equal(f.lookups.length, 0);
});

test('manual checks never send or edit Discord messages even while background service is running', async () => {
  const f = fixture(); f.model.running = true;
  const result = await f.model.run(f.context, 'tiktok.check', { slotId: '1' });
  assert.equal(result.runtime[0].status, 'live'); assert.equal(f.calls.length, 0);
  await assert.rejects(f.model.run(f.context, 'tiktok.check', { slotId: '1' }), /30 Sekunden/);
  assert.equal(f.lookups.length, 1);
  f.store.values.set(RUNTIME, JSON.stringify({ 1: { ...live(), messageId: MESSAGE, messageChannelId: CHANNEL, attemptedRoom: ROOM, startedAt: new Date(START - 60000).toISOString() } }));
  f.current = offline(); f.advance(30000);
  await f.model.run(f.context, 'tiktok.check', { slotId: '1' });
  assert.equal(f.record().status, 'offline'); assert.equal(f.calls.length, 0);
});

test('live notification is reserved durably before POST and sent only once across repeated checks and restart', async () => {
  const f = fixture({ onDiscord(f, method) {
    if (method === 'POST') { assert.equal(f.record().attemptedRoom, ROOM); assert.equal(f.record().delivery, 'sending'); }
  } });
  await f.poll();
  assert.equal(f.record().delivery, 'sent'); assert.equal(f.record().messageId, MESSAGE);
  const posted = f.calls.find(call => call.method === 'POST').payload;
  assert.equal(posted.enforce_nonce, true); assert.match(posted.nonce, /^[a-f0-9]{24}$/);
  assert.deepEqual(posted.allowed_mentions, { parse: [], roles: [ROLE], users: [], replied_user: false });
  assert.equal(posted.content, `<@&${ROLE}>`);
  f.advance(300000); await f.poll();
  f.restart(); f.advance(300000); await f.poll();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('ambiguous Discord delivery is shown and never automatically retried, including after restart', async () => {
  const f = fixture({ onDiscord(_f, method) { if (method === 'POST') throw new Error('fixture request lost after possible delivery'); } });
  await f.poll(); assert.equal(f.record().delivery, 'uncertain'); assert.equal(f.record().messageId, null);
  assert.match(f.record().error, /nicht automatisch doppelt/);
  f.restart(); f.advance(300000); await f.poll();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('missing, invalid or mismatched Discord delivery confirmation is never treated as sent', async () => {
  for (const response of [{}, { id: 'bad' }, { id: MESSAGE, channel_id: OTHER_CHANNEL }]) {
    const f = fixture({ onDiscord(_f, method) { if (method === 'POST') return response; } });
    await f.poll(); assert.equal(f.record().delivery, 'uncertain'); assert.equal(f.record().messageId, null);
    f.restart(); await f.poll(); assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  }
});

test('channel guild and type are rechecked immediately before live announcement', async () => {
  for (const change of [{ channelGuild: OTHER_GUILD }, { channelType: 2 }]) {
    const f = fixture(); Object.assign(f, change); await f.poll();
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
    assert.equal(f.record().delivery, 'uncertain');
  }
});

test('offline transition updates the original announcement once and fences the saved channel', async () => {
  const f = fixture(); await f.poll(); f.current = offline(); f.advance(120000); await f.poll();
  assert.equal(f.record().endedAt, new Date(f.now()).toISOString());
  const patch = f.calls.find(call => call.method === 'PATCH');
  assert.equal(patch.route, `/channels/${CHANNEL}/messages/${MESSAGE}`);
  assert.deepEqual(patch.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.equal(patch.payload.content, ''); assert.match(patch.payload.embeds[0].title, /beendet/);
  f.advance(300000); await f.poll(); f.restart(); await f.poll();
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1);
  const other = fixture(); await other.poll(); other.channelGuild = OTHER_GUILD; other.current = offline(); await other.poll();
  assert.equal(other.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.match(other.record().error, /nicht aktualisiert/);
});

test('new room clears an old ended marker and receives its own single offline update', async () => {
  const f = fixture(); await f.poll(); f.current = offline(); f.advance(60000); await f.poll();
  assert.ok(f.record().endedAt);
  f.current = live({ roomId: NEXT_ROOM, startedAt: new Date(f.now()).toISOString() });
  f.advance(300000); await f.poll(); assert.equal(f.record().endedAt, null); assert.equal(f.record().attemptedRoom, NEXT_ROOM);
  f.current = offline(); f.advance(180000); await f.poll();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 2);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 2);
});

test('lookup failure preserves previous stream identity and records error rather than pretending it ended', async () => {
  const f = fixture({ lookup(f) { if (f.failLookup) throw new Error('TikTok schränkt die Abfrage ein.'); return f.current; } });
  await f.poll(); f.failLookup = true; f.advance(300000); await f.poll();
  assert.equal(f.record().status, 'error'); assert.equal(f.record().roomId, ROOM); assert.equal(f.record().messageId, MESSAGE);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.match(f.record().error, /schränkt/);
});

test('unverified start is labeled as estimated and remains stable through later checks', async () => {
  const f = fixture(); f.current = live({ startedAt: null }); await f.poll();
  const first = f.record().startedAt; assert.equal(first, new Date(START).toISOString()); assert.equal(f.record().startEstimated, true);
  assert.equal(f.calls.find(call => call.method === 'POST').payload.embeds[0].fields[0].name, 'Live erkannt');
  f.advance(300000); await f.poll(); assert.equal(f.record().startedAt, first);
});

test('session revocation during either a successful or failed manual lookup prevents persistence', async () => {
  for (const failLookup of [false, true]) {
    const f = fixture({ lookup(f) { f.valid = false; if (failLookup) throw new Error('fixture lookup failed'); return live(); } });
    const before = f.store.writes.length;
    await assert.rejects(f.model.run(f.context, 'tiktok.check', { slotId: '1' }), /revoked/);
    assert.equal(f.store.writes.length, before); assert.equal(f.calls.length, 0);
  }
});

test('session revocation during save prevents the entire settings transaction', async () => {
  const f = fixture({ onAdmin(f, _method, route) { if (route.endsWith('/roles')) f.valid = false; } });
  const original = f.store.setting(SETTINGS);
  await assert.rejects(f.model.run(f.context, 'tiktok.save', { slots: activeSlots({ title: 'Must not persist' }) }), /revoked/);
  assert.equal(f.store.setting(SETTINGS), original); assert.equal(f.store.writes.length, 0);
});

test('unknown moderation commands, unprivileged sessions and payload injection cannot change TikTok state', async () => {
  const f = fixture();
  for (const [action, payload] of [['moderation.ban', {}], ['tiktok.save', { slots: activeSlots(), moderation: true }], ['tiktok.check', { slotId: '1', cookie: 'fixture-only' }]]) await assert.rejects(f.model.run(f.context, action, payload));
  f.valid = false;
  await assert.rejects(f.model.run(f.context, 'tiktok.state'));
  assert.equal(f.calls.length, 0); assert.equal(f.adminCalls.length, 0); assert.equal(f.lookups.length, 0); assert.equal(f.store.writes.length, 0);
});

test('background scheduler is idempotent, polls one account no faster than 300 seconds and stops cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.current = offline();
  t.after(async () => { await f.model.stop(); });
  const tick = async ms => { f.advance(ms); t.mock.timers.tick(ms); await f.model.queue; await Promise.resolve(); };
  f.model.start(); const firstTimer = f.model.timer; f.model.start(); assert.equal(f.model.timer, firstTimer);
  await tick(15000); assert.equal(f.lookups.length, 1);
  for (let index = 0; index < 19; index++) await tick(15000);
  assert.equal(f.lookups.length, 1);
  await tick(15000); assert.equal(f.lookups.length, 2);
  assert.equal(f.calls.length, 0);
  await f.model.stop(); await tick(600000); assert.equal(f.lookups.length, 2);
});

test('background polling covers all 20 enabled slots fairly without issuing a burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slots = defaultSlots().map((slot, index) => ({ ...slot, enabled: true, username: `fixture_${index}`, channelId: CHANNEL }));
  const f = fixture({ slots }); f.current = offline();
  t.after(async () => { await f.model.stop(); });
  f.model.start();
  for (let index = 0; index < 20; index++) { f.advance(15000); t.mock.timers.tick(15000); await f.model.queue; await Promise.resolve(); assert.equal(f.lookups.length, index + 1); }
  assert.deepEqual(f.lookups.map(call => call[0]), slots.map(slot => slot.username));
  assert.equal(f.calls.length, 0);
});
