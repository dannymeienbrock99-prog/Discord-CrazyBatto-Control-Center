import { AppError } from './errors.mjs';
import { sha256 } from './store.mjs';

const API = 'https://discord.com/api/v10';
const MAX_RESPONSE = 2 * 1024 * 1024;

async function jsonResponse(response) {
  if (response.status === 204) return null;
  const reader = response.body?.getReader?.();
  let raw;
  if (reader) {
    const parts = []; let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new Error('Discord-Antwort zu groß.'); }
      parts.push(Buffer.from(chunk.value));
    }
    raw = Buffer.concat(parts).toString('utf8');
  } else {
    raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE) throw new Error('Discord-Antwort zu groß.');
  }
  return raw ? JSON.parse(raw) : null;
}

function fieldErrors(raw) {
  const fields = [];
  const visit = (value, path, depth) => {
    if (!value || typeof value !== 'object' || depth > 6 || fields.length >= 5) return;
    if (Array.isArray(value._errors)) {
      for (const error of value._errors.slice(0, 2)) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INVALID';
        fields.push((path || 'Anfrage') + ' [' + code + ']');
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== '_errors' && /^[A-Za-z_][A-Za-z_0-9]{0,60}$|^\d{1,4}$/.test(key)) visit(child, path ? path + '.' + key : key, depth + 1);
      if (fields.length >= 5) break;
    }
  };
  visit(raw?.errors, '', 0);
  return fields.slice(0, 5).join('; ');
}

function discordError(response, body, mutation) {
  const code = Number.isSafeInteger(body?.code) ? ' · Discord ' + body.code : '';
  const detail = ' (HTTP ' + response.status + code + ')';
  if (response.status === 429) {
    const seconds = Number(body?.retry_after ?? response.headers.get('retry-after'));
    const wait = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 5000;
    return new AppError('rate_limited', 'Discord begrenzt die Anfragen. Bitte nach der angezeigten Wartezeit erneut versuchen.' + detail, 429, Math.min(wait, 7 * 86400_000));
  }
  if (response.status === 401) return new AppError('auth', 'Die Discord-Anmeldung ist nicht mehr gültig.' + detail, 401);
  if (response.status === 403) return new AppError('forbidden', 'Discord verweigert den Zugriff. Bitte Server-, Kanal- und Bot-Rechte prüfen.' + detail, 403);
  if (response.status === 404) return new AppError('forbidden', 'Der Discord-Server, Kanal oder die Nachricht ist für diesen Zugang nicht mehr verfügbar.' + detail, 404);
  if (response.status >= 500) return new AppError(mutation ? 'uncertain' : 'network', mutation ? 'Discord hat während der Übertragung einen Serverfehler gemeldet. Die Zustellung ist unklar; bitte zuerst in Discord prüfen.' + detail : 'Discord ist vorübergehend nicht erreichbar.' + detail, 502);
  const fields = fieldErrors(body);
  return new AppError('permanent', 'Discord hat das Format oder ein Feld abgelehnt.' + detail + (fields ? ' Felder: ' + fields : ''), 400);
}

export class DiscordClient {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) { this.config = config; this.fetch = fetchImpl; this.now = now; this.delays = new Map(); }

  async request(method, path, { token, payload, imageBytes, imageMeta } = {}) {
    if (!/^\/[A-Za-z0-9_@/?.=&%-]+$/.test(path) || path.includes('..')) throw new Error('Ungültiger interner Discord-Pfad.');
    const authorizationKey = token ? sha256(token) : 'bot';
    const routeKey = authorizationKey + ':' + method + ':' + path.replace(/\/messages\/\d+/g, '/messages/:id');
    const globalKey = authorizationKey + ':global';
    const until = Math.max(this.delays.get(globalKey) || 0, this.delays.get(routeKey) || 0);
    if (until > this.now()) throw new AppError('rate_limited', 'Discord begrenzt die Anfragen. Bitte nach der angezeigten Wartezeit erneut versuchen.', 429, until - this.now());
    const headers = { Authorization: token ? 'Bearer ' + token : 'Bot ' + this.config.botToken, 'User-Agent': 'Crazy_Batto-Discord-App/2.2.0' };
    let body;
    if (imageBytes) {
      body = new FormData();
      body.set('payload_json', JSON.stringify(payload));
      body.set('files[0]', new Blob([imageBytes], { type: imageMeta.mime }), imageMeta.name);
    } else if (payload !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload); }
    const mutation = method !== 'GET';
    let response;
    try {
      response = await this.fetch(API + path, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(imageBytes ? 150_000 : 35_000) });
    } catch (error) {
      const definitelyBeforeConnect = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.cause?.code || error?.code);
      throw new AppError(mutation && !definitelyBeforeConnect ? 'uncertain' : 'network', mutation && !definitelyBeforeConnect
        ? 'Die Verbindung wurde während der Übertragung unterbrochen. Die Zustellung ist unklar; bitte zuerst in Discord prüfen.'
        : 'Discord konnte nicht erreicht werden. Bitte später erneut versuchen.', 502, mutation && !definitelyBeforeConnect ? 0 : 5000);
    }
    let parsed;
    try { parsed = await jsonResponse(response); }
    catch {
      if (!response.ok) throw discordError(response, null, mutation);
      throw new AppError(mutation ? 'uncertain' : 'network', mutation ? 'Discord hat geantwortet, aber die Bestätigung konnte nicht gelesen werden. Bitte zuerst in Discord prüfen.' : 'Die Discord-Antwort konnte nicht gelesen werden.', 502);
    }
    if (!response.ok) {
      const error = discordError(response, parsed, mutation);
      if (error.kind === 'rate_limited') {
        this.delays.set(parsed?.global === true ? globalKey : routeKey, this.now() + error.retryAfterMs);
        if (this.delays.size > 5000) for (const [key, expiry] of this.delays) if (expiry <= this.now()) this.delays.delete(key);
      }
      throw error;
    }
    return parsed;
  }

  async tokenExchange(fields) {
    let response;
    try {
      response = await this.fetch(API + '/oauth2/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(this.config.clientId + ':' + this.config.clientSecret).toString('base64'), 'User-Agent': 'Crazy_Batto-Discord-App/2.2.0' },
        body: new URLSearchParams(fields).toString()
      });
    } catch { throw new AppError('network', 'Discord-Anmeldung derzeit nicht erreichbar. Bitte die Anmeldung erneut starten.', 502); }
    let result;
    try { result = await jsonResponse(response); }
    catch {
      if (response.status === 429) throw discordError(response, null, false);
      throw new AppError('network', 'Discord hat derzeit keine lesbare Anmeldebestätigung geliefert. Bitte später erneut versuchen.', 502);
    }
    if (response.status === 429) throw discordError(response, result, false);
    if (response.status >= 500) throw new AppError('network', 'Die Discord-Anmeldung ist vorübergehend nicht erreichbar. Bitte später erneut versuchen.', 502);
    if (!response.ok) {
      if (['invalid_grant', 'access_denied'].includes(result?.error)) throw new AppError('auth', 'Discord hat diese Anmeldung abgelehnt. Bitte erneut anmelden.', 401);
      if (['invalid_client', 'unauthorized_client', 'invalid_scope', 'unsupported_grant_type', 'invalid_request'].includes(result?.error)) throw new AppError('unconfigured', 'Die Discord-Anmeldekonfiguration auf dem Server wurde abgelehnt. Bitte den Betreiber kontaktieren.', 503);
      throw new AppError('network', 'Die Discord-Anmeldung konnte derzeit nicht bestätigt werden. Bitte später erneut versuchen.', 502);
    }
    return result;
  }
}
