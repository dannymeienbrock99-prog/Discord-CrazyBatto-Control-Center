const DISCORD_ID = /^\d{17,20}$/;
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ud800-\udfff]/u;

export function ownerNicknameError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Bitte einen Server-Spitznamen eingeben.';
  if (UNSAFE_NAME.test(value)) return 'Der Spitzname darf keine Steuerzeichen oder Schreibrichtungszeichen enthalten.';
  if ([...value.trim()].length > 32) return 'Mit Krone darf dein Spitzname höchstens 32 Zeichen enthalten. Kürze ihn bitte etwas.';
  return '';
}

export function ownerNicknameSuggestion(name) {
  return name.startsWith('👑') ? name : `👑 ${name}`;
}

export function checkedOwner(result, ownerId) {
  const member = result?.member;
  if (!DISCORD_ID.test(ownerId || '') || member?.id !== ownerId || member?.isOwner !== true) {
    throw new Error('Der Serverbesitzer wurde von Discord nicht eindeutig bestätigt. Bitte erneut laden.');
  }
  const nickname = member.nickname || member.name;
  if (typeof nickname !== 'string' || !nickname.trim()) throw new Error('Discord hat keinen gültigen Besitzernamen geliefert. Bitte erneut laden.');
  return { ...member, currentNickname: nickname, hasCrown: nickname.startsWith('👑') };
}

export function ownerTextChannels(guildData, guildId) {
  if (!DISCORD_ID.test(guildId || '') || guildData?.guild?.id !== guildId) return [];
  return (guildData.channels || []).filter(channel => DISCORD_ID.test(channel?.id || '')
    && [0, 5].includes(channel.type) && (!channel.guild_id || channel.guild_id === guildId))
    .slice().sort((a, b) => (a.position || 0) - (b.position || 0));
}

export function ownerVerification(result, ownerId, nickname) {
  const owner = checkedOwner(result, ownerId);
  return { owner, requestedNickname: nickname.trim(), matches: owner.currentNickname === nickname.trim(), checkedAt: Date.now() };
}
