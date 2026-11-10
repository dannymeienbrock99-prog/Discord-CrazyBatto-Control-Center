import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscordClient} from '../src/discord.mjs';
test('Discord audit reasons use the fixed percent-encoded header and never modify payloads',async()=>{
  const calls=[],client=new DiscordClient({botToken:'fixture-only'},{fetchImpl:async(url,options)=>{calls.push({url,...options});return new Response(null,{status:204});}});
  await client.request('PATCH','/guilds/123/members/456',{payload:{mute:true},auditReason:'Geprüft: Grüße & Regeln'});
  assert.equal(calls[0].headers['X-Audit-Log-Reason'],encodeURIComponent('Geprüft: Grüße & Regeln'));assert.deepEqual(JSON.parse(calls[0].body),{mute:true});
  await client.request('DELETE','/guilds/123/members/456');assert(!Object.hasOwn(calls[1].headers,'X-Audit-Log-Reason'));
});
test('invalid audit reasons are rejected before network use, including header injection and excessive length',async()=>{
  let calls=0;const client=new DiscordClient({botToken:'fixture-only'},{fetchImpl:async()=>{calls++;return new Response(null,{status:204});}});
  for(const reason of ['',123,'x'.repeat(501),'first\r\nAuthorization: secret','first\nsecond'])await assert.rejects(client.request('PATCH','/guilds/123/members/456',{auditReason:reason}));
  await assert.rejects(client.request('GET','/guilds/123/members/456',{auditReason:'Valid reason'}));assert.equal(calls,0);
});
