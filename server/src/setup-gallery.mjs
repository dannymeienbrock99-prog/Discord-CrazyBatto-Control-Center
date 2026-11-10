import { assert } from './errors.mjs';
import { inspectImageBytes, MAX_IMAGE_BYTES } from './payloads.mjs';
import { imageStorageId } from './image-storage.mjs';
import { sha256 } from './store.mjs';

const SLOTS = ['gaming-hero', 'gaming-gallery', 'old-start', 'old-upgrade', 'old-cooling'];
const ID = /^gallery_[a-f0-9]{64}$/;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const clean = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
export const GALLERY_LIMITS = { maxFileBytes: MAX_IMAGE_BYTES, maxLibraryBytes: 100 * 1024 * 1024, maxImages: 100 };

export class SetupGallery {
  constructor(store, storage, { now = Date.now, additionalReferences = () => false } = {}) { this.store = store; this.storage = storage; this.now = now; this.additionalReferences = additionalReferences; this.pending = Promise.resolve(); this.uploads = 0; }
  // Serialize slot references and file quarantine so a new reference cannot be
  // published while the same image is being removed from the private store.
  exclusive(task) { const next = this.pending.then(task, task); this.pending = next.catch(() => {}); return next; }
  row(id) { assert(ID.test(id), 'Der Bildverweis ist ungültig.'); const row = this.store.get('SELECT * FROM setup_images WHERE id=?', id); assert(row, 'Dieses Bild ist nicht vorhanden.', 'not_found', 404); return row; }
  image(row, caption = '') { return { id: row.id, name: row.filename, caption, url: '/api/setup/images/' + row.id, width: row.width, height: row.height, size: row.size, mimeType: row.mime_type }; }
  slot(name) {
    assert(SLOTS.includes(name), 'Dieser Bildbereich ist nicht vorhanden.', 'not_found', 404);
    const row = this.store.get('SELECT * FROM setup_slots WHERE slot=?', name);
    return { slot: name, revision: row?.revision || 0, images: (row ? JSON.parse(row.images) : []).map(item => this.image(this.row(item.id), item.caption)) };
  }
  slots() { return SLOTS.map(slot => this.slot(slot)); }
  images() { return this.store.all('SELECT * FROM setup_images ORDER BY created_at,id').map(row => this.image(row)); }
  referenced(id, { publicOnly = false } = {}) { return this.slots().some(slot => slot.images.some(image => image.id === id)) || this.additionalReferences(id, { publicOnly }); }
  async upload(req, authorize) {
    assert(this.uploads < 4, 'Es werden bereits Bilder übertragen. Bitte kurz warten.', 'rate_limited', 429);
    this.uploads++;
    try { return await this.receive(req, authorize); }
    finally { this.uploads--; }
  }
  async receive(req, authorize) {
    authorize();
    const length = Number(req.headers['content-length']), mimeType = String(req.headers['content-type'] || '').split(';')[0].trim();
    assert(Number.isSafeInteger(length) && length > 0 && length <= MAX_IMAGE_BYTES, 'Das Bild darf höchstens 8 MiB groß sein und benötigt eine Größenangabe.', 'validation', 413);
    assert(!req.headers['content-encoding'] && MIME.has(mimeType), 'Erlaubt sind unverpackte JPG-, PNG- und WebP-Bilder.', 'validation', 415);
    let filename;
    try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { assert(false, 'Der Dateiname ist ungültig.'); }
    assert(filename && filename.length <= 160 && !/[\u0000-\u001f\u007f/\\:]/.test(filename), 'Bitte einen gültigen Bilddateinamen übergeben.');
    const chunks = []; let received = 0;
    for await (const chunk of req) { received += chunk.length; assert(received <= length && received <= MAX_IMAGE_BYTES, 'Das Bild ist größer als erlaubt.', 'validation', 413); chunks.push(chunk); }
    assert(received === length, 'Das Bild wurde nicht vollständig übertragen.');
    const bytes = Buffer.concat(chunks), dimensions = inspectImageBytes(bytes, mimeType), id = imageStorageId('gallery', sha256(bytes));
    return this.exclusive(async () => {
      const user = authorize(), old = this.store.get('SELECT * FROM setup_images WHERE id=?', id);
      if (!old) {
        const quota = this.store.get('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM setup_images');
        assert(quota.count < GALLERY_LIMITS.maxImages && quota.bytes + bytes.length <= GALLERY_LIMITS.maxLibraryBytes, 'Der Bildspeicher der Website ist voll. Bitte unbenutzte Bilder entfernen.', 'conflict', 409);
      }
      await this.storage.put(id, bytes, { mimeType, ...dimensions });
      authorize();
      this.store.transaction(() => {
        if (!old) this.store.run('INSERT INTO setup_images VALUES (?,?,?,?,?,?,?,?)', id, clean(filename, 160), mimeType, bytes.length, dimensions.width, dimensions.height, user.id, this.now());
        this.store.audit(user.id, 'setup.image_uploaded', id, {}, this.now());
      });
      return { image: this.image(this.row(id)) };
    });
  }
  async update(name, body, authorize) {
    return this.exclusive(() => {
      const user = authorize(), current = this.slot(name);
      assert(body && Object.keys(body).length === 2 && Object.hasOwn(body, 'expectedRevision') && Object.hasOwn(body, 'images'), 'Bitte Bildliste und Versionsnummer übergeben.');
      assert(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision === current.revision, 'Dieser Bildbereich wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      assert(Array.isArray(body.images) && body.images.length <= (name === 'gaming-gallery' ? 50 : 1), 'Dieser Bildbereich enthält zu viele Bilder.');
      const seen = new Set(), images = body.images.map(item => {
        assert(item && typeof item === 'object' && Object.keys(item).length === 2 && typeof item.caption === 'string' && item.caption.length <= 300 && !seen.has(item.id), 'Die Bildliste ist ungültig.');
        this.row(item.id); seen.add(item.id); return { id: item.id, caption: clean(item.caption, 300) };
      });
      assert(current.revision < Number.MAX_SAFE_INTEGER, 'Die Versionsnummer ist ungültig.', 'conflict', 409);
      this.store.transaction(() => {
        this.store.run('INSERT INTO setup_slots VALUES (?,?,?) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,images=excluded.images', name, current.revision + 1, JSON.stringify(images));
        this.store.audit(user.id, 'setup.slot_updated', name, {}, this.now());
      });
      return { slot: this.slot(name) };
    });
  }
  async remove(id, authorize) {
    return this.exclusive(async () => {
      const user = authorize(); this.row(id);
      assert(!this.referenced(id), 'Dieses Bild wird noch auf der Website verwendet.', 'conflict', 409);
      await this.storage.remove(id);
      try { authorize(); } catch (error) { this.store.audit(user.id, 'setup.quarantined_pending_metadata', id, {}, this.now()); throw error; }
      this.store.transaction(() => { this.store.run('DELETE FROM setup_images WHERE id=?', id); this.store.audit(user.id, 'setup.image_removed', id, {}, this.now()); });
      return { ok: true };
    });
  }
  async read(id, { publicOnly = true } = {}) {
    const row = this.row(id);
    if (publicOnly) assert(this.referenced(id, { publicOnly: true }), 'Dieses Bild ist nicht veröffentlicht.', 'not_found', 404);
    const mimeType = row.mime_type, bytes = await this.storage.read(id, { mimeType, width: row.width, height: row.height, size: row.size });
    // A public image removed during an in-flight NAS read stays private.
    this.row(id);
    if (publicOnly) assert(this.referenced(id, { publicOnly: true }), 'Dieses Bild ist nicht veröffentlicht.', 'not_found', 404);
    return { bytes, mimeType };
  }
}
