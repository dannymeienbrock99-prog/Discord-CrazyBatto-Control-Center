import { createHash } from 'node:crypto';
import { AppError, assert, errorBody, safeMessage } from './errors.mjs';
import { birthDate } from './member-profile.mjs';
import { readBody, parseJson } from './multipart.mjs';
import { P, has, channelPermissions } from './permissions.mjs';

const ZONE = 'Europe/Berlin';
const DAY = 86400_000;
const ID = /^\d{17,20}$/;
const SETTINGS_KEY = 'birthday_settings_v1';
const defaults = Object.freeze({ enabled: false, channelId: '', reminderDays: 3, hour: 10,
  greetingTemplate: '🎂 Alles Gute zum Geburtstag, {name}! Wir wünschen dir einen wunderschönen Tag! {website}',
  reminderTemplate: '🎉 In {days} Tagen hat {name} Geburtstag ({date}). Denk an einen lieben Gruß! {website}',
  greetingImageUrl: '', reminderImageUrl: '',
  mentionMode: 'none' });
const imageKeys = ['greetingImageUrl', 'reminderImageUrl'];
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const digest = value => createHash('sha256').update(value).digest('hex');
const cleanName = value => String(value || 'Community-Mitglied').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Community-Mitglied';
const safeDiscordName = value => cleanName(value).replace(/[@<>]/g, '').replace(/[\\*_~`|]/g, '\\$&');
const iso = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

export function berlinTime(now = Date.now()) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, year: Number(parts.year), hour: Number(parts.hour) };
}

// Calendar dates are evaluated at UTC midnight only after selecting Berlin's
// civil date. DST therefore never changes a whole-day difference.
export function nextBirthday(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  let year = Number(today.slice(0, 4));
  const occurrence = y => iso(y, month, month === 2 && day === 29 && !leap(y) ? 28 : day);
  let nextDate = occurrence(year);
  if (nextDate < today) nextDate = occurrence(++year);
  return { day, month, nextDate, daysUntil: Math.round((Date.parse(nextDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY) };
}

function birthdayImageUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'Bildlinks dürfen höchstens 2048 Zeichen enthalten.');
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { throw new AppError('validation', 'Bitte einen öffentlichen HTTPS-Bildlink verwenden.', 400); }
  const host = url.hostname.toLowerCase();
  assert(!/[\s\\\u0000-\u001f\u007f]/.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && /^[a-z0-9.-]+$/.test(host) && host.includes('.') && !host.endsWith('.') && !/^\d+(?:\.\d+){3}$/.test(host) && !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host), 'Bitte einen öffentlichen HTTPS-Bildlink ohne Zugangsdaten oder Sonderport verwenden.');
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw new AppError('validation', 'Der Bildlink ist ungültig.', 400); }
  assert(!/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(pathname), 'Bitte einen Bildlink statt eines Video- oder Streamlinks verwenden.');
  return url.href;
}

function validateSettings(raw, previous = defaults) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'Bitte gültige Geburtstagseinstellungen senden.');
  assert(Object.keys(defaults).filter(key => !imageKeys.includes(key)).every(key => Object.hasOwn(raw, key)) && Object.keys(raw).every(key => Object.hasOwn(defaults, key)), 'Die Geburtstagseinstellungen sind unvollständig oder enthalten unbekannte Felder.');
  raw = { ...raw, ...Object.fromEntries(imageKeys.map(key => [key, birthdayImageUrl(Object.hasOwn(raw, key) ? raw[key] : previous[key] ?? '')])) };
  assert(typeof raw.enabled === 'boolean', 'Bitte den automatischen Versand ein- oder ausschalten.');
  assert(typeof raw.channelId === 'string' && (!raw.channelId || ID.test(raw.channelId)), 'Bitte einen gültigen Discord-Kanal wählen.');
  assert(!raw.enabled || !!raw.channelId, 'Bitte zuerst einen Discord-Kanal auswählen.');
  assert(Number.isInteger(raw.reminderDays) && raw.reminderDays >= 1 && raw.reminderDays <= 30, 'Die Erinnerung muss 1 bis 30 Tage vorher erfolgen.');
  assert(Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23, 'Bitte eine Uhrzeit von 0 bis 23 Uhr wählen.');
  assert(['none', 'everyone'].includes(raw.mentionMode), 'Bitte eine gültige Erwähnung wählen.');
  for (const key of ['greetingTemplate', 'reminderTemplate']) {
    const text = raw[key];
    assert(typeof text === 'string' && text.trim().length >= 1 && text.length <= 1400 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'Nachrichtentexte müssen 1 bis 1400 Zeichen enthalten.');
    assert(!/\{[^{}]*\}/g.test(text.replace(/\{(?:name|date|days|website)\}/g, '')), 'Erlaubte Platzhalter: {name}, {date}, {days}, {website}.');
  }
  return Object.fromEntries(Object.keys(defaults).map(key => [key, typeof raw[key] === 'string' ? raw[key].trim() : raw[key]]));
}

export function birthdayMessage(settings, entry, type, website) {
  const values = { name: safeDiscordName(entry.name), date: `${String(entry.day).padStart(2, '0')}.${String(entry.month).padStart(2, '0')}.`, days: String(entry.daysUntil), website };
  // Mention tokens from either a member name or a message template cannot
  // choose arbitrary recipients. Only the explicit everyone switch can ping.
  const template = type === 'greeting' ? settings.greetingTemplate : settings.reminderTemplate;
  const text = template.replace(/@(everyone|here)/gi, '@\u200b$1').replace(/<@[^>]*>/g, '')
    .replace(/\{(name|date|days|website)\}/g, (_, key) => values[key]);
  const imageUrl = birthdayImageUrl(settings[type === 'greeting' ? 'greetingImageUrl' : 'reminderImageUrl'] ?? '');
  return { content: ((settings.mentionMode === 'everyone' ? '@everyone ' : '') + text).slice(0, 2000),
    ...(imageUrl ? { embeds: [{ image: { url: imageUrl } }] } : {}),
    allowed_mentions: { parse: settings.mentionMode === 'everyone' ? ['everyone'] : [], users: [], roles: [], replied_user: false } };
}

export class BirthdayService {
  constructor(service, { now = Date.now } = {}) {
    this.service = service; this.accounts = service.accounts; this.config = service.config;
    this.discord = service.discord; this.store = this.accounts.store; this.now = now;
    this.timer = null; this.running = null; this.stopping = false;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS birthday_preferences (
      user_id TEXT PRIMARY KEY REFERENCES accounts(id), shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)), updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS birthday_deliveries (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), event_date TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('greeting','reminder')), state TEXT NOT NULL,
        channel_id TEXT NOT NULL, message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        UNIQUE(user_id,event_date,kind));`);
    // A crash during a send is ambiguous. Never repeat it automatically after
    // restart; the admin can resolve the visible delivery record explicitly.
    this.store.run("UPDATE birthday_deliveries SET state='uncertain',last_error=? WHERE state='sending'", 'Der Versand wurde unterbrochen. Bitte im Discord-Kanal prüfen.');
  }
  settings() {
    const saved = this.store.setting(SETTINGS_KEY);
    if (!saved) return { ...defaults };
    try { return validateSettings(JSON.parse(saved)); }
    catch { throw new AppError('unconfigured', 'Die Geburtstagseinstellungen konnten nicht gelesen werden.', 503); }
  }
  sharePreference(id) { return this.store.get('SELECT shared FROM birthday_preferences WHERE user_id=?', id)?.shared === 1; }
  profile(id) { return { birthDate: this.accounts.memberProfile.row(id)?.birth_date || '', shared: this.sharePreference(id) }; }
  saveInitialProfile(id, value, shared = false) {
    const validated = birthDate(value, this.now());
    assert(typeof shared === 'boolean', 'Bitte die Kalenderfreigabe bestätigen oder ausschalten.');
    // This helper is only for a genuinely new signup. Existing profile data or
    // existing preferences are never updated by an unauthenticated request.
    this.store.transaction(() => {
      this.store.run('INSERT OR IGNORE INTO member_profiles(user_id,birth_date,updated_at) VALUES (?,?,?)', id, validated, this.now());
      this.store.run('INSERT OR IGNORE INTO birthday_preferences(user_id,shared,updated_at) VALUES (?,?,?)', id, Number(shared), this.now());
    });
    return this.profile(id);
  }
  saveProfile(context, body) {
    assert(Object.keys(body).length === 2 && Object.hasOwn(body, 'birthDate') && typeof body.shared === 'boolean', 'Bitte Geburtsdatum und Kalenderfreigabe senden.');
    const validated = birthDate(body.birthDate, this.now());
    const user = this.accounts.assertCurrent(context);
    this.store.transaction(() => {
      this.store.run(`INSERT INTO member_profiles(user_id,birth_date,updated_at) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET birth_date=excluded.birth_date,updated_at=excluded.updated_at`, user.id, validated, this.now());
      this.store.run(`INSERT INTO birthday_preferences VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET shared=excluded.shared,updated_at=excluded.updated_at`, user.id, Number(body.shared), this.now());
    });
    return this.profile(user.id);
  }
  members(today = berlinTime(this.now()).today) {
    return this.store.all(`SELECT a.id,a.name,p.birth_date FROM accounts a
      JOIN member_profiles p ON p.user_id=a.id JOIN birthday_preferences b ON b.user_id=a.id
      WHERE a.confirmed=1 AND a.suspended=0 AND b.shared=1 AND p.birth_date IS NOT NULL`)
      .filter(row => !this.accounts.controlMembers || this.accounts.controlMembers.status(row.id).status === 'approved')
      .map(row => ({ id: row.id, name: cleanName(row.name), ...nextBirthday(row.birth_date, today) }))
      .filter(entry => Number.isInteger(entry.daysUntil))
      .sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, 'de'));
  }
  calendar() {
    const { today } = berlinTime(this.now());
    return { entries: this.members(today).map(({ id, ...entry }) => entry), timezone: ZONE, today,
      reminderDays: this.settings().reminderDays, leapDayPolicy: '28. Februar in Jahren ohne 29. Februar' };
  }
  status() {
    let health = {}; try { health = JSON.parse(this.store.setting('birthday_health_v1') || '{}'); } catch {}
    return { configured: !!this.config.botToken && ID.test(this.config.discordGuildId || ''),
      timezone: ZONE, ...health,
      uncertainCount: this.store.get("SELECT COUNT(*) AS count FROM birthday_deliveries WHERE state='uncertain'").count,
      failedCount: this.store.get("SELECT COUNT(*) AS count FROM birthday_deliveries WHERE state='failed'").count };
  }
  adminView() {
    return { settings: this.settings(), status: this.status(), deliveries: this.store.all(`SELECT d.id,a.name,d.event_date AS eventDate,d.kind,d.state,d.channel_id AS channelId,
      d.message_id AS messageId,d.updated_at AS updatedAt,d.last_error AS lastError
      FROM birthday_deliveries d JOIN accounts a ON a.id=d.user_id ORDER BY d.updated_at DESC LIMIT 30`) };
  }
  async channelContext() {
    assert(this.status().configured, 'Der Discord-Bot muss zuerst auf der Website eingerichtet werden.', 'unconfigured', 503);
    const guildId = this.config.discordGuildId;
    const [guild, bot, channels] = await Promise.all([
      this.discord.request('GET', '/guilds/' + guildId), this.discord.request('GET', '/users/@me'),
      this.discord.request('GET', '/guilds/' + guildId + '/channels')]);
    assert(guild?.id === guildId && Array.isArray(guild.roles) && ID.test(bot?.id || '') && Array.isArray(channels), 'Discord hat keine gültigen Kanalinformationen geliefert.', 'network', 502);
    const member = await this.discord.request('GET', '/guilds/' + guildId + '/members/' + bot.id);
    assert(Array.isArray(member?.roles) && (!member.user || member.user.id === bot.id), 'Die Bot-Rechte konnten nicht geprüft werden.', 'network', 502);
    return { guildId, channels: channels.filter(channel => channel?.guild_id === guildId && ID.test(channel.id) && [0, 5].includes(channel.type))
      .sort((a, b) => (a.position || 0) - (b.position || 0)).map(channel => {
        const permissions = channelPermissions(guild, { ...member, user: { ...member.user, id: bot.id } }, channel, this.now());
        return { id: channel.id, name: cleanName(channel.name), canSend: has(permissions, P.VIEW_CHANNEL | P.SEND_MESSAGES), canEmbedLinks: has(permissions, P.EMBED_LINKS), canMentionEveryone: has(permissions, P.MENTION_EVERYONE) };
      }) };
  }
  requireChannel(settings, context) {
    const channel = context.channels.find(item => item.id === settings.channelId);
    assert(channel?.canSend, 'Der Bot benötigt im gewählten Kanal die Rechte „Kanal ansehen“ und „Nachrichten senden“.', 'forbidden', 403);
    assert(!(settings.greetingImageUrl || settings.reminderImageUrl) || channel.canEmbedLinks, 'Für Geburtstagsbilder benötigt der Bot im gewählten Kanal das Recht „Links einbetten“.', 'forbidden', 403);
    assert(settings.mentionMode !== 'everyone' || channel.canMentionEveryone, 'Der Bot darf in diesem Kanal noch nicht @everyone erwähnen.', 'forbidden', 403);
  }
  async saveSettings(req, raw) {
    const settings = validateSettings(raw, this.settings());
    // Disabling must remain possible even if the channel was deleted or the
    // bot lost access. Every activation validates the live guild permissions.
    if (settings.enabled) this.requireChannel(settings, await this.channelContext());
    const auth = await this.accounts.authorizeAdmin(req);
    this.store.transaction(() => {
      this.store.setSetting(SETTINGS_KEY, JSON.stringify(settings));
      this.store.audit(auth.user.id, 'birthdays.settings', this.config.discordGuildId || '', { enabled: settings.enabled, channelId: settings.channelId, reminderDays: settings.reminderDays, hour: settings.hour, mentionMode: settings.mentionMode }, this.now());
    });
    return this.adminView();
  }
  resolveDelivery(context, id, action) {
    const user = this.accounts.assertCurrent(context, { admin: true });
    assert(['mark_sent', 'retry'].includes(action), 'Bitte „als gesendet markieren“ oder „erneut versuchen“ wählen.');
    const row = this.store.get('SELECT * FROM birthday_deliveries WHERE id=?', id);
    assert(row && ['uncertain', 'failed'].includes(row.state), 'Dieser Versand ist nicht zur Prüfung offen.', 'conflict', 409);
    if (action === 'retry') {
      const settings = this.settings();
      const entry = this.members().find(item => item.id === row.user_id && item.nextDate === row.event_date);
      assert(settings.enabled && entry && entry.daysUntil === (row.kind === 'greeting' ? 0 : settings.reminderDays),
        'Ein erneuter Versuch ist nur am vorgesehenen Versandtag mit aktiver Kalenderfreigabe möglich.', 'conflict', 409);
    }
    this.store.transaction(() => {
      this.store.run('UPDATE birthday_deliveries SET state=?,retry_at=0,updated_at=?,last_error=? WHERE id=?', action === 'mark_sent' ? 'sent' : 'failed', this.now(), '', id);
      this.store.audit(user.id, 'birthdays.delivery.' + action, id, {}, this.now());
    });
    return this.adminView();
  }
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref();
    void this.tick();
  }
  async stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; await this.running; }
  tick() {
    if (this.stopping) return Promise.resolve();
    if (!this.running) this.running = this.run().catch(error => {
      this.store.setSetting('birthday_health_v1', JSON.stringify({ lastRun: this.now(), lastError: safeMessage(error.message) }));
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async run() {
    const settings = this.settings(), { today, hour } = berlinTime(this.now());
    if (!settings.enabled || hour < settings.hour || this.stopping) return;
    const due = this.members(today).filter(entry => entry.daysUntil === 0 || entry.daysUntil === settings.reminderDays);
    if (!due.length) { this.store.setSetting('birthday_health_v1', JSON.stringify({ lastRun: this.now(), lastError: '' })); return; }
    this.requireChannel(settings, await this.channelContext());
    const settingsStamp = JSON.stringify(settings);
    let lastError = '';
    for (const candidate of due) {
      if (this.stopping || berlinTime(this.now()).today !== today || JSON.stringify(this.settings()) !== settingsStamp) break;
      // Consent, account eligibility and the date are read again after network
      // awaits, so revocation during a previous send takes effect immediately.
      const entry = this.members(today).find(item => item.id === candidate.id && item.nextDate === candidate.nextDate && item.daysUntil === candidate.daysUntil);
      if (!entry) continue;
      const kind = entry.daysUntil === 0 ? 'greeting' : 'reminder';
      // A changed profile date must not generate a second annual greeting or
      // reminder for the same member.
      const id = digest(entry.id + ':' + entry.nextDate.slice(0, 4) + ':' + kind);
      const reserved = this.store.transaction(() => {
        const old = this.store.get('SELECT * FROM birthday_deliveries WHERE id=?', id);
        if (old && (old.state !== 'failed' || old.retry_at > this.now())) return false;
        this.store.run(`INSERT INTO birthday_deliveries(id,user_id,event_date,kind,state,channel_id,attempts,updated_at)
          VALUES (?,?,?,?,'sending',?,1,?) ON CONFLICT(id) DO UPDATE SET state='sending',channel_id=excluded.channel_id,attempts=attempts+1,updated_at=excluded.updated_at`,
        id, entry.id, entry.nextDate, kind, settings.channelId, this.now());
        return true;
      });
      if (!reserved) continue;
      try {
        const payload = { ...birthdayMessage(settings, entry, kind, this.config.publicOrigin + '/geburtstage.html'), nonce: id.slice(0, 24), enforce_nonce: true };
        const response = await this.discord.request('POST', '/channels/' + settings.channelId + '/messages', { payload });
        assert(ID.test(response?.id || '') && response.channel_id === settings.channelId, 'Die Zustellung wurde nicht eindeutig bestätigt. Bitte den Discord-Kanal prüfen.', 'uncertain', 502);
        this.store.run("UPDATE birthday_deliveries SET state='sent',message_id=?,updated_at=?,last_error='',retry_at=0 WHERE id=?", response.id, this.now(), id);
      } catch (error) {
        const uncertain = error.kind === 'uncertain' || !(error instanceof AppError);
        lastError = safeMessage(error.message);
        this.store.run('UPDATE birthday_deliveries SET state=?,updated_at=?,last_error=?,retry_at=? WHERE id=?', uncertain ? 'uncertain' : 'failed', this.now(), lastError, this.now() + Math.max(error.retryAfterMs || 0, 15 * 60_000), id);
      }
    }
    this.store.setSetting('birthday_health_v1', JSON.stringify({ lastRun: this.now(), lastError }));
  }
  async handle(req, res) {
    const route = new URL(req.url, 'http://local.invalid').pathname;
    if (route !== '/api/birthdays/calendar' && route !== '/api/account/birthday' && route !== '/api/admin/birthdays' && !route.startsWith('/api/admin/birthdays/')) return false;
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const body = async () => {
      assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 'Bitte JSON senden.', 'validation', 415);
      return parseJson(await readBody(req, 12 * 1024));
    };
    try {
      if (route === '/api/birthdays/calendar') {
        assert(req.method === 'GET', 'Bitte den Kalender mit GET abrufen.', 'validation', 405);
        this.accounts.limit('birthdays:public:' + (req.socket?.remoteAddress || 'unknown'), 180);
        send(this.calendar()); return true;
      }
      const context = await this.accounts.authenticateRequest(req, { mutation: !['GET', 'HEAD'].includes(req.method), requireAdmin: route.startsWith('/api/admin/') });
      this.accounts.limit('birthdays:' + context.user.id, 60);
      if (route === '/api/account/birthday') {
        if (req.method === 'GET') { send(this.profile(context.user.id)); return true; }
        if (req.method === 'PUT') { send(this.saveProfile(context, await body())); return true; }
      }
      if (route === '/api/admin/birthdays') {
        if (req.method === 'GET') { send(this.adminView()); return true; }
        if (req.method === 'PUT') { send(await this.saveSettings(req, await body())); return true; }
      }
      if (route === '/api/admin/birthdays/channels' && req.method === 'GET') { const channels = await this.channelContext(); this.accounts.assertCurrent(context, { admin: true }); send(channels); return true; }
      const delivery = /^\/api\/admin\/birthdays\/deliveries\/([a-f0-9]{64})$/.exec(route);
      if (delivery && req.method === 'POST') { const data = await body(); assert(Object.keys(data).length === 1, 'Bitte nur die Versandentscheidung senden.'); send(this.resolveDelivery(context, delivery[1], data.action)); return true; }
      throw new AppError('not_found', 'Diese Geburtstagsfunktion ist nicht vorhanden.', 404);
    } catch (error) { send(errorBody(error), error instanceof AppError ? error.status : 500); return true; }
  }
}
