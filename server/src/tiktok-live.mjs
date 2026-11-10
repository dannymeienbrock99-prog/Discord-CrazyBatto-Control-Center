import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

const SETTINGS = 'control_tiktok_slots_v1', RUNTIME = 'control_tiktok_runtime_v1';
const ID = /^\d{17,20}$/, USER = /^[a-zA-Z0-9_.]{2,24}$/;
const TIKTOK_IMAGE_DOMAINS = ['tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com'];
function imageAddress(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host) || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) return null;
    if (/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(decodeURIComponent(url.pathname))) return null;
    return url.href;
  } catch { return null; }
}
export function tiktokImageUrl(value) {
  const safe = imageAddress(value);
  if (!safe) return null;
  const host = new URL(safe).hostname;
  return TIKTOK_IMAGE_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain)) ? safe : null;
}
function firstTikTokImage(...values) {
  for (const value of values) {
    const candidates = typeof value === 'string' ? [value] : value && typeof value === 'object' ? [...(Array.isArray(value.urlList) ? value.urlList.slice(0, 10) : []), ...(Array.isArray(value.url_list) ? value.url_list.slice(0, 10) : [])] : [];
    for (const candidate of candidates) { const safe = tiktokImageUrl(candidate); if (safe) return safe; }
  }
  return null;
}
export function tiktokPreview(slot, state) {
  const coverUrl = tiktokImageUrl(state.coverUrl), avatarUrl = tiktokImageUrl(state.avatarUrl), custom = imageAddress(slot.imageUrl);
  const live = state.status === 'live', last = live ? '' : 'Letztes ';
  const preview = coverUrl ? { kind: 'live-cover', imageUrl: coverUrl, label: last + 'TikTok-Cover · Standbild, kein Live-Video' }
    : custom ? { kind: 'custom-image', imageUrl: custom, label: 'Eigenes Ersatzbild · kein Livebild' }
    : avatarUrl ? { kind: 'creator-avatar', imageUrl: avatarUrl, label: 'TikTok-Profilbild · kein Livebild' }
    : { kind: 'unavailable', imageUrl: null, label: 'Keine Bildvorschau von TikTok verfügbar' };
  return { coverUrl, avatarUrl, liveUrl: USER.test(slot.username) ? `https://www.tiktok.com/@${slot.username}/live` : null, preview };
}
const fail = message => { throw new AppError('validation', message, 400); };
export const defaultSlots = () => Array.from({ length: 20 }, (_, n) => ({ id: String(n + 1), enabled: false, username: '', channelId: '', roleId: '', title: '{name} ist live!', description: 'Schau jetzt auf TikTok vorbei.', imageUrl: '' }));
function text(value, max) { if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('Bitte gültigen Text eingeben.'); return value.trim(); }
export function validateSlots(value) {
  if (!Array.isArray(value) || value.length !== 20) fail('Bitte alle 20 TikTok-Plätze speichern.');
  const names = new Set();
  return value.map((raw, n) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['id','enabled','username','channelId','roleId','title','description','imageUrl'].includes(k)) || raw.id !== String(n + 1) || typeof raw.enabled !== 'boolean') fail('Ungültiger TikTok-Platz.');
    const username = text(raw.username, 25).replace(/^@/, '').toLowerCase();
    const channelId = text(raw.channelId, 20), roleId = text(raw.roleId, 20);
    if ((username && !USER.test(username)) || (channelId && !ID.test(channelId)) || (roleId && !ID.test(roleId))) fail('Bitte TikTok-Name, Kanal und Rolle prüfen.');
    if (raw.enabled && (!username || !channelId)) fail('Aktive Plätze benötigen einen TikTok-Namen und Zielkanal.');
    if (raw.enabled && names.has(username)) fail('Ein TikTok-Konto darf nur einmal aktiv sein.');
    if (raw.enabled) names.add(username);
    const title = text(raw.title, 180), description = text(raw.description, 3000), imageUrl = text(raw.imageUrl, 1000);
    if (!title) fail('Bitte einen Titel für die Live-Nachricht eingeben.');
    if (imageUrl && !imageAddress(imageUrl)) fail('Bitte eine öffentliche HTTPS-Bildadresse ohne Zugangsdaten oder Video-Datei verwenden.');
    return { id: raw.id, enabled: raw.enabled, username, channelId, roleId, title, description, imageUrl };
  });
}

// Public, unsigned TikTok room lookup. No cookies, credentials, signing service,
// challenge handling or retry around a denial. Unknown data is never "offline".
export function parseTikTokStatus(data, now = Date.now()) {
  if (!data || Number(data.statusCode ?? data.status_code ?? 0) !== 0 || !data.data?.user) throw new Error('TikTok liefert zurzeit keinen lesbaren Live-Status.');
  const user = data.data.user, room = data.data.liveRoom;
  // The public LIVE response is undocumented and optional image fields vary.
  // Read supplied image metadata only; never construct a cover or fetch media.
  const coverUrl = firstTikTokImage(room?.coverUrl, room?.cover, room?.cover_url, room?.squareCoverImg);
  const avatarUrl = firstTikTokImage(user.avatarLarger, user.avatarMedium, user.avatarThumb, user.avatar_large, user.avatar_medium, user.avatar_thumb);
  const rawStatus = room?.status ?? user.status;
  const status = rawStatus === undefined || rawStatus === null ? NaN : Number(rawStatus);
  const roomId = String(user.roomId ?? room?.id_str ?? room?.id ?? '');
  if (status === 4 || (roomId === '0' && [0,4].includes(status))) return { status: 'offline', roomId: null, startedAt: null, name: String(user.nickname || user.uniqueId || '').slice(0,100), coverUrl, avatarUrl };
  if (status !== 2 || !/^\d{10,25}$/.test(roomId) || roomId === '0') throw new Error('TikTok bestätigt weder einen laufenden noch einen beendeten Livestream.');
  const seconds = Number(room?.createTime ?? room?.create_time), millis = seconds * 1000;
  const startedAt = Number.isFinite(millis) && millis > now - 7 * 86400_000 && millis <= now ? new Date(millis).toISOString() : null;
  return { status: 'live', roomId, startedAt, name: String(user.nickname || user.uniqueId || '').slice(0,100), coverUrl, avatarUrl };
}
export async function fetchTikTokStatus(username, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!USER.test(username)) fail('Ungültiger TikTok-Name.');
  const url = new URL('https://www.tiktok.com/api-live/user/room/');
  url.search = new URLSearchParams({ uniqueId: username, sourceType: '54', aid: '1988' }).toString();
  let response;
  try { response = await fetchImpl(url.href, { headers: { Accept: 'application/json', 'User-Agent': 'CrazyBatto-Control-Center/3.0 (Live notifications)' }, redirect: 'error', signal: AbortSignal.timeout(12_000) }); }
  catch { throw new Error('TikTok ist momentan nicht erreichbar.'); }
  if (!response.ok) { await response.body?.cancel?.(); throw new Error([403,429].includes(response.status) ? 'TikTok schränkt die Abfrage ein. Der Status bleibt unbekannt.' : 'TikTok hat die Abfrage nicht bestätigt.'); }
  const reader = response.body?.getReader(); let raw = '';
  if (reader) {
    const chunks = []; let size = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Die TikTok-Antwort ist zu groß.'); } chunks.push(Buffer.from(chunk.value)); }
    raw = Buffer.concat(chunks).toString('utf8');
  } else { raw = await response.text(); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Die TikTok-Antwort ist zu groß.'); }
  let data; try { data = JSON.parse(raw); } catch { throw new Error('TikTok liefert keine lesbaren Daten. Möglicherweise ist die öffentliche Abfrage eingeschränkt.'); }
  return parseTikTokStatus(data, now());
}

export class TikTokLive {
  constructor(service, { now = Date.now, lookup = fetchTikTokStatus } = {}) {
    this.service = service; this.store = service.accounts.store; this.now = now; this.lookup = lookup;
    this.queue = Promise.resolve(); this.timer = null; this.cursor = 0; this.running = false; this.nextManual = new Map(); this.nextPoll = new Map();
  }
  settings() { const raw = this.store.setting(SETTINGS); return raw ? validateSlots(JSON.parse(raw)) : defaultSlots(); }
  records() { const raw = this.store.setting(RUNTIME); if (!raw) return {}; const v = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('TikTok-Speicher ist nicht lesbar.'); return v; }
  enqueue(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  state() {
    const slots = this.settings(), records = this.records();
    return { slots, runtime: slots.map(slot => {
      const record = { slotId: slot.id, status: !slot.username ? 'unconfigured' : !slot.enabled ? 'disabled' : 'unknown', startedAt: null, detectedAt: null, lastCheckedAt: null, messageId: null, error: null, ...records[slot.id], ...(!slot.enabled ? { status: slot.username ? 'disabled' : 'unconfigured' } : {}) };
      return { ...record, ...tiktokPreview(slot, record) };
    }), pollIntervalSeconds: 300,
      provider: { name: 'TikTok – öffentliche Live-Abfrage', available: true, experimental: true, message: 'TikTok kann öffentliche Abfragen einschränken. Abruffehler werden angezeigt. Der Timer beginnt beim bestätigten Start, sonst bei der Erkennung.' } };
  }
  async run(context, action, payload = {}) {
    return this.enqueue(async () => {
      const ensure = () => this.service.accounts.assertCurrent(context, { admin: true }); ensure();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload.guildId !== undefined && payload.guildId !== this.service.config.discordGuildId)) fail('Diese Anfrage gehört nicht zum konfigurierten Server.');
      if (action === 'tiktok.state') return this.state();
      if (action === 'tiktok.save') {
        if (Object.keys(payload).some(k => !['slots','guildId'].includes(k))) fail('Unbekannte TikTok-Einstellung.');
        const slots = validateSlots(payload.slots);
        const admin = await this.service.discordControl.admin(context), gid = this.service.config.discordGuildId;
        const channels = await admin.client.request('GET', `/guilds/${gid}/channels`), roles = await admin.client.request('GET', `/guilds/${gid}/roles`);
        for (const slot of slots) {
          if (slot.channelId && !channels.some(c => c.id === slot.channelId && [0,5].includes(c.type))) fail('Der TikTok-Zielkanal muss ein Textkanal dieses Servers sein.');
          if (slot.roleId && (slot.roleId === gid || !roles.some(r => r.id === slot.roleId))) fail('Die gewählte Rolle gehört nicht zu diesem Server.');
        }
        const old = this.settings(), records = this.records();
        for (const slot of slots) if (old[Number(slot.id)-1].username !== slot.username) delete records[slot.id];
        ensure(); this.store.transaction(() => { this.store.setSetting(SETTINGS, JSON.stringify(slots)); this.store.setSetting(RUNTIME, JSON.stringify(records)); });
        return this.state();
      }
      if (action === 'tiktok.check') {
        if (Object.keys(payload).some(k => !['slotId','guildId'].includes(k))) fail('Unbekannte TikTok-Angabe.');
        const slot = this.settings().find(s => s.id === payload.slotId); if (!slot?.username) fail('Bitte diesen TikTok-Platz zuerst speichern.');
        if ((this.nextManual.get(slot.id) || 0) > this.now()) fail('Bitte 30 Sekunden bis zur nächsten Prüfung warten.');
        this.nextManual.set(slot.id, this.now()+30_000); await this.checkSlot(slot, false, ensure); ensure(); return this.state();
      }
      fail('Unbekannte TikTok-Aktion.');
    });
  }
  start() {
    if (this.running) return; this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.enqueue(async () => { const slots = this.settings(); for (let i=0;i<20;i++) { const slot = slots[this.cursor++ % 20]; if (slot.enabled && (this.nextPoll.get(slot.username) || 0) <= this.now()) { this.nextPoll.set(slot.username, this.now()+300_000); await this.checkSlot(slot, true); break; } } }).catch(() => {});
      if (this.running) { this.timer = setTimeout(tick, 15_000); this.timer.unref?.(); }
    };
    this.timer = setTimeout(tick, 15_000); this.timer.unref?.();
  }
  async stop() { this.running = false; clearTimeout(this.timer); await this.queue; }
  async checkSlot(slot, notify, ensure = () => {}) {
    const records = this.records(), prev = records[slot.id] || {}, checkedAt = new Date(this.now()).toISOString();
    let found;
    try { found = await this.lookup(slot.username, { now: this.now }); }
    catch (error) { ensure(); records[slot.id] = { ...prev, status: 'error', lastCheckedAt: checkedAt, error: String(error.message || 'TikTok konnte nicht geprüft werden.').slice(0,300) }; this.store.setSetting(RUNTIME, JSON.stringify(records)); return; }
    ensure();
    const sameRoom = found.roomId && found.roomId === prev.roomId;
    const entry = records[slot.id] = { ...prev, ...found, slotId: slot.id, lastCheckedAt: checkedAt, error: null,
      coverUrl: tiktokImageUrl(found.coverUrl) || ((sameRoom || found.status === 'offline') ? tiktokImageUrl(prev.coverUrl) : null),
      avatarUrl: tiktokImageUrl(found.avatarUrl) || tiktokImageUrl(prev.avatarUrl),
      detectedAt: found.status === 'live' ? sameRoom && prev.detectedAt || checkedAt : prev.detectedAt || null,
      startedAt: found.status === 'live' ? found.startedAt || (sameRoom && prev.startedAt) || checkedAt : prev.startedAt || null,
      startEstimated: found.status === 'live' ? !found.startedAt && !(sameRoom && prev.startEstimated === false) : prev.startEstimated };
    this.store.setSetting(RUNTIME, JSON.stringify(records));
    if (!notify || !this.running || !slot.enabled) return;
    if (found.status === 'live' && prev.attemptedRoom !== found.roomId) {
      // Persist before network transmission. Ambiguous deliveries are shown and
      // never automatically retried, including after a process restart.
      entry.attemptedRoom = found.roomId; entry.delivery = 'sending'; entry.messageId = null;
      entry.endedAt = null;
      entry.messageChannelId = slot.channelId; this.store.setSetting(RUNTIME, JSON.stringify(records));
      try {
        const channel = await this.service.discord.request('GET', `/channels/${slot.channelId}`);
        if (channel?.guild_id !== this.service.config.discordGuildId || ![0,5].includes(channel.type)) throw new Error('Ungültiger Discord-Zielkanal.');
        const payload = this.message(slot, entry, true);
        payload.nonce = createHash('sha256').update(`${slot.id}:${slot.username}:${found.roomId}`).digest('hex').slice(0,24); payload.enforce_nonce = true;
        const result = await this.service.discord.request('POST', `/channels/${slot.channelId}/messages`, { payload });
        if (!ID.test(result?.id || '') || (result.channel_id !== undefined && result.channel_id !== slot.channelId)) throw new Error('Unbestätigte Discord-Nachricht.');
        entry.messageId = result.id; entry.delivery = 'sent';
      } catch { entry.delivery = 'uncertain'; entry.error = 'Die Live-Nachricht wurde nicht bestätigt. Bitte zuerst im Discord-Kanal prüfen; sie wird nicht automatisch doppelt gesendet.'; }
      this.store.setSetting(RUNTIME, JSON.stringify(records));
    } else if (found.status === 'offline' && prev.messageId && !prev.endedAt) {
      entry.endedAt = checkedAt; this.store.setSetting(RUNTIME, JSON.stringify(records));
      try {
        if (!ID.test(prev.messageChannelId || '') || !ID.test(prev.messageId || '')) throw new Error('Ungültige gespeicherte Nachricht.');
        const channel = await this.service.discord.request('GET', `/channels/${prev.messageChannelId}`);
        if (channel?.guild_id !== this.service.config.discordGuildId || ![0,5].includes(channel.type)) throw new Error('Ungültiger Discord-Zielkanal.');
        await this.service.discord.request('PATCH', `/channels/${prev.messageChannelId}/messages/${prev.messageId}`, { payload: this.message(slot, entry, false) });
      }
      catch { entry.error = 'Der Stream ist beendet. Die Discord-Nachricht konnte nicht aktualisiert werden.'; }
      this.store.setSetting(RUNTIME, JSON.stringify(records));
    }
  }
  message(slot, state, live) {
    const seconds = Math.floor(Date.parse(state.startedAt) / 1000);
    const name = String(state.name || slot.username).replace(/@/g, '@\u200b');
    const title = live ? slot.title.replaceAll('{name}', name).slice(0,256) : `${name} · Livestream beendet`;
    const embed = { title, description: slot.description.replaceAll('{name}', name).slice(0,4096), color: live ? 0xd4af57 : 0x64646a,
      url: `https://www.tiktok.com/@${slot.username}/live`, fields: [{ name: live ? state.startEstimated ? 'Live erkannt' : 'Live seit' : 'Dauer ab Erkennung / Start', value: live ? `<t:${seconds}:R> · <t:${seconds}:t>` : `${Math.max(0, Math.floor((Date.parse(state.endedAt)-Date.parse(state.startedAt))/60000))} Minuten`, inline: true }], footer: { text: 'Crazy_Batto · Live-Benachrichtigung' } };
    const metadata = tiktokPreview(slot, { ...state, status: live ? 'live' : 'offline' });
    if (metadata.preview.imageUrl) embed.image = { url: metadata.preview.imageUrl };
    if (metadata.avatarUrl && metadata.preview.kind !== 'creator-avatar') embed.thumbnail = { url: metadata.avatarUrl };
    embed.footer.text += ' · ' + metadata.preview.label;
    return { content: live && slot.roleId ? `<@&${slot.roleId}>` : '', embeds: [embed],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: live ? 'Livestream auf TikTok ansehen' : 'TikTok-Kanal öffnen', url: live ? metadata.liveUrl : `https://www.tiktok.com/@${slot.username}` }] }],
      allowed_mentions: { parse: [], roles: live && slot.roleId ? [slot.roleId] : [], users: [], replied_user: false } };
  }
}
