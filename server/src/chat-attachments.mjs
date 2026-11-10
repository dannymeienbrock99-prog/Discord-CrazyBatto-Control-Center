import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { AppError, assert } from './errors.mjs';
import { inspectImageBytes, MAX_IMAGE_BYTES } from './payloads.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAGIC = Buffer.from('CBCHAT01');
const HEADER_SIZE = 36;
async function writeAll(handle, bytes, position = null) {
  let offset = 0;
  while (offset < bytes.length) { const result = await handle.write(bytes, offset, bytes.length - offset, position === null ? null : position + offset); assert(result.bytesWritten > 0, 'Die Datei konnte nicht gespeichert werden.', 'unconfigured', 503); offset += result.bytesWritten; }
}
export const CHAT_ATTACHMENT_LIMITS = Object.freeze({ maxFileBytes: 20 * 1024 * 1024, maxFiles: 5, maxUserBytes: 250 * 1024 * 1024, maxVoiceSeconds: 300, maxImagePreviewBytes: MAX_IMAGE_BYTES });
const imageFilename = /\.(?:jpe?g|png|gif|webp)$/i;
const imageMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function inspectGif(bytes) {
  assert(bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)), 'Die GIF-Datei ist ungültig.');
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  let offset = 13, frames = 0, pixels = 0;
  if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 7) + 1);
  const blocks = () => {
    for (;;) { assert(offset < bytes.length, 'Die GIF-Datei ist unvollständig.'); const size = bytes[offset++]; if (!size) return; offset += size; assert(offset <= bytes.length, 'Die GIF-Datei ist unvollständig.'); }
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) { assert(frames > 0 && offset === bytes.length, 'Die GIF-Datei ist ungültig.'); return { width, height }; }
    if (marker === 0x21) { assert(offset < bytes.length && [0xf9, 0xfe, 0x01, 0xff].includes(bytes[offset++]), 'Die GIF-Erweiterung ist ungültig.'); blocks(); continue; }
    assert(marker === 0x2c && offset + 9 <= bytes.length, 'Die GIF-Bilddaten sind ungültig.');
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2), frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6), flags = bytes[offset + 8];
    assert(frameWidth > 0 && frameHeight > 0 && left + frameWidth <= width && top + frameHeight <= height, 'Die GIF-Abmessungen sind ungültig.');
    assert(++frames <= 200 && (pixels += frameWidth * frameHeight) <= 100_000_000 && width * height * frames <= 100_000_000, 'Diese GIF-Animation ist für eine Vorschau zu groß.');
    offset += 9; if (flags & 0x80) offset += 3 * 2 ** ((flags & 7) + 1);
    assert(offset < bytes.length && bytes[offset] >= 2 && bytes[offset] <= 8, 'Die GIF-Bilddaten sind ungültig.'); offset++; blocks();
  }
  throw new AppError('validation', 'Die GIF-Datei ist unvollständig.');
}

// The MIME sent by an uploader and its extension never authorize inline data.
// Only a supported raster format with validated framing/dimensions is returned.
export function inspectChatImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  try {
    let mimeType;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) mimeType = 'image/jpeg';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
    else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) mimeType = 'image/gif';
    else return null;
    const dimensions = mimeType === 'image/gif' ? inspectGif(bytes) : inspectImageBytes(bytes, mimeType);
    assert(dimensions.width <= 8192 && dimensions.height <= 8192 && dimensions.width * dimensions.height <= 32_000_000, 'Das Bild ist für eine Vorschau zu groß.');
    return { mimeType, ...dimensions };
  } catch { return null; }
}
const voiceFormats = {
  'audio/webm': 'matroska', 'audio/ogg': 'ogg', 'audio/mp4': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav'
};
const basename = value => {
  let name; try { name = decodeURIComponent(value || ''); } catch { throw new AppError('validation', 'Der Dateiname ist ungültig.'); }
  assert(name && name.length <= 160 && name === name.trim() && !/[\u0000-\u001f\u007f/\\:<>"|?*\u202a-\u202e\u2066-\u2069]/.test(name) && !/^\.+$/.test(name), 'Bitte einen gültigen Dateinamen verwenden.');
  return name;
};

// Attachments never enter the public media library. Each file is authenticated
// AES-GCM ciphertext, bound to its random attachment ID and the existing key.
export class ChatAttachments {
  constructor(community) {
    this.community = community; this.accounts = community.accounts; this.store = community.store;
    this.directory = path.join(this.accounts.config.dataDir, 'private-chat-attachments');
    this.activeUploads = 0; this.activeReads = 0; this.waitingReads = []; this.pendingBytes = new Map(); this.spawn = spawn;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS community_chat_attachments (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, uploader_id TEXT NOT NULL REFERENCES accounts(id),
      upload_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','voice')),
      filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>0),
      sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, message_id TEXT, position INTEGER,
      UNIQUE(thread_id,uploader_id,upload_id));
      CREATE INDEX IF NOT EXISTS community_chat_attachments_user ON community_chat_attachments(uploader_id);
      CREATE INDEX IF NOT EXISTS community_chat_attachments_message ON community_chat_attachments(message_id,position);`);
    const columns = new Set(this.store.all('PRAGMA table_info(community_chat_attachments)').map(row => row.name));
    this.store.transaction(() => {
      for (const [name, type] of [['preview_checked', 'INTEGER NOT NULL DEFAULT 0'], ['preview_mime_type', 'TEXT'], ['preview_width', 'INTEGER'], ['preview_height', 'INTEGER'], ['duration_seconds', 'REAL']]) {
        if (!columns.has(name)) this.store.db.exec('ALTER TABLE community_chat_attachments ADD COLUMN ' + name + ' ' + type);
      }
    });
  }
  key() { const key = this.accounts.config.encryptionKey; assert(Buffer.isBuffer(key) && key.length === 32, 'Der private Dateispeicher ist noch nicht eingerichtet.', 'unconfigured', 503); return key; }
  file(id) { assert(UUID.test(id), 'Diese Datei ist nicht vorhanden.', 'not_found', 404); return path.join(this.directory, id + '.bin'); }
  view(row) {
    const url = '/api/community/threads/' + row.thread_id + '/attachments/' + row.id;
    const hasPreview = row.kind === 'file' && row.size <= MAX_IMAGE_BYTES && (imageMime.has(row.preview_mime_type) || !row.preview_checked && imageFilename.test(row.filename));
    return { id: row.id, name: row.filename, mimeType: row.mime_type, size: row.size, kind: row.kind, url,
      ...(hasPreview ? { previewUrl: url + '/preview', ...(imageMime.has(row.preview_mime_type) ? { previewMimeType: row.preview_mime_type, width: row.preview_width, height: row.preview_height } : {}) } : {}),
      ...(Number.isFinite(row.duration_seconds) && row.duration_seconds > 0 ? { durationSeconds: row.duration_seconds } : {}) };
  }
  forMessage(id) { return this.store.all('SELECT * FROM community_chat_attachments WHERE message_id=? ORDER BY position,id', id).map(row => this.view(row)); }
  sender(context, threadId) {
    const actor = this.community.actor(context), thread = this.community.thread(threadId, actor.id);
    assert(this.community.threadView(thread, actor.id).canSend, 'Dateien können erst nach Annahme der Anfrage gesendet werden.', 'forbidden', 403);
    return { actor, thread };
  }
  authorize(context, threadId, id) {
    const actor = this.community.actor(context); this.community.thread(threadId, actor.id);
    const row = this.store.get('SELECT * FROM community_chat_attachments WHERE id=? AND thread_id=?', id, threadId);
    assert(row && (row.message_id || row.uploader_id === actor.id), 'Diese Datei ist nicht vorhanden.', 'not_found', 404); return row;
  }
  claim(ids, threadId, actorId, messageId) {
    for (const [position, id] of ids.entries()) {
      const row = this.store.get('SELECT * FROM community_chat_attachments WHERE id=? AND thread_id=? AND uploader_id=? AND message_id IS NULL', id, threadId, actorId);
      assert(row, 'Eine ausgewählte Datei ist nicht mehr verfügbar. Bitte erneut hinzufügen.', 'conflict', 409);
      this.store.run('UPDATE community_chat_attachments SET message_id=?,position=? WHERE id=? AND message_id IS NULL', messageId, position, id);
    }
  }
  async initDirectory() {
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.promises.lstat(this.directory); assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Der private Dateispeicher ist nicht verfügbar.', 'unconfigured', 503);
    await fs.promises.chmod(this.directory, 0o700);
  }
  async acquireRead() {
    if (this.activeReads < 2) { this.activeReads++; return; }
    assert(this.waitingReads.length < 64, 'Der private Dateispeicher ist ausgelastet. Bitte kurz warten.', 'rate_limited', 429);
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => { this.waitingReads = this.waitingReads.filter(row => row !== waiter); reject(new AppError('rate_limited', 'Der private Dateispeicher ist ausgelastet. Bitte erneut versuchen.', 429)); }, 15000);
      waiter.timer.unref(); this.waitingReads.push(waiter);
    });
  }
  releaseRead() {
    const waiter = this.waitingReads.shift();
    if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); } else this.activeReads--;
  }
  async cleanupStaged(actorId) {
    const old = this.store.all('SELECT id FROM community_chat_attachments WHERE uploader_id=? AND message_id IS NULL AND created_at<?', actorId, this.community.now() - 24 * 3600_000);
    // Remove claimable metadata synchronously before any awaited filesystem work.
    this.store.transaction(() => { for (const row of old) this.store.run('DELETE FROM community_chat_attachments WHERE id=? AND message_id IS NULL', row.id); });
    for (const row of old) await fs.promises.unlink(this.file(row.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async decryptStream(id, file) {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(), header = Buffer.alloc(HEADER_SIZE);
      assert(stat.isFile() && stat.size > HEADER_SIZE && stat.size <= CHAT_ATTACHMENT_LIMITS.maxFileBytes + HEADER_SIZE, 'Die gespeicherte Datei ist beschädigt.', 'unconfigured', 503);
      const read = await handle.read(header, 0, HEADER_SIZE, 0);
      assert(read.bytesRead === HEADER_SIZE && header.subarray(0, 8).equals(MAGIC), 'Die gespeicherte Datei ist beschädigt.', 'unconfigured', 503);
      const decipher = createDecipheriv('aes-256-gcm', this.key(), header.subarray(8, 20)); decipher.setAAD(Buffer.from(id)); decipher.setAuthTag(header.subarray(20));
      return { input: handle.createReadStream({ start: HEADER_SIZE, autoClose: true }), decipher, size: stat.size - HEADER_SIZE };
    } catch (error) { await handle.close(); throw error; }
  }
  async verifyVoice(id, file, mime) {
    const format = voiceFormats[mime]; assert(format, 'Diese Sprachaufnahme wird nicht unterstützt. Bitte erneut aufnehmen.', 'validation', 415);
    const { input, decipher } = await this.decryptStream(id, file);
    const child = this.spawn(this.accounts.config.chatFfprobePath || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'pipe', '-f', format, '-i', 'pipe:0', '-count_packets', '-show_entries', 'stream=codec_type,codec_name,duration:format=duration', '-of', 'json'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 12000); timer.unref();
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 32768) { overflow = true; child.kill('SIGKILL'); } });
    const completion = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    try {
      const results = await Promise.allSettled([pipeline(input, decipher, child.stdin), completion]);
      if (results[1].status === 'rejected' && results[1].reason?.code === 'ENOENT') throw new AppError('unconfigured', 'Sprachaufnahmen sind momentan nicht verfügbar. Bitte später erneut versuchen.', 503);
      assert(results.every(row => row.status === 'fulfilled') && results[1].value === 0 && !overflow && !timedOut, 'Diese Sprachaufnahme konnte nicht gelesen werden. Bitte erneut aufnehmen.', 'validation', 422);
      let probe; try { probe = JSON.parse(output); } catch { throw new AppError('validation', 'Die Sprachaufnahme ist ungültig.', 422); }
      const streams = probe.streams;
      assert(Array.isArray(streams) && streams.length === 1 && streams[0].codec_type === 'audio' && ['opus', 'vorbis', 'aac', 'mp3', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'].includes(streams[0].codec_name), 'Bitte ausschließlich eine Sprachaufnahme ohne Video senden.', 'validation', 422);
      const durations = [probe.format?.duration, ...streams.map(row => row.duration)].map(Number).filter(Number.isFinite);
      assert(durations.every(duration => duration > 0 && duration <= CHAT_ATTACHMENT_LIMITS.maxVoiceSeconds + 1), 'Eine Sprachnachricht darf höchstens fünf Minuten dauern.', 'validation', 422);
      return durations.length ? Math.max(...durations) : null;
    } finally { clearTimeout(timer); input.destroy(); decipher.destroy(); child.stdin.destroy(); child.kill(); }
  }
  async upload(req, context, threadId) {
    const { actor } = this.sender(context, threadId), length = Number(req.headers['content-length']);
    assert(/^\d+$/.test(req.headers['content-length'] || '') && Number.isSafeInteger(length) && length > 0 && length <= CHAT_ATTACHMENT_LIMITS.maxFileBytes, 'Eine Datei darf höchstens 20 MiB groß sein.', 'validation', 413);
    assert(!req.headers['content-encoding'], 'Bitte die Datei unverpackt übertragen.', 'validation', 415);
    const filename = basename(req.headers['x-file-name']), kind = req.headers['x-attachment-kind'], uploadId = req.headers['x-upload-id'];
    assert(['file', 'voice'].includes(kind) && typeof uploadId === 'string' && UUID.test(uploadId), 'Die Dateiübertragung ist ungültig.');
    const mime = kind === 'voice' ? String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() : 'application/octet-stream';
    assert(kind !== 'voice' || Object.hasOwn(voiceFormats, mime), 'Dieses Aufnahmeformat wird nicht unterstützt.', 'validation', 415);
    assert(this.activeUploads < 2, 'Es werden bereits Dateien übertragen. Bitte kurz warten.', 'rate_limited', 429);
    this.accounts.limit('community-attachment:' + actor.id, 60, 3600_000); this.activeUploads++;
    const id = randomUUID(), temp = this.file(id) + '.part', final = this.file(id); let handle, reserved = false, committed = false;
    try {
      await this.initDirectory(); await this.cleanupStaged(actor.id); this.sender(context, threadId);
      const used = this.store.get('SELECT COALESCE(SUM(size),0) AS bytes FROM community_chat_attachments WHERE uploader_id=?', actor.id).bytes;
      const existing = this.store.get('SELECT * FROM community_chat_attachments WHERE thread_id=? AND uploader_id=? AND upload_id=?', threadId, actor.id, uploadId);
      assert(used + (this.pendingBytes.get(actor.id) || 0) + (existing ? 0 : length) <= CHAT_ATTACHMENT_LIMITS.maxUserBytes, 'Dein privater Dateispeicher ist voll (250 MiB).', 'conflict', 409);
      this.pendingBytes.set(actor.id, (this.pendingBytes.get(actor.id) || 0) + length); reserved = true;
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv); cipher.setAAD(Buffer.from(id));
      handle = await fs.promises.open(temp, 'wx', 0o600); await writeAll(handle, Buffer.concat([MAGIC, iv, Buffer.alloc(16)]));
      let size = 0; const digest = createHash('sha256'), previewChunks = kind === 'file' && length <= MAX_IMAGE_BYTES ? [] : null;
      for await (const chunk of req) {
        size += chunk.length; assert(size <= length, 'Die Datei ist größer als angegeben.', 'validation', 413); digest.update(chunk); if (previewChunks) previewChunks.push(chunk); await writeAll(handle, cipher.update(chunk));
      }
      assert(size === length, 'Die Datei wurde nicht vollständig übertragen.'); await writeAll(handle, cipher.final()); await writeAll(handle, cipher.getAuthTag(), 20); await handle.sync(); await handle.close(); handle = null;
      const hash = digest.digest('hex'), duration = kind === 'voice' ? await this.verifyVoice(id, temp, mime) : null;
      const preview = previewChunks ? inspectChatImage(Buffer.concat(previewChunks)) : null;
      return await this.community.exclusive(async () => {
        this.sender(context, threadId);
        const previous = this.store.get('SELECT * FROM community_chat_attachments WHERE thread_id=? AND uploader_id=? AND upload_id=?', threadId, actor.id, uploadId);
        if (previous) { assert(previous.sha256 === hash && previous.kind === kind && previous.filename === filename && previous.mime_type === mime && previous.size === size, 'Diese Uploadkennung wurde bereits für eine andere Datei verwendet.', 'conflict', 409); return this.view(previous); }
        const usedNow = this.store.get('SELECT COALESCE(SUM(size),0) AS bytes FROM community_chat_attachments WHERE uploader_id=?', actor.id).bytes;
        assert(usedNow + size <= CHAT_ATTACHMENT_LIMITS.maxUserBytes, 'Dein privater Dateispeicher ist voll (250 MiB).', 'conflict', 409);
        await fs.promises.rename(temp, final); this.sender(context, threadId);
        this.store.run('INSERT INTO community_chat_attachments(id,thread_id,uploader_id,upload_id,kind,filename,mime_type,size,sha256,created_at,preview_checked,preview_mime_type,preview_width,preview_height,duration_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)', id, threadId, actor.id, uploadId, kind, filename, mime, size, hash, this.community.now(), preview?.mimeType ?? null, preview?.width ?? null, preview?.height ?? null, duration); committed = true;
        return this.view(this.store.get('SELECT * FROM community_chat_attachments WHERE id=?', id));
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temp).catch(() => {}); if (!committed) await fs.promises.unlink(final).catch(() => {});
      if (reserved) { const pending = (this.pendingBytes.get(actor.id) || 0) - length; if (pending) this.pendingBytes.set(actor.id, pending); else this.pendingBytes.delete(actor.id); }
      this.activeUploads--;
    }
  }
  async serve(req, res, context, threadId, id, preview = false) {
    const before = this.authorize(context, threadId, id);
    if (preview) { assert(before.kind === 'file', 'Für diese Datei ist keine Bildvorschau verfügbar.', 'validation', 415); assert(before.size <= MAX_IMAGE_BYTES, 'Bildvorschauen sind bis 8 MiB möglich. Bitte die Originaldatei herunterladen.', 'validation', 413); }
    await this.acquireRead();
    try {
      if (res.destroyed) return;
      this.authorize(context, threadId, id);
      let bytes;
      try {
        const { input, decipher, size } = await this.decryptStream(id, this.file(id));
        if (size !== before.size) { input.destroy(); decipher.destroy(); throw new AppError('unconfigured', 'Die gespeicherte Dateigröße stimmt nicht überein.', 503); }
        const chunks = []; await pipeline(input, decipher, async source => { for await (const chunk of source) chunks.push(chunk); }); bytes = Buffer.concat(chunks);
      } catch (error) { if (error instanceof AppError) throw error; throw new AppError('unconfigured', 'Die private Datei kann momentan nicht gelesen werden.', 503); }
      const row = this.authorize(context, threadId, id);
      assert(bytes.length === row.size && createHash('sha256').update(bytes).digest('hex') === row.sha256, 'Die private Datei ist beschädigt.', 'unconfigured', 503);
      let previewImage = null;
      if (preview) {
        previewImage = inspectChatImage(bytes);
        this.store.run('UPDATE community_chat_attachments SET preview_checked=1,preview_mime_type=?,preview_width=?,preview_height=? WHERE id=?', previewImage?.mimeType ?? null, previewImage?.width ?? null, previewImage?.height ?? null, row.id);
        assert(previewImage, 'Für diese Datei ist keine Bildvorschau verfügbar. Bitte die Originaldatei herunterladen.', 'validation', 415);
      }
      const headers = { 'Content-Type': previewImage?.mimeType || row.mime_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Accept-Ranges': 'bytes', 'Content-Disposition': (previewImage || row.kind === 'voice' ? 'inline' : 'attachment') + '; filename="download"; filename*=UTF-8\'\'' + encodeURIComponent(row.filename) };
      let start = 0, end = row.size - 1, status = 200;
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range), first = range?.[1], last = range?.[2];
        if (!range || !first && !last || first && !Number.isSafeInteger(Number(first)) || last && !Number.isSafeInteger(Number(last))) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + row.size, 'Content-Length': 0 }); res.end(); return; }
        if (!first) { start = Math.max(0, row.size - Number(last)); } else { start = Number(first); if (last) end = Math.min(end, Number(last)); }
        if (start > end || start >= row.size || !first && Number(last) === 0) { res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + row.size, 'Content-Length': 0 }); res.end(); return; }
        status = 206; headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + row.size;
      }
      res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 }); res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    } finally { this.releaseRead(); }
  }
}
