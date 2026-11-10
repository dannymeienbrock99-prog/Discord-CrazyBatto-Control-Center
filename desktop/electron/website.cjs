'use strict';

const { isIP } = require('node:net');
const { workspaceOperation, allowedTransportPath, workspaceImagePath } = require('./workspace-operations.cjs');

const DEFAULT_ORIGIN = 'https://crazybatto.de';
const EXPECTED_BOT_ID = process.env.CONTROL_DISCORD_CLIENT_ID || '900000000000000002';
const DISCORD_ACTIONS = ['guild.load', 'message.send', 'guild.update', 'channel.create', 'channel.update', 'role.create', 'role.update', 'bot.profile', 'event.create', 'log.list',
  'extras.state','extras.automod.list','extras.automod.save','extras.audio.send',
  'roles.state','roles.save','roles.decorate','roles.publish','setup.state','setup.save','setup.moderate','setup.retry','setup.image','setup.panel.state','setup.panel.save','setup.panel.publish','joinrole.state','joinrole.save','community.state','community.save','community.publish','community.register','community.report.list','community.report.moderate','community.voice.list','community.voice.control','community.ticket.list','community.ticket.close','tiktok.state','tiktok.save','tiktok.check','joinrequests.list','joinrequests.review','admincrown.list','admincrown.lookup','admincrown.apply','admincrown.remove'];
const MAX_BRIDGE_BODY = 24 * 1024 * 1024;
const SESSION = /^[A-Za-z0-9_-]{32,128}$/;
const DISCORD_ID = /^\d{17,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_KEY = /token|password|secret|authorization|cookie|verifier/i;

class WebsiteError extends Error {
  constructor(message, code = 'validation', status = 0) { super(message); this.name = 'WebsiteError'; this.code = code; this.status = status; }
}
const fail = (message, code, status) => { throw new WebsiteError(message, code, status); };
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Bitte gültige Angaben senden.');
  return value;
}
function fields(value, allowed, required = []) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('Die Aktion enthält fehlende oder unbekannte Angaben.');
}
function normalizeBaseUrl(value = DEFAULT_ORIGIN) {
  let url;
  if (typeof value !== 'string' || value.length > 300 || /[\s\\]/.test(value)) fail('Bitte eine gültige HTTPS-Adresse der Website eingeben.');
  try { url = new URL(value); } catch { fail('Bitte eine gültige HTTPS-Adresse der Website eingeben.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/'
    || !host.includes('.') || host.endsWith('.') || host.endsWith('.localhost') || host.endsWith('.local') || isIP(host)
    || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    fail('Bitte die HTTPS-Hauptadresse ohne Pfad, Port oder Zugangsdaten eingeben.');
  }
  return url.origin;
}
function safeText(value, secrets = [], max = 500) {
  let text = String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of secrets) if (secret && secret.length >= 8) text = text.split(secret).join('[geschützt]');
  return text.slice(0, max);
}
function publicData(value, secrets = [], depth = 0) {
  if (depth > 16) return null;
  if (typeof value === 'string') return safeText(value, secrets, 10000);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 2500).map(item => publicData(item, secrets, depth + 1));
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = publicData(item, secrets, depth + 1);
  }
  return result;
}
function setupImageData(value, token) {
  const limit = 8 * 1024 * 1024;
  const invalid = () => fail('Die Website hat keine gültige private Bildvorschau geliefert.', 'response', 502);
  if (!value || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mimeType) || typeof value.dataUrl !== 'string') invalid();
  const prefix = `data:${value.mimeType};base64,`;
  if (!value.dataUrl.startsWith(prefix) || value.dataUrl.length > prefix.length + Math.ceil(limit / 3) * 4 || (token && value.dataUrl.includes(token))) invalid();
  const encoded = value.dataUrl.slice(prefix.length);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid();
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== encoded) invalid();
  return value.dataUrl;
}
function adminUser(value, secrets = []) {
  if (!value || value.isAdmin !== true || value.confirmed !== true || value.suspended === true) fail('Für diese Verwaltung brauchst du ein bestätigtes Administratorkonto.', 'forbidden', 403);
  if (typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.email !== 'string' || typeof value.name !== 'string') fail('Die Website hat keine gültige Kontoidentität bestätigt.', 'response', 502);
  return { id: value.id, name: safeText(value.name, secrets, 80), email: safeText(value.email, secrets, 254), confirmed: true, isAdmin: true, canUpload: value.canUpload === true, suspended: false };
}
function birthdaySettings(body) {
  const keys = ['enabled', 'channelId', 'reminderDays', 'hour', 'greetingTemplate', 'reminderTemplate', 'mentionMode'];
  fields(body, [...keys, 'greetingImageUrl', 'reminderImageUrl'], keys);
  if (typeof body.enabled !== 'boolean' || typeof body.channelId !== 'string' || (body.channelId && !DISCORD_ID.test(body.channelId)) || (body.enabled && !body.channelId)) fail('Bitte einen gültigen Geburtstagskanal auswählen.');
  if (!Number.isInteger(body.reminderDays) || body.reminderDays < 1 || body.reminderDays > 30 || !Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23) fail('Bitte 1 bis 30 Tage Vorlauf und eine Stunde von 0 bis 23 wählen.');
  if (!['none', 'everyone'].includes(body.mentionMode)) fail('Bitte eine gültige Erwähnung wählen.');
  for (const key of ['greetingTemplate', 'reminderTemplate']) {
    const text = body[key];
    if (typeof text !== 'string' || !text.trim() || text.length > 1400 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || /\{[^{}]*\}/.test(text.replace(/\{(?:name|date|days|website)\}/g, ''))) fail('Nachrichten benötigen 1 bis 1400 Zeichen; Platzhalter: {name}, {date}, {days}, {website}.');
  }
  for (const key of ['greetingImageUrl', 'reminderImageUrl']) {
    if (!Object.hasOwn(body,key)) continue;
    const value=body[key];
    if (typeof value!=='string' || value.length>2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) fail('Bitte einen gültigen HTTPS-Bildlink mit höchstens 2048 Zeichen verwenden.');
    if (!value) continue;
    let url;try{url=new URL(value);}catch{fail('Der Geburtstags-Bildlink ist ungültig.');}
    const host=url.hostname.toLowerCase();
    if (url.protocol!=='https:' || url.username || url.password || url.port || url.hash || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.endsWith('.') || isIP(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) fail('Bitte einen öffentlichen HTTPS-Bildlink ohne Zugangsdaten oder Sonderport verwenden.');
    let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{fail('Der Geburtstags-Bildlink ist ungültig.');}
    if (/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(pathname)) fail('Bitte einen Bildlink statt eines Video- oder Streamlinks verwenden.');
  }
  return { ...body };
}
function operationRequest(operation, body) {
  if (/^(?:members|support|robot)\./.test(operation)) return workspaceOperation(operation, body);
  const empty = () => { if (body !== undefined) fields(body, []); return {}; };
  switch (operation) {
    case 'discord.capabilities': empty(); return ['GET', '/api/admin/discord-control/capabilities'];
    case 'discord.state': empty(); return ['GET', '/api/admin/discord-control/state'];
    case 'discord.action': {
      fields(body, ['action', 'payload'], ['action', 'payload']);
      if (!DISCORD_ACTIONS.includes(body.action)) fail('Diese Discord-Aktion ist nicht freigegeben.');
      object(body.payload);
      const requestBody = { action: body.action, payload: body.payload };
      // The server accepts two independent 8 MiB images (guild icon + banner).
      // Account for base64 expansion and the complete UTF-8 request envelope.
      if (Buffer.byteLength(JSON.stringify(requestBody), 'utf8') > MAX_BRIDGE_BODY) fail('Die Discord-Aktion ist zu groß.');
      return ['POST', '/api/admin/discord-control/action', requestBody, body.action==='extras.audio.send'?180000:90000];
    }
    case 'bot.get': empty(); return ['GET', '/api/admin/bot'];
    case 'bot.update': fields(body, ['enabled'], ['enabled']); if (typeof body.enabled !== 'boolean') fail('Bitte die Bot-Befehle ein- oder ausschalten.'); return ['PUT', '/api/admin/bot', { enabled: body.enabled }];
    case 'bot.check': return ['POST', '/api/admin/bot/check', empty()];
    case 'bot.sync': return ['POST', '/api/admin/bot/commands', empty(), 90000];
    case 'birthdays.get': empty(); return ['GET', '/api/admin/birthdays'];
    case 'birthdays.update': return ['PUT', '/api/admin/birthdays', birthdaySettings(body)];
    case 'birthdays.channels': empty(); return ['GET', '/api/admin/birthdays/channels'];
    case 'birthdays.delivery': {
      fields(body, ['id', 'action'], ['id', 'action']);
      if (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id) || !['mark_sent', 'retry'].includes(body.action)) fail('Bitte eine gültige Versandentscheidung auswählen.');
      return ['POST', '/api/admin/birthdays/deliveries/' + body.id, { action: body.action }];
    }
    case 'spotify.status': empty(); return ['GET','/api/spotify/status'];
    case 'spotify.player': empty(); return ['GET','/api/spotify/player'];
    case 'spotify.disconnect': return ['POST','/api/spotify/disconnect',empty()];
    case 'spotify.admin.read': empty(); return ['GET','/api/admin/spotify'];
    case 'spotify.admin.check':
      fields(body,['expectedRevision'],['expectedRevision']);
      if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail('Bitte die Spotify-Einrichtung neu laden.');
      return ['POST','/api/admin/spotify/check-credentials',{expectedRevision:body.expectedRevision}];
    case 'spotify.admin.save':
      fields(body,['clientId','clientSecret','expectedRevision'],['clientId','expectedRevision']);
      if(typeof body.clientId!=='string'||!/^[a-f0-9]{32}$/i.test(body.clientId)||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0)fail('Die Spotify-App-Angaben sind ungültig.');
      if(body.clientSecret!==undefined&&(typeof body.clientSecret!=='string'||!/^$|^[\x21-\x7e]{16,512}$/.test(body.clientSecret)))fail('Der Spotify-App-Schlüssel ist ungültig.');
      return ['PUT','/api/admin/spotify',{...body}];
    case 'spotify.control': {
      object(body);const action=body.action;
      if(!['play','pause','next','previous','volume','transfer'].includes(action))fail('Diese Spotify-Aktion ist nicht verfügbar.');
      fields(body,['action','deviceId',...(action==='play'?['uri']:[]),...(action==='volume'?['volume']:[])],['action','deviceId']);
      if(typeof body.deviceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId))fail('Bitte ein gültiges Spotify-Gerät wählen.');
      if(action==='volume'&&(!Number.isInteger(body.volume)||body.volume<0||body.volume>100))fail('Bitte eine Lautstärke von 0 bis 100 wählen.');
      if(body.uri!==undefined&&(typeof body.uri!=='string'||body.uri.length>1024||!(/^(?:spotify:(?:track|album|playlist):[A-Za-z0-9]{22}|https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(?:track|album|playlist)\/[A-Za-z0-9]{22}\/?(?:\?si=[A-Za-z0-9_-]+)?)$/.test(body.uri))))fail('Bitte einen Spotify-Titel, ein Album oder eine Playlist wählen.');
      return ['POST','/api/spotify/control',{...body}];
    }
    case 'music.read': empty(); return ['GET', '/api/music-remote'];
    case 'music.link.start': return ['POST', '/api/music-remote/link/start', empty()];
    case 'music.link.poll': return ['POST', '/api/music-remote/link/poll', empty()];
    case 'music.link.cancel': return ['POST', '/api/music-remote/link/cancel', empty()];
    case 'music.link.unlink': empty(); return ['DELETE', '/api/music-remote/link'];
    case 'music.control': {
      object(body);
      if (!['join', 'play', 'queue', 'pause', 'resume', 'next', 'previous', 'stop', 'volume'].includes(body.action)) fail('Diese Musikaktion ist nicht verfügbar.');
      const extra = ['play', 'queue'].includes(body.action) ? ['playlistId', 'trackId'] : body.action === 'volume' ? ['volume'] : [];
      fields(body, ['action', 'channelId', ...extra], ['action']);
      if (body.channelId !== undefined && (typeof body.channelId !== 'string' || !DISCORD_ID.test(body.channelId))) fail('Bitte einen gültigen Sprachkanal wählen.');
      if (body.playlistId !== undefined && body.playlistId !== 'all' && (typeof body.playlistId !== 'string' || !UUID.test(body.playlistId))) fail('Diese Playlist ist ungültig.');
      if (body.trackId !== undefined && (typeof body.trackId !== 'string' || !UUID.test(body.trackId))) fail('Dieser Titel ist ungültig.');
      if (body.action === 'volume' && (!Number.isInteger(body.volume) || body.volume < 0 || body.volume > 100)) fail('Bitte eine Lautstärke von 0 bis 100 wählen.');
      return ['POST', '/api/music-remote/control', { ...body }, ['join', 'play', 'queue'].includes(body.action) ? 90000 : 30000];
    }
    default: fail('Diese Website-Aktion ist nicht freigegeben.');
  }
}

class WebsiteService {
  #active = null;
  #epoch = 0;
  constructor({ connections, fetch: fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.connections = connections; this.fetch = fetchImpl; this.now = now;
    if (typeof fetchImpl !== 'function') throw new Error('Die Website-Verbindung ist nicht verfügbar.');
  }
  state() {
    if (this.#active?.expiresAt && this.#active.expiresAt <= this.now()) { this.#active = null; this.#epoch++; }
    const active = this.#active;
    return { connected: !!active, user: active ? { ...active.user } : null, profileId: active?.profileId || null, baseUrl: active?.baseUrl || DEFAULT_ORIGIN, expiresAt: active?.expiresAt || null };
  }
  requireSession() {
    this.state();
    if (!this.#active) fail('Bitte zuerst mit deinem Website-Administratorkonto anmelden.', 'auth', 401);
    return this.#active;
  }
  async transport(baseUrl, path, { method = 'GET', body, token, timeout = 30000, secrets = [] } = {}) {
    const origin = normalizeBaseUrl(baseUrl);
    const responseLimit = (path === '/api/admin/discord-control/action' && method === 'POST' && body?.action === 'setup.image') || workspaceImagePath(path) ? 12 * 1024 * 1024 : 4 * 1024 * 1024;
    // Even internal call sites cannot send account credentials to a URL/path supplied by the renderer.
    if (!allowedTransportPath(path)) fail('Diese Website-Adresse ist nicht freigegeben.');
    const headers = { Accept: 'application/json', 'X-Client-Type': 'native' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) { if (!SESSION.test(token)) fail('Die gespeicherte Website-Anmeldung ist ungültig.', 'auth', 401); headers.Authorization = 'Bearer ' + token; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    const protectedValues = [...secrets, token].filter(Boolean);
    try {
      let response;
      try { response = await this.fetch(origin + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }); }
      catch { fail(controller.signal.aborted ? 'Die Website antwortet zu langsam. Bitte den Status prüfen, bevor du die Aktion wiederholst.' : 'Die Website ist nicht erreichbar oder hat eine unzulässige Weiterleitung gesendet.', 'network'); }
      if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== origin + path)) fail('Eine Weiterleitung der Website-Anmeldung wurde blockiert.', 'redirect', response.status);
      if (Number(response.headers?.get?.('content-length')) > responseLimit) fail('Die Website-Antwort ist zu groß.', 'response', 502);
      let value;
      try {
        if (response.body?.getReader) {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > responseLimit) { await reader.cancel(); fail('Die Website-Antwort ist zu groß.', 'response', 502); } chunks.push(Buffer.from(part.value)); }
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } else if (typeof response.text === 'function') {
          const text = await response.text(); if (Buffer.byteLength(text,'utf8') > responseLimit) fail('Die Website-Antwort ist zu groß.', 'response', 502); value = JSON.parse(text);
        } else value = await response.json();
      } catch (error) { if (error instanceof WebsiteError) throw error; fail('Die Website hat keine gültige Antwort geliefert.', 'response', response.status); }
      if (!response.ok || value?.ok === false) {
        const reportedCode=value?.error?.code||value?.kind||value?.code;
        const code = typeof reportedCode === 'string' && /^[a-z_]{1,40}$/.test(reportedCode) ? reportedCode : 'http';
        fail(code==='preview_too_large'?'Das Bild ist für die Vorschau zu groß. Öffne das Original im Browser.':safeText(value?.error?.message || value?.message || (typeof value?.error==='string'?value.error:'') || 'Die Website konnte diese Aktion nicht ausführen.', protectedValues), code, response.status);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Die Website hat keine gültige Antwort geliefert.', 'response', 502);
      return value;
    } finally { clearTimeout(timer); }
  }
  async authenticated(path, options = {}, session = this.requireSession()) {
    try {
      const result = await this.transport(session.baseUrl, path, { ...options, token: session.token });
      if (this.#active !== session) fail('Die Website-Verbindung wurde geändert. Bitte erneut laden.', 'session_changed', 409);
      return result;
    } catch (error) {
      // The bridge distinguishes a rejected server-side Discord credential
      // from an expired website session. The former must not log out the admin.
      if (error.status === 401 && error.code !== 'discord' && this.#active === session) { this.#active = null; this.#epoch++; }
      throw error;
    }
  }
  async login(payload) {
    fields(payload, ['profileId', 'baseUrl', 'email', 'password', 'remember'], ['email', 'password']);
    const profile = payload.profileId ? await this.connections.getProfile(payload.profileId) : null;
    if (payload.profileId && (!profile || profile.kind !== 'website')) fail('Bitte eine Website-Verbindung auswählen.');
    const baseUrl = normalizeBaseUrl(payload.baseUrl || profile?.baseUrl || DEFAULT_ORIGIN);
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof payload.password !== 'string' || payload.password.length < 8 || payload.password.length > 128) fail('Bitte eine gültige E-Mail und dein Passwort eingeben.');
    if (payload.remember !== undefined && typeof payload.remember !== 'boolean') fail('Bitte die Speicheroption bestätigen.');
    const epoch = ++this.#epoch; this.#active = null;
    const response = await this.transport(baseUrl, '/api/account/login', { method: 'POST', body: { email, password: payload.password, native: true }, secrets: [payload.password] });
    if (typeof response.token !== 'string' || !SESSION.test(response.token) || !Number.isFinite(response.expiresAt) || response.expiresAt <= this.now()) fail('Die Website hat keine gültige Anmeldung geliefert.', 'auth', 401);
    let user;
    try { user = adminUser(response.user, [response.token, payload.password]); }
    catch (error) { await this.transport(baseUrl, '/api/account/logout', { method: 'POST', token: response.token }).catch(() => {}); throw error; }
    if (epoch !== this.#epoch) { await this.transport(baseUrl, '/api/account/logout', { method: 'POST', token: response.token }).catch(() => {}); fail('Die Anmeldung wurde inzwischen abgebrochen.', 'session_changed', 409); }
    let saved;
    try {
      saved = await this.connections.run('connections.save', { ...(profile ? { id: profile.id } : {}), name: profile?.name || 'Crazy_Batto Website', kind: 'website', baseUrl, username: email, accessKey: response.token, remember: payload.remember === true });
    } catch (error) { await this.transport(baseUrl, '/api/account/logout', { method: 'POST', token: response.token }).catch(() => {}); throw error; }
    if (epoch !== this.#epoch) { await this.connections.run('connections.clearSecret', { id: saved.id }); await this.transport(baseUrl, '/api/account/logout', { method: 'POST', token: response.token }).catch(() => {}); fail('Die Anmeldung wurde inzwischen abgebrochen.', 'session_changed', 409); }
    this.#active = { baseUrl, token: response.token, expiresAt: response.expiresAt, profileId: saved.id, user };
    return this.state();
  }
  async reconnect(payload) {
    fields(payload, ['profileId'], ['profileId']);
    const profile = await this.connections.getProfile(payload.profileId);
    if (!profile || profile.kind !== 'website') fail('Bitte eine gespeicherte Website-Verbindung auswählen.');
    const baseUrl = normalizeBaseUrl(profile.baseUrl), secret = await this.connections.getSecret(profile.id);
    if (!secret?.accessKey || !SESSION.test(secret.accessKey)) fail('Für diese Website ist keine Anmeldung gespeichert. Bitte erneut anmelden.', 'auth', 401);
    const epoch = ++this.#epoch; this.#active = null;
    let response;
    try { response = await this.transport(baseUrl, '/api/account/session', { token: secret.accessKey }); }
    catch (error) { if (error.status === 401) await this.connections.run('connections.clearSecret', { id: profile.id }); throw error; }
    const user = adminUser(response.user, [secret.accessKey]);
    if (epoch !== this.#epoch) fail('Die Verbindung wurde inzwischen abgebrochen.', 'session_changed', 409);
    this.#active = { baseUrl, token: secret.accessKey, expiresAt: null, profileId: profile.id, user };
    return this.state();
  }
  async disconnect(payload = {}) {
    fields(payload, ['forget']);
    const active = this.#active; this.#active = null; this.#epoch++;
    let warning = null, revoked = false;
    if (active) {
      try { await this.transport(active.baseUrl, '/api/account/logout', { method: 'POST', token: active.token }); revoked = true; }
      catch { warning = 'Die lokale Verbindung ist getrennt. Die Abmeldung auf der Website konnte nicht bestätigt werden.'; }
      if (revoked || payload.forget === true) await this.connections.run('connections.clearSecret', { id: active.profileId });
    }
    return { ...this.state(), ...(warning ? { warning } : {}) };
  }
  async request(payload) {
    fields(payload, ['operation', 'body'], ['operation']);
    const [method, path, body, timeout] = operationRequest(payload.operation, payload.body);
    const active = this.requireSession();
    const response = await this.authenticated(path, { method, body, timeout }, active);
    const safe = publicData(response, [active.token]);
    if (['support.image','robot.image'].includes(payload.operation)) safe.dataUrl=setupImageData(response,active.token);
    if(['spotify.admin.read','spotify.admin.save'].includes(payload.operation)&&typeof response.secretConfigured==='boolean')safe.secretConfigured=response.secretConfigured;
    // Only the dedicated, bounded raster preview may exceed the normal text limit.
    // Other fields still pass through the standard secret and length filtering.
    if (payload.operation === 'discord.action' && body.action === 'setup.image' && response.ok === true) {
      const dataUrl = setupImageData(response.result, active.token);
      safe.result.dataUrl = dataUrl;
    }
    if (payload.operation === 'discord.capabilities' && (safe.ok !== true || safe.version !== 1 || safe.expectedBotId !== EXPECTED_BOT_ID || !Array.isArray(safe.actions))) fail('Die Server-Erweiterung bestätigt nicht den vorgesehenen Crazy_Batto-Bot.', 'identity', 502);
    if (payload.operation === 'discord.state' && (safe.ok !== true || safe.state?.bot?.id !== EXPECTED_BOT_ID)) fail('Die Server-Erweiterung bestätigt nicht den vorgesehenen Crazy_Batto-Bot.', 'identity', 502);
    // A login URL is only an opaque path on the authenticated website, never a supplied external origin.
    for (const source of [safe, safe.link]) if (source?.authorizePath !== undefined && !/^\/oauth\/start\/[A-Za-z0-9_-]{16,128}$/.test(source.authorizePath)) fail('Die Website hat keine gültige Discord-Verbindungsadresse geliefert.', 'response', 502);
    return safe;
  }
  async load() {
    const active = this.requireSession();
    const session = await this.authenticated('/api/account/session', {}, active);
    try { active.user = adminUser(session.user, [active.token]); } catch (error) { if (this.#active === active) { this.#active = null; this.#epoch++; } throw error; }
    const modules = [['bot', 'bot.get'], ['birthdays', 'birthdays.get'], ['birthdayChannels', 'birthdays.channels'], ['discordControl', 'discord.capabilities']];
    const settled = await Promise.allSettled(modules.map(([, operation]) => this.request({ operation })));
    const result = { state: this.state(), bot: null, birthdays: null, birthdayChannels: null, discordControl: null, capabilities: { bot: false, birthdays: false, birthdayChannels: false, discordControl: false, music: false }, errors: {} };
    settled.forEach((outcome, index) => {
      const key = modules[index][0];
      if (outcome.status === 'fulfilled' && this.#active === active) { result[key] = outcome.value; result.capabilities[key] = true; }
      else { const error = outcome.reason || new WebsiteError('Die Verbindung wurde inzwischen geändert.', 'session_changed', 409); result.errors[key] = { code: error.code || 'network', message: safeText(error.message, [active.token]), status: error.status || 0 }; }
    });
    result.capabilities.music = result.bot?.music?.configured === true;
    return result;
  }
  async run(action, payload = {}) {
    switch (action) {
      case 'website.state': return this.state();
      case 'website.login': return this.login(payload);
      case 'website.reconnect': return this.reconnect(payload);
      case 'website.disconnect': return this.disconnect(payload);
      case 'website.load': fields(payload, []); return this.load();
      case 'website.request': return this.request(payload);
      default: fail('Diese Website-Aktion ist nicht freigegeben.');
    }
  }
}

module.exports = { WebsiteService, WebsiteError, normalizeBaseUrl };
