import { Readable } from 'node:stream';

const MAX_BYTES = 80 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFLINE = 'Der Musikspeicher ist offline. Bitte die Speicherverbindung prüfen.';

export class PcStorageError extends Error {
  constructor(code, message, status = 503) {
    super(message); this.name = 'PcStorageError'; this.code = code; this.kind = code; this.status = status; this.statusCode = status;
  }
}

export function privateStorageUrl(value) {
  try {
    const url = new URL(value);
    const octets = url.hostname.split('.').map(Number);
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && octets.every(x => Number.isInteger(x) && x >= 0 && x <= 255);
    const tailnet = ipv4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    const loopback = (ipv4 && octets[0] === 127) || url.hostname === '[::1]';
    if (!['http:', 'https:'].includes(url.protocol) || !(tailnet || loopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch { return null; }
}

async function boundedJson(response) {
  if (!response.body) throw new PcStorageError('storage_response', 'Der Musikspeicher hat keine gültige Antwort gesendet.');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) throw new Error('too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new PcStorageError('storage_response', 'Der Musikspeicher hat keine gültige Antwort gesendet.'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class PcStorageClient {
  constructor({ url, token, fetchImpl = fetch } = {}) {
    this.url = privateStorageUrl(url);
    this.token = typeof token === 'string' ? token : '';
    this.configured = Boolean(this.url && /^[A-Za-z0-9_-]{43,256}$/.test(this.token));
    this.fetchImpl = fetchImpl;
  }

  requireConfigured() {
    if (!this.configured) throw new PcStorageError('storage_unconfigured', 'Der private Musikspeicher ist noch nicht eingerichtet.');
  }

  filePath(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new PcStorageError('invalid_file', 'Ungültige Musikdatei.', 400);
    return '/files/' + id.toLowerCase();
  }

  async request(route, options = {}, timeoutMs = 10000, headersTimeoutMs = timeoutMs) {
    this.requireConfigured();
    const headersDeadline = new AbortController();
    const timer = setTimeout(() => headersDeadline.abort(), headersTimeoutMs); timer.unref();
    try {
      const response = await this.fetchImpl(this.url + route, { ...options, headers: { ...options.headers, Authorization: 'Bearer ' + this.token }, redirect: 'error', signal: AbortSignal.any([headersDeadline.signal, AbortSignal.timeout(timeoutMs)]) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new PcStorageError('storage_redirect', 'Der Musikspeicher darf keine Weiterleitung verwenden.');
      }
      return response;
    } catch (error) {
      if (error instanceof PcStorageError) throw error;
      throw new PcStorageError('storage_offline', OFFLINE);
    } finally { clearTimeout(timer); }
  }

  async result(response) {
    const body = await boundedJson(response);
    if (!response.ok) {
      const allowed = new Set(['invalid_type', 'invalid_media', 'invalid_image', 'image_hash_mismatch', 'invalid_name', 'file_too_large', 'length_required', 'invalid_encoding', 'busy', 'conflict', 'quota_exceeded', 'disk_full', 'incomplete_upload', 'timeout', 'not_found', 'storage_corrupt']);
      const known = allowed.has(body?.error?.code);
      throw new PcStorageError(known ? body.error.code : 'storage_unavailable', known && typeof body.error.message === 'string' ? body.error.message.slice(0, 300) : 'Der private Musikspeicher ist momentan nicht verfügbar.', known ? response.status : 503);
    }
    return body;
  }

  async health() {
    try {
      const body = await this.result(await this.request('/health', {}, 4000));
      if (body.online !== true) throw new PcStorageError('storage_offline', OFFLINE);
      const values = {};
      for (const key of ['usedBytes', 'quotaBytes', 'freeBytes', 'maxFileBytes', 'activeUploads', 'activeStreams', 'imageStorageVersion', 'maxImageBytes']) {
        if (Number.isSafeInteger(body[key]) && body[key] >= 0) values[key] = body[key];
      }
      return { configured: true, online: true, message: 'Musikspeicher erreichbar.', ...values };
    } catch (error) { return { configured: this.configured, online: false, message: error instanceof PcStorageError ? error.message : OFFLINE }; }
  }

  async upload(readable, { id, filename, size, mimeType }) {
    const route = this.filePath(id);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) throw new PcStorageError('file_too_large', 'Die Datei muss zwischen 1 Byte und 80 MiB groß sein.', 413);
    if (typeof filename !== 'string' || filename.length > 240 || /[\u0000-\u001f\u007f/\\:]/.test(filename) || !/\.(mp3|mp4)$/i.test(filename)) throw new PcStorageError('invalid_name', 'Nur MP3- und MP4-Dateinamen ohne Pfad sind erlaubt.', 400);
    if (!['audio/mpeg', 'video/mp4', 'audio/mp4'].includes(mimeType)) throw new PcStorageError('invalid_type', 'Nur MP3 und MP4 sind erlaubt.', 415);
    this.requireConfigured();
    let uploadFailure;
    const body = Readable.from((async function* () {
      try {
      let received = 0;
      for await (const chunk of readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += bytes.length;
        if (received > size || received > MAX_BYTES) throw new PcStorageError('file_too_large', 'Die Dateigröße wurde überschritten.', 413);
        yield bytes;
      }
      if (received !== size) throw new PcStorageError('incomplete_upload', 'Die Musikdatei wurde nicht vollständig übertragen.', 400);
      } catch (error) { uploadFailure = error; throw error; }
    })());
    try {
      const response = await this.request(route + '?filename=' + encodeURIComponent(filename), { method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Length': String(size) }, body, duplex: 'half' }, 125000);
      const result = await this.result(response);
      if (result.id !== id.toLowerCase() || result.size !== size || !['audio/mpeg', 'audio/mp4', 'video/mp4'].includes(result.mimeType) || !Number.isFinite(result.duration) || result.duration <= 0 || !/^[a-f0-9]{64}$/.test(result.sha256 || '')) {
        throw new PcStorageError('storage_response', 'Der Musikspeicher hat den Upload nicht gültig bestätigt.');
      }
      return { id: result.id, size: result.size, mimeType: result.mimeType, duration: result.duration, sha256: result.sha256 };
    } catch (error) {
      if (uploadFailure instanceof PcStorageError) throw uploadFailure;
      throw error;
    } finally { body.destroy(); }
  }

  async stream(id, { range, method = 'GET' } = {}) {
    const route = this.filePath(id);
    if (!['GET', 'HEAD'].includes(method)) throw new PcStorageError('invalid_method', 'Ungültige Wiedergabeanfrage.', 400);
    if (range && (typeof range !== 'string' || range.length > 128 || /[\r\n]/.test(range))) throw new PcStorageError('invalid_range', 'Ungültiger Dateibereich.', 416);
    return this.request(route, { method, headers: range ? { Range: range } : {} }, 610000, 10000);
  }

  async remove(id) {
    const result = await this.result(await this.request(this.filePath(id), { method: 'DELETE' }));
    if (result.ok !== true || result.quarantined !== true || result.id !== id.toLowerCase()) throw new PcStorageError('storage_response', 'Die Datei wurde nicht bestätigt in den Papierkorb des Musikspeichers verschoben.');
    return { ok: true, id: result.id, quarantined: true };
  }
}
