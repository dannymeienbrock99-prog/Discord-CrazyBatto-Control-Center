import { handleRobotSchichtlog } from './robot-schichtlog.mjs';
import { handleRobotOrders } from './robot-orders.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPortalCookie, clearPortalOAuthCookie } from './portal.mjs';
import { AppError, errorBody, assert } from './errors.mjs';
import { readBody, parseJson, parseMultipart, MAX_REQUEST_BYTES } from './multipart.mjs';
import { SITE_MAX_UPLOAD_REQUEST_BYTES } from './site.mjs';
import { isChatAppReleaseRoute, serveChatAppRelease } from './chat-app-release.mjs';
import { isCrazyRgbReleaseRoute, serveCrazyRgbRelease } from './crazy-rgb-release.mjs';
import { isSuiteReleaseRoute, serveSuiteRelease } from './suite-release.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([['portal.css', 'text/css; charset=utf-8'], ['portal.js', 'text/javascript; charset=utf-8'], ['icons.svg', 'image/svg+xml'], ['background-batto.jpeg', 'image/jpeg']]);
const siteAssets = new Map([['site.css', 'text/css; charset=utf-8'], ['site.js', 'text/javascript; charset=utf-8'], ['icons.svg', 'image/svg+xml'], ['brand-dragon.jpeg', 'image/jpeg'], ['discord-app.png', 'image/png']]);
const showcasePages = new Map([
  ['/pc-hilfe.html', 'pc-hilfe.html'], ['/control-center/', 'control-mobile.html'], ['/control-center', 'control-mobile.html'],
  ['/eure-gaming-setups.html', 'eure-gaming-setups.html'],
  ['/geburtstage.html', 'geburtstage.html'], ['/geburtstage-admin.html', 'geburtstage-admin.html'],
  ['/batto-3-in-1-praesentation.html', 'batto-3-in-1-praesentation.html'],
  ['/crazy-rgb-praesentation.html', 'crazy-rgb-praesentation.html'],
  ['/products.html', 'products.html'], ['/products-admin.html', 'products-admin.html'],
  ['/discord-server.html', 'discord-server.html'], ['/discord-server-admin.html', 'discord-server-admin.html'],
  ['/music-remote.html', 'music-remote.html'],
  ['/musik-app.html', 'musik-app.html'],
  ['/musik-quellen.html', 'musik-quellen.html'],
  ['/apps.html', 'apps.html'],
  ['/impressum.html', 'impressum.html'],
  ['/cookies.html', 'cookies.html'],
  ['/mein-profil.html', 'mein-profil.html'], ['/schulungen.html', 'schulungen.html'], ['/schulungen-admin.html', 'schulungen-admin.html'],
  ['/', 'index.html'], ['/index.html', 'index.html'],
  ['/altes-setup.html', 'altes-setup.html'], ['/gaming-setup.html', 'gaming-setup.html'],
  ['/software.html', 'software.html'], ['/discord-app.html', 'discord-app.html'],
  ['/registrierung.html', 'registrierung.html'], ['/portal', 'registrierung.html'], ['/portal/', 'registrierung.html'],
  ['/media-player.html', 'media-player.html'], ['/admin.html', 'admin.html'], ['/bot.html', 'bot.html'],
  ['/profile.html', 'profile.html'], ['/nachrichten.html', 'nachrichten.html'], ['/community-admin.html', 'community-admin.html']
]);
// Only the reviewed website files receive public routes. Source material,
// private releases and owner uploads are never exposed by this static handler.
const showcaseAssets = new Map([
  ['control-client.js', 'text/javascript; charset=utf-8'], ['control-mobile.js', 'text/javascript; charset=utf-8'], ['pc-support.js', 'text/javascript; charset=utf-8'], ['control-support.css', 'text/css; charset=utf-8'],
  ['gaming-setups.js', 'text/javascript; charset=utf-8'], ['gaming-setups.css', 'text/css; charset=utf-8'],
  ['birthdays.js', 'text/javascript; charset=utf-8'], ['birthdays-admin.js', 'text/javascript; charset=utf-8'], ['birthdays.css', 'text/css; charset=utf-8'],
  ["crazy-rgb-065-panelimport.png","image/png"],
  ["crazy-rgb-064-sensoren.png","image/png"],
  ["crazy-rgb-064-folie-01.png","image/png"],
  ["crazy-rgb-064-folie-02.png","image/png"],
  ["crazy-rgb-064-folie-03.png","image/png"],
  ["crazy-rgb-064-folie-04.png","image/png"],
  ["crazy-rgb-064-folie-05.png","image/png"],
  ["crazy-rgb-064-folie-06.png","image/png"],
  ["crazy-rgb-064-folie-07.png","image/png"],
  ["crazy-rgb-064-folie-08.png","image/png"],
  ["crazy-rgb-064-folie-09.png","image/png"],
  ["crazy-rgb-064-folie-10.png","image/png"],
  ["crazy-rgb-064-folie-11.png","image/png"],
  ["crazy-rgb-064-folie-12.png","image/png"],
  ["crazy-rgb-064-folie-13.png","image/png"],
  ["crazy-rgb-064-folie-14.png","image/png"],
  ["crazy-rgb-064-folie-15.png","image/png"],
  ["crazy-rgb-064-folie-16.png","image/png"],
  ["crazy-rgb-064-folie-17.png","image/png"],
  ["crazy-rgb-064-folie-18.png","image/png"],
  ["crazy-rgb-064-folie-19.png","image/png"],
  ["crazy-rgb-064-folie-20.png","image/png"],
  ["crazy-rgb-064-folie-21.png","image/png"],
  ["crazy-rgb-praesentation-064.css","text/css; charset=utf-8"],
  ["crazy-rgb-praesentation-064.js","text/javascript; charset=utf-8"],
  ["crazy-rgb-063-folie-01.png","image/png"],
  ["crazy-rgb-063-folie-02.png","image/png"],
  ["crazy-rgb-063-folie-03.png","image/png"],
  ["crazy-rgb-063-folie-04.png","image/png"],
  ["crazy-rgb-063-folie-05.png","image/png"],
  ["crazy-rgb-063-folie-06.png","image/png"],
  ["crazy-rgb-063-folie-07.png","image/png"],
  ["crazy-rgb-063-folie-08.png","image/png"],
  ["crazy-rgb-063-folie-09.png","image/png"],
  ["crazy-rgb-063-folie-10.png","image/png"],
  ["crazy-rgb-praesentation-063.css","text/css; charset=utf-8"],
  ["crazy-rgb-praesentation-063.js","text/javascript; charset=utf-8"],
  ['crazy-rgb-059.css', 'text/css; charset=utf-8'],
  ['crazy-rgb-058.css', 'text/css; charset=utf-8'], ['crazy-rgb-058-pump.png', 'image/png'],
  ['crazy-rgb-057.css', 'text/css; charset=utf-8'],
  
  ['products.js', 'text/javascript; charset=utf-8'], ['products-admin.js', 'text/javascript; charset=utf-8'],
  ['products.css', 'text/css; charset=utf-8'],
  ['product-rog-gr120.jpeg', 'image/jpeg'], ['product-rog-glacial.jpeg', 'image/jpeg'],
  ['rgb-slotcover-card-20261020.png', 'image/png'], ['product-recommendations-card-20261020.png', 'image/png'],
  ['visitor-stats.js', 'text/javascript; charset=utf-8'], ['visitor-stats.css', 'text/css; charset=utf-8'],
  ['discord-server.js', 'text/javascript; charset=utf-8'], ['discord-server-admin.js', 'text/javascript; charset=utf-8'], ['discord-server.css', 'text/css; charset=utf-8'],
  ['music-remote.js', 'text/javascript; charset=utf-8'], ['music-remote.css', 'text/css; charset=utf-8'],
  ['music-guide.js', 'text/javascript; charset=utf-8'], ['music-guide.css', 'text/css; charset=utf-8'],
  ['apps-page.js', 'text/javascript; charset=utf-8'], ['apps-page.css', 'text/css; charset=utf-8'],
  ['pwa.js', 'text/javascript; charset=utf-8'], ['pwa.css', 'text/css; charset=utf-8'], ['admin-mobile.css', 'text/css; charset=utf-8'],
  ['app-icon-192.png', 'image/png'], ['app-icon-512.png', 'image/png'], ['app-icon-180.png', 'image/png'],
  ['training.js', 'text/javascript; charset=utf-8'], ['training.css', 'text/css; charset=utf-8'],
  ['contact-animation.js', 'text/javascript; charset=utf-8'], ['contact-animation.css', 'text/css; charset=utf-8'],
  ['contact-blossom.gif', 'image/gif'], ['contact-blossom-poster.webp', 'image/webp'],
  ['cookie-consent.js', 'text/javascript; charset=utf-8'], ['cookie-consent.css', 'text/css; charset=utf-8'], ['cookie-banner.gif', 'image/gif'],
  ['crazy-batto-impressum-banner.png', 'image/png'],
  ['crazy-batto-discord-banner.gif', 'image/gif'],
  ['team-alpha-banner-20261016.webp', 'image/webp'], ['team-alpha-banner-poster-20261016.webp', 'image/webp'],
  ['team-alpha-banner-motion-20261016.gif', 'image/gif'], ['team-alpha-banner-motion-poster-20261016.webp', 'image/webp'],
  ['site.css', 'text/css; charset=utf-8'], ['site.js', 'text/javascript; charset=utf-8'],
  ['logo.jpeg', 'image/jpeg'], ['portrait.png', 'image/png'], ['header.gif', 'image/gif'],
  ['header-poster.webp', 'image/webp'], ['marble-gold.webp', 'image/webp'],
  ['setup-2022.jpeg', 'image/jpeg'], ['setup-umbau.jpeg', 'image/jpeg'], ['kraken-g12.png', 'image/png'],
  ['gaming-1.jpg', 'image/jpeg'], ['gaming-2.jpg', 'image/jpeg'], ['gaming-3.jpg', 'image/jpeg'],
  ['gaming-4.jpg', 'image/jpeg'], ['gaming-5.jpg', 'image/jpeg'], ['gaming-7.jpeg', 'image/jpeg'],
  ['gaming-8.jpeg', 'image/jpeg'], ['gaming-9.jpeg', 'image/jpeg'],
  ['gaming-setup-gesamt.jpeg', 'image/jpeg'], ['gaming-aufbau-radiatoren.jpg', 'image/jpeg'],
  ['gaming-rgb-slotcover.jpeg', 'image/jpeg'], ['gaming-wasserkuehlung-front.jpg', 'image/jpeg'],
  ['software-start.jpg', 'image/jpeg'], ['software-multi-chat.jpg', 'image/jpeg'],
  ['software-rgb.jpg', 'image/jpeg'], ['software-luefterkurven.jpg', 'image/jpeg'],
  ['software-touch-deck.jpg', 'image/jpeg'], ['software-strimer.jpg', 'image/jpeg'],
  ['software-widgets.jpg', 'image/jpeg'], ['software-uebersicht.jpg', 'image/jpeg'],
  ['discord-app.png', 'image/png']
]);
for (const name of ['player.css', 'player-effects.css', 'account.css', 'setup-gallery.css', 'community.css', 'private-chat.css', 'chat-media.css', 'chat-notifications.css', 'extensions.css']) showcaseAssets.set(name, 'text/css; charset=utf-8');
for (const name of ['player.js', 'player-config.js', 'player-startup.js', 'player-visualizer.js', 'player-effects.js', 'account-client.js', 'account-page.js', 'admin-page.js', 'bot-page.js', 'setup-gallery.js', 'community.js', 'private-chat.js', 'chat-media.js', 'chat-notifications.js', 'member-profile.js']) showcaseAssets.set(name, 'text/javascript; charset=utf-8');
for (const name of ['back', 'disc', 'external-window', 'heart', 'heart-filled', 'minus', 'music', 'next', 'pause', 'play', 'plus', 'previous', 'repeat', 'search', 'settings', 'shuffle', 'speaker-high', 'speaker-muted', 'trash', 'upload', 'x']) showcaseAssets.set('player-icons/' + name + '.svg', 'image/svg+xml');
showcaseAssets.set('rog-logo.svg', 'image/svg+xml');
showcaseAssets.set('control/dragon-gold-welcome.png', 'image/png');
showcaseAssets.set('control/dragon-gold-birthday.png', 'image/png');
showcaseAssets.set('control/dragon-gold-ticket.png', 'image/png');
showcaseAssets.set('control/dragon-gold-calendar.png', 'image/png');
showcaseAssets.set('control/dragon-gold-reports.png', 'image/png');
showcaseAssets.set('control/dragon-gold-pc-help.png', 'image/png');
showcaseAssets.set('control/dragon-gold-rules.png', 'image/png');
showcaseAssets.set('control/dragon-gold-announcement.png', 'image/png');
showcaseAssets.set('control/gaming-setups-header.mp4', 'video/mp4');
showcaseAssets.set('control/gaming-setups-header.jpg', 'image/jpeg');
showcaseAssets.set('control/marble-gold.webp', 'image/webp');
showcaseAssets.set('rog-maus-original.png', 'image/png');
showcaseAssets.set('batto-suite-account.css', 'text/css; charset=utf-8');
showcaseAssets.set('batto-suite-praesentation.css', 'text/css; charset=utf-8');
showcaseAssets.set('batto-suite-1200-kalibrierung.png', 'image/png');
for (const name of ['oxanium-latin', 'oxanium-latin-ext']) showcaseAssets.set('fonts/' + name + '.woff2', 'font/woff2');
const portalCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const siteCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";
const installFiles = new Map([
  ['/control-center/service-worker.js', ['control-mobile-sw.js', 'text/javascript; charset=utf-8']],
  ['/control-center/manifest.webmanifest', ['control-mobile.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/admin.webmanifest', ['admin.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/chat.webmanifest', ['chat.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
]);
function readCookie(header, name) {
  const values = String(header || '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : undefined;
}

const htmlEscape = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Single byte ranges let browsers seek within the public header video.
// Unknown or malformed range formats are ignored, as permitted by HTTP.
export function videoByteRange(header, size) {
  if (typeof header !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last === 0 ? { unsatisfied: true } : { start: Math.max(0, size - last), end: size - 1 };
  if (last !== null && last < first) return null;
  if (first >= size) return { unsatisfied: true };
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

function page(title, body) {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + htmlEscape(title) + ' · Crazy_Batto Discord App</title><style>html{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#101522;color:#eef3ff;margin:0;padding:40px 20px}main{max-width:520px;margin:8vh auto;padding:28px;background:#1b2335;border-radius:22px;border:1px solid #33425b}h1{font-size:26px}p{line-height:1.6}strong{color:#84e5c1}code{display:block;font-size:28px;letter-spacing:3px;padding:16px;background:#101522;border-radius:12px;text-align:center}</style></head><body><main><p>CRAZY_BATTO DISCORD APP</p><h1>' + htmlEscape(title) + '</h1>' + body + '</main></body></html>';
}

export function createHttpServer(service, { rateLimits = true } = {}) {
  const limits = new Map();
  let imageHealth = null, imageHealthUntil = 0, imageHealthPending = null;
  const publicImageHealth = async () => {
    if (imageHealth && Date.now() < imageHealthUntil) return imageHealth;
    if (!imageHealthPending) imageHealthPending = (async () => {
      const client = service.accounts?.imageStorage || service.imageStorage;
      try {
        const status = client ? await client.status() : { configured: false, online: false };
        imageHealth = { configured: status.configured === true, online: status.online === true,
          message: status.online === true ? 'Bildspeicher verbunden.' : status.configured === true ? 'Der Bildspeicher ist momentan nicht verfügbar.' : 'Der Bildspeicher ist noch nicht eingerichtet.' };
      } catch { imageHealth = { configured: !!client?.configured, online: false, message: 'Der Bildspeicher ist momentan nicht verfügbar.' }; }
      imageHealthUntil = Date.now() + 15_000;
      return imageHealth;
    })().finally(() => { imageHealthPending = null; });
    return imageHealthPending;
  };
  const publicBotPresence = () => {
    try {
      const status = service.botGateway?.status();
      const states = ['unconfigured', 'connecting', 'online', 'reconnecting', 'waiting', 'stopped', 'error'];
      const state = states.includes(status?.phase) ? status.phase : 'unconfigured';
      return { online: status?.ready === true && state === 'online', state };
    } catch { return { online: false, state: 'error' }; }
  };
  const limited = (key, maximum, windowMs) => {
    if (!rateLimits) return;
    const now = service.now();
    if (limits.size > 5000) for (const [name, limit] of limits) if (limit.until <= now) limits.delete(name);
    let limit = limits.get(key);
    if (!limit || limit.until <= now) { limit = { count: 0, until: now + windowMs }; limits.set(key, limit); }
    if (++limit.count > maximum) throw new AppError('rate_limited', 'Zu viele Anfragen. Bitte einen Moment warten.', 429, limit.until - now);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    let pathname = '';
    const json = async (maximum = 64 * 1024) => {
      assert(/^application\/json(?:;|$)/i.test(request.headers['content-type'] || ''), 'Die Anfrage muss JSON enthalten.', 'validation', 415);
      return parseJson(await readBody(request, maximum));
    };
    const streamFile = (filename, contentType, downloadName = null) => {
      let fd;
      try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        assert(stat.isFile() && stat.size > 0, downloadName ? 'Die APK wurde auf diesem Server noch nicht bereitgestellt.' : 'Diese Datei ist nicht verfügbar.', 'unconfigured', 503);
        response.setHeader('Content-Type', contentType);
        response.setHeader('Content-Length', stat.size);
        if (downloadName) { response.setHeader('Content-Disposition', 'attachment; filename="' + downloadName + '"'); response.setHeader('Cache-Control', 'private, no-store, max-age=0'); response.setHeader('Vary', 'Cookie'); }
        const video = contentType === 'video/mp4' && !downloadName;
        if (video) response.setHeader('Accept-Ranges', 'bytes');
        // HEAD describes the full representation; Range applies only to GET.
        const range = video && request.method === 'GET' && !request.headers['if-range'] ? videoByteRange(request.headers.range, stat.size) : null;
        if (range?.unsatisfied) {
          fs.closeSync(fd); fd = undefined;
          response.setHeader('Content-Range', 'bytes */' + stat.size);
          response.setHeader('Content-Length', 0);
          response.writeHead(416); response.end(); return;
        }
        if (range) {
          response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
          response.setHeader('Content-Length', range.end - range.start + 1);
        }
        if (request.method === 'HEAD') { fs.closeSync(fd); fd = undefined; response.writeHead(200); response.end(); return; }
        const stream = fs.createReadStream(filename, { fd, autoClose: true, ...(range || {}) }); fd = undefined;
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        response.writeHead(range ? 206 : 200); stream.pipe(response);
      } catch (cause) {
        if (fd !== undefined) fs.closeSync(fd);
        if (cause instanceof AppError) throw cause;
        throw new AppError('unconfigured', downloadName ? 'Die APK wurde auf diesem Server noch nicht bereitgestellt. Bitte später erneut versuchen.' : 'Die Website wurde auf diesem Server noch nicht bereitgestellt.', 503);
      }
    };
    const send = (value, status = 200) => { if (response.writableEnded || response.destroyed) return; if (response.headersSent) { response.destroy(); return; } response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    const sendSiteImage = async (id, options, authorize = () => {}) => {
      authorize();
      const file = service.site.imageFile(id, options);
      if (!file.nasId) return streamFile(file.filename, file.mimeType);
      const image = await service.site.imageBytes(id, options);
      authorize();
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(200, { 'Content-Type': image.mimeType, 'Content-Length': image.bytes.length });
      response.end(request.method === 'HEAD' ? undefined : image.bytes);
    };
    const sendPage = (title, body, status = 200) => { if (response.writableEnded || response.destroyed) return; if (response.headersSent) { response.destroy(); return; } response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page(title, body)); };
    try {
      const url = new URL(request.url, 'http://modstempel.local'); pathname = url.pathname;
      if (request.method === 'GET' && pathname === '/health') {
        const health = { ...service.health() };
        if (service.accounts) {
          Object.assign(health, { appVersion: service.config.apkVersion || '2.3.0', configured: !!service.config.configured, emailAccounts: service.accounts.status(), player: true, accessMode: 'email' });
          // Email accounts use their own administrator roles. A missing legacy
          // Discord owner must not leave a warning after configured is true.
          if (health.configured) delete health.message;
        }
        return send({ ...health, imageStorage: await publicImageHealth(), botPresence: publicBotPresence() });
      }
      const forwarded = service.config.trustProxy && typeof request.headers['x-forwarded-for'] === 'string' ? request.headers['x-forwarded-for'].split(',').at(-1).trim() : '';
      const remote = forwarded || request.socket.remoteAddress || 'unknown';
      if (isSuiteReleaseRoute(pathname)) {
        limited('batto-suite-release:' + remote, 60, 60_000);
        return await serveSuiteRelease(request, response, pathname);
      }
      if (isCrazyRgbReleaseRoute(pathname)) {
        limited('crazy-rgb-release:' + remote, 60, 60_000);
        return await serveCrazyRgbRelease(request, response, pathname);
      }
      if (isChatAppReleaseRoute(pathname)) {
        limited('chat-release:' + remote, 60, 60_000);
        return await serveChatAppRelease(request, response, service.config, pathname);
      }
      if (pathname.startsWith('/api/admin/robot/') || pathname.startsWith('/api/robot-schichtlog/orders/')) {
        limited('robot-orders:' + remote, 180, 60_000);
        if (await handleRobotOrders(service, request, response, url)) return;
      }
      if (service.controlMembers && await service.controlMembers.handle(request, response)) return;
      if (service.pcSupport && await service.pcSupport.handle(request, response)) return;
      if (service.controlPush && await service.controlPush.handle(request, response)) return;
      if (service.birthdays && await service.birthdays.handle(request, response)) return;
      if (service.botAdmin && await service.botAdmin.handle(request, response)) return;
      if (service.musicRemote && await service.musicRemote.handle(request, response)) return;
      if (service.discordDirectory && await service.discordDirectory.handle(request, response)) return;
      if (pathname === '/robot-schichtlog' || pathname.startsWith('/robot-schichtlog/') || pathname.startsWith('/api/robot-schichtlog/')) {
        limited('robot-schichtlog:' + remote, 240, 60_000);
        await handleRobotSchichtlog(service, request, response, url); return;
      }
      if (service.discordControl && await service.discordControl.handle(request, response)) return;
      if (service.gamingSetups && await service.gamingSetups.handle(request, response)) return;
      if (service.accounts && await service.accounts.handle(request, response)) return;
      if (service.accounts && (pathname === '/portal' || pathname.startsWith('/portal/'))) {
        if (['GET', 'HEAD'].includes(request.method)) { response.writeHead(303, { Location: '/registrierung.html' }); return response.end(); }
        throw new AppError('retired', 'Die Registrierung erfolgt jetzt mit Name, E-Mail und Passwort auf der Kontoseite.', 410);
      }
      if (installFiles.has(pathname)) {
        assert(['GET', 'HEAD'].includes(request.method), 'Diese Datei unterstützt nur das Öffnen.', 'validation', 405);
        limited('showcase:' + remote, 360, 60_000);
        const [filename, contentType] = installFiles.get(pathname);
        response.setHeader('Content-Security-Policy', siteCsp);
        if (pathname === '/service-worker.js') response.setHeader('Service-Worker-Allowed', '/');
        if (pathname === '/control-center/service-worker.js') response.setHeader('Service-Worker-Allowed', '/control-center/');
        return streamFile(path.join(publicDir, 'showcase', filename), contentType);
      }
      if (showcasePages.has(pathname)) {
        assert(['GET', 'HEAD'].includes(request.method), 'Diese Website unterstützt nur das Öffnen.', 'validation', 405);
        limited('showcase:' + remote, 360, 60_000);
        const filename = showcasePages.get(pathname);
        if (pathname.startsWith('/control-center')) response.setHeader('X-Robots-Tag', 'noindex, nofollow');
        response.setHeader('Content-Security-Policy', siteCsp);
        service.accounts?.visitorStats?.observe(request, response, url);
        return streamFile(path.join(publicDir, 'showcase', filename), 'text/html; charset=utf-8');
      }
      if (pathname.startsWith('/assets/')) {
        assert(['GET', 'HEAD'].includes(request.method), 'Diese Datei unterstützt nur das Öffnen.', 'validation', 405);
        limited('showcase:' + remote, 360, 60_000);
        const name = pathname.slice('/assets/'.length);
        assert(showcaseAssets.has(name), 'Diese Datei ist nicht vorhanden.', 'not_found', 404);
        response.setHeader('Content-Security-Policy', siteCsp);
        return streamFile(path.join(publicDir, 'showcase', 'assets', name), showcaseAssets.get(name));
      }
      if (['/site', '/site/'].includes(pathname)) {
        assert(['GET', 'HEAD'].includes(request.method), 'Diese Website unterstützt nur das Öffnen.', 'validation', 405);
        response.setHeader('Content-Security-Policy', siteCsp);
        return streamFile(path.join(publicDir, 'site/index.html'), 'text/html; charset=utf-8');
      }
      if (pathname.startsWith('/site/')) {
        limited('site:' + remote, 360, 60_000);
        if (request.method === 'GET' && pathname === '/site/api/content') return send(service.site.publicContent());
        if (pathname.startsWith('/site/assets/')) {
          assert(['GET', 'HEAD'].includes(request.method), 'Diese Datei unterstützt nur das Öffnen.', 'validation', 405);
          const name = pathname.slice('/site/assets/'.length);
          assert(siteAssets.has(name), 'Diese Datei ist nicht vorhanden.', 'not_found', 404);
          response.setHeader('Content-Security-Policy', siteCsp);
          return streamFile(path.join(publicDir, 'site', name), siteAssets.get(name));
        }
        const media = /^\/site\/media\/(img_[a-f0-9]{64})$/.exec(pathname);
        if (media && ['GET', 'HEAD'].includes(request.method)) {
          return await sendSiteImage(media[1], { publicOnly: true });
        }
        throw new AppError('not_found', 'Diese Website-Adresse ist nicht vorhanden.', 404);
      }
      if (pathname.startsWith('/portal/assets/')) {
        assert(['GET', 'HEAD'].includes(request.method), 'Diese Datei unterstützt nur das Öffnen.', 'validation', 405);
        const name = pathname.slice('/portal/assets/'.length);
        assert(assets.has(name), 'Diese Datei ist nicht vorhanden.', 'not_found', 404);
        response.setHeader('Content-Security-Policy', portalCsp);
        return streamFile(path.join(publicDir, name), assets.get(name));
      }
      if (pathname.startsWith('/portal/')) {
        limited('portal:' + remote, 180, 60_000);
        const portalToken = readCookie(request.headers.cookie, 'ms_portal');
        if (pathname === '/portal/login') {
          assert(request.method === 'GET', 'Die Anmeldung muss im Browser geöffnet werden.', 'validation', 405);
          limited('portal-login:' + remote, 20, 10 * 60_000);
          const start = service.portal.start();
          response.writeHead(302, { Location: start.url, 'Set-Cookie': start.cookie }); return response.end();
        }
        if (pathname === '/portal/callback') {
          assert(request.method === 'GET', 'Diese Anmeldung unterstützt nur das Öffnen.', 'validation', 405);
          const result = await service.portal.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'), browserSecret: readCookie(request.headers.cookie, 'ms_portal_oauth'), previousToken: portalToken });
          response.writeHead(303, { Location: '/portal', 'Set-Cookie': [result.cookie, clearPortalOAuthCookie()] }); return response.end();
        }
        if (request.headers.origin && request.headers.origin !== service.config.publicOrigin) throw new AppError('forbidden', 'Diese Browser-Anfrage gehört nicht zur Website der Crazy_Batto Discord App.', 403);
        if (request.method === 'GET' && pathname === '/portal/api/session') return send(service.portal.info(service.portal.session(portalToken, { optional: true })));
        const portalSession = service.portal.session(portalToken);
        if (['GET', 'HEAD'].includes(request.method) && pathname === '/portal/download') {
          service.access.requireApprovedUser(portalSession.userId);
          limited('download:' + portalSession.userId, 12, 60_000);
          return streamFile(service.config.apkPath, 'application/vnd.android.package-archive', service.config.apkFilename);
        }
        if (request.method === 'POST' && ['/portal/api/register', '/portal/api/logout'].includes(pathname)) {
          service.portal.requireCsrf(portalSession, request.headers);
          const body = await json();
          const current = service.portal.session(portalToken);
          service.portal.requireCsrf(current, request.headers);
          if (pathname.endsWith('/register')) {
            limited('register:' + current.userId, 10, 60_000);
            return send(service.access.register(current.userId, body));
          }
          const result = service.portal.logout(current);
          response.setHeader('Set-Cookie', clearPortalCookie()); return send(result);
        }
        throw new AppError('not_found', 'Diese Portal-Aktion ist nicht vorhanden.', 404);
      }
      if (pathname.startsWith('/oauth/')) {
        limited('browser:' + remote, 80, 10 * 60_000);
        assert(request.method === 'GET', 'Diese Browser-Adresse unterstützt nur das Öffnen.', 'validation', 405);
        const match = /^\/oauth\/start\/([A-Za-z0-9_-]{16,128})$/.exec(pathname);
        if (match) {
          const start = service.auth.browserStart(match[1]);
          response.writeHead(302, { Location: start.url, 'Set-Cookie': start.cookie }); return response.end();
        }
        if (pathname === '/oauth/callback') {
          const browserSecret = /(?:^|;\s*)ms_oauth=([A-Za-z0-9_-]+)/.exec(request.headers.cookie || '')?.[1];
          const result = await service.auth.callback({ state: url.searchParams.get('state'), code: url.searchParams.get('code'), error: url.searchParams.get('error'), browserSecret });
          response.setHeader('Set-Cookie', 'ms_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=0');
          return sendPage('Discord-Anmeldung bestätigt', '<p>Angemeldet als <strong>' + htmlEscape(result.user.displayName) + '</strong>.</p><p>Diese Anmeldung gehört zum Gerätecode:</p><code>' + htmlEscape(result.displayCode) + '</code><p>Wechsle jetzt zurück zur App oder zum Browserfenster, in dem du die Verbindung gestartet hast. Für die Musiksteuerung ist das <strong>Crazy_Batto Musik</strong>. Dort wird die bestätigte Anmeldung automatisch übernommen. Falls du diese Anmeldung nicht selbst gestartet hast, bestätige den Gerätecode nicht in einer fremden App und beende die Anmeldung in Discord.</p>');
        }
        throw new AppError('not_found', 'Diese Anmeldeseite ist nicht vorhanden.', 404);
      }
      if (!pathname.startsWith('/v2/')) throw new AppError('not_found', 'Diese Server-Adresse ist nicht vorhanden.', 404);
      if (request.headers.origin && request.headers.origin !== service.config.publicOrigin) throw new AppError('forbidden', 'Dieser Browser-Ursprung ist nicht für die App freigegeben.', 403);
      const dispatchV2 = async () => {
      if (request.method === 'POST' && pathname === '/v2/auth/start') {
        limited('auth-start:' + remote, 20, 10 * 60_000);
        return send(service.auth.start((await json()).challenge));
      }
      if (request.method === 'POST' && ['/v2/auth/poll', '/v2/auth/cancel'].includes(pathname)) {
        limited('auth-poll:' + remote, 100, 60_000);
        const body = await json();
        return send(pathname.endsWith('/poll') ? service.auth.poll(body.loginId, body.verifier) : service.auth.cancel(body.loginId, body.verifier));
      }
      const token = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.authorization || '')?.[1];
      const session = service.auth.session(token);
      limited('api:' + session.userId, 180, 60_000);
      if (request.method === 'GET' && pathname === '/v2/session') return send({ ok: true, user: session.user, expiresAt: session.expiresAt, access: service.accounts ? service.access.requireApp(session) : service.access.state(session.userId) });
      if (request.method === 'POST' && pathname === '/v2/auth/logout') return send(service.auth.logout(session));
      if (pathname.startsWith('/v2/admin/')) {
        if (service.accounts && !pathname.startsWith('/v2/admin/site')) throw new AppError('retired', 'Registrierungen und App-Rechte werden jetzt im Adminbereich der Webseite verwaltet.', 410);
        service.access.requireOwner(session);
        if (request.method === 'GET' && pathname === '/v2/admin/site') return send(service.site.admin(session));
        if (request.method === 'POST' && pathname === '/v2/admin/site') return send(service.site.save(session, await json()));
        if (request.method === 'POST' && pathname === '/v2/admin/site/publish') return send(await service.site.publish(session, await json()));
        if (request.method === 'POST' && pathname === '/v2/admin/site/images') {
          limited('site-upload:' + session.userId, 30, 60_000);
          return send(await service.site.upload(session, await json(SITE_MAX_UPLOAD_REQUEST_BYTES)));
        }
        const siteImage = /^\/v2\/admin\/site\/images\/(img_[a-f0-9]{64}|brand-dragon|discord-app)$/.exec(pathname);
        if (siteImage && ['GET', 'HEAD'].includes(request.method)) {
          service.access.requireOwner(session);
          response.setHeader('Vary', 'Authorization');
          return await sendSiteImage(siteImage[1], {}, () => service.access.requireOwner(session));
        }
        if (siteImage && request.method === 'DELETE') return send(await service.site.deleteImage(session, siteImage[1]));
        if (request.method === 'GET' && pathname === '/v2/admin/summary') return send(service.access.summary(session));
        if (request.method === 'GET' && pathname === '/v2/admin/registrations') {
          const rawLimit = url.searchParams.get('limit'), rawOffset = url.searchParams.get('offset');
          assert((rawLimit === null || /^\d{1,3}$/.test(rawLimit)) && (rawOffset === null || /^\d{1,9}$/.test(rawOffset)), 'Die Seitenauswahl ist ungültig.');
          return send(service.access.list(session, { status: url.searchParams.get('status') || 'all', limit: rawLimit === null ? 100 : Number(rawLimit), offset: rawOffset === null ? 0 : Number(rawOffset) }));
        }
        const decision = /^\/v2\/admin\/registrations\/(\d{17,20})\/decision$/.exec(pathname);
        if (request.method === 'POST' && decision) return send(service.access.decide(session, decision[1], await json()));
        throw new AppError('not_found', 'Diese Betreiber-Aktion ist nicht vorhanden.', 404);
      }
      service.access.requireApp(session);
      if (request.method === 'GET' && pathname === '/v2/guilds') return send(await service.guilds(session));
      const guild = /^\/v2\/guilds\/(\d{17,20})\/(setup|settings|moderator-role|install|events)$/.exec(pathname);
      if (guild) {
        if (request.method === 'GET' && guild[2] === 'setup') return send(await service.setup(session, guild[1]));
        if (request.method === 'PUT' && guild[2] === 'settings') return send(await service.setGuildSettings(session, guild[1], await json()));
        if (request.method === 'PUT' && guild[2] === 'moderator-role') return send(await service.setModeratorRole(session, guild[1], (await json()).roleId));
        if (request.method === 'GET' && guild[2] === 'install') return send(await service.install(session, guild[1]));
        if (request.method === 'GET' && guild[2] === 'events') return send(await service.scheduledEvents(session, guild[1]));
        throw new AppError('validation', 'Diese Aktion unterstützt die angegebene Methode nicht.', 405);
      }
      if (request.method === 'POST' && pathname === '/v2/operations') {
        limited('send:' + session.userId, 20, 60_000);
        const type = request.headers['content-type'] || '';
        if (/^multipart\/form-data(?:;|$)/i.test(type)) {
          const upload = parseMultipart(await readBody(request, MAX_REQUEST_BYTES), type);
          return send(await service.accept(session, upload.operation, upload.image));
        }
        return send(await service.accept(session, (await json()).operation));
      }
      const operation = /^\/v2\/operations\/([A-Za-z0-9_-]{16,80})(?:\/(retry|poll))?$/.exec(pathname);
      if (operation) {
        if (request.method === 'GET' && !operation[2]) return send(service.operationStatus(session, operation[1]));
        if (request.method === 'GET' && operation[2] === 'poll') return send(await service.pollResults(session, operation[1]));
        if (request.method === 'POST' && operation[2] === 'retry') {
          limited('send:' + session.userId, 20, 60_000);
          return send(await service.retry(session, operation[1], (await json()).acknowledgeUncertain));
        }
        throw new AppError('validation', 'Diese Aktion unterstützt die angegebene Methode nicht.', 405);
      }
      throw new AppError('not_found', 'Diese Aktion ist nicht vorhanden.', 404);
      };
      if (service.accounts) {
        let auth;
        try { auth = await service.accounts.authorizeNativeApp(request.headers['x-app-account'], 'discord-app'); }
        catch (error) {
          if (error instanceof AppError && [401, 403].includes(error.status)) error.kind = error.status === 401 ? 'account_auth' : 'account_access';
          throw error;
        }
        return await service.accountContext.run(auth, dispatchV2);
      }
      return await dispatchV2();
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      if (error.retryAfterMs && !response.headersSent) response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      if (pathname === '/portal/callback' || pathname === '/portal/login') sendPage('Anmeldung nicht abgeschlossen', '<p>' + htmlEscape(errorBody(error).message) + '</p><p>Öffne die Website der Crazy_Batto Discord App erneut und starte die Anmeldung dort.</p>', status);
      else if (pathname.startsWith('/oauth/')) sendPage('Anmeldung nicht abgeschlossen', '<p>' + htmlEscape(errorBody(error).message) + '</p><p>Wechsle zurück zur App und starte die Anmeldung erneut.</p>', status);
      else send(errorBody(error), status);
    }
  });
  server.requestTimeout = 200_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5000;
  return server;
}
