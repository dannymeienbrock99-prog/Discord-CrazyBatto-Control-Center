import crypto from 'node:crypto';
import { isIP } from 'node:net';

const TIME_ZONE = 'Europe/Berlin';
const RETENTION_DAYS = 90;
const MAX_DAILY_VISITORS = 100_000;
const COOKIE = '__Host-cb_account';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const DAY_MS = 86_400_000;
const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const PAGE_LABELS = new Map([
  ['/', 'Startseite'], ['/discord-server.html', 'Discord-Server'],
  ['/musik-app.html', 'Musik-App'], ['/musik-quellen.html', 'Musikquellen'],
  ['/apps.html', 'Apps'], ['/impressum.html', 'Impressum'], ['/cookies.html', 'Cookies und Datenschutz'],
  ['/schulungen.html', 'Schulungen'], ['/altes-setup.html', 'Altes Setup'],
  ['/gaming-setup.html', 'Gaming-Setup'], ['/software.html', 'Software'],
  ['/products.html', 'Produkte und Empfehlungen'],
  ['/discord-app.html', 'Discord-App'], ['/media-player.html', 'Musikplayer'],
  ['/profile.html', 'Kooperationspartner'],
]);
const PROFILE_LABELS = new Map([
  ['sarah', 'Sarah / L4e ImLuNa'], ['michelle', 'Michelle'], ['faelan', 'Fáelán'],
  ['g-gaming', 'G___Gaming'], ['devilwolf666', 'Devilwolf666'],
]);
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|mediapartners|curl\/|wget\/|python|go-http-client|uptime|monitoring|pingdom|pagespeed|whatsapp|telegram/i;

function dayKey(time) {
  const parts = Object.fromEntries(dayFormatter.formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const shiftDay = (day, offset) => new Date(Date.parse(day + 'T12:00:00Z') + offset * DAY_MS).toISOString().slice(0, 10);
const labelFor = page => page.startsWith('/profile.html?person=')
  ? PROFILE_LABELS.get(page.slice('/profile.html?person='.length)) || 'Kooperationspartner'
  : PAGE_LABELS.get(page) || 'Öffentliche Seite';

function publicPage(url) {
  const pathname = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!PAGE_LABELS.has(pathname)) return null;
  if (pathname !== '/profile.html') return pathname;
  // Only these public profile identifiers may reach storage. All other query
  // parameters, arbitrary strings, fragments and referrers are discarded.
  const people = url.searchParams.getAll('person');
  return people.length === 1 && PROFILE_LABELS.has(people[0]) ? pathname + '?person=' + people[0] : pathname;
}

function normalizeIp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const address = value.trim();
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6 || address.includes('%')) return null;
  const canonical = new URL('http://[' + address + ']/').hostname.slice(1, -1).toLowerCase();
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function requestIp(req, trustProxy) {
  const header = req.headers['x-forwarded-for'];
  // Match the application's existing, explicit reverse-proxy trust policy.
  // A malformed trusted address is not replaced with the shared proxy's IP.
  if (trustProxy && typeof header === 'string') return normalizeIp(header.split(',').at(-1));
  return normalizeIp(req.socket?.remoteAddress);
}

function localSession(store, req, now) {
  const authorization = req.headers.authorization;
  let token, kind;
  if (authorization) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
    if (!bearer) return false;
    token = bearer[1]; kind = 'native';
  } else {
    const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
    if (cookies.length !== 1) return false;
    token = cookies[0].slice(COOKIE.length + 1); kind = 'browser';
    if (!TOKEN.test(token)) return false;
  }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return !!store.get(`SELECT 1 AS valid FROM account_sessions s JOIN accounts a ON a.id=s.user_id
    WHERE s.hash=? AND s.kind=? AND s.expires_at>? AND a.confirmed=1 AND a.suspended=0`, hash, kind, now);
}

export class VisitorStats {
  constructor(store, { now = Date.now, trustProxy = false } = {}) {
    this.store = store; this.now = now; this.trustProxy = trustProxy; this.errors = 0;
    this.store.transaction(() => {
      this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS visitor_stats_state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), started_at INTEGER NOT NULL,
          current_day TEXT NOT NULL, daily_secret TEXT NOT NULL,
          total_views INTEGER NOT NULL DEFAULT 0, total_visitor_days INTEGER NOT NULL DEFAULT 0,
          partial INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS visitor_stats_daily (
          day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0,
          visitors INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS visitor_stats_pages (
          day TEXT NOT NULL, page TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,page));
        CREATE TABLE IF NOT EXISTS visitor_stats_seen (
          digest TEXT PRIMARY KEY);`);
      const time = this.now();
      this.store.run(`INSERT OR IGNORE INTO visitor_stats_state(singleton,started_at,current_day,daily_secret)
        VALUES (1,?,?,?)`, time, dayKey(time), crypto.randomBytes(32).toString('hex'));
      this.maintain(dayKey(time));
    });
    // Also expire the previous day's deduplication data when the website is
    // quiet. No persistent browser identifiers or cross-day keys are used.
    this.timer = setInterval(() => {
      try { this.store.transaction(() => this.maintain(dayKey(this.now()))); }
      catch { this.errors = Math.min(this.errors + 1, Number.MAX_SAFE_INTEGER); }
    }, 60_000);
    this.timer.unref?.();
  }

  close() { clearInterval(this.timer); }

  maintain(day) {
    let state = this.store.get('SELECT * FROM visitor_stats_state WHERE singleton=1');
    if (state.current_day !== day) {
      this.store.run('DELETE FROM visitor_stats_seen');
      this.store.run('UPDATE visitor_stats_state SET current_day=?,daily_secret=? WHERE singleton=1', day, crypto.randomBytes(32).toString('hex'));
      state = this.store.get('SELECT * FROM visitor_stats_state WHERE singleton=1');
    }
    const oldest = shiftDay(day, -(RETENTION_DAYS - 1));
    this.store.run('DELETE FROM visitor_stats_daily WHERE day<?', oldest);
    this.store.run('DELETE FROM visitor_stats_pages WHERE day<?', oldest);
    return state;
  }

  observe(req, res, url) {
    try {
      if (req.method !== 'GET') return;
      const page = publicPage(url);
      if (!page) return;
      const agent = req.headers['user-agent'];
      if (typeof agent !== 'string' || !agent || BOT.test(agent)) return;
      if (/prefetch|prerender/i.test(String(req.headers.purpose || '') + ' ' + String(req.headers['sec-purpose'] || '') + ' ' + String(req.headers['x-purpose'] || ''))) return;
      if (req.headers['sec-fetch-dest'] && req.headers['sec-fetch-dest'] !== 'document') return;
      if (req.headers['sec-fetch-mode'] && req.headers['sec-fetch-mode'] !== 'navigate') return;
      if (req.headers.accept && !/(?:text\/html|application\/xhtml\+xml|\*\/\*)/i.test(req.headers.accept)) return;
      res.once('finish', () => {
        try {
          if (res.statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(String(res.getHeader('Content-Type') || ''))) return;
          const time = this.now();
          if (localSession(this.store, req, time)) return;
          this.record(page, requestIp(req, this.trustProxy), time);
        } catch { this.errors = Math.min(this.errors + 1, Number.MAX_SAFE_INTEGER); }
      });
    } catch { this.errors = Math.min(this.errors + 1, Number.MAX_SAFE_INTEGER); }
  }

  record(page, ip, time) {
    const day = dayKey(time);
    this.store.transaction(() => {
      const state = this.maintain(day);
      this.store.run(`INSERT INTO visitor_stats_daily(day,views) VALUES (?,1)
        ON CONFLICT(day) DO UPDATE SET views=views+1`, day);
      this.store.run(`INSERT INTO visitor_stats_pages(day,page,views) VALUES (?,?,1)
        ON CONFLICT(day,page) DO UPDATE SET views=views+1`, day, page);
      this.store.run('UPDATE visitor_stats_state SET total_views=total_views+1 WHERE singleton=1');
      if (ip) {
        const digest = crypto.createHmac('sha256', Buffer.from(state.daily_secret, 'hex')).update(ip).digest('hex');
        if (this.store.get('SELECT 1 AS seen FROM visitor_stats_seen WHERE digest=?', digest)) return;
        const count = this.store.get('SELECT visitors FROM visitor_stats_daily WHERE day=?', day).visitors;
        if (count < MAX_DAILY_VISITORS) {
          this.store.run('INSERT INTO visitor_stats_seen(digest) VALUES (?)', digest);
          this.store.run('UPDATE visitor_stats_daily SET visitors=visitors+1 WHERE day=?', day);
          this.store.run('UPDATE visitor_stats_state SET total_visitor_days=total_visitor_days+1 WHERE singleton=1');
          return;
        }
      }
      // Missing addresses and the finite deduplication limit do not inflate
      // visitor estimates. Views remain counted and the limitation is visible.
      this.store.run('UPDATE visitor_stats_daily SET partial=1 WHERE day=?', day);
      this.store.run('UPDATE visitor_stats_state SET partial=1 WHERE singleton=1');
    });
  }

  report(rangeDays = 30) {
    if (![7, 30, 90].includes(rangeDays)) throw new RangeError('Unsupported visitor statistics range');
    const time = this.now(), today = dayKey(time);
    return this.store.transaction(() => {
      const state = this.maintain(today);
      const startedDay = dayKey(state.started_at);
      const firstDay = [shiftDay(today, -(rangeDays - 1)), startedDay].sort().at(-1);
      const rows = this.store.all('SELECT day,views,visitors,partial FROM visitor_stats_daily WHERE day>=? AND day<=? ORDER BY day', firstDay, today);
      const byDay = new Map(rows.map(row => [row.day, row]));
      const daily = [];
      for (let date = firstDay; date <= today && daily.length < RETENTION_DAYS; date = shiftDay(date, 1)) {
        const row = byDay.get(date);
        daily.push({ date, views: row?.views || 0, visitors: row?.visitors || 0 });
      }
      const pages = this.store.all(`SELECT page,SUM(views) AS views FROM visitor_stats_pages
        WHERE day>=? AND day<=? GROUP BY page ORDER BY views DESC,page`, firstDay, today)
        .map(row => ({ path: row.page, label: labelFor(row.page), views: row.views }));
      const current = byDay.get(today);
      return {
        startedAt: new Date(state.started_at).toISOString(), timeZone: TIME_ZONE,
        retentionDays: RETENTION_DAYS, rangeDays, generatedAt: new Date(time).toISOString(),
        today: { date: today, views: current?.views || 0, visitors: current?.visitors || 0 },
        totals: { views: state.total_views, visitorDays: state.total_visitor_days },
        period: { views: daily.reduce((sum, row) => sum + row.views, 0), visitorDays: daily.reduce((sum, row) => sum + row.visitors, 0) },
        daily, pages, partial: !!state.partial || this.errors > 0 || rows.some(row => row.partial),
        method: 'daily-ip-hmac',
      };
    });
  }
}
