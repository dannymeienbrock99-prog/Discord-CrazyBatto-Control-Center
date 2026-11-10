import { AppError, assert, safeMessage } from './errors.mjs';
import { P, has, basePermissions } from './permissions.mjs';
import { CID, discordId, ephemeral } from './community-schema.mjs';

export const DEVICE_ROLE_ACTIONS = Object.freeze(['roles.state', 'roles.save', 'roles.decorate', 'roles.publish']);
export const DEVICE_ROLES = Object.freeze({
  pc: { label: 'PC', emoji: '🖥️' }, playstation: { label: 'PlayStation', emoji: '🎮' },
  xbox: { label: 'Xbox', emoji: '🟢' }, smartphone: { label: 'Smartphone', emoji: '📱' },
  switch: { label: 'Nintendo Switch', emoji: '🔴' }, king: { label: 'King', emoji: '👑' },
  moderator: { label: 'Moderator', emoji: '🛡️' },
});
const KEY = 'control_device_roles_v1', MANAGE_ROLES = 1n << 28n;
const DEVICES = ['pc', 'playstation', 'xbox', 'smartphone', 'switch'];
const KEYS = Object.keys(DEVICE_ROLES);
const mappingDefault = () => Object.fromEntries(KEYS.map(key => [key, '']));
const normalize = name => String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const protectedName = name => /(?:^|\s)(?:king|könig|admin\w*|moderator\w*)(?:\s|$)/u.test(normalize(name));
const problem = error => error instanceof AppError ? safeMessage(error.message) : 'Discord hat die Aktion nicht bestätigt. Bitte den aktuellen Zustand prüfen.';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class DeviceRoles {
  constructor(service) {
    this.service = service; this.community = service.communityControl; this.store = service.accounts.store;
    this.actorQueues = new Map(); this.adminQueue = Promise.resolve();
  }
  data() {
    const raw = this.store.setting(KEY);
    if (!raw) return { revision: 0, mapping: mappingDefault(), channelId: '', enabled: false, publication: null, publishAttempt: null, decorations: [] };
    let value; try { value = JSON.parse(raw); } catch { throw new AppError('storage', 'Die Geräte-Rollen können nicht gelesen werden.', 503); }
    assert(value && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.mapping && typeof value.enabled === 'boolean', 'Die gespeicherten Geräte-Rollen sind ungültig.', 'storage', 503);
    return { publication: null, publishAttempt: null, decorations: [], ...value, mapping: { ...mappingDefault(), ...value.mapping } };
  }
  mutate(fn) { return this.store.transaction(() => { const value = this.data(); const result = fn(value); this.store.setSetting(KEY, JSON.stringify(value)); return result; }); }
  current(context) { assert(context, 'Eine gültige Administrator-Anmeldung ist erforderlich.', 'auth', 401); this.community.current(context); this.community.identity(); }
  role(auth, roleId) { return auth.guild.roles.find(role => role.id === roleId); }
  editable(auth, role) {
    assert(role && role.id !== auth.guild.id && !role.managed, 'Diese Rolle ist nicht frei bearbeitbar.', 'forbidden', 403);
    assert(has(basePermissions(auth.guild, auth.member), MANAGE_ROLES), 'Dem Bot fehlt „Rollen verwalten“.', 'forbidden', 403);
    assert(Number(role.position) < this.community.position(auth.guild, auth.member), 'Die Botrolle muss über dieser Rolle stehen. Die Rollenreihenfolge wurde nicht geändert.', 'forbidden', 403);
  }
  deviceAssignable(auth, key, mapping) {
    assert(DEVICES.includes(key), 'Diese Rolle gehört nicht zur Geräteauswahl.', 'forbidden', 403);
    const roleId = mapping[key]; discordId(roleId);
    assert(roleId !== mapping.king && roleId !== mapping.moderator, 'King und Moderator sind nicht selbst auswählbar.', 'forbidden', 403);
    const role = this.role(auth, roleId); this.editable(auth, role);
    assert(String(role.permissions) === '0' && !protectedName(role.name), 'Geräterollen dürfen keine eigenen Rechte enthalten und keine Teamrolle sein.', 'forbidden', 403);
    return role;
  }
  async state(context, auth) {
    this.current(context); auth ||= await this.community.authority(context);
    const d = this.data(), iconFeature = auth.guild.features?.includes('ROLE_ICONS') === true;
    const suggestions = Object.fromEntries(KEYS.map(key => {
      const matches = auth.guild.roles.filter(role => !role.managed && role.id !== auth.guild.id && normalize(role.name) === normalize(DEVICE_ROLES[key].label));
      return [key, matches.length === 1 ? matches[0].id : ''];
    }));
    this.current(context);
    return { ...d, iconFeature, iconMode: iconFeature ? 'role-icon' : 'role-name', suggestions,
      roles: auth.guild.roles.map(role => ({ id: role.id, name: role.name, position: role.position, managed: role.managed === true, permissions: String(role.permissions), icon: role.icon || null, unicode_emoji: role.unicode_emoji || null,
        editable: !role.managed && role.id !== auth.guild.id && has(basePermissions(auth.guild, auth.member), MANAGE_ROLES) && Number(role.position) < this.community.position(auth.guild, auth.member) })),
      deviceKeys: [...DEVICES], labels: DEVICE_ROLES,
      iconMessage: iconFeature ? 'Discord zeigt neben dem Namen das Icon der höchsten Rolle mit Icon. Weitere Icons stehen im Profil.' : 'Dieser Server hat keine Rollen-Icons freigeschaltet. Die Symbole stehen im Rollennamen und im Profil, nicht automatisch neben jedem Mitgliedsnamen.' };
  }
  async run(context, action, payload = {}) {
    this.current(context); assert(DEVICE_ROLE_ACTIONS.includes(action), 'Unbekannte Rollen-Aktion.');
    assert(!payload.guildId || payload.guildId === this.service.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (action === 'roles.state') return this.state(context);
    assert(payload.confirm === true, 'Bitte die Rollen-Aktion bestätigen.');
    const task = this.adminQueue.then(async () => {
      this.current(context);
      if (action === 'roles.save') return this.save(context, payload);
      if (action === 'roles.decorate') return this.decorate(context);
      return this.publish(context);
    });
    this.adminQueue = task.catch(() => {}); return task;
  }
  async save(context, payload) {
    const before = this.data();
    assert(Number.isSafeInteger(payload.revision) && payload.revision === before.revision, 'Die Rollen-Einstellungen wurden inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    assert(payload.mapping && typeof payload.mapping === 'object' && !Array.isArray(payload.mapping) && Object.keys(payload.mapping).length === KEYS.length && KEYS.every(key => Object.hasOwn(payload.mapping, key)), 'Bitte alle festen Rollen-Zuordnungen angeben.');
    const mapping = Object.fromEntries(KEYS.map(key => [key, discordId(payload.mapping[key], true)]));
    assert(new Set(Object.values(mapping).filter(Boolean)).size === Object.values(mapping).filter(Boolean).length, 'Eine Rolle darf nur einem Bereich zugeordnet sein.');
    const channelId = discordId(payload.channelId, true); assert(typeof payload.enabled === 'boolean', 'Bitte die Geräteauswahl ein- oder ausschalten.');
    if (payload.enabled) assert(channelId && DEVICES.every(key => mapping[key]), 'Für die aktive Auswahl werden ein Textkanal und alle fünf Geräterollen benötigt.');
    const auth = await this.community.authority(context, MANAGE_ROLES, channelId);
    if (channelId) this.community.sendable(auth);
    for (const key of KEYS) if (mapping[key]) {
      const role = this.role(auth, mapping[key]);
      assert(role && role.id !== auth.guild.id && !role.managed, 'Bitte Rollen dieses Servers auswählen.');
      if (DEVICES.includes(key)) this.deviceAssignable(auth, key, mapping);
    }
    this.current(context);
    this.mutate(d => { assert(d.revision === payload.revision, 'Die Rollen-Einstellungen wurden inzwischen geändert.', 'conflict', 409); d.mapping = mapping; d.channelId = channelId; d.enabled = payload.enabled; d.revision++; });
    return this.state(context, auth);
  }
  async decorate(context) {
    const configuration = this.data(), results = [];
    for (const key of KEYS) {
      const roleId = configuration.mapping[key];
      if (!roleId) { results.push({ key, roleId: '', status: 'skipped', message: 'Keine Rolle zugeordnet.' }); continue; }
      let stage = 'checking';
      try {
        assert(this.data().revision === configuration.revision, 'Die Rollen-Zuordnung wurde inzwischen geändert.', 'conflict', 409);
        const auth = await this.community.authority(context, MANAGE_ROLES), role = this.role(auth, roleId);
        this.editable(auth, role); if (DEVICES.includes(key)) this.deviceAssignable(auth, key, configuration.mapping);
        const { emoji } = DEVICE_ROLES[key], iconFeature = auth.guild.features?.includes('ROLE_ICONS') === true;
        let patch;
        if (iconFeature) patch = { unicode_emoji: emoji, icon: null };
        else {
          let name = key === 'king' ? 'King' : role.name;
          while (name.startsWith(emoji)) name = name.slice(emoji.length).trimStart();
          patch = { name: `${emoji} ${name}` };
          assert([...patch.name].length <= 100, 'Mit Symbol wäre der Rollenname zu lang.');
        }
        const unchanged = Object.entries(patch).every(([field, value]) => (role[field] ?? null) === value);
        if (unchanged) { results.push({ key, roleId, status: 'unchanged', mode: iconFeature ? 'role-icon' : 'role-name', message: 'Das gewünschte Symbol ist bereits gesetzt.' }); continue; }
        this.current(context); assert(this.data().revision === configuration.revision, 'Die Rollen-Zuordnung wurde inzwischen geändert.', 'conflict', 409);
        stage = 'sending';
        const updated = await this.community.request(context, 'PATCH', `/guilds/${auth.guild.id}/roles/${roleId}`, patch);
        assert(updated?.id === roleId && Object.entries(patch).every(([field, value]) => (updated[field] ?? null) === value), 'Discord hat das Rollensymbol nicht eindeutig bestätigt. Bitte die Rolle vor erneutem Ändern prüfen.', 'uncertain', 502);
        results.push({ key, roleId, status: 'applied', mode: iconFeature ? 'role-icon' : 'role-name', message: iconFeature ? 'Rollen-Icon gespeichert.' : 'Symbol im Rollennamen gespeichert.' });
      } catch (error) {
        results.push({ key, roleId, status: stage === 'sending' ? 'uncertain' : 'not-applied', message: problem(error) });
      }
    }
    this.mutate(d => { d.decorations = results; });
    return { ...(await this.state(context)), decorations: results, applied: results.filter(row => row.status === 'applied').length };
  }
  validPanel(data, snapshot = this.data()) {
    const panel = snapshot.publication;
    return snapshot.enabled && panel && panel.revision === snapshot.revision && panel.channelId === snapshot.channelId && data.guild_id === this.service.config.discordGuildId && data.message?.id === panel.messageId && data.channel_id === panel.channelId && same(panel.mapping, snapshot.mapping);
  }
  async publish(context) {
    const d = this.data();
    assert(d.enabled && d.channelId, 'Bitte die Geräteauswahl zuerst speichern und einschalten.');
    assert(!['sending', 'uncertain'].includes(d.publishAttempt?.status), 'Die letzte Veröffentlichung ist noch ungeklärt. Bitte zuerst in Discord prüfen; es wird keine zweite Karte automatisch gesendet.', 'uncertain', 409);
    const auth = await this.community.authority(context, MANAGE_ROLES, d.channelId); this.community.sendable(auth);
    for (const key of DEVICES) this.deviceAssignable(auth, key, d.mapping);
    const message = { embeds: [{ title: 'Auf welchen Geräten spielst du?', description: 'Wähle deine Geräte mit den Schaltflächen. Ein weiterer Klick entfernt das jeweilige Gerät. Du kannst mehrere Geräte angeben.\n\nKing und Moderator werden ausschließlich vom Team vergeben.', color: 0xD4AF37 }], allowed_mentions: { parse: [], users: [], roles: [] },
      components: [{ type: 1, components: DEVICES.map(key => ({ type: 2, style: 2, label: DEVICE_ROLES[key].label, emoji: { name: DEVICE_ROLES[key].emoji }, custom_id: `cbdevices:${key}` })) }] };
    this.current(context);
    this.mutate(current => { assert(current.revision === d.revision, 'Die Rollen-Zuordnung wurde inzwischen geändert.', 'conflict', 409); current.publishAttempt = { status: 'sending', at: Date.now(), channelId: d.channelId }; });
    let sent;
    try {
      if (d.publication?.channelId === d.channelId && CID.test(d.publication.messageId)) {
        const updated = await this.community.request(context, 'PATCH', `/channels/${d.channelId}/messages/${d.publication.messageId}`, message);
        assert(updated?.id === d.publication.messageId && (!updated.channel_id || updated.channel_id === d.channelId), 'Discord hat die Gerätekarte nicht eindeutig bestätigt.', 'uncertain', 502);
        sent = { id: updated.id, url: `https://discord.com/channels/${auth.guild.id}/${d.channelId}/${updated.id}` };
      } else sent = await this.community.post(context, auth, message);
    } catch (error) {
      this.mutate(current => { current.publishAttempt.status = error instanceof AppError && !['network', 'uncertain'].includes(error.kind) ? 'failed' : 'uncertain'; }); throw error;
    }
    this.mutate(current => { current.publishAttempt.status = 'published'; current.publication = { channelId: d.channelId, messageId: sent.id, revision: d.revision, mapping: d.mapping, publishedAt: Date.now() }; });
    return { ...(await this.state(context)), url: sent.url, published: true };
  }
  serialize(actorId, work) {
    const previous = this.actorQueues.get(actorId) || Promise.resolve();
    const next = previous.catch(() => {}).then(work); this.actorQueues.set(actorId, next);
    next.finally(() => { if (this.actorQueues.get(actorId) === next) this.actorQueues.delete(actorId); }).catch(() => {});
    return next;
  }
  interaction(data) {
    if (!data?.data?.custom_id?.startsWith('cbdevices:')) return null;
    try {
      this.community.identity();
      const key = data.data.custom_id.slice('cbdevices:'.length), actorId = discordId(data.member?.user?.id);
      assert(data.type === 3 && DEVICES.includes(key) && data.guild_id === this.service.config.discordGuildId && !data.member.user.bot, 'Diese Geräteauswahl ist nicht erlaubt.', 'forbidden', 403);
      assert(!data.member.pending, 'Bitte zuerst die Serverregeln und die Beitrittsprüfung abschließen.', 'forbidden', 403);
      const configuration = this.data(); assert(this.validPanel(data, configuration), 'Diese Gerätekarte ist nicht mehr aktiv. Bitte die aktuelle Karte verwenden.');
      return this.community.defer(data, () => this.serialize(actorId, async () => {
        assert(this.validPanel(data) && this.data().revision === configuration.revision, 'Die Geräteauswahl wurde inzwischen geändert.');
        let auth = await this.community.authority(null, MANAGE_ROLES);
        this.deviceAssignable(auth, key, configuration.mapping);
        const route = `/guilds/${auth.guild.id}/members/${actorId}`;
        const member = await this.community.request(null, 'GET', route);
        assert(member?.user?.id === actorId && Array.isArray(member.roles) && !member.user.bot, 'Dieses Mitglied konnte nicht bestätigt werden.', 'forbidden', 403);
        assert(member.pending !== true, 'Bitte zuerst die Serverregeln und die Beitrittsprüfung abschließen.', 'forbidden', 403);
        auth = await this.community.authority(null, MANAGE_ROLES);
        const role = this.deviceAssignable(auth, key, configuration.mapping);
        assert(this.validPanel(data) && this.data().revision === configuration.revision, 'Die Geräteauswahl wurde inzwischen geändert.');
        const removing = member.roles.includes(role.id);
        await this.community.request(null, removing ? 'DELETE' : 'PUT', `${route}/roles/${role.id}`);
        const updated = await this.community.request(null, 'GET', route);
        assert(updated?.user?.id === actorId && Array.isArray(updated.roles) && updated.roles.includes(role.id) === !removing, 'Discord hat deine Geräteauswahl nicht eindeutig bestätigt. Bitte dein Profil prüfen, bevor du erneut klickst.', 'uncertain', 502);
        return `${DEVICE_ROLES[key].emoji} ${DEVICE_ROLES[key].label} ${removing ? 'entfernt' : 'ausgewählt'}. Deine anderen Rollen bleiben erhalten.`;
      }));
    } catch (error) { return ephemeral(problem(error)); }
  }
}
