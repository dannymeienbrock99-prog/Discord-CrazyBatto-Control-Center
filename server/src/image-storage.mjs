import { AppError, assert } from './errors.mjs';
import { PcStorageClient } from './pc-storage.mjs';
import { inspectImageBytes, MAX_IMAGE_BYTES } from './payloads.mjs';
import { sha256 } from './store.mjs';

export const NAS_IMAGE_ID = /^(?:app|site|gallery)_[a-f0-9]{64}$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function imageStorageId(scope, digest) {
  const id = scope + '_' + digest;
  assert(NAS_IMAGE_ID.test(id), 'Der Bildverweis ist ungültig.');
  return id;
}

export class ImageStorageClient {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.client = new PcStorageClient({ url: config.musicStorageUrl, token: config.musicStorageToken, fetchImpl });
    this.configured = this.client.configured;
    this.active = 0;
  }
  async status() {
    if (!this.configured) return { configured: false, online: false, message: 'Der private Bildspeicher ist noch nicht eingerichtet.' };
    const health = await this.client.health();
    if (!health.online) return { configured: true, online: false, message: 'Der Bildspeicher ist offline. Bitte die Speicherverbindung prüfen.' };
    if (health.imageStorageVersion !== 1) return { configured: true, online: false, message: 'Die Bildspeicherung ist auf dem privaten Speicher noch nicht eingerichtet.' };
    return { configured: true, online: true, message: 'Bildspeicher verbunden.' };
  }
  async bounded(task) {
    assert(this.configured, 'Der private Bildspeicher ist noch nicht eingerichtet.', 'unconfigured', 503);
    assert(this.active < 8, 'Der Bildspeicher ist ausgelastet. Bitte kurz warten.', 'rate_limited', 429);
    this.active++;
    try { return await task(); }
    catch (error) {
      if (error instanceof AppError) throw error;
      const status = error.status || error.statusCode;
      if (status === 404) throw new AppError('not_found', 'Das gespeicherte Bild ist nicht vorhanden.', 404);
      if (status === 409) throw new AppError('conflict', 'Der Bildspeicher konnte diese Änderung nicht übernehmen. Bitte neu laden.', 409);
      if ([400, 413, 415, 422].includes(status)) throw new AppError('validation', 'Das Bild wurde vom Speicher nicht als gültige JPG-, PNG- oder WebP-Datei bestätigt.', status);
      if (status === 429) throw new AppError('rate_limited', 'Der Bildspeicher ist ausgelastet. Bitte kurz warten.', 429, 5000);
      throw new AppError('network', 'Der Bildspeicher ist nicht erreichbar. Es wurde keine neue Bildkopie auf dem Webserver angelegt.', 503, 5000);
    } finally { this.active--; }
  }
  route(id) { assert(NAS_IMAGE_ID.test(id), 'Der Bildverweis ist ungültig.'); return '/v1/images/' + id; }
  verify(id, bytes, meta) {
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES && TYPES.has(meta.mimeType), 'Erlaubt sind JPG-, PNG- und WebP-Bilder bis 8 MiB.', 'validation', 413);
    const digest = sha256(bytes), dimensions = inspectImageBytes(bytes, meta.mimeType);
    assert(id.endsWith('_' + digest) && dimensions.width === meta.width && dimensions.height === meta.height && dimensions.width > 0 && dimensions.height > 0 && dimensions.width <= 8192 && dimensions.height <= 8192 && dimensions.width * dimensions.height <= 32_000_000, 'Der Bildinhalt stimmt nicht mit den gespeicherten Angaben überein.', 'validation', 422);
    return { id, sha256: digest, size: bytes.length, mimeType: meta.mimeType, ...dimensions };
  }
  async put(id, bytes, meta) {
    const expected = this.verify(id, bytes, meta), route = this.route(id);
    return this.bounded(async () => {
      const response = await this.client.request(route, { method: 'PUT', headers: { 'Content-Type': expected.mimeType, 'Content-Length': String(bytes.length) }, body: bytes }, 125000);
      const result = await this.client.result(response);
      assert(Object.keys(expected).every(key => result[key] === expected[key]), 'Die Speicherbestätigung für das Bild stimmt nicht überein.', 'network', 502);
      return expected;
    });
  }
  async read(id, meta) {
    const route = this.route(id);
    return this.bounded(async () => {
      const response = await this.client.request(route, {}, 60000, 10000);
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new AppError(response.status === 404 ? 'not_found' : 'network', response.status === 404 ? 'Das gespeicherte Bild ist nicht vorhanden.' : 'Der Bildspeicher ist momentan nicht erreichbar.', response.status === 404 ? 404 : 503, 5000);
      }
      if (!response.body || response.headers.get('content-type')?.split(';')[0] !== meta.mimeType || Number(response.headers.get('content-length')) !== meta.size) {
        await response.body?.cancel();
        throw new AppError('network', 'Der Bildspeicher hat keine gültigen Bilddaten geliefert.', 502);
      }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          assert(size <= meta.size && size <= MAX_IMAGE_BYTES, 'Der Bildspeicher hat eine ungültige Bildgröße geliefert.', 'network', 502);
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      assert(size === meta.size, 'Das Bild wurde nicht vollständig übertragen.', 'network', 502);
      this.verify(id, bytes, meta);
      return bytes;
    });
  }
  async remove(id) {
    const route = this.route(id);
    return this.bounded(async () => {
      const result = await this.client.result(await this.client.request(route, { method: 'DELETE' }));
      assert(result.ok === true && result.quarantined === true && result.id === id, 'Das Entfernen des Bildes wurde nicht bestätigt.', 'network', 502);
      return { ok: true, id, quarantined: true };
    });
  }
}
