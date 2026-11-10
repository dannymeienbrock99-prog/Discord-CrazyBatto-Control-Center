import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, assert } from './errors.mjs';
import { inspectImageBytes, validateImageBytes } from './payloads.mjs';
import { atomicWrite, sha256 } from './store.mjs';
import { imageStorageId } from './image-storage.mjs';

export const SITE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const SITE_MAX_UPLOAD_REQUEST_BYTES = 6 * 1024 * 1024;
export const SITE_MAX_BYTES = 100 * 1024 * 1024;
export const SITE_MAX_IMAGES = 100;
const MAX_PIXELS = 32_000_000;
const IMAGE_ID = /^img_[a-f0-9]{64}$/;
const FORMAT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const BUILT_INS = Object.freeze({
  'brand-dragon': { filename: 'brand-dragon.jpeg', mimeType: 'image/jpeg' },
  'discord-app': { filename: 'discord-app.png', mimeType: 'image/png' }
});
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, keys, label) {
  assert(isRecord(value), label + ' fehlt oder ist ungültig.');
  assert(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), label + ' enthält fehlende oder unbekannte Felder.');
}
function text(value, maximum, label, minimum = 0) {
  assert(typeof value === 'string', label + ' muss Text enthalten.');
  const normalized = value.trim();
  assert(normalized.length >= minimum && normalized.length <= maximum, label + ' ist zu kurz oder zu lang (höchstens ' + maximum + ' Zeichen).');
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized), label + ' enthält ungültige Steuerzeichen.');
  return normalized;
}
function rows(value, maximum, label) { assert(Array.isArray(value) && value.length <= maximum, label + ' darf höchstens ' + maximum + ' Einträge enthalten.'); return value; }
function link(value) {
  if (value === null) return null;
  const raw = text(value, 1000, 'Die Link-Adresse', 1);
  if (raw === '/portal') return raw;
  assert(!/[\s\\]/.test(raw), 'Die Link-Adresse enthält ungültige Zeichen.');
  let parsed; try { parsed = new URL(raw); } catch { throw new AppError('validation', 'Bitte eine vollständige HTTPS-Link-Adresse eintragen.'); }
  assert(parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && !!parsed.hostname, 'Links müssen HTTPS ohne Zugangsdaten oder besondere Ports verwenden.');
  assert(parsed.href.length <= 1000, 'Die normalisierte Link-Adresse darf höchstens 1000 Zeichen enthalten.');
  return parsed.href;
}
function imageId(value, images, nullable = true) {
  if (value === null && nullable) return null;
  assert(typeof value === 'string' && (Object.hasOwn(BUILT_INS, value) || IMAGE_ID.test(value) && Object.hasOwn(images, value)), 'Dieses Bild ist nicht in der Bildverwaltung vorhanden.');
  return value;
}

export function normalizeSiteContent(raw, images = {}) {
  fields(raw, ['heroTitle', 'heroText', 'about', 'setup', 'apps', 'socialLinks'], 'Der Websiteinhalt');
  fields(raw.about, ['title', 'text', 'imageId', 'imageAlt'], 'Über mich');
  fields(raw.setup, ['title', 'text', 'components', 'images'], 'Das Setup');
  const appIds = new Set();
  return {
    heroTitle: text(raw.heroTitle, 100, 'Die Hauptüberschrift', 1), heroText: text(raw.heroText, 500, 'Der Einleitungstext'),
    about: { title: text(raw.about.title, 100, 'Die Über-mich-Überschrift'), text: text(raw.about.text, 5000, 'Der Über-mich-Text'),
      imageId: imageId(raw.about.imageId, images), imageAlt: text(raw.about.imageAlt, 300, 'Die Bildbeschreibung') },
    setup: { title: text(raw.setup.title, 100, 'Die Setupüberschrift'), text: text(raw.setup.text, 5000, 'Der Setuptext'),
      components: rows(raw.setup.components, 24, 'Die Komponentenliste').map(row => { fields(row, ['label', 'value'], 'Die Komponente'); return { label: text(row.label, 80, 'Der Komponentenname', 1), value: text(row.value, 300, 'Die Komponentenangabe', 1) }; }),
      images: rows(raw.setup.images, 12, 'Die Setupgalerie').map(row => { fields(row, ['imageId', 'alt', 'caption'], 'Das Setupbild'); return { imageId: imageId(row.imageId, images, false), alt: text(row.alt, 300, 'Die Bildbeschreibung'), caption: text(row.caption, 500, 'Die Bildunterschrift') }; }) },
    apps: rows(raw.apps, 8, 'Die Appliste').map(row => {
      fields(row, ['id', 'name', 'description', 'imageId', 'imageAlt', 'url', 'buttonLabel'], 'Die App');
      assert(typeof row.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(row.id) && !appIds.has(row.id), 'Die App-Kennungen müssen gültig und eindeutig sein.'); appIds.add(row.id);
      return { id: row.id, name: text(row.name, 100, 'Der Appname', 1), description: text(row.description, 3000, 'Die Appbeschreibung'), imageId: imageId(row.imageId, images),
        imageAlt: text(row.imageAlt, 300, 'Die App-Bildbeschreibung'), url: link(row.url), buttonLabel: text(row.buttonLabel, 60, 'Die Schaltflächenbeschriftung') };
    }),
    socialLinks: rows(raw.socialLinks, 12, 'Die Linkliste').map(row => { fields(row, ['label', 'url'], 'Der Link'); return { label: text(row.label, 80, 'Die Linkbeschriftung', 1), url: link(row.url) }; })
  };
}

export function referencedSiteImages(content) {
  return new Set([content.about.imageId, ...content.setup.images.map(row => row.imageId), ...content.apps.map(row => row.imageId)].filter(Boolean));
}
const defaultContent = () => ({ heroTitle: 'Crazy_Batto Discord App', heroText: '', about: { title: 'Über mich', text: '', imageId: null, imageAlt: '' },
  setup: { title: 'Mein Setup', text: '', components: [], images: [] }, apps: [], socialLinks: [] });

// Supplement the shared image header/dimension parser with bounded container
// validation. Content is never interpreted as markup or served as an HTML/SVG.
function validateContainer(bytes, mimeType) {
  if (mimeType === 'image/png') {
    let at = 8, sawData = false, ended = false, chunks = 0;
    while (at < bytes.length) {
      assert(at + 12 <= bytes.length && ++chunks <= 10000, 'Die PNG-Dateistruktur ist unvollständig.');
      const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
      assert(/^[A-Za-z]{4}$/.test(type) && size <= bytes.length - at - 12, 'Die PNG-Dateistruktur ist ungültig.');
      if (type === 'IDAT') { assert(size > 0, 'Das PNG enthält keine Bilddaten.'); sawData = true; }
      if (type === 'IHDR') assert(at === 8 && size === 13, 'Die PNG-Kopfdaten sind ungültig.');
      if (type === 'IEND') { assert(size === 0 && at + 12 === bytes.length, 'Das PNG enthält unerwartete Daten.'); ended = true; }
      at += size + 12;
    }
    assert(sawData && ended, 'Die PNG-Bilddaten sind unvollständig.');
  } else if (mimeType === 'image/webp') {
    let at = 12, sawFrame = false, chunks = 0;
    while (at < bytes.length) {
      assert(at + 8 <= bytes.length && ++chunks <= 10000, 'Die WebP-Dateistruktur ist unvollständig.');
      const type = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
      assert(size <= bytes.length - at - 8, 'Die WebP-Dateistruktur ist ungültig.');
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type)) { assert(size > 0, 'Das WebP enthält keine Bilddaten.'); sawFrame = true; }
      at += 8 + size + (size % 2);
    }
    assert(at === bytes.length && sawFrame, 'Die WebP-Bilddaten sind unvollständig.');
  } else {
    let at = 2, sawScan = false, segments = 0;
    while (at < bytes.length - 2) {
      assert(bytes[at] === 0xff && ++segments <= 10000, 'Die JPEG-Dateistruktur ist ungültig.');
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda) { sawScan = true; break; }
      assert(marker !== 0xd9 && marker !== 0x00 && marker !== 0xd8, 'Die JPEG-Bilddaten sind unvollständig.');
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      assert(at + 2 <= bytes.length, 'Die JPEG-Datei ist unvollständig.');
      const size = bytes.readUInt16BE(at);
      assert(size >= 2 && at + size < bytes.length, 'Die JPEG-Datei ist unvollständig.'); at += size;
    }
    assert(sawScan && at + 2 < bytes.length && bytes.readUInt16BE(at) >= 6 && at + bytes.readUInt16BE(at) < bytes.length - 2, 'Die JPEG-Bilddaten fehlen.');
  }
}

function imageFilename(value) {
  const filename = text(value, 160, 'Der Bilddateiname', 1);
  assert(!/[\\/\r\n]/.test(filename) && filename !== '.' && filename !== '..', 'Bitte nur den Bilddateinamen ohne Ordner angeben.');
  return filename;
}
function imageRecord(bytes, mimeType, filename) {
  assert(typeof mimeType === 'string' && Object.hasOwn(FORMAT, mimeType), 'Erlaubt sind JPG-, PNG- und WebP-Bilder.');
  assert(bytes.length > 0 && bytes.length <= SITE_MAX_IMAGE_BYTES, 'Das Bild darf höchstens 4 MiB groß sein.', 'validation', 413);
  const dimensions = inspectImageBytes(bytes, mimeType);
  assert(dimensions.width * dimensions.height <= MAX_PIXELS, 'Das Bild darf höchstens 32 Millionen Pixel enthalten.');
  validateContainer(bytes, mimeType);
  const digest = sha256(bytes);
  validateImageBytes({ ref: digest + '.' + FORMAT[mimeType], mime: mimeType, size: bytes.length, ...dimensions }, bytes, mimeType);
  return { id: 'img_' + digest, mimeType, ...dimensions, size: bytes.length, filename: imageFilename(filename) };
}
function readInitialFile(filename, maximum) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size > 0 && stat.size <= maximum, 'Die mitgelieferte Website-Datei ist ungültig.', 'unconfigured', 503);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function initialImages(content, directory) {
  let manifest = { images: [] };
  try {
    const stat = fs.lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Der mitgelieferte Website-Bildordner ist ungültig.', 'unconfigured', 503);
    manifest = JSON.parse(readInitialFile(path.join(directory, 'manifest.json'), 64 * 1024).toString('utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fields(manifest, ['images'], 'Die mitgelieferte Bilderliste');
  const declared = {};
  for (const entry of rows(manifest.images, SITE_MAX_IMAGES, 'Die mitgelieferte Bilderliste')) {
    fields(entry, ['id', 'filename', 'mimeType'], 'Das mitgelieferte Bild');
    assert(typeof entry.id === 'string' && IMAGE_ID.test(entry.id) && !Object.hasOwn(declared, entry.id), 'Die mitgelieferte Bildkennung ist ungültig.');
    assert(typeof entry.mimeType === 'string' && Object.hasOwn(FORMAT, entry.mimeType), 'Erlaubt sind JPG-, PNG- und WebP-Bilder.');
    declared[entry.id] = { ...entry, filename: imageFilename(entry.filename) };
  }
  content = normalizeSiteContent(content, declared);
  const images = {}, files = []; let usedBytes = 0;
  // Only initial content references are imported. Source files are outside the
  // public asset directory and never gain their own public route.
  for (const id of referencedSiteImages(content)) {
    if (Object.hasOwn(BUILT_INS, id)) continue;
    const entry = declared[id], bytes = readInitialFile(path.join(directory, entry.filename), SITE_MAX_IMAGE_BYTES);
    const row = imageRecord(bytes, entry.mimeType, entry.filename);
    assert(row.id === id, 'Das mitgelieferte Websitebild stimmt nicht mit seiner Bildkennung überein.', 'unconfigured', 503);
    usedBytes += bytes.length;
    assert(usedBytes <= SITE_MAX_BYTES, 'Der Website-Bildspeicher überschreitet sein Limit.', 'unconfigured', 503);
    images[id] = row; files.push({ row, bytes });
  }
  return { content, images, files };
}

export class Site {
  constructor(config, store, access, { now = Date.now, imageStorage = null, assetsDirectory = fileURLToPath(new URL('../public/site/', import.meta.url)), defaultFile = fileURLToPath(new URL('../site-default.json', import.meta.url)), defaultImagesDirectory = fileURLToPath(new URL('../site-default-images/', import.meta.url)) } = {}) {
    this.config = config; this.store = store; this.access = access; this.now = now; this.assetsDirectory = assetsDirectory;
    this.imageStorage = imageStorage; this.imagePending = Promise.resolve(); this.deletingImages = new Set();
    this.directory = path.join(store.dataDir, 'site-images');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.checkDirectory(); fs.chmodSync(this.directory, 0o700);
    if (this.store.data.site === undefined) {
      let initial = { content: defaultContent(), images: {}, files: [] };
      let source;
      try {
        source = readInitialFile(defaultFile, 64 * 1024);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (source !== undefined) initial = initialImages(JSON.parse(source.toString('utf8')), defaultImagesDirectory);
      const content = normalizeSiteContent(initial.content, initial.images);
      const site = { schemaVersion: 1, version: 1, publishedVersion: 1, publishedAt: null, updatedAt: null,
        draft: structuredClone(content), published: structuredClone(content), images: initial.images, audit: [] };
      this.validateStored(site);
      // Commit normal private image bytes before the database references them.
      // Existing website data skip this whole branch, including missing or
      // changed initial files. Updates never reimport deleted owner images.
      for (const { row, bytes } of initial.files) this.writeImage(row, bytes);
      this.store.transaction(draft => { assert(draft.site === undefined, 'Die Website wurde bereits eingerichtet.', 'conflict', 409); draft.site = site; });
    }
    this.validateStored(this.store.data.site);
    // A crash after writing image bytes but before committing metadata can leave
    // an orphan. Remove only our generated, unreferenced filenames on startup.
    const retained = new Set(Object.values(this.store.data.site.images).map(row => row.id + '.' + FORMAT[row.mimeType]));
    for (const name of fs.readdirSync(this.directory)) {
      if (/^img_[a-f0-9]{64}\.(?:jpg|png|webp)(?:\.tmp-[A-Za-z0-9_-]+)?$/.test(name) && !retained.has(name)) {
        const target = path.join(this.directory, name); const stat = fs.lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(target);
      }
    }
  }
  checkDirectory() { const stat = fs.lstatSync(this.directory); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Der private Website-Bildordner ist ungültig.', 'unconfigured', 503); }
  validateStored(site) {
    assert(isRecord(site) && site.schemaVersion === 1 && Number.isSafeInteger(site.version) && site.version >= 1 && Number.isSafeInteger(site.publishedVersion) && site.publishedVersion >= 1 && site.publishedVersion <= site.version && isRecord(site.images) && Array.isArray(site.audit), 'Die Website-Datenbank ist ungültig.', 'unconfigured', 503);
    assert([site.publishedAt, site.updatedAt].every(value => value === null || Number.isSafeInteger(value) && value > 0), 'Die Website-Zeitangaben sind ungültig.', 'unconfigured', 503);
    const images = Object.entries(site.images);
    assert(images.length <= SITE_MAX_IMAGES, 'Die Website-Bildverwaltung ist ungültig.', 'unconfigured', 503);
    for (const [id, row] of images) {
      assert(IMAGE_ID.test(id) && isRecord(row) && row.id === id && Object.hasOwn(FORMAT, row.mimeType) && Number.isInteger(row.width) && row.width > 0 && Number.isInteger(row.height) && row.height > 0 && row.width * row.height <= MAX_PIXELS && Number.isInteger(row.size) && row.size > 0 && row.size <= SITE_MAX_IMAGE_BYTES && typeof row.filename === 'string' && row.filename.length <= 160, 'Die gespeicherten Website-Bilddaten sind ungültig.', 'unconfigured', 503);
      if (row.storage) assert(row.storage.backend === 'nas' && row.storage.id === imageStorageId('site', id.slice(4)), 'Der Website-Bildspeicherverweis ist ungültig.', 'unconfigured', 503);
    }
    assert(images.reduce((sum, [, row]) => sum + row.size, 0) <= SITE_MAX_BYTES, 'Der Website-Bildspeicher überschreitet sein Limit.', 'unconfigured', 503);
    normalizeSiteContent(site.draft, site.images); normalizeSiteContent(site.published, site.images);
  }
  quota(data = this.store.data.site) { return { usedBytes: Object.values(data.images).reduce((sum, row) => sum + row.size, 0), maxBytes: SITE_MAX_BYTES, maxImageBytes: SITE_MAX_IMAGE_BYTES, maxImages: SITE_MAX_IMAGES }; }
  privatePath(row) { assert(IMAGE_ID.test(row.id) && Object.hasOwn(FORMAT, row.mimeType), 'Der Bildverweis ist ungültig.'); this.checkDirectory(); return path.join(this.directory, row.id + '.' + FORMAT[row.mimeType]); }
  writeImage(row, bytes) {
    const target = this.privatePath(row);
    try { const stat = fs.lstatSync(target); assert(stat.isFile() && !stat.isSymbolicLink(), 'Dieser Bildspeicher ist nicht verfügbar.', 'unconfigured', 503); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    atomicWrite(target, bytes);
  }
  imageFile(id, { publicOnly = false } = {}) {
    if (publicOnly) assert(referencedSiteImages(this.store.data.site.published).has(id), 'Dieses Bild ist nicht veröffentlicht.', 'not_found', 404);
    if (Object.hasOwn(BUILT_INS, id)) return { filename: path.join(this.assetsDirectory, BUILT_INS[id].filename), mimeType: BUILT_INS[id].mimeType };
    const row = IMAGE_ID.test(id) && this.store.data.site.images[id];
    assert(row, 'Dieses Bild ist nicht vorhanden.', 'not_found', 404);
    if (row.storage) return { nasId: row.storage.id, mimeType: row.mimeType, width: row.width, height: row.height, size: row.size };
    return { filename: this.privatePath(row), mimeType: row.mimeType };
  }
  async imageBytes(id, options = {}) {
    const source = this.imageFile(id, options);
    assert(source.nasId && this.imageStorage, 'Der Bildspeicher ist noch nicht eingerichtet.', 'unconfigured', 503);
    const bytes = await this.imageStorage.read(source.nasId, source);
    this.imageFile(id, options);
    return { bytes, mimeType: source.mimeType };
  }
  exclusiveImage(task) { const next = this.imagePending.then(task, task); this.imagePending = next.catch(() => {}); return next; }
  builtIn(id) {
    const source = BUILT_INS[id]; let fd;
    try {
      fd = fs.openSync(path.join(this.assetsDirectory, source.filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd); assert(stat.isFile() && stat.size > 0 && stat.size <= 8 * 1024 * 1024, 'Das Website-Standardbild ist ungültig.', 'unconfigured', 503);
      const bytes = fs.readFileSync(fd), dimensions = inspectImageBytes(bytes, source.mimeType);
      return { id, url: '/site/assets/' + source.filename, mimeType: source.mimeType, ...dimensions, size: bytes.length, filename: source.filename, builtIn: true };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('unconfigured', 'Die Website-Standardbilder wurden auf diesem Server noch nicht vollständig bereitgestellt.', 503);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  images({ publicOnly = false } = {}) {
    const ids = publicOnly ? [...referencedSiteImages(this.store.data.site.published)] : [...Object.keys(BUILT_INS), ...Object.keys(this.store.data.site.images)];
    return ids.map(id => {
      const source = this.store.data.site.images[id];
      const row = Object.hasOwn(BUILT_INS, id) ? this.builtIn(id) : { id, mimeType: source.mimeType, width: source.width, height: source.height, size: source.size,
        filename: source.filename, url: publicOnly ? '/site/media/' + id : '/v2/admin/site/images/' + id, builtIn: false };
      if (publicOnly) delete row.filename;
      return row;
    });
  }
  publicContent() { const site = this.store.data.site; return { ok: true, version: site.publishedVersion, publishedAt: site.publishedAt, content: structuredClone(site.published), images: this.images({ publicOnly: true }) }; }
  admin(session) { this.access.requireOwner(session); const site = this.store.data.site; return { ok: true, version: site.version, publishedVersion: site.publishedVersion,
    publishedAt: site.publishedAt, updatedAt: site.updatedAt, draft: structuredClone(site.draft), published: structuredClone(site.published), images: this.images(), quota: this.quota() }; }
  version(site, expectedVersion) {
    assert(Number.isSafeInteger(expectedVersion) && expectedVersion >= 1, 'Die angezeigte Websiteversion fehlt.');
    assert(site.version === expectedVersion, 'Die Website wurde inzwischen geändert. Bitte neu laden und deine Änderungen prüfen.', 'conflict', 409);
    assert(site.version < Number.MAX_SAFE_INTEGER - 1, 'Die Websiteversion kann nicht weiter erhöht werden.', 'unconfigured', 503);
  }
  audit(site, session, action, imageId = null) {
    assert(site.audit.length < 100_000, 'Das Websiteprotokoll ist voll. Bitte den Serverbetreiber kontaktieren.', 'unconfigured', 503);
    site.audit.push({ at: this.now(), actorId: session.userId, action, version: site.version, imageId });
  }
  save(session, body) {
    this.access.requireOwner(session); fields(body, ['expectedVersion', 'content'], 'Die Websiteanfrage');
    this.version(this.store.data.site, body.expectedVersion);
    const content = normalizeSiteContent(body.content, this.store.data.site.images);
    assert(![...referencedSiteImages(content)].some(id => this.deletingImages.has(id)), 'Ein ausgewähltes Bild wird gerade entfernt. Bitte neu laden.', 'conflict', 409);
    this.store.transaction(draft => {
      this.access.requireOwner(session); this.version(draft.site, body.expectedVersion);
      draft.site.draft = normalizeSiteContent(content, draft.site.images); draft.site.version++; draft.site.updatedAt = this.now(); this.audit(draft.site, session, 'save');
    });
    return this.admin(session);
  }
  publish(session, body) {
    if ([...referencedSiteImages(this.store.data.site.draft)].some(id => this.store.data.site.images[id]?.storage)) return this.publishNas(session, body);
    this.access.requireOwner(session); fields(body, ['expectedVersion'], 'Die Veröffentlichungsanfrage'); this.version(this.store.data.site, body.expectedVersion);
    for (const id of referencedSiteImages(this.store.data.site.draft)) {
      const filename = this.imageFile(id).filename; let fd;
      try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); assert(fs.fstatSync(fd).isFile(), 'Ein Websitebild fehlt. Bitte erneut hochladen.', 'conflict', 409); }
      catch { throw new AppError('conflict', 'Ein Websitebild fehlt oder kann nicht gelesen werden. Bitte erneut hochladen.', 409); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    this.store.transaction(draft => {
      this.access.requireOwner(session); this.version(draft.site, body.expectedVersion);
      draft.site.published = normalizeSiteContent(draft.site.draft, draft.site.images); draft.site.version++; draft.site.publishedVersion = draft.site.version;
      draft.site.publishedAt = this.now(); draft.site.updatedAt = this.now(); this.audit(draft.site, session, 'publish');
    });
    return this.admin(session);
  }
  upload(session, body) {
    if (this.imageStorage) return this.uploadNas(session, body);
    this.access.requireOwner(session); fields(body, ['filename', 'mimeType', 'dataBase64'], 'Der Bildupload');
    const filename = imageFilename(body.filename);
    assert(typeof body.mimeType === 'string' && Object.hasOwn(FORMAT, body.mimeType), 'Erlaubt sind JPG-, PNG- und WebP-Bilder.');
    assert(typeof body.dataBase64 === 'string' && body.dataBase64.length > 0 && body.dataBase64.length <= Math.ceil(SITE_MAX_IMAGE_BYTES / 3) * 4, 'Das Bild darf höchstens 4 MiB groß sein.', 'validation', 413);
    assert(body.dataBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64), 'Der Bildinhalt ist kein gültiges Base64.');
    const bytes = Buffer.from(body.dataBase64, 'base64');
    assert(bytes.length <= SITE_MAX_IMAGE_BYTES, 'Das Bild darf höchstens 4 MiB groß sein.', 'validation', 413);
    assert(bytes.length > 0 && bytes.toString('base64') === body.dataBase64, 'Der Bildinhalt ist ungültig.');
    const incoming = imageRecord(bytes, body.mimeType, filename), id = incoming.id;
    this.access.requireOwner(session);
    const old = this.store.data.site.images[id];
    if (!old) {
      const quota = this.quota();
      assert(Object.keys(this.store.data.site.images).length < SITE_MAX_IMAGES && quota.usedBytes + bytes.length <= quota.maxBytes, 'Der Website-Bildspeicher ist voll. Bitte unbenutzte Bilder entfernen.', 'conflict', 409);
    }
    const row = old || incoming;
    // Bytes are committed first. A failed metadata write is cleaned at startup;
    // no public route can resolve an uncommitted image, even with a guessed ID.
    this.writeImage(row, bytes);
    if (!old) this.store.transaction(draft => { this.access.requireOwner(session); draft.site.images[id] = row; this.audit(draft.site, session, 'upload', id); });
    const images = this.images(); return { ok: true, image: images.find(image => image.id === id), images, quota: this.quota() };
  }
  deleteImage(session, id) {
    if (this.store.data.site.images[id]?.storage) return this.deleteNasImage(session, id);
    this.access.requireOwner(session);
    assert(!Object.hasOwn(BUILT_INS, id), 'Mitgelieferte Standardbilder können nicht gelöscht werden.', 'conflict', 409);
    assert(IMAGE_ID.test(id) && this.store.data.site.images[id], 'Dieses Bild ist nicht vorhanden.', 'not_found', 404);
    const row = this.store.data.site.images[id], target = this.privatePath(row);
    this.store.transaction(draft => {
      this.access.requireOwner(session);
      assert(!referencedSiteImages(draft.site.draft).has(id) && !referencedSiteImages(draft.site.published).has(id), 'Dieses Bild wird noch im Entwurf oder auf der veröffentlichten Website verwendet.', 'conflict', 409);
      delete draft.site.images[id]; this.audit(draft.site, session, 'delete_image', id);
    });
    // Remove only a regular generated file. An interrupted cleanup leaves an
    // inaccessible orphan, which startup cleanup handles without exposing it.
    try { if (fs.lstatSync(target).isFile()) fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ok: true, images: this.images(), quota: this.quota() };
  }
  async uploadNas(session, body) {
    this.access.requireOwner(session); fields(body, ['filename', 'mimeType', 'dataBase64'], 'Der Bildupload');
    const filename = imageFilename(body.filename);
    assert(Object.hasOwn(FORMAT, body.mimeType), 'Erlaubt sind JPG-, PNG- und WebP-Bilder.');
    assert(typeof body.dataBase64 === 'string' && body.dataBase64.length > 0 && body.dataBase64.length <= Math.ceil(SITE_MAX_IMAGE_BYTES / 3) * 4 && body.dataBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64), 'Das Bild muss gültiges Base64 enthalten und darf höchstens 4 MiB groß sein.', 'validation', 413);
    const bytes = Buffer.from(body.dataBase64, 'base64');
    assert(bytes.length > 0 && bytes.length <= SITE_MAX_IMAGE_BYTES && bytes.toString('base64') === body.dataBase64, 'Der Bildinhalt ist ungültig.');
    const incoming = imageRecord(bytes, body.mimeType, filename), id = incoming.id, nasId = imageStorageId('site', id.slice(4));
    return this.exclusiveImage(async () => {
      this.access.requireOwner(session);
      const old = this.store.data.site.images[id], quota = this.quota();
      if (!old) assert(Object.keys(this.store.data.site.images).length < SITE_MAX_IMAGES && quota.usedBytes + bytes.length <= quota.maxBytes, 'Der Website-Bildspeicher ist voll. Bitte unbenutzte Bilder entfernen.', 'conflict', 409);
      await this.imageStorage.put(nasId, bytes, incoming);
      this.access.requireOwner(session);
      assert(JSON.stringify(this.store.data.site.images[id]) === JSON.stringify(old), 'Dieser Bildeintrag wurde während der Übertragung geändert. Bitte neu laden.', 'conflict', 409);
      this.store.transaction(draft => {
        this.access.requireOwner(session);
        draft.site.images[id] = { ...(old || incoming), storage: { backend: 'nas', id: nasId } };
        this.audit(draft.site, session, 'upload', id);
      });
      const images = this.images(); return { ok: true, image: images.find(image => image.id === id), images, quota: this.quota() };
    });
  }
  async publishNas(session, body) {
    return this.exclusiveImage(async () => {
      this.access.requireOwner(session); fields(body, ['expectedVersion'], 'Die Veröffentlichungsanfrage'); this.version(this.store.data.site, body.expectedVersion);
      const ids = [...referencedSiteImages(this.store.data.site.draft)];
      for (const id of ids) {
        this.access.requireOwner(session);
        const source = this.imageFile(id);
        if (source.nasId) await this.imageStorage.read(source.nasId, source);
        else {
          let fd;
          try { fd = fs.openSync(source.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); assert(fs.fstatSync(fd).isFile(), 'Ein Websitebild fehlt.', 'conflict', 409); }
          catch { throw new AppError('conflict', 'Ein Websitebild fehlt oder kann nicht gelesen werden. Bitte erneut hochladen.', 409); }
          finally { if (fd !== undefined) fs.closeSync(fd); }
        }
      }
      this.store.transaction(draft => {
        this.access.requireOwner(session); this.version(draft.site, body.expectedVersion);
        draft.site.published = normalizeSiteContent(draft.site.draft, draft.site.images); draft.site.version++; draft.site.publishedVersion = draft.site.version;
        draft.site.publishedAt = this.now(); draft.site.updatedAt = this.now(); this.audit(draft.site, session, 'publish');
      });
      return this.admin(session);
    });
  }
  async deleteNasImage(session, id) {
    return this.exclusiveImage(async () => {
      this.access.requireOwner(session);
      const row = this.store.data.site.images[id];
      assert(row?.storage?.backend === 'nas', 'Dieses Bild ist nicht vorhanden.', 'not_found', 404);
      assert(!referencedSiteImages(this.store.data.site.draft).has(id) && !referencedSiteImages(this.store.data.site.published).has(id), 'Dieses Bild wird noch im Entwurf oder auf der veröffentlichten Website verwendet.', 'conflict', 409);
      this.deletingImages.add(id);
      try {
        await this.imageStorage.remove(row.storage.id);
        try { this.access.requireOwner(session); }
        catch (error) { this.store.transaction(draft => this.audit(draft.site, session, 'quarantined_pending_metadata', id)); throw error; }
        this.store.transaction(draft => { this.access.requireOwner(session); delete draft.site.images[id]; this.audit(draft.site, session, 'delete_image', id); });
      } finally { this.deletingImages.delete(id); }
      return { ok: true, images: this.images(), quota: this.quota() };
    });
  }
}
