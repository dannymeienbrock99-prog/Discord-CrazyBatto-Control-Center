'use strict';

const { DiscordClient } = require('./discord-client.cjs');
const V = require('./validation.cjs');
const { randomUUID } = require('node:crypto');

class AdminService {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.Client = options.Client || DiscordClient;
    this.client = null;
    this.bot = null;
    this.guilds = [];
    this.logs = storage.read('logs', []);
    this.connecting = false;
  }
  state() { return { connected: Boolean(this.client && this.bot), bot: this.bot, guilds: this.guilds, remembered: this.storage.hasToken() }; }
  log(action, status, detail = '') {
    this.logs.unshift({ id: randomUUID(), time: new Date().toISOString(), action, status, detail: String(detail).slice(0,300) });
    this.logs = this.logs.slice(0,200);
    // A failed local audit write must not report a successful Discord mutation as failed.
    // Otherwise a user may repeat a message or event that Discord already accepted.
    try { this.storage.write('logs', this.logs); } catch { /* Keep the in-memory history available. */ }
  }
  async connect(payload) {
    if (this.connecting) throw new Error('Eine Verbindung wird bereits aufgebaut.');
    this.connecting = true;
    try {
      const token = payload.token || this.storage.readToken();
      if (!token) throw new Error('Bitte deinen Bot-Token eintragen.');
      const candidate = new this.Client(token);
      const bot = await candidate.request('GET','/users/@me');
      if (!bot.bot) throw new Error('Diese App unterstützt ausschließlich offizielle Bot-Konten.');
      const guilds = [];
      let after = '';
      for (let page = 0; page < 100; page++) {
        const list = await candidate.request('GET',`/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`);
        if (!Array.isArray(list)) throw new Error('Discord hat keine gültige Serverliste geliefert.');
        guilds.push(...list);
        if (list.length < 200) break;
        const next = list.at(-1).id;
        if (next === after) break;
        after = V.id(next);
      }
      if (payload.remember === true) this.storage.saveToken(token);
      else if (payload.token) this.storage.deleteToken();
      this.client = candidate;
      this.bot = { id:bot.id, username:bot.username, discriminator:bot.discriminator, avatar:bot.avatar, bot:true, global_name:bot.global_name };
      this.guilds = guilds;
      this.log('Bot verbunden', 'success', bot.username);
      return this.state();
    } finally { this.connecting = false; }
  }
  requireClient() { if (!this.client) throw new Error('Bitte zuerst deinen Discord-Bot verbinden.'); return this.client; }
  requireGuild(value) {
    this.requireClient();
    const guildId = V.id(value,'Server-ID');
    if (!this.guilds.some(g => g.id === guildId)) throw new Error('Dieser Server gehört nicht zur verbundenen Bot-Auswahl.');
    return guildId;
  }
  async channelInGuild(guildId, channelId) {
    const channel = await this.client.request('GET', `/channels/${V.id(channelId,'Kanal-ID')}`);
    if (channel.guild_id !== guildId) throw new Error('Der Kanal gehört nicht zum ausgewählten Server.');
    return channel;
  }
  async run(action, payload = {}) {
    V.object(payload);
    switch (action) {
      case 'app.state': return this.state();
      case 'bot.connect': return this.connect(payload);
      case 'bot.disconnect':
        if (this.connecting) throw new Error('Bitte den Verbindungsaufbau abwarten.');
        this.client = null; this.bot = null; this.guilds = [];
        if (payload.forget) this.storage.deleteToken();
        this.log('Verbindung getrennt','success'); return this.state();
      case 'guild.load': {
        const guildId = this.requireGuild(payload.guildId);
        const [guild,channels,roles,events] = await Promise.all([
          this.client.request('GET',`/guilds/${guildId}?with_counts=true`),
          this.client.request('GET',`/guilds/${guildId}/channels`),
          this.client.request('GET',`/guilds/${guildId}/roles`),
          this.client.request('GET',`/guilds/${guildId}/scheduled-events?with_user_count=true`)
        ]);
        return { guild, channels, roles, events };
      }
      case 'message.send': {
        const guildId = this.requireGuild(payload.guildId);
        const channel = await this.channelInGuild(guildId, payload.channelId);
        if (![0,5,10,11,12].includes(channel.type)) throw new Error('Bitte einen Text- oder Ankündigungskanal wählen.');
        const built = V.buildMessage(payload);
        if (built.payload.allowed_mentions.roles.length) {
          const roles = await this.client.request('GET',`/guilds/${guildId}/roles`);
          if (built.payload.allowed_mentions.roles.some(roleId => roleId === guildId || !roles.some(role => role.id === roleId))) throw new Error('Eine ausgewählte Rolle ist ungültig. @everyone ist nicht erlaubt.');
        }
        // A random nonce plus enforce_nonce prevents duplicate posts if Discord retries internally.
        built.payload.nonce = `${Date.now()}${Math.floor(Math.random()*1000000).toString().padStart(6,'0')}`;
        built.payload.enforce_nonce = true;
        const sent = await this.client.request('POST',`/channels/${channel.id}/messages`,built.payload,built.image);
        this.log('Einbettung gesendet','success',`#${channel.name}`);
        return { id:sent.id, url:`https://discord.com/channels/${guildId}/${channel.id}/${sent.id}` };
      }
      case 'guild.update': {
        const guildId = this.requireGuild(payload.guildId);
        const update = {};
        if (payload.name !== undefined) update.name = V.text(payload.name,100,'Servername',{required:true,min:2}).trim();
        if (payload.description !== undefined) update.description = V.text(payload.description,300,'Serverbeschreibung') || null;
        for (const key of ['icon','banner']) if (payload[key] !== undefined) { V.imageData(payload[key]); update[key] = payload[key]; }
        if (!Object.keys(update).length) throw new Error('Bitte mindestens eine Änderung eingeben.');
        const guild = await this.client.request('PATCH',`/guilds/${guildId}`,update);
        this.guilds = this.guilds.map(g => g.id === guildId ? {...g,name:guild.name,icon:guild.icon} : g);
        this.log('Server gestaltet','success',guild.name); return guild;
      }
      case 'channel.create':
      case 'channel.update': {
        const guildId = this.requireGuild(payload.guildId);
        const update = { name:V.text(payload.name,100,'Kanalname',{required:true}).trim() };
        let channelType;
        if (action === 'channel.create') {
          const type = payload.type == null ? 0 : Number(payload.type);
          if (![0,2,4,5,13,15].includes(type)) throw new Error('Dieser Kanaltyp wird nicht unterstützt.');
          update.type = type;
          channelType = type;
        } else {
          channelType = (await this.channelInGuild(guildId,payload.channelId)).type;
        }
        if (payload.topic !== undefined && [0,5,15,16].includes(channelType)) update.topic = V.text(payload.topic,channelType === 15 || channelType === 16 ? 4096 : 1024,'Kanalthema');
        if (payload.parentId) {
          const parent = await this.channelInGuild(guildId,payload.parentId);
          if (parent.type !== 4) throw new Error('Bitte eine gültige Kategorie wählen.');
          update.parent_id = parent.id;
        } else if (payload.parentId === null) update.parent_id = null;
        const channel = await this.client.request(action === 'channel.create' ? 'POST' : 'PATCH', action === 'channel.create' ? `/guilds/${guildId}/channels` : `/channels/${payload.channelId}`, update);
        this.log(action === 'channel.create' ? 'Kanal erstellt' : 'Kanal geändert','success',channel.name); return channel;
      }
      case 'role.create':
      case 'role.update': {
        const guildId = this.requireGuild(payload.guildId);
        const update = { name:V.text(payload.name,100,'Rollenname',{required:true}),color:V.color(payload.color) ?? 0,mentionable:Boolean(payload.mentionable),hoist:Boolean(payload.hoist) };
        if (action === 'role.update') {
          V.id(payload.roleId,'Rollen-ID');
          const roles = await this.client.request('GET',`/guilds/${guildId}/roles`);
          const role = roles.find(r=>r.id === payload.roleId);
          if (!role || role.managed || role.id === guildId) throw new Error('Diese Rolle kann in der App nicht bearbeitet werden.');
        }
        const role = await this.client.request(action === 'role.create' ? 'POST' : 'PATCH', `/guilds/${guildId}/roles${action === 'role.update' ? `/${payload.roleId}` : ''}`,update);
        this.log(action === 'role.create' ? 'Rolle erstellt' : 'Rolle geändert','success',role.name); return role;
      }
      case 'bot.profile': {
        this.requireClient();
        const update = {};
        if (payload.username !== undefined) update.username = V.text(payload.username,32,'Bot-Name',{required:true,min:2});
        if (payload.avatar !== undefined) { V.imageData(payload.avatar); update.avatar = payload.avatar; }
        if (!Object.keys(update).length) throw new Error('Bitte einen Namen oder ein Bild eingeben.');
        const bot = await this.client.request('PATCH','/users/@me',update);
        this.bot = {...this.bot,username:bot.username,avatar:bot.avatar};
        this.log('Bot-Profil aktualisiert','success',bot.username); return this.bot;
      }
      case 'event.create': {
        const guildId = this.requireGuild(payload.guildId);
        const start = new Date(payload.start), end = new Date(payload.end);
        if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start.getTime() <= Date.now() || end <= start) throw new Error('Das Event muss in der Zukunft beginnen und danach enden.');
        const body = { name:V.text(payload.name,100,'Eventname',{required:true}),description:V.text(payload.description,1000,'Eventbeschreibung'),scheduled_start_time:start.toISOString(),scheduled_end_time:end.toISOString(),privacy_level:2,entity_type:3,entity_metadata:{location:V.text(payload.location,100,'Ort oder Link',{required:true})} };
        if (!body.description) delete body.description;
        const event = await this.client.request('POST',`/guilds/${guildId}/scheduled-events`,body);
        this.log('Event erstellt','success',event.name); return event;
      }
      case 'log.list': return this.logs;
      case 'templates.list': return this.storage.read('templates',[]);
      case 'templates.save': {
        const templates = this.storage.read('templates',[]);
        const name = V.text(payload.name,100,'Vorlagenname',{required:true});
        const draft = V.cleanDraft(payload.draft);
        if (templates.length >= 100 && !templates.some(t=>t.id === payload.id)) throw new Error('Höchstens 100 Vorlagen können gespeichert werden.');
        const template = {id: typeof payload.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(payload.id) ? payload.id : randomUUID(),name,draft,updatedAt:new Date().toISOString()};
        const next = templates.filter(t=>t.id !== template.id); next.unshift(template);
        this.storage.write('templates',next); return template;
      }
      case 'templates.delete': {
        const templates = this.storage.read('templates',[]);
        this.storage.write('templates',templates.filter(t=>t.id !== payload.id)); return {deleted:true};
      }
      case 'settings.get': return this.storage.read('settings',{});
      case 'settings.save': {
        const settings = V.object(payload.settings,'Einstellungen');
        const clean = {...this.storage.read('settings',{})};
        if (settings.lastGuildId) clean.lastGuildId = V.id(settings.lastGuildId);
        if (settings.accent) { V.color(settings.accent); clean.accent = settings.accent; }
        if (typeof settings.compact === 'boolean') clean.compact = settings.compact;
        if (typeof settings.joinRequestNotifications === 'boolean') clean.joinRequestNotifications = settings.joinRequestNotifications;
        this.storage.write('settings',clean); return clean;
      }
      default: throw new Error('Diese Aktion wird nicht unterstützt.');
    }
  }
}
module.exports = { AdminService };
