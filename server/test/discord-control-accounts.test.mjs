import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AccountService } from '../src/accounts.mjs';
import { sha256 } from '../src/store.mjs';
import { createHttpServer } from '../src/http.mjs';
import { DiscordControl, EXPECTED_BOT_ID } from '../src/discord-control.mjs';
import { DiscordClient } from '../src/discord-control-lib/discord-client.cjs';
import { SETUP_PANEL_ACTIONS } from '../src/setup-panel.mjs';
import { JOIN_ROLE_ACTIONS } from '../src/join-role.mjs';
import { EXTRA_ACTIONS } from '../src/control-extras.mjs';

const ORIGIN = 'https://crazybatto.test';
const GUILD = '900000000000000018';
const TEST_BOT_TOKEN = 'fixture-only-no-real-discord-token-000000';
const NEW_ACTIONS = [...SETUP_PANEL_ACTIONS, ...JOIN_ROLE_ACTIONS];

function moduleFixtures(f) {
  const calls = [];
  for (const [name, target] of [['panel', 'setupPanel'], ['join', 'autoJoinRole'], ['gallery', 'gamingSetups']]) {
    f.service[target] = { async run(context, action, payload) {
      f.accounts.assertCurrent(context, { admin: true });
      calls.push({ name, action, accountId: context.user.id, payload: structuredClone(payload) });
      return { module: name, action, expectedRevision: payload.expectedRevision ?? null };
    } };
  }
  return calls;
}

const newActionBody = action => ({ action, payload: { guildId: GUILD, ...(action.endsWith('.state') ? {} : { expectedRevision: 0, confirm: true }),
  ...(action === 'setup.panel.save' ? { settings: { channelId: '', title: 'Eure Gaming Setups', description: 'Nach Admin-Freigabe', imageUrl: '', buttonLabel: 'Setup einreichen' } } : {}),
  ...(action === 'joinrole.save' ? { settings: { enabled: false, roleId: '' } } : {}) } });

function setup(t, { admin = true, kind = 'native', onDiscord } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crazybatto-control-account-test-'));
  const now = Date.now(), accountId = crypto.randomUUID();
  const identityUser = { id: accountId, email: 'admin@example.test', email_confirmed_at: new Date(now).toISOString(), user_metadata: { name: 'Fixture Admin' } };
  const config = { dataDir: directory, encryptionKey: crypto.randomBytes(32), publicOrigin: ORIGIN,
    clientId: EXPECTED_BOT_ID, discordGuildId: GUILD, botToken: TEST_BOT_TOKEN, musicStorageUrl: '', musicStorageToken: '' };
  const accounts = new AccountService(config, {
    identity: { configured: true, async user() { return identityUser; }, async logout() {} },
    now: () => now, storage: { configured: false }, imageStorage: { configured: false },
  });
  accounts.mirror(accounts.identityUser(identityUser), true);
  accounts.store.run('UPDATE accounts SET is_admin=? WHERE id=?', admin ? 1 : 0, accountId);
  const accountToken = 'A'.repeat(48), csrf = 'fixture-csrf-value';
  accounts.store.run('INSERT INTO account_sessions VALUES (?,?,?,?,?,?,?)', sha256(accountToken), accountId, kind, csrf,
    JSON.stringify(accounts.vault.seal({ accessToken: 'fixture-access-value', refreshToken: 'fixture-refresh', expiresAt: now + 3600000 })), now + 86400000, now);
  const calls = [];
  class FixtureDiscord extends DiscordClient {
    async perform(method, route, body) {
      calls.push({ method, route });
      if (onDiscord) onDiscord(accounts, method, route);
      if (route === '/users/@me') return { id: EXPECTED_BOT_ID, username: 'Crazy_Batto', discriminator: '8744', bot: true };
      if (route === '/guilds/' + GUILD) return { id: GUILD, name: body?.name || 'Fixture Community' };
      throw new Error('Unexpected fixture route');
    }
  }
  const service = { accounts, config };
  const control = new DiscordControl(service, { Client: FixtureDiscord });
  t.after(() => {
    accounts.close();
    const resolved = path.resolve(directory);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'crazybatto-control-account-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  async function call(method, endpoint, body, override = {}) {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url: '/api/admin/discord-control/' + endpoint, socket: { remoteAddress: 'test' }, headers: {
      ...(kind === 'native' ? { authorization: 'Bearer ' + accountToken, 'x-client-type': 'native' } : { cookie: '__Host-cb_account=' + accountToken, origin: ORIGIN, 'x-csrf-token': csrf }),
      ...(body ? { 'content-type': 'application/json' } : {}), ...override,
    } });
    const res = { status: 0, writeHead(status, headers) { this.status = status; this.headers = headers; }, end(raw) { this.raw = raw; this.body = JSON.parse(raw); this.writableEnded = true; } };
    assert.equal(await control.handle(req, res), true);
    return res;
  }
  return { accounts, accountId, calls, call, control, config, service, csrf, accountToken };
}

test('real Website AccountService and HTTP module import without starting a server', () => {
  assert.equal(typeof createHttpServer, 'function');
  assert.equal(typeof AccountService.prototype.authenticateRequest, 'function');
  assert.equal(typeof AccountService.prototype.assertCurrent, 'function');
  assert.equal(typeof AccountService.prototype.authorizeAdmin, 'function');
});

test('all extra actions route through the real admin session and are advertised once', async t => {
  const f=setup(t),calls=[];
  f.service.controlExtras={async run(context,action,payload){f.accounts.assertCurrent(context,{admin:true});calls.push({action,payload});return{action};}};
  const caps=await f.call('GET','capabilities');
  for(const action of EXTRA_ACTIONS){assert.equal(caps.body.actions.filter(item=>item===action).length,1);const response=await f.call('POST','action',{action,payload:{guildId:GUILD}});assert.equal(response.status,200);assert.equal(response.body.result.action,action);}
  assert.equal(calls.length,4);assert.equal(f.calls.length,0);
  f.accounts.store.run('UPDATE accounts SET is_admin=0');
  for(const action of EXTRA_ACTIONS)assert.equal((await f.call('POST','action',{action,payload:{guildId:GUILD}})).status,403);
  assert.equal(calls.length,4);
});

test('extra actions require real browser CSRF, origin and current session even while queued', async t => {
  const f=setup(t,{kind:'browser'});let calls=0;
  f.service.controlExtras={async run(context){f.accounts.assertCurrent(context,{admin:true});calls++;return{};}};
  for(const action of EXTRA_ACTIONS){const body={action,payload:{guildId:GUILD}};assert.equal((await f.call('POST','action',body,{'x-csrf-token':''})).status,403);assert.equal((await f.call('POST','action',body,{origin:'https://evil.test'})).status,403);}
  let release;f.control.queue=new Promise(resolve=>{release=resolve;});
  const response=f.call('POST','action',{action:'extras.audio.send',payload:{guildId:GUILD}});
  await new Promise(resolve=>setImmediate(resolve));f.accounts.store.run('DELETE FROM account_sessions');release();assert.equal((await response).status,401);assert.equal(calls,0);
});

test('real native session uses decrypted session, confirmed identity, admin flag and unchanged AccountStore', async t => {
  const f = setup(t); const r = await f.call('GET', 'state');
  assert.equal(r.status, 200); assert.equal(r.body.state.bot.id, EXPECTED_BOT_ID);
  assert.ok(!r.raw.includes(TEST_BOT_TOKEN)); assert.ok(!r.raw.includes(f.accountToken));
  assert.equal(f.accounts.store.get('SELECT COUNT(*) AS count FROM accounts').count, 1);
  assert.equal(f.accounts.store.get('SELECT COUNT(*) AS count FROM account_sessions').count, 1);
});

test('real non-admin, suspended and deleted sessions are rejected without Discord calls', async t => {
  const f = setup(t, { admin: false });
  assert.equal((await f.call('GET', 'capabilities')).status, 403);
  f.accounts.store.run('UPDATE accounts SET is_admin=1,suspended=1 WHERE id=?', f.accountId);
  assert.equal((await f.call('GET', 'state')).status, 403);
  f.accounts.store.run('UPDATE accounts SET suspended=0 WHERE id=?', f.accountId);
  f.accounts.store.run('DELETE FROM account_sessions');
  assert.equal((await f.call('GET', 'state')).status, 401);
  assert.equal(f.calls.length, 0);
});

test('real browser CSRF and origin checks reject mutations then permit a valid request', async t => {
  const f = setup(t, { kind: 'browser' });
  const body = { action: 'guild.update', payload: { name: 'Changed Fixture' } };
  assert.equal((await f.call('POST', 'action', body, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.call('POST', 'action', body, { origin: 'https://evil.test' })).status, 403);
  assert.equal(f.calls.length, 0);
  const r = await f.call('POST', 'action', body);
  assert.equal(r.status, 200); assert.equal(r.body.result.name, 'Changed Fixture');
  const audit = f.accounts.store.get("SELECT * FROM account_audit WHERE action='discord.control.guild.update'");
  assert.equal(audit.actor_id, f.accountId);
  const log = f.accounts.store.setting('discord_control_logs');
  assert.ok(log.includes('Server gestaltet')); assert.ok(!log.includes(TEST_BOT_TOKEN));
});

test('real native origin and session-kind restrictions cannot be bypassed', async t => {
  const f = setup(t);
  assert.equal((await f.call('GET', 'state', undefined, { origin: ORIGIN })).status, 403);
  assert.equal((await f.call('GET', 'state', undefined, { cookie: '__Host-cb_account=' + f.accountToken })).status, 403);
  f.accounts.store.run("UPDATE account_sessions SET kind='browser'");
  assert.equal((await f.call('GET', 'state')).status, 401);
  assert.equal(f.calls.length, 0);
});

test('real assertCurrent sees an admin revocation during Discord identity check', async t => {
  const f = setup(t, { onDiscord(accounts, method, route) { if (route === '/users/@me') accounts.store.run('UPDATE accounts SET is_admin=0'); } });
  const r = await f.call('POST', 'action', { action: 'guild.update', payload: { name: 'Never applied' } });
  assert.equal(r.status, 403); assert.deepEqual(f.calls, [{ method: 'GET', route: '/users/@me' }]);
});

test('capabilities advertise exactly the five setup-panel and join-role actions to a real admin session', async t => {
  const f = setup(t), r = await f.call('GET', 'capabilities');
  assert.equal(r.status, 200); assert.equal(NEW_ACTIONS.length, 5);
  for (const action of NEW_ACTIONS) assert.equal(r.body.actions.filter(value => value === action).length, 1, action);
  assert.equal(r.body.modules.setupPanel, true); assert.equal(r.body.modules.autoJoinRole, true); assert.equal(r.body.modules.gamingSetups, true);
  assert(r.body.actions.includes('setup.state')); assert.equal(r.body.botTokenRequiredOnPc, false);
  assert.equal(f.calls.length, 0); assert(!r.raw.includes(TEST_BOT_TOKEN)); assert(!r.raw.includes(f.accountToken));
});

test('all five actions reach their dedicated modules and setup.panel cannot fall through to the setup gallery', async t => {
  const f = setup(t), delegated = moduleFixtures(f);
  for (const action of NEW_ACTIONS) {
    const body = newActionBody(action), r = await f.call('POST', 'action', body);
    assert.equal(r.status, 200, action); assert.equal(r.body.result.module, action.startsWith('setup.panel.') ? 'panel' : 'join');
    assert.equal(delegated.at(-1).accountId, f.accountId); assert.deepEqual(delegated.at(-1).payload, body.payload);
  }
  const gallery = await f.call('POST', 'action', { action: 'setup.state', payload: { guildId: GUILD } });
  assert.equal(gallery.status, 200); assert.equal(gallery.body.result.module, 'gallery');
  assert.deepEqual(delegated.map(row => row.name), ['panel', 'panel', 'panel', 'join', 'join', 'gallery']);
  assert.equal(f.calls.length, 0, 'The generic Discord admin client is not used for these module actions.');
});

test('the five new actions reject missing, non-admin, suspended and deleted real sessions before routing', async t => {
  const f = setup(t, { admin: false }), delegated = moduleFixtures(f);
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action))).status, 403, action);
  f.accounts.store.run('UPDATE accounts SET is_admin=1,suspended=1 WHERE id=?', f.accountId);
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action))).status, 403, action);
  f.accounts.store.run('UPDATE accounts SET suspended=0 WHERE id=?', f.accountId);
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action), { authorization: '' })).status, 401, action);
  f.accounts.store.run('DELETE FROM account_sessions');
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action))).status, 401, action);
  assert.equal(delegated.length, 0); assert.equal(f.calls.length, 0);
});

test('all five browser actions require the real CSRF token and matching origin, including state actions sent over POST', async t => {
  const f = setup(t, { kind: 'browser' }), delegated = moduleFixtures(f);
  for (const action of NEW_ACTIONS) {
    const body = newActionBody(action);
    assert.equal((await f.call('POST', 'action', body, { 'x-csrf-token': '' })).status, 403, action);
    assert.equal((await f.call('POST', 'action', body, { 'x-csrf-token': 'forged-csrf' })).status, 403, action);
    assert.equal((await f.call('POST', 'action', body, { origin: 'https://evil.test' })).status, 403, action);
  }
  assert.equal(delegated.length, 0); assert.equal(f.calls.length, 0);
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action))).status, 200, action);
  assert.equal(delegated.length, 5); assert.equal(f.calls.length, 0);
});

test('wrong guild, secret-bearing payloads and missing implementations cannot fall back to another module', async t => {
  const f = setup(t), delegated = moduleFixtures(f);
  for (const action of NEW_ACTIONS) {
    const body = newActionBody(action);
    assert.equal((await f.call('POST', 'action', { ...body, payload: { ...body.payload, guildId: '900000000000000024' } })).status, 403, action);
    const secret = await f.call('POST', 'action', { ...body, payload: { ...body.payload, botToken: TEST_BOT_TOKEN } });
    assert.equal(secret.status, 400, action); assert(!secret.raw.includes(TEST_BOT_TOKEN));
  }
  delete f.service.setupPanel; delete f.service.autoJoinRole;
  for (const action of NEW_ACTIONS) assert.equal((await f.call('POST', 'action', newActionBody(action))).status, 503, action);
  for (const action of ['setup.panel.delete', 'setup.panel.anything', 'joinrole.grant']) assert.equal((await f.call('POST', 'action', { action, payload: { guildId: GUILD } })).status, 400, action);
  assert.equal(delegated.length, 0); assert.equal(f.calls.length, 0);
});

test('an admin revoked while a new module action waits in the real control queue cannot reach the queued module', async t => {
  const f = setup(t), delegated = moduleFixtures(f);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.service.setupPanel.run = async context => {
    f.accounts.assertCurrent(context, { admin: true }); entered(); await gate;
    f.accounts.assertCurrent(context, { admin: true }); return { reached: true };
  };
  const first = f.call('POST', 'action', newActionBody('setup.panel.state')); await started;
  const queued = f.call('POST', 'action', newActionBody('joinrole.save'));
  for (let turn = 0; turn < 100 && f.control.pending < 2; turn++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.control.pending, 2);
  f.accounts.store.run('UPDATE accounts SET is_admin=0 WHERE id=?', f.accountId); release();
  const [a, b] = await Promise.all([first, queued]);
  assert.equal(a.status, 403); assert.equal(b.status, 403); assert.equal(delegated.length, 0); assert.equal(f.calls.length, 0);
});
