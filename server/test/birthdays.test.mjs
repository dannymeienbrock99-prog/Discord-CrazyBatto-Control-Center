import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AccountStore } from '../src/account-store.mjs';
import { MemberProfile } from '../src/member-profile.mjs';
import { AppError } from '../src/errors.mjs';
import { BirthdayService, nextBirthday, berlinTime, birthdayMessage } from '../src/birthdays.mjs';
import { P } from '../src/permissions.mjs';

const GUILD = '900000000000000031', CHANNEL = '900000000000000036', BOT = '900000000000000027', MESSAGE = '900000000000000029';
function setup(t, { now = Date.parse('2026-11-09T09:15:00Z') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'birthday-test-'));
  const store = new AccountStore(dir);
  const state = { now, sends: [], permissions: (P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MENTION_EVERYONE).toString(), calls: [], sendError: null, auth: null, onGet: null };
  const accounts = { store, now: () => state.now, limit() {}, assertCurrent(context, { admin = false } = {}) {
    const row = store.get('SELECT * FROM accounts WHERE id=?', context?.user?.id || '');
    if (!row || row.suspended || !row.confirmed || (admin && !row.is_admin)) throw new AppError('forbidden', 'Kein Zugriff.', 403);
    return { id: row.id, isAdmin: !!row.is_admin };
  }, async authenticateRequest(req, options) {
    state.auth = options;
    if (!req.headers.authorization) throw new AppError('auth', 'Bitte anmelden.', 401);
    const user = { id: req.headers.authorization };
    this.assertCurrent({ user }, { admin: options.requireAdmin });
    if (options.mutation && req.headers['x-csrf-token'] !== 'valid') throw new AppError('csrf', 'Ungültige Anfrage.', 403);
    return { user };
  }, async authorizeAdmin(req) { return this.authenticateRequest(req, { mutation: true, requireAdmin: true }); } };
  accounts.memberProfile = new MemberProfile(accounts);
  const service = { accounts, config: { botToken: 'fake-token', discordGuildId: GUILD, publicOrigin: 'https://crazybatto.de' }, discord: { async request(method, route, options) {
    state.calls.push({ method, route });
    if (method === 'POST') {
      state.sends.push(options.payload);
      if (state.sendError) throw state.sendError;
      return { id: MESSAGE, channel_id: CHANNEL };
    }
    if (state.onGet) await state.onGet(route);
    if (route === '/users/@me') return { id: BOT };
    if (route === '/guilds/' + GUILD) return { id: GUILD, owner_id: '900000000000000037', roles: [{ id: GUILD, permissions: state.permissions }] };
    if (route.endsWith('/members/' + BOT)) return { user: { id: BOT }, roles: [] };
    if (route.endsWith('/channels')) return [{ id: CHANNEL, guild_id: GUILD, type: 0, name: 'geburtstage', permission_overwrites: [] }, { id: '900000000000000012', guild_id: '900000000000000007', type: 0, name: 'fremd' }];
    throw new Error('Unexpected mock request ' + route);
  } } };
  const birthdays = new BirthdayService(service, { now: () => state.now });
  function member(id, date, { confirmed = 1, suspended = 0, admin = 0, shared = false, name = 'Anna' } = {}) {
    store.run('INSERT INTO accounts(id,email,name,confirmed,suspended,is_admin,created_at) VALUES (?,?,?,?,?,?,?)', id, id + '@example.test', name, confirmed, suspended, admin, state.now);
    if (date) birthdays.saveInitialProfile(id, date, shared);
    return { user: { id } };
  }
  function enable(extra = {}) { store.setSetting('birthday_settings_v1', JSON.stringify({ ...birthdays.settings(), enabled: true, channelId: CHANNEL, ...extra })); }
  t.after(async () => { await birthdays.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { birthdays, store, state, service, accounts, member, enable };
}
async function request(birthdays, route, method = 'GET', data, auth, csrf = 'valid') {
  const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []);
  Object.assign(req, { method, url: route, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}), 'x-csrf-token': csrf }, socket: { remoteAddress: 'test' } });
  const response = { status: 0, headers: null, data: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.data = JSON.parse(value); } };
  response.handled = await birthdays.handle(req, response);
  return response;
}

test('existing private profiles never enter the public calendar without consent', t => {
  const { birthdays, member, store } = setup(t);
  member('private', '1990-11-09');
  member('shared', '1988-11-12', { shared: true, name: 'Bea' });
  member('pending', '2001-11-10', { shared: true, confirmed: 0 });
  member('blocked', '2002-11-11', { shared: true, suspended: 1 });
  const calendar = birthdays.calendar();
  assert.deepEqual(calendar.entries, [{ name: 'Bea', day: 12, month: 11, nextDate: '2026-11-12', daysUntil: 3 }]);
  assert.equal(calendar.timezone, 'Europe/Berlin');
  const text = JSON.stringify(calendar);
  assert.ok(!text.includes('1988') && !text.includes('@example') && !text.includes('shared'));
  store.run('DELETE FROM birthday_preferences WHERE user_id=?', 'shared');
  assert.equal(birthdays.calendar().entries.length, 0);
});

test('profile updates validate birth dates and permit revoking public sharing', t => {
  const { birthdays, member } = setup(t);
  const context = member('anna', '1990-11-09');
  assert.throws(() => birthdays.saveProfile(context, { birthDate: '2025-02-29', shared: true }));
  assert.throws(() => birthdays.saveProfile(context, { birthDate: '2027-01-01', shared: true }));
  assert.throws(() => birthdays.saveProfile(context, { birthDate: '1990-01-01', shared: 'true' }));
  birthdays.saveProfile(context, { birthDate: '2000-02-29', shared: true });
  assert.equal(birthdays.calendar().entries.length, 1);
  birthdays.saveProfile(context, { birthDate: '2000-02-29', shared: false });
  assert.equal(birthdays.calendar().entries.length, 0);
});

test('initial signup storage never overwrites an existing date or preference', t => {
  const { birthdays, member } = setup(t);
  member('anna', '1990-11-09');
  birthdays.saveInitialProfile('anna', '2000-05-05', true);
  assert.deepEqual(birthdays.profile('anna'), { birthDate: '1990-11-09', shared: false });
});

test('calendar handles leap days, year rollover and DST in Berlin', () => {
  assert.deepEqual(nextBirthday('2000-02-29', '2027-02-27'), { day: 29, month: 2, nextDate: '2027-02-28', daysUntil: 1 });
  assert.equal(nextBirthday('2000-02-29', '2028-02-28').nextDate, '2028-02-29');
  assert.equal(nextBirthday('1990-01-01', '2026-12-29').daysUntil, 3);
  assert.equal(nextBirthday('1990-01-01', '2026-12-29').nextDate, '2027-01-01');
  assert.equal(nextBirthday('1990-03-29', '2026-03-28').daysUntil, 1);
  assert.equal(berlinTime(Date.parse('2026-07-01T22:30:00Z')).today, '2026-07-02');
  assert.equal(berlinTime(Date.parse('2026-11-08T23:30:00Z')).today, '2026-11-09');
  assert.equal(nextBirthday('2001-02-29', '2026-01-01'), null);
});

test('scheduler sends reminders three days ahead and greeting on birthday once', async t => {
  const { birthdays, member, state, enable } = setup(t);
  member('anna', '1990-11-12', { shared: true }); enable();
  await Promise.all([birthdays.tick(), birthdays.tick()]);
  assert.equal(state.sends.length, 1);
  assert.match(state.sends[0].content, /In 3 Tagen/);
  assert.equal(state.sends[0].enforce_nonce, true);
  await birthdays.tick(); assert.equal(state.sends.length, 1);
  state.now = Date.parse('2026-11-12T09:10:00Z');
  await birthdays.tick(); assert.equal(state.sends.length, 2);
  assert.match(state.sends[1].content, /Alles Gute/);
  await birthdays.tick(); assert.equal(state.sends.length, 2);
});

test('scheduler does nothing before Berlin hour or while disabled', async t => {
  const { birthdays, member, enable, state } = setup(t, { now: Date.parse('2026-11-09T08:59:00Z') });
  member('anna', '1990-11-09', { shared: true });
  await birthdays.tick(); assert.equal(state.sends.length, 0);
  enable(); await birthdays.tick(); assert.equal(state.sends.length, 0);
  state.now += 60_000; await birthdays.tick(); assert.equal(state.sends.length, 1);
});

test('restart catches up same day without repeating a persisted success', async t => {
  const { birthdays, service, member, enable, state } = setup(t);
  member('anna', '1990-11-09', { shared: true }); enable();
  const restarted = new BirthdayService(service, { now: () => state.now });
  await restarted.tick(); assert.equal(state.sends.length, 1);
  const again = new BirthdayService(service, { now: () => state.now });
  await again.tick(); assert.equal(state.sends.length, 1);
  assert.equal(birthdays.adminView().deliveries[0].state, 'sent');
});

test('definitive failure retries after cooldown and is only marked sent after success', async t => {
  const { birthdays, member, enable, state } = setup(t);
  member('anna', '1990-11-09', { shared: true }); enable();
  state.sendError = new AppError('rate_limited', 'Später versuchen.', 429, 1000);
  await birthdays.tick(); assert.equal(birthdays.adminView().deliveries[0].state, 'failed');
  await birthdays.tick(); assert.equal(state.sends.length, 1);
  state.sendError = null; state.now += 16 * 60_000;
  await birthdays.tick(); assert.equal(state.sends.length, 2);
  assert.equal(birthdays.adminView().deliveries[0].state, 'sent');
});

test('uncertain sends and interrupted sending records require explicit resolution', async t => {
  const { birthdays, service, member, enable, state, store } = setup(t);
  member('anna', '1990-11-09', { shared: true }); enable();
  state.sendError = new AppError('uncertain', 'Bestätigung fehlt.', 502);
  await birthdays.tick(); assert.equal(birthdays.status().uncertainCount, 1);
  state.sendError = null; state.now += 60 * 60_000;
  await birthdays.tick(); assert.equal(state.sends.length, 1);
  store.run("UPDATE birthday_deliveries SET state='sending'");
  const restarted = new BirthdayService(service, { now: () => state.now });
  await restarted.tick(); assert.equal(state.sends.length, 1);
  assert.equal(restarted.status().uncertainCount, 1);
  const context = member('admin', '1990-05-05', { admin: 1 });
  restarted.resolveDelivery(context, restarted.adminView().deliveries[0].id, 'mark_sent');
  assert.equal(restarted.status().uncertainCount, 0);
});

test('changing birthday cannot trigger a second annual greeting', async t => {
  const { birthdays, member, enable, state } = setup(t);
  const context = member('anna', '1990-11-09', { shared: true }); enable();
  await birthdays.tick();
  birthdays.saveProfile(context, { birthDate: '1990-11-10', shared: true });
  state.now += 86400_000;
  await birthdays.tick(); assert.equal(state.sends.length, 1);
});

test('withdrawal during channel lookup prevents any send', async t => {
  const { birthdays, member, enable, state } = setup(t);
  const context = member('anna', '1990-11-09', { shared: true }); enable();
  state.onGet = async () => birthdays.saveProfile(context, { birthDate: '1990-11-09', shared: false });
  await birthdays.tick(); assert.equal(state.sends.length, 0);
});

test('missing send rights and foreign channels are rejected without marking delivery', async t => {
  const { birthdays, member, enable, state } = setup(t);
  member('anna', '1990-11-09', { shared: true }); enable();
  state.permissions = P.VIEW_CHANNEL.toString();
  const channels = await birthdays.channelContext();
  assert.equal(channels.channels.length, 1); assert.equal(channels.channels[0].canSend, false);
  await birthdays.tick(); assert.equal(state.sends.length, 0); assert.equal(birthdays.adminView().deliveries.length, 0);
  assert.match(birthdays.status().lastError, /Rechte/);
});

test('messages restrict mentions to explicit everyone mode and never mention a member ID', () => {
  const settings = { greetingTemplate: '{name} @everyone <@900000000000000003> {date} {website}', reminderTemplate: '{days}', mentionMode: 'none' };
  const entry = { name: '@everyone <@900000000000000003> **Anna**', day: 9, month: 11, daysUntil: 0 };
  const plain = birthdayMessage(settings, entry, 'greeting', 'https://crazybatto.de/geburtstage.html');
  assert.deepEqual(plain.allowed_mentions.parse, []);
  assert.ok(!plain.content.includes('<@') && !plain.content.includes('@everyone'));
  const all = birthdayMessage({ ...settings, mentionMode: 'everyone' }, entry, 'greeting', 'https://crazybatto.de/geburtstage.html');
  assert.equal(all.content.match(/@everyone/g).length, 1); assert.deepEqual(all.allowed_mentions.parse, ['everyone']);
});

test('HTTP routes enforce login, admin and mutation CSRF while public output stays minimal', async t => {
  const { birthdays, member, state } = setup(t);
  member('anna', '1990-11-09', { shared: true }); member('admin', '1990-01-01', { admin: 1 });
  assert.equal((await request(birthdays, '/api/birthdays/calendar')).status, 200);
  assert.equal((await request(birthdays, '/api/account/birthday')).status, 401);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'GET', null, 'anna')).status, 403);
  assert.equal((await request(birthdays, '/api/account/birthday', 'PUT', { birthDate: '1990-11-09', shared: false }, 'anna', 'bad')).status, 403);
  assert.equal(state.auth.mutation, true);
  const own = await request(birthdays, '/api/account/birthday', 'GET', null, 'anna');
  assert.deepEqual(own.data, { birthDate: '1990-11-09', shared: true });
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'GET', null, 'admin')).status, 200);
  assert.equal((await request(birthdays, '/api/account/birthday', 'PUT', { birthDate: '1990-11-09', shared: false }, 'anna')).status, 200);
  assert.equal(birthdays.calendar().entries.length, 0);
});

test('settings reject foreign channels, bad templates and excessive advance days', async t => {
  const { birthdays, member } = setup(t);
  member('admin', '1990-01-01', { admin: 1 });
  const settings = { ...birthdays.settings(), channelId: CHANNEL, enabled: true };
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', { ...settings, reminderDays: 31 }, 'admin')).status, 400);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', { ...settings, greetingTemplate: '{age}' }, 'admin')).status, 400);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', { ...settings, channelId: '900000000000000012' }, 'admin')).status, 403);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', settings, 'admin')).status, 200);
  assert.equal(birthdays.settings().enabled, true);
});

test('admin can disable a configured schedule even when Discord is unavailable', async t => {
  const { birthdays, member, enable, state } = setup(t);
  member('admin', '1990-01-01', { admin: 1 }); enable();
  state.onGet = async () => { throw new AppError('network', 'offline', 502); };
  const response = await request(birthdays, '/api/admin/birthdays', 'PUT', { ...birthdays.settings(), enabled: false }, 'admin');
  assert.equal(response.status, 200); assert.equal(response.data.settings.enabled, false);
});

test('optional birthday images are backward compatible and legacy saves preserve existing image settings', async t => {
  const { birthdays, store, member, service, state } = setup(t); member('admin', '1990-01-01', { admin: 1 });
  const { greetingImageUrl, reminderImageUrl, ...legacy } = birthdays.settings();
  assert.equal(greetingImageUrl, ''); assert.equal(reminderImageUrl, '');
  store.setSetting('birthday_settings_v1', JSON.stringify(legacy));
  assert.equal(birthdays.settings().greetingImageUrl, ''); assert.equal(birthdays.settings().reminderImageUrl, '');
  const images = { greetingImageUrl: 'https://crazybatto.de/assets/control/dragon-gold-birthday.png', reminderImageUrl: 'https://crazybatto.de/assets/control/dragon-gold-calendar.png' };
  const saved = await request(birthdays, '/api/admin/birthdays', 'PUT', { ...legacy, ...images }, 'admin');
  assert.equal(saved.status, 200); assert.equal(saved.data.settings.greetingImageUrl, images.greetingImageUrl);
  const restarted = new BirthdayService(service, { now: () => state.now });
  const loaded = await request(restarted, '/api/admin/birthdays', 'GET', null, 'admin');
  assert.equal(loaded.data.settings.reminderImageUrl, images.reminderImageUrl);
  const oldClient = await request(restarted, '/api/admin/birthdays', 'PUT', { ...legacy, hour: 11 }, 'admin');
  assert.equal(oldClient.status, 200); assert.equal(oldClient.data.settings.greetingImageUrl, images.greetingImageUrl); assert.equal(oldClient.data.settings.reminderImageUrl, images.reminderImageUrl);
  const cleared = await request(restarted, '/api/admin/birthdays', 'PUT', { ...oldClient.data.settings, greetingImageUrl: '', reminderImageUrl: '' }, 'admin');
  assert.equal(cleared.status, 200); assert.equal(cleared.data.settings.greetingImageUrl, ''); assert.equal(cleared.data.settings.reminderImageUrl, '');
  assert.equal(state.calls.length, 0);
});

test('birthday image URLs reject credentials, unsafe destinations, malformed input and video links before network calls', async t => {
  const { birthdays, member, state } = setup(t); member('admin', '1990-01-01', { admin: 1 });
  for (const image of [null, 42, {}, 'http://example.com/a.png', 'data:image/png;base64,AAAA', 'file:///picture.png', 'https://user:pass@example.com/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png', 'https://localhost./a.png', 'https://example.local/a.png', 'https://example.local./a.png', 'https://example.com:8443/a.png', 'https://example.com/a.png#fragment', 'https://example.com/a\n.png', 'https://example.com\\a.png', 'https://example.com/video.mp4', 'https://example.com/video%2emp4', 'https://example.com/live.m3u8', 'https://example.com/%invalid', 'https://example.com/' + 'a'.repeat(2048)]) {
    const result = await request(birthdays, '/api/admin/birthdays', 'PUT', { ...birthdays.settings(), enabled: true, channelId: CHANNEL, greetingImageUrl: image }, 'admin');
    assert.equal(result.status, 400, String(image));
  }
  const unknown = await request(birthdays, '/api/admin/birthdays', 'PUT', { ...birthdays.settings(), imageUrl: 'https://example.com/a.png' }, 'admin');
  assert.equal(unknown.status, 400); assert.equal(state.calls.length, 0); assert.equal(birthdays.settings().greetingImageUrl, '');
});

test('automatic greetings and reminders use their own images while preserving consent and mention controls', async t => {
  const { birthdays, member, enable, state } = setup(t);
  member('today', '1990-11-09', { shared: true, name: 'Today' }); member('soon', '1990-11-12', { shared: true, name: 'Soon' }); member('private', '1990-11-09');
  state.permissions = (BigInt(state.permissions) | P.EMBED_LINKS).toString();
  const greeting = 'https://crazybatto.de/assets/control/dragon-gold-birthday.png', reminder = 'https://crazybatto.de/assets/control/dragon-gold-calendar.png';
  enable({ greetingImageUrl: greeting, reminderImageUrl: reminder }); await birthdays.tick();
  assert.equal(state.sends.length, 2);
  assert.equal(state.sends.find(payload => payload.content.includes('Today')).embeds[0].image.url, greeting);
  assert.equal(state.sends.find(payload => payload.content.includes('Soon')).embeds[0].image.url, reminder);
  assert(state.sends.every(payload => payload.allowed_mentions.parse.length === 0));
  assert(state.calls.every(call => call.route.startsWith('/guilds/') || call.route.startsWith('/channels/') || call.route === '/users/@me'));
  await birthdays.tick(); assert.equal(state.sends.length, 2);
});

test('image sends require Embed Links permission but existing text-only birthdays still work', async t => {
  const { birthdays, member, enable, state } = setup(t); member('admin', '1990-01-01', { admin: 1 }); member('today', '1990-11-09', { shared: true });
  const settings = { ...birthdays.settings(), enabled: true, channelId: CHANNEL, greetingImageUrl: 'https://example.com/birthday.png' };
  const denied = await request(birthdays, '/api/admin/birthdays', 'PUT', settings, 'admin'); assert.equal(denied.status, 403); assert.match(denied.data.message, /Links einbetten/);
  enable({ greetingImageUrl: settings.greetingImageUrl }); await birthdays.tick(); assert.equal(state.sends.length, 0); assert.equal(birthdays.adminView().deliveries.length, 0);
  const channels = await request(birthdays, '/api/admin/birthdays/channels', 'GET', null, 'admin'); assert.equal(channels.data.channels[0].canEmbedLinks, false);
  enable({ greetingImageUrl: '' }); await birthdays.tick(); assert.equal(state.sends.length, 1); assert.equal(state.sends[0].embeds, undefined);
});

test('birthday image configuration remains protected by admin, CSRF and revocation checks', async t => {
  const { birthdays, member, state, store } = setup(t); member('member', '1990-01-01'); member('admin', '1990-01-01', { admin: 1 });
  const settings = { ...birthdays.settings(), greetingImageUrl: 'https://example.com/birthday.png' };
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', settings)).status, 401);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', settings, 'member')).status, 403);
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', settings, 'admin', 'bad')).status, 403);
  state.permissions = (BigInt(state.permissions) | P.EMBED_LINKS).toString();
  state.onGet = async () => store.run('UPDATE accounts SET is_admin=0 WHERE id=?', 'admin');
  assert.equal((await request(birthdays, '/api/admin/birthdays', 'PUT', { ...settings, enabled: true, channelId: CHANNEL }, 'admin')).status, 403);
  assert.equal(birthdays.settings().greetingImageUrl, ''); assert.equal(state.sends.length, 0);
});

test('stop drains a pending tick before returning', async t => {
  const { birthdays, member, enable, state } = setup(t);
  member('anna', '1990-11-09', { shared: true }); enable();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  state.onGet = async () => pending;
  const running = birthdays.tick(); let stopped = false;
  const stop = birthdays.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await stop; await running;
  assert.equal(stopped, true); assert.equal(state.sends.length, 0);
});
