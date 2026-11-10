import test from 'node:test';
import {withCommunitySqlite} from './helpers/community-fixture-store.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { BotService, BOT_COMMANDS } from '../src/bot.mjs';
import { CommunityControl } from '../src/community-control.mjs';
import { COMMUNITY_BOT_ID, communityDefaults } from '../src/community-schema.mjs';

const GUILD = '900000000000000018', OTHER_GUILD = '900000000000000044';
const CHANNEL = '900000000000000045', MESSAGE = '900000000000000046';
const USER = '900000000000000047', TARGET = '900000000000000048';
const INTERACTION = '900000000000000049', COMMAND = '900000000000000050';
const NOW = Date.UTC(2026, 10, 9, 18, 0, 0);
const keys = crypto.generateKeyPairSync('ed25519');
const publicHex = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
function fixture() {
  const settings = new Map(), musicCalls = [], discordCalls = [], communityCalls = [];
  settings.set('bot_settings', JSON.stringify({ enabled: true, commandIds: Object.fromEntries(BOT_COMMANDS.map(command => [command.name, COMMAND])) }));
  const config = { clientId: COMMUNITY_BOT_ID, discordGuildId: GUILD, discordPublicKey: publicHex, botToken: 'fixture-only-bot-token', publicOrigin: 'https://crazybatto.test' };
  const service = { config,
    accounts: { store: { setting: key => settings.get(key), setSetting: (key, value) => settings.set(key, value), transaction: fn => fn() } },
    discord: { async request(...args) { discordCalls.push(args); throw new Error('No external Discord requests are permitted by this fixture.'); } },
    musicBot: { status: () => ({ configured: true }), accept: data => musicCalls.push(data) },
    birthdays: { calendar: () => ({ entries: [{ name: '@everyone **Fixture**', day: 9, month: 11, daysUntil: 0 }] }) }
  };
  withCommunitySqlite(service.accounts.store);
  const community = service.communityControl = new CommunityControl(service, { now: () => NOW });
  const data = community.data(); data.settings = communityDefaults();
  data.settings.tickets.enabled = true; data.settings.tickets.channelId = CHANNEL; data.settings.tickets.staffRoleIds = [TARGET];
  data.settings.reports.enabled = true; data.settings.reports.channelId = CHANNEL; data.settings.reports.staffRoleIds = [TARGET];
  data.settings.rules.enabled = true; data.settings.rules.channelId = CHANNEL; data.settings.rules.roleId = TARGET;
  for (const section of ['tickets', 'reports', 'rules']) data.publications[section] = { channelId: CHANNEL, messageId: MESSAGE };
  data.commands = { ticket: COMMAND, melden: COMMAND, 'Mitglied melden': COMMAND };
  settings.set('community_control_v3', JSON.stringify(data));
  const actual = community.interaction.bind(community);
  community.interaction = data => { communityCalls.push(data); return actual(data); };
  const bot = new BotService(service, { now: () => NOW });
  const payload = override => ({ id: INTERACTION, application_id: COMMUNITY_BOT_ID, guild_id: GUILD, channel_id: CHANNEL, token: 'fixture-only-interaction-token-0000', member: { user: { id: USER } }, message: { id: MESSAGE }, type: 3, data: { custom_id: 'cb3:ticket:open' }, ...override });
  const signed = (data, timestamp = String(NOW / 1000)) => {
    const bytes = Buffer.from(JSON.stringify(data));
    const signature = crypto.sign(null, Buffer.concat([Buffer.from(timestamp), bytes]), keys.privateKey).toString('hex');
    return { bytes, headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signature } };
  };
  const invoke = data => { const { bytes, headers } = signed(data); return bot.interaction(bytes, headers); };
  return { bot, service, community, communityCalls, settings, musicCalls, discordCalls, payload, signed, invoke };
}

test('invalid, missing, stale or tampered Ed25519 signatures never reach CommunityControl', () => {
  const f = fixture(); const signed = f.signed(f.payload());
  for (const headers of [{}, { ...signed.headers, 'x-signature-ed25519': '0'.repeat(128) }, { ...signed.headers, 'x-signature-ed25519': 'bad' }, { ...signed.headers, 'x-signature-timestamp': String(NOW / 1000 - 301) }, { ...signed.headers, 'x-signature-timestamp': String(NOW / 1000 + 301) }]) {
    assert.throws(() => f.bot.interaction(signed.bytes, headers), error => error.kind === 'signature' && error.status === 401);
  }
  const changed = Buffer.from(signed.bytes.toString().replace(USER, TARGET));
  assert.throws(() => f.bot.interaction(changed, signed.headers), error => error.kind === 'signature');
  assert.equal(f.communityCalls.length, 0); assert.equal(f.community.data().forms.length, 0); assert.equal(f.discordCalls.length, 0);
});

test('correctly signed Ping is answered directly while wrong application cannot enter community handling', () => {
  const f = fixture();
  assert.deepEqual(f.invoke(f.payload({ type: 1, data: undefined })), { type: 1 });
  assert.throws(() => f.invoke(f.payload({ application_id: TARGET })), error => error.kind === 'forbidden' && error.status === 403);
  assert.equal(f.communityCalls.length, 0);
});

test('valid signed community button reaches the actual module and opens an actor-bound private form', () => {
  const f = fixture();
  const result = f.invoke(f.payload());
  assert.equal(result.type, 9); assert.match(result.data.custom_id, /^cb3:form:[a-f0-9]{24}$/);
  assert.equal(f.communityCalls.length, 1);
  const form = f.community.data().forms[0];
  assert.equal(form.actorId, USER); assert.equal(form.kind, 'ticket'); assert.equal(form.expiresAt, NOW + 15 * 60000);
  assert.equal(f.discordCalls.length, 0); assert.equal(f.musicCalls.length, 0);
});

test('signed context-menu reporting is forwarded while foreign guild and stale panel are refused privately', () => {
  const f = fixture();
  const report = f.invoke(f.payload({ type: 2, data: { type: 2, name: 'Mitglied melden', id: COMMAND, target_id: TARGET } }));
  assert.equal(report.type, 4); assert.equal(report.data.flags, 64); assert.equal(report.data.components[0].components[0].type, 3); assert.equal(f.community.data().forms[0].targetId, TARGET);
  const before = f.community.data().forms.length;
  for (const data of [f.payload({ guild_id: OTHER_GUILD }), f.payload({ message: { id: TARGET } }), f.payload({ channel_id: TARGET })]) {
    const result = f.invoke(data);
    assert.equal(result.type, 4); assert.equal(result.data.flags, 64); assert.deepEqual(result.data.allowed_mentions.parse, []);
  }
  assert.equal(f.community.data().forms.length, before); assert.equal(f.discordCalls.length, 0);
});
test('signed report entry points require a signed fixed category before opening the bound reason modal',()=>{
  for(const data of [{custom_id:'cb3:report:select',component_type:5,values:[TARGET]},{type:1,name:'melden',id:COMMAND,options:[{name:'mitglied',type:6,value:TARGET}]},{type:2,name:'Mitglied melden',id:COMMAND,target_id:TARGET}]){
    const f=fixture(),picker=f.invoke(f.payload({type:data.custom_id?3:2,data})),select=picker.data.components[0].components[0];assert.equal(picker.type,4);assert.equal(picker.data.flags,64);assert.equal(select.type,3);
    const next=f.payload({data:{custom_id:select.custom_id,component_type:3,values:['belaestigung']}}),signed=f.signed(next);
    assert.throws(()=>f.bot.interaction(Buffer.from(signed.bytes.toString().replace('belaestigung','betrug')),signed.headers),{kind:'signature'});
    assert.equal(f.invoke({...next,member:{user:{id:TARGET}}}).type,4);assert.equal(f.community.data().forms[0].kind,'report-category');
    const modal=f.invoke(next);assert.equal(modal.type,9);assert.match(modal.data.title,/Belästigung/);assert.equal(modal.data.components[0].components[0].required,true);assert.equal(f.community.data().forms[0].category,'belaestigung');assert.equal(f.community.data().forms[0].targetId,TARGET);assert.equal(f.discordCalls.length,0);
  }
});
test('a re-registered command invalidates its earlier private category menu',()=>{
  const f=fixture(),picker=f.invoke(f.payload({type:2,data:{type:2,name:'Mitglied melden',id:COMMAND,target_id:TARGET}}));f.community.mutate(d=>d.commands['Mitglied melden']=MESSAGE);
  const result=f.invoke(f.payload({data:{custom_id:picker.data.components[0].components[0].custom_id,component_type:3,values:['spam']}}));assert.equal(result.type,4);assert.equal(result.data.components,undefined);assert.equal(f.community.data().forms[0].kind,'report-category');
});

test('signed refusal of rules remains private and never assigns roles or moderates a member', () => {
  const f = fixture();
  const result = f.invoke(f.payload({ data: { custom_id: 'cb3:rules:no' } }));
  assert.equal(result.type, 4); assert.equal(result.data.flags, 64); assert.match(result.data.content, /nicht entfernt/);
  assert.deepEqual(result.data.allowed_mentions.parse, []);
  assert.equal(f.community.pending.size, 0); assert.equal(f.discordCalls.length, 0);
});

test('existing signed birthday command still returns only the calendar with safe mentions', () => {
  const f = fixture();
  const result = f.invoke(f.payload({ type: 2, data: { type: 1, name: 'geburtstage', id: COMMAND } }));
  assert.equal(result.type, 4); assert.equal(result.data.flags, 64);
  assert.match(result.data.content, /Geburtstagskalender/); assert.match(result.data.content, /Fixture/); assert.match(result.data.content, /geburtstage\.html/);
  assert.ok(!result.data.content.includes('@everyone')); assert.deepEqual(result.data.allowed_mentions, { parse: [] });
  assert.equal(f.community.data().forms.length, 0); assert.equal(f.discordCalls.length, 0);
});

test('existing signed music player link is unchanged and playback is deferred only after valid verification', async () => {
  const f = fixture();
  const player = f.invoke(f.payload({ type: 2, data: { type: 1, name: 'musik', id: COMMAND, options: [{ name: 'aktion', value: 'player' }] } }));
  assert.equal(player.type, 4); assert.match(player.data.content, /media-player\.html/); assert.equal(f.musicCalls.length, 0);
  const playData = f.payload({ type: 2, data: { type: 1, name: 'musik', id: COMMAND, options: [{ name: 'aktion', value: 'play' }] } });
  const signed = f.signed(playData);
  assert.throws(() => f.bot.interaction(signed.bytes, { ...signed.headers, 'x-signature-ed25519': '0'.repeat(128) }));
  await new Promise(setImmediate); assert.equal(f.musicCalls.length, 0);
  assert.deepEqual(f.invoke(playData), { type: 5, data: { flags: 64 } });
  assert.equal(f.musicCalls.length, 0); await new Promise(setImmediate);
  assert.equal(f.musicCalls.length, 1); assert.equal(f.musicCalls[0].id, INTERACTION);
  assert.equal(f.discordCalls.length, 0);
});

test('legacy commands retain their configured command-ID, guild and enablement fences', async () => {
  const f = fixture();
  const play = { type: 2, data: { type: 1, name: 'musik', id: COMMAND, options: [{ name: 'aktion', value: 'play' }] } };
  for (const payload of [f.payload({ ...play, guild_id: OTHER_GUILD }), f.payload({ ...play, data: { ...play.data, id: TARGET } })]) assert.equal(f.invoke(payload).type, 4);
  f.settings.set('bot_settings', JSON.stringify({ enabled: false, commandIds: { musik: COMMAND } }));
  assert.equal(f.invoke(f.payload(play)).type, 4);
  await new Promise(setImmediate); assert.equal(f.musicCalls.length, 0);
  assert.equal(f.invoke(f.payload()).type, 9); // Community settings remain separately explicit.
});

test('HTTP interaction adapter verifies the original body and enforces its size bound', async () => {
  const f = fixture();
  async function request(signed, overrides = {}) {
    const req = Readable.from([signed.bytes]);
    Object.assign(req, { method: 'POST', url: '/discord/interactions', headers: { ...signed.headers, ...overrides } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    assert.equal(await f.bot.handle(req, res), true); return res;
  }
  const ping = f.signed(f.payload({ type: 1 }));
  const ok = await request(ping); assert.equal(ok.status, 200); assert.deepEqual(ok.body, { type: 1 });
  const bad = await request(ping, { 'x-signature-ed25519': '0'.repeat(128) }); assert.equal(bad.status, 401); assert.equal(bad.body.error.code, 'signature');
  const oversized = await request(ping, { 'content-length': String(64 * 1024 + 1) }); assert.equal(oversized.status, 413);
  assert.equal(f.communityCalls.length, 0); assert.equal(f.discordCalls.length, 0);
});
