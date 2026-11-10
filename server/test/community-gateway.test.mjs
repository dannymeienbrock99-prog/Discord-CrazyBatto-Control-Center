import test from 'node:test';
import assert from 'node:assert/strict';
import { BotGateway, gatewayAddress } from '../src/bot-gateway.mjs';

const BOT = '900000000000000002', GUILD = '900000000000000018', OTHER_GUILD = '900000000000000044';
const USER = '900000000000000045', VOICE = '900000000000000046';
const NOW = Date.UTC(2026, 10, 9, 18);
function fixture(options = {}) {
  let clock = NOW;
  const requests = [], sockets = [], timers = new Set();
  class FixtureSocket {
    constructor(url) { this.url = url; this.listeners = new Map(); this.sent = []; this.readyState = 1; sockets.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code) { this.closedWith = code; this.readyState = 3; }
    packet(data) { this.listeners.get('message')?.({ data: JSON.stringify(data) }); }
    closed(code) { this.readyState = 3; this.listeners.get('close')?.({ code }); }
  }
  const gateway = new BotGateway({ clientId: BOT, discordGuildId: GUILD, botToken: 'fixture-only-bot-token', musicBotEnabled: options.music !== false }, {
    now: () => clock, random: () => 0.5, WebSocketImpl: FixtureSocket,
    setTimer(callback, delay) { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
    fetchImpl: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200, json: async () => ({ url: 'wss://gateway.discord.gg', session_start_limit: { remaining: 10 } }) }; },
    ...(Object.hasOwn(options, 'resolver') ? { intentResolver: options.resolver } : {}),
    ...(options.onDispatch ? { onDispatch: options.onDispatch } : {})
  });
  const hello = socket => socket.packet({ op: 10, d: { heartbeat_interval: 45000 } });
  const ready = socket => socket.packet({ op: 0, t: 'READY', s: 1, d: { application: { id: BOT }, user: { id: BOT, bot: true }, session_id: 'fixture-session', resume_gateway_url: 'wss://gateway.discord.gg' } });
  const connect = async () => { gateway.running = true; await gateway.connect(); const socket = sockets.at(-1); hello(socket); return socket; };
  return { gateway, requests, sockets, timers, connect, hello, ready, advance: ms => { clock += ms; } };
}

test('legacy gateway defaults preserve voice129 and no-music zero intents', async t => {
  for (const [music, expected] of [[true, 129], [false, 0]]) {
    const f = fixture({ music }); t.after(() => f.gateway.stop());
    const socket = await f.connect();
    assert.equal(socket.sent.find(packet => packet.op === 2).d.intents, expected);
    assert.equal(f.requests[0].url, 'https://discord.com/api/v10/gateway/bot');
    assert.equal(f.requests[0].init.redirect, 'error');
  }
});

test('optional member resolver permits exactly129 or131 and safely defaults to voice129', async t => {
  const choices = [129, 131, 0, 2, 32767, '131', undefined, NaN, 'throw'];
  for (const value of choices) {
    const f = fixture({ music: false, resolver: async () => { if (value === 'throw') throw new Error('fixture member lookup failed'); return value; } });
    t.after(() => f.gateway.stop());
    const socket = await f.connect();
    assert.equal(socket.sent.find(packet => packet.op === 2).d.intents, value === 131 ? 131 : 129);
    assert.equal(f.gateway.lastIntents, value === 131 ? 131 : 129);
  }
});

test('session resumption does not request fresh member intent resolution or a second Identify', async t => {
  let resolved = 0;
  const f = fixture({ resolver: async () => { resolved++; return 131; } }); t.after(() => f.gateway.stop());
  const original = await f.connect(); f.ready(original);
  assert.equal(resolved, 1);
  f.gateway.detach();
  await f.gateway.connect(); const resumed = f.sockets.at(-1); f.hello(resumed);
  assert.equal(resolved, 1); assert.equal(f.requests.length, 1);
  assert.equal(resumed.sent.some(packet => packet.op === 2), false);
  assert.equal(resumed.sent.find(packet => packet.op === 6).d.session_id, 'fixture-session');
  resumed.packet({ op: 0, t: 'RESUMED', s: 2, d: {} }); assert.equal(f.gateway.status().ready, true);
});

test('stopping while intent resolution is pending cannot open a socket or send the bot token', async () => {
  let finish;
  const f = fixture({ resolver: () => new Promise(resolve => { finish = resolve; }) });
  f.gateway.running = true; const connecting = f.gateway.connect();
  f.gateway.stop(); finish(131); await connecting;
  assert.equal(f.requests.length, 0); assert.equal(f.sockets.length, 0); assert.equal(f.gateway.status().phase, 'stopped');
});

test('community dispatch exceptions and rejected promises cannot disconnect the music gateway', async t => {
  for (const callback of [() => { throw new Error('fixture synchronous failure'); }, async () => { throw new Error('fixture asynchronous failure'); }]) {
    const f = fixture({ onDispatch: callback, resolver: async () => 129 }); t.after(() => f.gateway.stop());
    const socket = await f.connect(); f.ready(socket);
    socket.packet({ op: 0, t: 'GUILD_MEMBER_ADD', s: 2, d: { guild_id: GUILD, user: { id: USER } } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.gateway.status().ready, true); assert.equal(f.gateway.ws, socket); assert.equal(socket.closedWith, undefined);
  }
});

test('gateway dispatch preserves voice state tracking and the existing music adapter callbacks', async t => {
  const dispatched = [], voiceUpdates = [], serverUpdates = [];
  let destroyed = 0;
  const f = fixture({ onDispatch: packet => dispatched.push(packet), resolver: async () => 129 }); t.after(() => f.gateway.stop());
  const socket = await f.connect(); f.ready(socket);
  const adapter = f.gateway.voiceAdapter(GUILD)({ onVoiceStateUpdate: value => voiceUpdates.push(value), onVoiceServerUpdate: value => serverUpdates.push(value), destroy: () => destroyed++ });
  assert.throws(() => f.gateway.voiceAdapter(OTHER_GUILD));
  socket.packet({ op: 0, t: 'GUILD_CREATE', s: 2, d: { id: GUILD, members: [{ user: { id: USER, username: 'Fixture User' }, nick: 'Fixture Nick' }], voice_states: [{ user_id: USER, channel_id: VOICE, mute: false, self_mute: true }] } });
  assert.equal(f.gateway.voiceChannel(USER), VOICE); assert.equal(f.gateway.voiceMembers()[0].name, 'Fixture Nick');
  const copied = f.gateway.voiceMembers(); copied[0].mute = true; assert.equal(f.gateway.voiceMembers()[0].mute, false);
  socket.packet({ op: 0, t: 'VOICE_STATE_UPDATE', s: 3, d: { guild_id: GUILD, user_id: BOT, channel_id: VOICE, session_id: 'fixture-voice' } });
  socket.packet({ op: 0, t: 'VOICE_SERVER_UPDATE', s: 4, d: { guild_id: GUILD, endpoint: 'fixture-voice.example.test', token: 'fixture-only-voice-token' } });
  assert.equal(voiceUpdates.length, 1); assert.equal(serverUpdates.length, 1);
  assert.equal(adapter.sendPayload({ op: 4, d: { guild_id: GUILD, channel_id: VOICE, self_mute: false, self_deaf: false } }), true);
  assert.equal(socket.sent.at(-1).op, 4);
  socket.packet({ op: 0, t: 'VOICE_STATE_UPDATE', s: 5, d: { guild_id: OTHER_GUILD, user_id: USER, channel_id: null } });
  assert.equal(f.gateway.voiceChannel(USER), VOICE);
  f.gateway.applyVoiceControl(USER, 'mute'); assert.equal(f.gateway.voiceMembers().find(member => member.userId === USER).mute, true);
  f.gateway.applyVoiceControl(USER, 'unmute'); assert.equal(f.gateway.voiceMembers().find(member => member.userId === USER).mute, false);
  f.gateway.applyVoiceControl(USER, 'disconnect'); assert.equal(f.gateway.voiceChannel(USER), null);
  socket.packet({ op: 0, t: 'GUILD_DELETE', s: 6, d: { id: GUILD } });
  assert.equal(destroyed, 1); assert.deepEqual(f.gateway.voiceMembers(), []);
  assert.ok(dispatched.some(packet => packet.t === 'VOICE_STATE_UPDATE'));
});

test('voice state still works for community moderation when the music feature is disabled', async t => {
  const f = fixture({ music: false, resolver: async () => 129, onDispatch: () => {} }); t.after(() => f.gateway.stop());
  const socket = await f.connect(); f.ready(socket);
  socket.packet({ op: 0, t: 'VOICE_STATE_UPDATE', s: 2, d: { guild_id: GUILD, user_id: USER, channel_id: VOICE, member: { user: { username: 'Fixture' } } } });
  assert.equal(f.gateway.voiceChannel(USER), VOICE); assert.equal(f.gateway.voiceMembers()[0].name, 'Fixture');
});

test('members-only4014 rejection falls back once to129 without bypassing the fresh Identify cooldown', async t => {
  const f = fixture({ resolver: async () => 131, onDispatch: () => {} }); t.after(() => f.gateway.stop());
  const socket = await f.connect();
  assert.equal(socket.sent.find(packet => packet.op === 2).d.intents, 131);
  socket.closed(4014);
  assert.equal(f.gateway.running, true); assert.equal(f.gateway.status().membersIntentRejected, true);
  assert.ok(f.gateway.retryTimer.delay >= 300000);
  f.advance(300000); await f.gateway.connect(); const fallback = f.sockets.at(-1); f.hello(fallback);
  assert.equal(fallback.sent.find(packet => packet.op === 2).d.intents, 129);
  fallback.closed(4014);
  assert.equal(f.gateway.running, false); assert.equal(f.gateway.status().phase, 'error');
});

test('gateway destinations reject credentials, non-Discord hosts, wrong paths and insecure schemes', () => {
  assert.equal(gatewayAddress('wss://gateway.discord.gg/?arbitrary=discarded'), 'wss://gateway.discord.gg/?v=10&encoding=json');
  for (const url of ['ws://gateway.discord.gg', 'wss://evil.test', 'wss://gateway.discord.gg.evil.test', 'wss://user:password@gateway.discord.gg', 'wss://gateway.discord.gg:444', 'wss://gateway.discord.gg/other', 'wss://gateway.discord.gg/#fragment']) assert.throws(() => gatewayAddress(url));
});
