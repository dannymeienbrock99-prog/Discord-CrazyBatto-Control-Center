import { randomUUID } from 'node:crypto';
import { AppError, assert, safeMessage } from './errors.mjs';
import { inspectImageBytes } from './payloads.mjs';

const SETTING = 'discord_directory_v1';
const OWNER_GUILD = process.env.DISCORD_GUILD_ID || '900000000000000018';
const OWNER_BANNER = '/assets/team-alpha-banner-motion-20261016.gif';
const OWNER_POSTER = '/assets/team-alpha-banner-motion-poster-20261016.webp';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SNOWFLAKE = /^\d{17,20}$/;
const HASH = /^(?:a_)?[a-f0-9]{32}$/;
const CODE = /^[A-Za-z0-9_-]{2,100}$/;
const FRESH_MS = 5 * 60_000;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const IMAGE_CACHE_LIMIT = 32 * 1024 * 1024;
export const DISCORD_DIRECTORY_LIMITS = Object.freeze({ entries: 20, description: 300 });

function exact(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Die Serverangaben sind unvollständig oder enthalten unbekannte Felder.');
}
function source(value) {
  assert(typeof value === 'string' && value.length <= 250, 'Bitte einen Discord-Einladungslink oder eine Server-ID eingeben.');
  const raw = value.trim();
  if (SNOWFLAKE.test(raw)) return { kind: 'guild', value: raw, source: raw };
  if (CODE.test(raw)) return { kind: 'invite', value: raw, source: 'https://discord.gg/' + raw };
  let url; try { url = new URL(raw); } catch {}
  assert(url && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash, 'Erlaubt sind HTTPS-Einladungslinks von discord.gg oder discord.com/invite.');
  const match = url.hostname === 'discord.gg' ? /^\/([A-Za-z0-9_-]{2,100})\/?$/.exec(url.pathname)
    : url.hostname === 'discord.com' ? /^\/invite\/([A-Za-z0-9_-]{2,100})\/?$/.exec(url.pathname) : null;
  assert(match, 'Dieser Link ist kein unterstützter Discord-Einladungslink.');
  return { kind: 'invite', value: match[1], source: 'https://discord.gg/' + match[1] };
}
const label = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

async function bytes(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) { await response.body?.cancel(); throw new AppError('network', 'Die Discord-Antwort ist zu groß.', 502); }
  assert(response.body, 'Discord hat keine lesbare Antwort geliefert.', 'network', 502);
  const reader = response.body.getReader(), parts = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      assert(length <= maximum, 'Die Discord-Antwort ist zu groß.', 'network', 502);
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts);
}
async function body(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte unkomprimierte JSON-Daten senden.', 'validation', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 24 * 1024, 'Die Serverliste ist zu groß.', 'validation', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('validation', 'Die Serverliste enthält kein gültiges JSON.', 400); }
}

// Only explicitly curated entries are published. There is deliberately no bot
// guild-list discovery here, and browsers never contact the Discord API/CDN.
export class DiscordDirectory {
  constructor(service, { fetchImpl = globalThis.fetch } = {}) {
    this.accounts = service.accounts; this.config = service.config;
    this.store = this.accounts.store; this.now = this.accounts.now; this.fetch = fetchImpl;
    this.pending = new Map(); this.images = new Map(); this.imagePending = new Map();
    this.imageFailures = new Map(); this.imageBytes = 0; this.activeFetches = 0; this.retryUntil = 0;
    this.store.transaction(() => {
      this.store.db.exec(`CREATE TABLE IF NOT EXISTS discord_directory_cache (
        source TEXT PRIMARY KEY, data TEXT, checked_at INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '');`);
      if (this.store.setting(SETTING) === undefined) this.store.setSetting(SETTING, JSON.stringify({ revision: 0, entries: [{
        id: randomUUID(), source: process.env.DISCORD_INVITE_URL || 'https://discord.gg/YOUR_INVITE_CODE', guildId: OWNER_GUILD,
        description: '', visible: true, bannerMode: 'owner'
      }] }));
    });
  }
  settings() { return JSON.parse(this.store.setting(SETTING)); }
  cached(entry) {
    const row = this.store.get('SELECT * FROM discord_directory_cache WHERE source=?', entry.source);
    return row ? { ...row, data: row.data ? JSON.parse(row.data) : null } : null;
  }
  async details(rawSource, signal = null) {
    const parsed = source(rawSource);
    assert(this.now() >= this.retryUntil, 'Discord begrenzt die Abfragen. Bitte später erneut versuchen.', 'rate_limited', 429);
    const route = parsed.kind === 'invite' ? '/invites/' + parsed.value + '?with_counts=true' : '/guilds/' + parsed.value + '?with_counts=true';
    const headers = { Accept: 'application/json', 'User-Agent': 'Crazy_Batto-Serververzeichnis/1.0' };
    if (parsed.kind === 'guild') {
      assert(this.config.botToken, 'Für eine reine Server-ID muss der Bot eingerichtet und auf diesem Server Mitglied sein. Bitte sonst einen Einladungslink verwenden.', 'unconfigured', 503);
      headers.Authorization = 'Bot ' + this.config.botToken;
    }
    let response;
    const timeout = AbortSignal.timeout(8000);
    try { response = await this.fetch('https://discord.com/api/v10' + route, { headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch { throw new AppError('network', 'Die Serverdaten konnten gerade nicht von Discord geladen werden.', 502); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        this.retryUntil = this.now() + Math.min(300_000, Math.max(60_000, Number.isFinite(seconds) ? seconds * 1000 : 60_000));
        throw new AppError('rate_limited', 'Discord begrenzt die Abfragen. Bitte später erneut versuchen.', 429);
      }
      if ([401, 403, 404].includes(response.status)) throw new AppError('discord_unavailable', parsed.kind === 'invite'
        ? 'Der Einladungslink ist ungültig, abgelaufen oder nicht öffentlich erreichbar.'
        : 'Der Bot kann diese Server-ID nicht lesen. Bitte einen gültigen Einladungslink verwenden.', 422);
      throw new AppError('network', 'Discord konnte die Serverdaten derzeit nicht bereitstellen.', 502);
    }
    let raw;
    try { raw = JSON.parse((await bytes(response, 256 * 1024)).toString('utf8')); }
    catch { throw new AppError('network', 'Discord hat keine gültigen Serverdaten geliefert.', 502); }
    const guild = parsed.kind === 'invite' ? raw?.guild : raw;
    assert(guild && typeof guild.id === 'string' && SNOWFLAKE.test(guild.id) && label(guild.name, 100), 'Dieser Link gehört nicht zu einem erreichbaren Discord-Server.', 'validation', 422);
    if (parsed.kind === 'guild') assert(guild.id === parsed.value, 'Discord hat einen anderen Server zurückgegeben.', 'network', 502);
    return { guildId: guild.id, name: label(guild.name, 100),
      banner: typeof guild.banner === 'string' && HASH.test(guild.banner) ? guild.banner : null,
      icon: typeof guild.icon === 'string' && HASH.test(guild.icon) ? guild.icon : null,
      memberCount: count(raw.approximate_member_count), onlineCount: count(raw.approximate_presence_count),
      inviteUrl: parsed.kind === 'invite' ? parsed.source : null, updatedAt: this.now() };
  }
  refresh(entry) {
    const current = this.cached(entry);
    if (current && this.now() - current.checked_at < (current.last_error ? 60_000 : FRESH_MS)) return Promise.resolve();
    if (this.pending.has(entry.source)) return this.pending.get(entry.source);
    if (this.activeFetches >= 4) return Promise.resolve();
    this.activeFetches++;
    const task = (async () => {
      let data = null, error = '';
      try {
        data = await this.details(entry.source);
        assert(data.guildId === entry.guildId, 'Die Einladung gehört inzwischen zu einem anderen Server.', 'discord_unavailable', 422);
      } catch (cause) { error = cause instanceof AppError && cause.kind === 'discord_unavailable' ? 'unavailable' : 'temporary'; }
      const live = this.settings().entries.find(item => item.id === entry.id && item.source === entry.source && item.guildId === entry.guildId);
      if (!live) return;
      // Failed refreshes keep the timestamp of the last successful snapshot.
      // A changed or expired invite never silently publishes another guild.
      this.store.run(`INSERT INTO discord_directory_cache(source,data,checked_at,last_error) VALUES (?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET data=COALESCE(excluded.data,data),checked_at=excluded.checked_at,last_error=excluded.last_error`,
      entry.source, !error && data ? JSON.stringify(data) : null, this.now(), error);
    })().catch(() => {}).finally(() => { this.pending.delete(entry.source); this.activeFetches--; });
    this.pending.set(entry.source, task); return task;
  }
  view(entry, admin = false) {
    const cached = this.cached(entry), data = cached?.data;
    const usable = data?.guildId === entry.guildId;
    const prefix = admin ? '/api/admin/discord-servers/' : '/api/discord-servers/';
    return { id: entry.id, guildId: entry.guildId, name: usable ? data.name : null, description: entry.description,
      memberCount: usable ? data.memberCount : null, onlineCount: usable ? data.onlineCount : null, countsApproximate: true,
      bannerUrl: entry.bannerMode === 'owner' ? OWNER_BANNER : usable && data.banner ? prefix + entry.id + '/images/banner' : null,
      bannerPosterUrl: entry.bannerMode === 'owner' ? OWNER_POSTER : null,
      iconUrl: usable && data.icon ? prefix + entry.id + '/images/icon' : null,
      inviteUrl: usable && cached.last_error !== 'unavailable' ? data.inviteUrl : null,
      updatedAt: usable ? data.updatedAt : null,
      status: !usable ? 'unavailable' : cached.last_error || this.now() - data.updatedAt >= FRESH_MS ? 'stale' : 'ready' };
  }
  async list(admin = false) {
    const selected = this.settings().entries.filter(entry => admin || entry.visible);
    // Bound the initial response even when Discord is slow. Remaining updates
    // finish in the background and are visible on the next refresh.
    const pending = selected.map(entry => this.refresh(entry));
    let timer;
    try { await Promise.race([Promise.allSettled(pending), new Promise(resolve => { timer = setTimeout(resolve, 1200); timer.unref?.(); })]); }
    finally { clearTimeout(timer); }
    const latest = this.settings();
    if (admin) return { revision: latest.revision, entries: latest.entries.map(entry => ({ ...entry, server: this.view(entry, true) })), limits: DISCORD_DIRECTORY_LIMITS };
    return { servers: latest.entries.filter(entry => entry.visible).map(entry => this.view(entry)), refreshAfterSeconds: 60 };
  }
  async save(context, value) {
    exact(value, ['expectedRevision', 'entries']);
    const before = this.settings();
    assert(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision === before.revision, 'Die Serverliste wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
    assert(Array.isArray(value.entries) && value.entries.length <= DISCORD_DIRECTORY_LIMITS.entries, 'Es sind höchstens 20 Server erlaubt.');
    const seenIds = new Set(), seenSources = new Set(), updates = new Map();
    const entries = value.entries.map(item => {
      exact(item, ['id', 'source', 'description', 'visible', 'bannerMode']);
      assert(item.id === null || typeof item.id === 'string' && UUID.test(item.id) && before.entries.some(old => old.id === item.id), 'Der Servereintrag ist unbekannt. Bitte die Liste neu laden.');
      const id = item.id || randomUUID(), parsed = source(item.source);
      assert(!seenIds.has(id) && !seenSources.has(parsed.source), 'Ein Server darf nur einmal in der Liste stehen.');
      seenIds.add(id); seenSources.add(parsed.source);
      assert(typeof item.description === 'string' && item.description.length <= DISCORD_DIRECTORY_LIMITS.description && !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(item.description), 'Die Beschreibung darf höchstens 300 Zeichen enthalten; Zeilenumbrüche sind erlaubt.');
      assert(typeof item.visible === 'boolean' && ['discord', 'owner'].includes(item.bannerMode), 'Sichtbarkeit oder Banner-Auswahl sind ungültig.');
      const old = before.entries.find(entry => entry.id === id && entry.source === parsed.source);
      return { id, source: parsed.source, guildId: old?.guildId || '', description: item.description.replace(/\r\n?/g, '\n').trim(), visible: item.visible, bannerMode: item.bannerMode };
    });
    // Only newly added or changed sources need a successful Discord lookup;
    // hiding/removing an unavailable server remains possible during an outage.
    const needsLookup = entries.filter(entry => !entry.guildId);
    assert(this.activeFetches + Math.min(needsLookup.length, 2) <= 6, 'Discord wird gerade abgefragt. Bitte kurz warten.', 'rate_limited', 429);
    let cursor = 0;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12_000);
    timer.unref?.();
    try {
      await Promise.all(Array.from({ length: Math.min(needsLookup.length, 2) }, async () => {
        try {
          for (;;) {
            const entry = needsLookup[cursor++]; if (!entry) return;
            assert(!controller.signal.aborted, 'Die Serverprüfung dauert zu lange. Bitte weniger neue Server auf einmal hinzufügen.', 'network', 503);
            this.accounts.assertCurrent(context, { admin: true });
            this.activeFetches++;
            try { const data = await this.details(entry.source, controller.signal); entry.guildId = data.guildId; updates.set(entry.source, data); }
            finally { this.activeFetches--; }
          }
        } catch (error) { controller.abort(); throw error; }
      }));
    } finally { clearTimeout(timer); }
    assert(new Set(entries.map(entry => entry.guildId)).size === entries.length, 'Derselbe Discord-Server ist bereits über eine andere Einladung eingetragen.');
    assert(entries.every(entry => entry.bannerMode !== 'owner' || entry.guildId === OWNER_GUILD), 'Das Crazy_Batto-Banner darf nur dem eigenen Server zugewiesen werden.');
    const admin = this.accounts.assertCurrent(context, { admin: true });
    this.store.transaction(() => {
      this.accounts.assertCurrent(context, { admin: true });
      const live = this.settings();
      assert(live.revision === value.expectedRevision && live.revision < Number.MAX_SAFE_INTEGER, 'Die Serverliste wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      this.store.setSetting(SETTING, JSON.stringify({ revision: live.revision + 1, entries }));
      for (const [key, data] of updates) this.store.run(`INSERT INTO discord_directory_cache(source,data,checked_at,last_error) VALUES (?,?,?,'')
        ON CONFLICT(source) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at,last_error=''`, key, JSON.stringify(data), this.now());
      for (const row of this.store.all('SELECT source FROM discord_directory_cache')) if (!seenSources.has(row.source)) this.store.run('DELETE FROM discord_directory_cache WHERE source=?', row.source);
      this.store.audit(admin.id, 'discord_directory.updated', null, { revision: live.revision + 1, count: entries.length, visible: entries.filter(entry => entry.visible).length }, this.now());
    });
    return { revision: value.expectedRevision + 1, entries: entries.map(entry => ({ ...entry, server: this.view(entry, true) })), limits: DISCORD_DIRECTORY_LIMITS };
  }
  imageDescriptor(id, kind, admin) {
    const entry = this.settings().entries.find(item => item.id === id && (admin || item.visible));
    assert(entry, 'Dieser Server ist nicht veröffentlicht.', 'not_found', 404);
    const data = this.cached(entry)?.data;
    assert(data?.guildId === entry.guildId && HASH.test(data[kind] || ''), 'Für diesen Server ist kein entsprechendes Discord-Bild verfügbar.', 'not_found', 404);
    const folder = kind === 'banner' ? 'banners' : 'icons', size = kind === 'banner' ? 1024 : 128;
    // Path components are strictly validated Discord IDs and image hashes.
    return 'https://cdn.discordapp.com/' + folder + '/' + entry.guildId + '/' + data[kind] + '.webp?size=' + size;
  }
  async image(id, kind, admin, authorize) {
    authorize();
    const url = this.imageDescriptor(id, kind, admin);
    let cached = this.images.get(url);
    if (!cached || this.now() - cached.at > 60 * 60_000) {
      assert((this.imageFailures.get(url) || 0) <= this.now(), 'Das Discord-Bild ist momentan nicht verfügbar.', 'network', 503);
      if (!this.imagePending.has(url)) {
        assert(this.imagePending.size < 4, 'Die Bilder werden gerade geladen. Bitte kurz warten.', 'rate_limited', 429);
        this.imagePending.set(url, (async () => {
          const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'image/webp' } });
          if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
            await response.body?.cancel(); throw new AppError('network', 'Das Discord-Bild ist momentan nicht verfügbar.', 503);
          }
          const data = await bytes(response, IMAGE_LIMIT), size = inspectImageBytes(data, 'image/webp');
          assert(size.width > 0 && size.height > 0 && size.width <= 4096 && size.height <= 4096 && size.width * size.height <= 16_777_216, 'Discord hat kein gültiges Vorschaubild geliefert.', 'network', 502);
          const old = this.images.get(url);
          if (old) { this.imageBytes -= old.bytes.length; this.images.delete(url); }
          while ((this.imageBytes + data.length > IMAGE_CACHE_LIMIT || this.images.size >= 80) && this.images.size) {
            const oldest = this.images.keys().next().value;
            this.imageBytes -= this.images.get(oldest).bytes.length; this.images.delete(oldest);
          }
          const result = { bytes: data, at: this.now() };
          this.images.set(url, result); this.imageBytes += data.length; this.imageFailures.delete(url);
          return result;
        })().catch(() => {
          if (this.imageFailures.size > 80) this.imageFailures.clear();
          this.imageFailures.set(url, this.now() + 60_000);
          throw new AppError('network', 'Das Discord-Bild ist momentan nicht verfügbar.', 503);
        }).finally(() => this.imagePending.delete(url)));
      }
      cached = await this.imagePending.get(url);
    }
    authorize();
    assert(this.imageDescriptor(id, kind, admin) === url, 'Das veröffentlichte Serverbild wurde inzwischen geändert.', 'not_found', 404);
    return cached.bytes;
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://local.invalid').pathname;
    if (!/^\/api\/(?:admin\/)?discord-servers(?:\/|$)/.test(route)) return false;
    const admin = route.startsWith('/api/admin/'), mutation = !['GET', 'HEAD'].includes(req.method);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (admin) res.setHeader('Vary', 'Cookie, Authorization');
    const send = (value, status = 200) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value));
    };
    try {
      const forwarded = this.config.trustProxy && typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
      this.accounts.limit('directory:' + (forwarded || req.socket?.remoteAddress || 'unknown'), 240);
      const context = admin ? await this.accounts.authenticateRequest(req, { mutation, requireAdmin: true }) : null;
      const authorize = () => { if (admin) this.accounts.assertCurrent(context, { admin: true }); };
      authorize();
      if (req.method === 'GET' && route === (admin ? '/api/admin/discord-servers' : '/api/discord-servers')) {
        const result = await this.list(admin); authorize(); send(result); return true;
      }
      if (admin && req.method === 'PUT' && route === '/api/admin/discord-servers') {
        this.accounts.limit('directory:save:' + context.user.id, 20, 10 * 60_000);
        const result = await this.save(context, await body(req)); authorize(); send(result); return true;
      }
      const image = /^\/api\/(?:admin\/)?discord-servers\/([^/]+)\/images\/(banner|icon)$/.exec(route);
      if (image && UUID.test(image[1]) && ['GET', 'HEAD'].includes(req.method)) {
        const imageBytes = await this.image(image[1], image[2], admin, authorize);
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': imageBytes.length });
          res.end(req.method === 'HEAD' ? undefined : imageBytes);
        }
        return true;
      }
      throw new AppError('not_found', 'Diese Serververzeichnis-Funktion ist nicht vorhanden.', 404);
    } catch (error) {
      const known = error instanceof AppError;
      if (known && error.retryAfterMs && !res.headersSent) res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      send({ ok: false, error: { code: known ? error.kind : 'network', message: known ? safeMessage(error.message) : 'Das Serververzeichnis ist gerade nicht erreichbar. Bitte erneut versuchen.' } }, known ? error.status : 500);
      return true;
    }
  }
}
