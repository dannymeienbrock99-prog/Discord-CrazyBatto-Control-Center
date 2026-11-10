import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './errors.mjs';

// Public certificate fingerprint, never the signing key. Only this reviewed
// package may claim the website through Android Digital Asset Links.
export const CHAT_APP_RELEASE = Object.freeze({
  packageName: 'de.crazybatto.chat', versionName: '1.0.0', versionCode: 1, minSdk: 26,
  filename: 'Crazy_Batto-Chat-1.0.0.apk',
  signerCertificateSha256: String(process.env.CHAT_APP_SIGNER_SHA256 || '0'.repeat(64)).replaceAll(':', '').toLowerCase()
});
export const CHAT_APP_DOWNLOAD_ROUTE = '/downloads/' + CHAT_APP_RELEASE.filename;
export const CHAT_APP_METADATA_ROUTE = '/downloads/chat-app.json';
export const CHAT_APP_ASSETLINKS_ROUTE = '/.well-known/assetlinks.json';
const routes = new Set([CHAT_APP_DOWNLOAD_ROUTE, CHAT_APP_METADATA_ROUTE, CHAT_APP_ASSETLINKS_ROUTE]);
export const isChatAppReleaseRoute = pathname => routes.has(pathname);
const unavailable = () => new AppError('unconfigured', 'Die Chat-App wird gerade vorbereitet. Bitte später erneut versuchen.', 503);

async function readRegularFile(filename, maximum) {
  // The release is an immutable deployment artifact. Do not follow either a
  // file symlink or a parent-directory symlink into unrelated server files.
  const absolute = path.resolve(filename);
  for (let current = absolute; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) throw unavailable();
    if (current === path.dirname(current)) break;
  }
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximum) throw unavailable();
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw unavailable();
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function apkPayload(bytes) {
  // Signature verification happens in the Android release build. At runtime,
  // additionally require the verified bytes to contain a non-split APK with an
  // APK Signing Block and the expected Android executable/package entries.
  if (bytes.length < 100 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) return false;
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > 10000 || bytes.readUInt16LE(end + 8) !== count || directoryOffset + directorySize !== end || directoryOffset < 32) return false;
  if (!bytes.subarray(directoryOffset - 16, directoryOffset).equals(Buffer.from('APK Sig Block 42'))) return false;
  const blockSize = bytes.readBigUInt64LE(directoryOffset - 24);
  if (blockSize < 24n || blockSize > BigInt(directoryOffset - 8)) return false;
  const blockStart = directoryOffset - Number(blockSize) - 8;
  if (bytes.readBigUInt64LE(blockStart) !== blockSize) return false;
  const required = new Set(['AndroidManifest.xml', 'classes.dex', 'resources.arsc']);
  let cursor = directoryOffset;
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) return false;
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameSize + extraSize + commentSize, local = bytes.readUInt32LE(cursor + 42);
    if (next > end || local + 30 > blockStart || bytes.readUInt32LE(local) !== 0x04034b50 || (bytes.readUInt16LE(cursor + 8) & 1)) return false;
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString('utf8');
    if (required.has(name)) {
      const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28), compressedSize = bytes.readUInt32LE(cursor + 20);
      if (!compressedSize || !bytes.readUInt32LE(cursor + 24) || local + 30 + localNameSize + localExtraSize + compressedSize > blockStart) return false;
      if (bytes.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== name) return false;
      required.delete(name);
    }
    cursor = next;
  }
  return cursor === end && required.size === 0;
}

export async function readChatAppRelease(config) {
  try {
    const filename = path.resolve(config.chatAppApkPath || './releases/' + CHAT_APP_RELEASE.filename);
    if (path.basename(filename) !== CHAT_APP_RELEASE.filename) throw unavailable();
    const proofFilename = filename.slice(0, -4) + '.verified.json';
    const proof = JSON.parse((await readRegularFile(proofFilename, 16 * 1024)).toString('utf8'));
    const certificate = String(proof.signerCertificateSha256 || '').replaceAll(':', '').toLowerCase();
    if (proof.packageName !== CHAT_APP_RELEASE.packageName || proof.versionName !== CHAT_APP_RELEASE.versionName || proof.versionCode !== CHAT_APP_RELEASE.versionCode ||
      proof.signatureVerified !== true || certificate !== CHAT_APP_RELEASE.signerCertificateSha256 || !/^[a-f0-9]{64}$/.test(proof.sha256)) throw unavailable();
    const bytes = await readRegularFile(filename, 64 * 1024 * 1024);
    if (createHash('sha256').update(bytes).digest('hex') !== proof.sha256 || !apkPayload(bytes)) throw unavailable();
    return { bytes, metadata: {
      ...CHAT_APP_RELEASE, sha256: proof.sha256, sizeBytes: bytes.length, signatureVerified: true,
      platform: 'android', minimumAndroidVersion: '8.0', downloadUrl: CHAT_APP_DOWNLOAD_ROUTE
    } };
  } catch { throw unavailable(); }
}

export async function serveChatAppRelease(request, response, config, pathname) {
  if (!routes.has(pathname)) return false;
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    throw new AppError('validation', 'Diese Datei unterstützt nur das Öffnen.', 405);
  }
  const release = await readChatAppRelease(config);
  let bytes;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (pathname === CHAT_APP_DOWNLOAD_ROUTE) {
    bytes = release.bytes;
    response.setHeader('Content-Type', 'application/vnd.android.package-archive');
    response.setHeader('Content-Disposition', 'attachment; filename="' + CHAT_APP_RELEASE.filename + '"');
    response.setHeader('X-Content-SHA256', release.metadata.sha256);
  } else {
    const content = pathname === CHAT_APP_METADATA_ROUTE ? release.metadata : [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app', package_name: CHAT_APP_RELEASE.packageName,
        sha256_cert_fingerprints: [CHAT_APP_RELEASE.signerCertificateSha256.toUpperCase().match(/.{2}/g).join(':')]
      }
    }, {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app', package_name: 'de.crazybatto.controlcenter',
        sha256_cert_fingerprints: [String(process.env.CONTROL_APP_SIGNER_SHA256 || '0'.repeat(64)).replaceAll(':', '').toUpperCase().match(/.{2}/g).join(':')]
      }
    }];
    bytes = Buffer.from(JSON.stringify(content));
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
  response.setHeader('Content-Length', bytes.length);
  response.writeHead(200);
  response.end(request.method === 'HEAD' ? undefined : bytes);
  return true;
}
