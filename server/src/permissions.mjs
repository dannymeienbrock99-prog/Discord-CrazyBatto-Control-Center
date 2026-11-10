export const P = Object.freeze({
  ADMINISTRATOR: 1n << 3n, MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n, ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n,
  CREATE_EVENTS: 1n << 44n, SEND_POLLS: 1n << 49n
});
const ALL = (1n << 64n) - 1n;
const value = input => /^\d+$/.test(String(input ?? '')) ? BigInt(input) : 0n;
export const has = (permissions, flag) => (permissions & flag) === flag;

export function basePermissions(guild, member, now = Date.now()) {
  if (!member?.user?.id || !Array.isArray(member.roles) || !Array.isArray(guild?.roles)) return 0n;
  if (guild.owner_id === member.user.id) return ALL;
  let permissions = value(guild.roles.find(role => role.id === guild.id)?.permissions);
  for (const role of guild.roles) if (member.roles.includes(role.id)) permissions |= value(role.permissions);
  if (has(permissions, P.ADMINISTRATOR)) return ALL;
  const timeout = Date.parse(member.communication_disabled_until || '');
  if (Number.isFinite(timeout) && timeout > now) return permissions & (P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  if (member.pending === true) return permissions & (P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  return permissions;
}

export function channelPermissions(guild, member, channel, now = Date.now()) {
  if (!channel || channel.guild_id !== guild.id || !Array.isArray(member?.roles)) return 0n;
  let permissions = basePermissions(guild, member, now);
  if (has(permissions, P.ADMINISTRATOR)) return ALL;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find(item => item.type === 0 && item.id === guild.id);
  if (everyone) permissions = (permissions & ~value(everyone.deny)) | value(everyone.allow);
  let allow = 0n, deny = 0n;
  for (const item of overwrites) {
    if (item.type === 0 && member.roles.includes(item.id)) { allow |= value(item.allow); deny |= value(item.deny); }
  }
  permissions = (permissions & ~deny) | allow;
  const personal = overwrites.find(item => item.type === 1 && item.id === member.user.id);
  if (personal) permissions = (permissions & ~value(personal.deny)) | value(personal.allow);
  const timeout = Date.parse(member.communication_disabled_until || '');
  if ((Number.isFinite(timeout) && timeout > now) || member.pending === true) permissions &= P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY;
  return permissions;
}

export function canConfigure(guild, member, now) { return has(basePermissions(guild, member, now), P.MANAGE_GUILD); }
export function canMentionRole(permissions, role) { return !!role && (role.mentionable === true || has(permissions, P.MENTION_EVERYONE)); }

export function channelCapabilities(context, channel, moderatorRoleId, now, categorySettings = {}) {
  const user = channelPermissions(context.guild, context.member, channel, now);
  const bot = channelPermissions(context.guild, context.botMember, channel, now);
  const base = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.EMBED_LINKS;
  const both = flag => has(user, flag) && has(bot, flag);
  const ready = [0, 5].includes(channel.type) && both(base);
  const role = context.guild.roles.find(item => item.id === moderatorRoleId && item.id !== context.guild.id);
  const memberMayStamp = !!role && (context.member.roles.includes(role.id) || canConfigure(context.guild, context.member, now));
  const capabilities = {}, reasons = {};
  for (const category of ['modstempel', 'stream', 'big_match', 'general', 'poll']) {
    const policy = categorySettings[category] || { channelId: null, mentionMode: category === 'modstempel' ? 'role' : 'none', roleId: category === 'modstempel' ? moderatorRoleId : null };
    const mentionRole = context.guild.roles.find(item => item.id === policy.roleId && item.id !== context.guild.id);
    let reason = !ready ? 'Dir oder dem Bot fehlen Kanalzugriff, Nachrichten- oder Einbettungsrechte.' : '';
    if (!reason && policy.channelId && policy.channelId !== channel.id) reason = 'Für diese Beitragsart ist ein anderer Zielkanal festgelegt.';
    if (!reason && category === 'modstempel' && !memberMayStamp) reason = !role ? 'Die Serververwaltung muss zuerst die Dienstrolle festlegen.' : 'Für Dienstmeldungen brauchst du die festgelegte Dienstrolle oder Serververwaltungsrechte.';
    if (!reason && ['stream', 'poll'].includes(category) && !both(P.SEND_POLLS)) reason = 'Dir oder dem Bot fehlt in diesem Kanal das Recht „Umfragen senden“.';
    if (!reason && policy.mentionMode === 'everyone' && !both(P.MENTION_EVERYONE)) reason = 'Die eingestellte @everyone-Erwähnung ist für dich oder den Bot in diesem Kanal nicht erlaubt.';
    if (!reason && policy.mentionMode === 'role' && (!canMentionRole(user, mentionRole) || !canMentionRole(bot, mentionRole))) reason = 'Die eingestellte Rolle fehlt oder darf von dir oder dem Bot in diesem Kanal nicht erwähnt werden.';
    capabilities[category] = !reason;
    if (reason) reasons[category] = reason;
  }
  return {
    capabilities, reasons,
    ...(!Object.values(capabilities).some(Boolean) ? { reason: Object.values(reasons)[0] } : {}),
    userPermissions: user, botPermissions: bot
  };
}

export const INSTALL_PERMISSIONS = Object.entries(P).filter(([key]) => !['ADMINISTRATOR', 'MANAGE_GUILD'].includes(key)).reduce((all, [, bit]) => all | bit, 0n).toString();
