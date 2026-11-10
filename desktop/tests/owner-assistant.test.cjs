const test = require('node:test');
const assert = require('node:assert/strict');
const helper = import('../src/components/owner-crown-assistant.mjs');
const GUILD = '900000000000000018', OWNER = '900000000000000017';

test('owner verification requires the actual server owner and an exact saved nickname', async () => {
  const {checkedOwner, ownerVerification} = await helper;
  const response = name => ({member:{id:OWNER,isOwner:true,nickname:name,name:'Account name'}});
  assert.equal(ownerVerification(response('👑 Crazy_Batto'), OWNER, '👑 Crazy_Batto').matches, true);
  assert.equal(ownerVerification(response('Crazy_Batto'), OWNER, '👑 Crazy_Batto').matches, false);
  assert.equal(ownerVerification(response('👑 Crazy_Batto'), OWNER, '👑 Other').matches, false);
  assert.throws(() => checkedOwner({member:{id:OWNER,isOwner:false,name:'Owner?'}}, OWNER));
  assert.throws(() => checkedOwner(response('Name'), '900000000000000019'));
  assert.throws(() => checkedOwner({}, OWNER));
});

test('crown suggestion preserves an existing crown and never silently truncates a long name', async () => {
  const {ownerNicknameSuggestion, ownerNicknameError} = await helper;
  assert.equal(ownerNicknameSuggestion('👑 Crazy_Batto'), '👑 Crazy_Batto');
  assert.equal(ownerNicknameSuggestion('Crazy_Batto'), '👑 Crazy_Batto');
  const proposed = ownerNicknameSuggestion('a'.repeat(32));
  assert.equal([...proposed].length,34);
  assert.ok(ownerNicknameError(proposed));
});

test('nickname validation counts emoji codepoints and rejects invisible direction and control characters', async () => {
  const {ownerNicknameError} = await helper;
  assert.equal(ownerNicknameError('👑 ' + 'a'.repeat(30)), '');
  assert.ok(ownerNicknameError('👑 ' + 'a'.repeat(31)));
  for (const name of ['', '  ', '\nName', 'Name\u0000', '\u202eName', 'Name\u2067', '\u200eName', 'Name\u2028Line', 'Name\ud800']) assert.ok(ownerNicknameError(name), JSON.stringify(name));
  assert.equal(ownerNicknameError(' 👑 Name '), '');
});

test('Discord channel choices exclude foreign guilds, invalid IDs and voice channels', async () => {
  const {ownerTextChannels} = await helper;
  const channels = [{id:'900000000000000003',guild_id:GUILD,type:0,position:2},{id:'900000000000000004',type:5,position:1},{id:'900000000000000005',type:2},{id:'900000000000000006',guild_id:'900000000000000007',type:0},{id:'../bad',type:0}];
  assert.deepEqual(ownerTextChannels({guild:{id:GUILD},channels},GUILD).map(x=>x.id),['900000000000000004','900000000000000003']);
  assert.deepEqual(ownerTextChannels({guild:{id:'900000000000000007'},channels},GUILD),[]);
});
