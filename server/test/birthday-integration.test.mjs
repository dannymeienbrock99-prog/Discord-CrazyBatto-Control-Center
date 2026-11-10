import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountService } from '../src/accounts.mjs';
import { BirthdayService } from '../src/birthdays.mjs';
import { BotService, BOT_COMMANDS } from '../src/bot.mjs';
import { createHttpServer } from '../src/http.mjs';
import { AppError } from '../src/errors.mjs';
import { P } from '../src/permissions.mjs';

const ORIGIN = 'https://crazybatto.test';
const PASSWORD = 'birthday-integration-test-only';
const GUILD = '900000000000000031', BOT = '900000000000000032', CHANNEL = '900000000000000033', APP = '900000000000000034', COMMAND = '900000000000000035';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-birthday-integration-'));
  let time = Date.parse('2026-11-09T10:00:00Z'), sequence = 0;
  const state = { registrations: 0, duplicateIdentities: false, discordCalls: [], afterDiscord: null };
  const signing = crypto.generateKeyPairSync('ed25519');
  const config = { dataDir: directory, publicOrigin: ORIGIN, encryptionKey: crypto.randomBytes(32), configured: false,
    botToken: 'test-placeholder-never-used-for-network', discordGuildId: GUILD, clientId: APP,
    discordPublicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    musicStorageUrl: '', musicStorageToken: '', trustProxy: false };
  const users = new Map(), access = new Map(), refresh = new Map();
  const issue = user => {
    const access_token = 'test-access-' + String(++sequence).padStart(16, '0'), refresh_token = 'test-refresh-' + sequence;
    access.set(access_token, user); refresh.set(refresh_token, user);
    return { access_token, refresh_token, expires_in: 3600, user };
  };
  const identity = {
    configured: true,
    async register({ email, name }) {
      state.registrations++;
      if (users.has(email)) return { ...users.get(email), identities: state.duplicateIdentities ? [{ provider: 'email' }] : [] };
      const user = { id: crypto.randomUUID(), email, email_confirmed_at: null, identities: [{ provider: 'email' }], user_metadata: { name } };
      users.set(email, user); return user;
    },
    async login({ email, password }) { if (password !== PASSWORD || !users.has(email)) throw new AppError('auth', 'Anmeldung fehlgeschlagen.', 401); return issue(users.get(email)); },
    async user(token) { if (!access.has(token)) throw new AppError('auth', 'Abgelaufen.', 401); return access.get(token); },
    async refresh(token) { if (!refresh.has(token)) throw new AppError('auth', 'Abgelaufen.', 401); return issue(refresh.get(token)); },
    async logout(token) { access.delete(token); }
  };
  const accounts = new AccountService(config, { identity, now: () => time, storage: { configured: false }, imageStorage: { configured: false } });
  const service = { config, accounts, now: () => time, discord: { request: async (method, route, options) => {
    state.discordCalls.push({ method, route, options });
    if (state.afterDiscord) await state.afterDiscord();
    if (route === '/oauth2/applications/@me') return { id: APP };
    if (route === '/guilds/' + GUILD) return { id: GUILD, name: 'Test', owner_id: '900000000000000026', roles: [{ id: GUILD, permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MENTION_EVERYONE) }] };
    if (route === '/users/@me') return { id: BOT };
    if (route === '/guilds/' + GUILD + '/members/' + BOT) return { user: { id: BOT }, roles: [] };
    if (route === '/guilds/' + GUILD + '/channels') return [{ id: CHANNEL, guild_id: GUILD, type: 0, name: 'geburtstage', permission_overwrites: [] }];
    if (method === 'POST' && route.endsWith('/commands')) return { id: String(BigInt(COMMAND) + BigInt(BOT_COMMANDS.findIndex(command => command.name === options.payload.name))), name: options.payload.name };
    throw new Error('Unexpected stub request: ' + method + ' ' + route);
  } } };
  service.birthdays = new BirthdayService(service, { now: () => time });
  accounts.birthdays = service.birthdays;
  service.botAdmin = new BotService(service, { now: () => time });
  const server = createHttpServer(service, { rateLimits: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await service.birthdays.stop();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    accounts.close();
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cb-birthday-integration-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const call = async (route, { method = 'GET', body, raw, browser, token, headers = {} } = {}) => {
    const response = await fetch(base + route, { method, headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(browser ? { Cookie: browser.cookie, Origin: ORIGIN, 'X-CSRF-Token': browser.csrfToken } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(raw ? { body: raw } : {}) });
    const text = await response.text(); let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
  const signup = (name, extra = {}) => call('/api/account/register', { method: 'POST', headers: { Origin: ORIGIN }, body: { name, email: name.toLowerCase() + '@example.test', password: PASSWORD, birthDate: '1990-11-12', birthdayShared: false, ...extra } });
  const login = async (name, native = false) => {
    const response = await call('/api/account/login', { method: 'POST', headers: native ? { 'X-Client-Type': 'native' } : { Origin: ORIGIN }, body: { email: name.toLowerCase() + '@example.test', password: PASSWORD, ...(native ? { native: true } : {}) } });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return { ...response.data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const confirm = name => { const user = users.get(name.toLowerCase() + '@example.test'); user.email_confirmed_at = new Date(time).toISOString(); return user; };
  const member = async (name = 'Anna', extra = {}) => { assert.equal((await signup(name, extra)).status, 201); confirm(name); return login(name); };
  const sign = data => {
    const bytes = Buffer.from(JSON.stringify(data)), timestamp = String(Math.floor(time / 1000));
    return { raw: bytes, headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': crypto.sign(null, Buffer.concat([Buffer.from(timestamp), bytes]), signing.privateKey).toString('hex') } };
  };
  return { accounts, service, state, users, config, call, signup, login, confirm, member, sign, advance: ms => { time += ms; } };
}

test('actual registration requires birthday and boolean consent before identity call', async t => {
  const f = await fixture(t);
  for (const extra of [{ birthDate: undefined }, { birthDate: '2001-02-29' }, { birthDate: '2027-01-01' }, { birthdayShared: 'true' }]) {
    const response = await f.signup('Anna', extra);
    assert.equal(response.status, 400, JSON.stringify(response.data));
    f.accounts.limits.clear();
  }
  assert.equal(f.state.registrations, 0);
  assert.equal((await f.signup('Anna', { birthdayShared: true, isAdmin: true })).status, 201);
  const row = f.accounts.store.get('SELECT * FROM accounts WHERE email=?', 'anna@example.test');
  assert.equal(row.confirmed, 0); assert.equal(row.is_admin, 0);
  assert.deepEqual(f.service.birthdays.profile(row.id), { birthDate: '1990-11-12', shared: true });
  assert.deepEqual((await f.call('/api/birthdays/calendar')).data.entries, []);
  const denied = await f.call('/api/account/login', { method: 'POST', headers: { Origin: ORIGIN }, body: { email: 'anna@example.test', password: PASSWORD } });
  assert.equal(denied.status, 403);
  f.confirm('Anna'); await f.login('Anna');
  const calendar = await f.call('/api/birthdays/calendar');
  assert.equal(calendar.status, 200);
  assert.deepEqual(calendar.data.entries, [{ name: 'Anna', day: 12, month: 11, nextDate: '2026-11-12', daysUntil: 3 }]);
});

test('duplicate signup cannot overwrite verified or pending profile or visibility', async t => {
  const f = await fixture(t);
  const anna = await f.member('Anna', { birthdayShared: true });
  for (const duplicateIdentities of [false, true]) {
    f.state.duplicateIdentities = duplicateIdentities;
    const duplicate = await f.signup('Mallory', { email: 'anna@example.test', birthDate: '2000-01-01', birthdayShared: false });
    assert.equal(duplicate.status, 201);
    assert.deepEqual(f.service.birthdays.profile(anna.user.id), { birthDate: '1990-11-12', shared: true });
    assert.equal(f.accounts.store.get('SELECT name FROM accounts WHERE id=?', anna.user.id).name, 'Anna');
  }
  f.accounts.limits.clear();
  assert.equal((await f.signup('Pending')).status, 201);
  const id = f.users.get('pending@example.test').id;
  assert.equal((await f.signup('Mallory', { email: 'pending@example.test', birthDate: '2000-01-01', birthdayShared: true })).status, 201);
  assert.deepEqual(f.service.birthdays.profile(id), { birthDate: '1990-11-12', shared: false });
});

test('real browser sessions enforce birthday CSRF, exact origin, own-record edits and immediate privacy withdrawal', async t => {
  const f = await fixture(t), anna = await f.member('Anna'), bea = await f.member('Bea', { birthdayShared: true });
  const body = { birthDate: '1995-12-24', shared: true };
  assert.equal((await f.call('/api/account/birthday')).status, 401);
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', browser: anna, body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', browser: anna, body, headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', browser: anna, body: { ...body, userId: bea.user.id } })).status, 400);
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', browser: anna, body })).status, 200);
  assert.deepEqual(f.service.birthdays.profile(bea.user.id), { birthDate: '1990-11-12', shared: true });
  const calendar = (await f.call('/api/birthdays/calendar')).data;
  assert.equal(calendar.entries.length, 2);
  assert.ok(!JSON.stringify(calendar).includes('1995') && !JSON.stringify(calendar).includes(anna.user.id) && !JSON.stringify(calendar).includes('@example.test'));
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', browser: anna, body: { ...body, shared: false } })).status, 200);
  assert.deepEqual((await f.call('/api/birthdays/calendar')).data.entries.map(entry => entry.name), ['Bea']);
});

test('existing profile editor changes own date while preserving sharing and hides suspended accounts', async t => {
  const f = await fixture(t), anna = await f.member('Anna', { birthdayShared: true });
  const response = await f.call('/api/account/profile', { method: 'PUT', browser: anna, body: { birthDate: '1991-12-24' } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.deepEqual(f.service.birthdays.profile(anna.user.id), { birthDate: '1991-12-24', shared: true });
  assert.equal((await f.call('/api/birthdays/calendar')).data.entries[0].day, 24);
  f.accounts.store.run('UPDATE accounts SET suspended=1 WHERE id=?', anna.user.id);
  assert.deepEqual((await f.call('/api/birthdays/calendar')).data.entries, []);
  assert.equal((await f.call('/api/account/birthday', { browser: anna })).status, 403);
});

test('native sessions cannot become browser mutations and non-admin cannot reach birthday settings', async t => {
  const f = await fixture(t);
  await f.member('Anna'); const native = await f.login('Anna', true);
  const body = { birthDate: '1990-11-12', shared: true };
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', token: native.token, body, headers: { Origin: ORIGIN } })).status, 403);
  assert.equal((await f.call('/api/account/birthday', { method: 'PUT', token: native.token, body })).status, 200);
  for (const route of ['/api/admin/birthdays', '/api/admin/birthdays/channels']) assert.equal((await f.call(route, { token: native.token })).status, 403);
  assert.equal(f.state.discordCalls.length, 0);
});

test('admin mutations require CSRF and recheck actual role after Discord lookup', async t => {
  const f = await fixture(t), admin = await f.member('Admin');
  f.accounts.store.run('UPDATE accounts SET is_admin=1 WHERE id=?', admin.user.id);
  const body = { ...f.service.birthdays.settings(), enabled: true, channelId: CHANNEL };
  assert.equal((await f.call('/api/admin/birthdays', { method: 'PUT', browser: admin, body, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal(f.state.discordCalls.length, 0);
  const saved = await f.call('/api/admin/birthdays', { method: 'PUT', browser: admin, body });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  f.state.afterDiscord = async () => f.accounts.store.run('UPDATE accounts SET is_admin=0 WHERE id=?', admin.user.id);
  assert.equal((await f.call('/api/admin/birthdays', { method: 'PUT', browser: admin, body: { ...body, reminderDays: 7 } })).status, 403);
  assert.equal(f.service.birthdays.settings().reminderDays, 3);
});

test('signed /geburtstage reads same minimal feed and rejects unsigned, altered and foreign-guild requests', async t => {
  const f = await fixture(t);
  await f.member('Anna', { birthdayShared: true }); await f.member('Private');
  f.accounts.store.setSetting('bot_settings', JSON.stringify({ enabled: true, commandIds: { geburtstage: COMMAND }, registeredAt: 1 }));
  const interaction = { application_id: APP, guild_id: GUILD, type: 2, data: { name: 'geburtstage', id: COMMAND, type: 1 } };
  const unsigned = await f.call('/discord/interactions', { method: 'POST', body: interaction });
  assert.equal(unsigned.status, 401);
  const good = await f.call('/discord/interactions', { method: 'POST', ...f.sign(interaction) });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.match(good.data.data.content, /Anna · 12\.11\./);
  assert.doesNotMatch(good.data.data.content, /Private|1990|@example/);
  assert.equal(good.data.data.flags, 64);
  assert.deepEqual(good.data.data.allowed_mentions, { parse: [] });
  const altered = f.sign(interaction); altered.raw = Buffer.from(JSON.stringify({ ...interaction, guild_id: '900000000000000026' }));
  assert.equal((await f.call('/discord/interactions', { method: 'POST', ...altered })).status, 401);
  const foreign = await f.call('/discord/interactions', { method: 'POST', ...f.sign({ ...interaction, guild_id: '900000000000000026' }) });
  assert.doesNotMatch(foreign.data.data.content, /Anna|12\.11/);
});

test('actual bot registration uses per-command upserts and preserves unrelated commands', async t => {
  const f = await fixture(t), admin = await f.member('Admin');
  f.accounts.store.run('UPDATE accounts SET is_admin=1 WHERE id=?', admin.user.id);
  const response = await f.call('/api/admin/bot/commands', { method: 'POST', browser: admin });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const writes = f.state.discordCalls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, BOT_COMMANDS.length);
  assert.ok(writes.every(call => call.method === 'POST' && call.route.endsWith('/commands')));
  assert.ok(writes.some(call => call.options.payload.name === 'geburtstage'));
  assert.ok(!writes.some(call => call.options.payload.name === 'geburtstag'));
});
