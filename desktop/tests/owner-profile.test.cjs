'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOwnerProfileActions } = require('../electron/owner-profile.cjs');

const guildId = '900000000000000018';
const channelId = '900000000000000020';
function fixture() {
  const copied = [], opened = [];
  return { copied, opened, run: createOwnerProfileActions({
    writeText: value => copied.push(value),
    openExternal: async value => opened.push(value)
  }) };
}

test('copy writes only the explicit draft, trims it and counts Unicode code points', async () => {
  const f = fixture();
  assert.deepEqual(await f.run('ownerprofile.copy', { nickname: '  👑 Crazy_Batto  ' }), { copied: true, nickname: '👑 Crazy_Batto' });
  const fullLength = '👑'.repeat(32);
  assert.deepEqual(await f.run('ownerprofile.copy', { nickname: fullLength }), { copied: true, nickname: fullLength });
  assert.deepEqual(f.copied, ['👑 Crazy_Batto', fullLength]);
  assert.deepEqual(f.opened, []);
});

test('invalid and extra nickname payloads never alter the clipboard or open anything', async () => {
  const f = fixture();
  const invalid = [undefined, null, '', '  ', 123, false, {}, '👑'.repeat(33), '\nName', 'Name\t', 'Name\u0000', 'Name\u0085', 'Name\u061c', 'Name\u200e', 'Name\u200f', 'Name\u2028', 'Name\u2029', 'Name\u202e', 'Name\u2066', 'Name\u2069', '\ud800', '\udfff'];
  for (const name of invalid) await assert.rejects(f.run('ownerprofile.copy', { nickname: name }));
  for (const payload of [undefined, null, [], {}, { nickname: 'Name', url: 'https://example.com' }, { nickname: 'Name', readClipboard: true }]) await assert.rejects(f.run('ownerprofile.copy', payload));
  assert.deepEqual(f.copied, []);
  assert.deepEqual(f.opened, []);
});

test('open constructs one HTTPS Discord channel URL from validated IDs', async () => {
  const f = fixture();
  assert.deepEqual(await f.run('ownerprofile.open', { guildId, channelId }), { opened: true });
  assert.deepEqual(f.opened, [`https://discord.com/channels/${guildId}/${channelId}`]);
  assert.deepEqual(f.copied, []);
});

test('open rejects arbitrary destinations, malformed IDs and extra fields before side effects', async () => {
  const f = fixture();
  for (const badId of [undefined, null, 900000000000000018, '1', '0', '9999999999999999999999999', `${guildId}/x`, `${guildId}?token=x`, `${guildId}#fragment`, ` ${guildId}`, `https://example.com/${guildId}`, '../private', '١٣٥٢٠٥٢٩٩٤٥٧٦٧٤٨٧٠٩']) {
    await assert.rejects(f.run('ownerprofile.open', { guildId: badId, channelId }));
    await assert.rejects(f.run('ownerprofile.open', { guildId, channelId: badId }));
  }
  for (const payload of [undefined, null, [], {}, { guildId }, { guildId, channelId, url: 'https://example.com' }, { guildId, channelId, path: 'C:/private' }]) await assert.rejects(f.run('ownerprofile.open', payload));
  for (const action of ['ownerprofile.set', 'ownerprofile.nickname', 'ownerprofile.token', 'ownerprofile.read', 'ownerprofile.copy.extra']) await assert.rejects(f.run(action, { nickname: 'Name' }));
  assert.deepEqual(f.copied, []);
  assert.deepEqual(f.opened, []);
});

test('failed native operations are not reported as success and do not trigger other actions', async () => {
  let copies = 0, opens = 0;
  const run = createOwnerProfileActions({
    writeText: () => { copies++; throw new Error('Clipboard unavailable'); },
    openExternal: async () => { opens++; throw new Error('Browser unavailable'); }
  });
  await assert.rejects(run('ownerprofile.copy', { nickname: 'Name' }), /Clipboard unavailable/);
  assert.equal(copies, 1); assert.equal(opens, 0);
  await assert.rejects(run('ownerprofile.open', { guildId, channelId }), /Browser unavailable/);
  assert.equal(copies, 1); assert.equal(opens, 1);
});
