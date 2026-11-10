import { AppError, assert } from './errors.mjs';
import { P, has, basePermissions } from './permissions.mjs';
import { discordId, avatarUrl } from './community-schema.mjs';

const KEY = 'control_admin_crowns_v1';
const MANAGE_NICKNAMES = 1n << 27n;
const PREFIX = '👑 ';
export const CROWN_ACTIONS = Object.freeze(['admincrown.list', 'admincrown.lookup', 'admincrown.apply', 'admincrown.remove']);

export class AdminCrowns {
  constructor(service) { this.service = service; this.community = service.communityControl; this.store = service.accounts.store; }
  records() {
    const raw = this.store.setting(KEY);
    if (!raw) return {};
    try { const data = JSON.parse(raw); if (data && typeof data === 'object' && !Array.isArray(data)) return data; } catch {}
    throw new AppError('storage', 'Die gespeicherten Admin-Kronen können nicht gelesen werden.', 503);
  }
  describe(auth, member, records = this.records()) {
    assert(member?.user && /^\d{17,20}$/.test(member.user.id) && Array.isArray(member.roles), 'Discord hat kein gültiges Mitglied geliefert.', 'network', 502);
    const id = member.user.id, nickname = member.nick || null;
    const name = nickname || member.user.global_name || member.user.username || id;
    const isOwner = id === auth.guild.owner_id;
    const isAdmin = has(basePermissions(auth.guild, member), P.ADMINISTRATOR);
    const record = records[id];
    const managed = !!record && nickname === record.appliedNick;
    const hasCrown = name.startsWith('👑');
    let reason = '';
    if (member.user.bot) reason = 'Kronen sind hier für menschliche Admins vorgesehen.';
    else if (!isAdmin && !managed) reason = 'Dieses Mitglied besitzt keine Administratorrechte.';
    else if (isOwner) reason = 'Der Serverbesitzer muss seinen Spitznamen selbst in Discord ändern.';
    else if (!has(basePermissions(auth.guild, auth.member), MANAGE_NICKNAMES)) reason = 'Dem Bot fehlt „Spitznamen verwalten“.';
    else if (this.community.position(auth.guild, auth.member) <= this.community.position(auth.guild, member)) reason = 'Die höchste Botrolle muss über der höchsten Rolle dieses Admins stehen.';
    const applyReason = reason || (hasCrown ? 'Dieses Mitglied trägt bereits eine Krone.' : ([...PREFIX + name].length > 32 ? 'Mit Krone wäre der Spitzname länger als 32 Zeichen. Bitte den Namen zuerst kürzen.' : ''));
    return { id, name, nickname, avatarUrl: avatarUrl(member.user), isAdmin, isOwner, hasCrown, managed,
      canApply: !applyReason && isAdmin, canRemove: !reason && managed,
      reason: reason || (managed ? '' : applyReason), proposedNickname: hasCrown ? name : PREFIX + name };
  }
  async run(context, action, payload = {}) {
    assert(context, 'Eine gültige Administrator-Anmeldung ist erforderlich.', 'auth', 401);
    this.community.current(context); this.community.identity();
    assert(CROWN_ACTIONS.includes(action), 'Unbekannte Kronen-Aktion.');
    assert(!payload.guildId || payload.guildId === this.service.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (['admincrown.apply', 'admincrown.remove'].includes(action)) assert(payload.confirm === true, 'Bitte die Änderung des Server-Spitznamens bestätigen.');
    if (action !== 'admincrown.list') discordId(payload.userId);
    if (payload.after) discordId(payload.after);
    const auth = await this.community.authority(context);
    if (action === 'admincrown.list') {
      let rows;
      try { rows = await this.community.request(context, 'GET', `/guilds/${auth.guild.id}/members?limit=1000${payload.after ? '&after=' + payload.after : ''}`); }
      catch (error) { if ([401,403].includes(error.status)) throw new AppError('forbidden', 'Discord gibt die vollständige Mitgliederliste für diese Anwendung nicht frei. Aktiviere den Mitgliederzugriff in Discord oder suche einen Admin über seine Nutzer-ID.', 403); throw error; }
      assert(Array.isArray(rows), 'Discord hat keine gültige Mitgliederliste geliefert.', 'network', 502);
      this.community.current(context);
      const records = this.records();
      const members = rows.filter(row => row?.user?.bot !== true).map(row => this.describe(auth, row, records)).filter(row => row.isAdmin || row.managed);
      return { members, scanned: rows.length, hasMore: rows.length === 1000, nextAfter: rows.length === 1000 ? rows.at(-1).user.id : null,
        message: 'Die goldene Krone steht im Server-Spitznamen und ist für alle sichtbar. Änderungen erfolgen nur nach deiner Auswahl.' };
    }
    const route = `/guilds/${auth.guild.id}/members/${payload.userId}`;
    const member = await this.community.request(context, 'GET', route);
    assert(member?.user?.id === payload.userId, 'Discord hat ein anderes Mitglied geliefert.', 'network', 502);
    this.community.current(context);
    const before = this.describe(auth, member);
    if (action === 'admincrown.lookup') return { member: before };
    const removing = action === 'admincrown.remove';
    if (!removing && before.hasCrown && before.isAdmin) return { member: before, changed: false, message: 'Der Name trägt bereits eine Krone. Es wurde nichts geändert.' };
    assert(removing ? before.canRemove : before.canApply, before.reason || 'Dieser Spitzname wurde inzwischen geändert oder seine Krone stammt nicht aus dem Control Center.', 'forbidden', 403);
    const record = this.records()[payload.userId];
    const nick = removing ? record.originalNick : before.proposedNickname;
    const updated = await this.community.request(context, 'PATCH', route, { nick });
    assert(updated?.user?.id === payload.userId && (updated.nick || null) === (nick || null), 'Discord hat die Namensänderung nicht eindeutig bestätigt. Bitte die Mitgliederliste neu laden, bevor du erneut klickst.', 'uncertain', 502);
    // A confirmed Discord mutation stays successful even if the session expires in flight.
    let saved = true;
    try { this.store.transaction(() => {
      const records = this.records();
      if (removing) delete records[payload.userId];
      else records[payload.userId] = { originalNick: member.nick || null, appliedNick: nick };
      this.store.setSetting(KEY, JSON.stringify(records));
    }); } catch { saved = false; }
    try { this.store.audit(context.user.id, removing ? 'discord.crown.remove' : 'discord.crown.apply', payload.userId, {}); } catch { /* Audit failure must not discard nickname restoration data. */ }
    return { member: this.describe(auth, { ...member, ...updated }, saved ? this.records() : {}), changed: true,
      message: saved ? (removing ? 'Der vorherige Server-Spitzname ist wiederhergestellt.' : 'Die goldene Krone ist jetzt vor dem Server-Spitznamen sichtbar.') : 'Discord hat den Spitznamen geändert. Die lokale Wiederherstellung konnte nicht gespeichert werden; bitte vor weiteren Änderungen neu laden.' };
  }
}
