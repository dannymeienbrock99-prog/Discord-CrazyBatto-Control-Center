'use strict';

const V = require('./validation.cjs');

function exactPayload(payload, keys) {
  V.object(payload);
  if (Object.keys(payload).length !== keys.length || keys.some(key => !Object.hasOwn(payload, key)) || Object.keys(payload).some(key => !keys.includes(key))) {
    throw new Error('Die Eingabe für dein Serverprofil ist ungültig.');
  }
  return payload;
}

function nickname(value) {
  if (typeof value !== 'string') throw new Error('Der Server-Spitzname muss Text sein.');
  // Reject controls before trimming so line breaks and direction overrides are never copied.
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value)) {
    throw new Error('Der Server-Spitzname darf keine Steuerzeichen enthalten.');
  }
  const result = value.trim();
  const length = Array.from(result).length;
  if (length < 1 || length > 32) throw new Error('Der Server-Spitzname muss 1 bis 32 Zeichen enthalten.');
  return result;
}

function snowflake(value, label) {
  V.id(value, label);
  if (BigInt(value) === 0n || BigInt(value) > (2n ** 64n - 1n)) throw new Error(`${label} ist ungültig.`);
  return value;
}

function createOwnerProfileActions({ writeText, openExternal }) {
  return async function ownerProfileAction(action, payload) {
    if (action === 'ownerprofile.copy') {
      exactPayload(payload, ['nickname']);
      const name = nickname(payload.nickname);
      await writeText(name);
      return { copied: true, nickname: name };
    }
    if (action === 'ownerprofile.open') {
      exactPayload(payload, ['guildId', 'channelId']);
      const guildId = snowflake(payload.guildId, 'Server-ID');
      const channelId = snowflake(payload.channelId, 'Kanal-ID');
      await openExternal(`https://discord.com/channels/${guildId}/${channelId}`);
      return { opened: true };
    }
    throw new Error('Diese Serverprofil-Aktion ist nicht freigegeben.');
  };
}

module.exports = { createOwnerProfileActions };
