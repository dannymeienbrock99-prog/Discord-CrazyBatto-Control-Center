import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const releaseDirectory = '/releases/batto-suite/1.20.0-0ebe07a253d5';
const manifestPath = fileURLToPath(new URL('./suite-release-manifest.json', import.meta.url));
export const releaseNames = Object.freeze([
  'Batto-3-in-1-Setup-1.20.0.exe',
  'Batto-3-in-1-Setup-1.20.0.zip',
  'Batto-3-in-1-1.20.0-Praesentation-und-Anleitung.pdf',
  'Batto-3-in-1-1.20.0-Praesentation-und-Anleitung.pptx',
]);
const routes = new Map(releaseNames.map(name => ['/downloads/' + name, name]));
export const isSuiteReleaseRoute = pathname => routes.has(pathname);

export function createSuiteReleaseHandler({ directory = releaseDirectory, manifest = null } = {}) {
  const verified = new Map();
  return async function serve(request, response, pathname) {
    const name = routes.get(pathname);
    if (!name) return false;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const failure = (status, text) => {
      for (const header of ['Content-Length', 'Content-Disposition', 'X-Checksum-SHA256']) response.removeHeader(header);
      response.setHeader('Cache-Control', 'no-store');
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      failure(405, 'Nur GET und HEAD sind erlaubt.');
      return true;
    }
    let fd;
    try {
      const entries = manifest ?? JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(entries) || entries.length !== releaseNames.length || new Set(entries.map(item => item.name)).size !== releaseNames.length || entries.some(item => !releaseNames.includes(item.name))) throw Error('Release manifest incomplete');
      const entry = entries.find(item => item.name === name);
      if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 2_000_000_000 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Release manifest invalid');
      const root = fs.lstatSync(directory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Release directory invalid');
      const filename = path.join(directory, name);
      if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw Error('Release file invalid');
      // The exact basename comes solely from the fixed map, never from a client path.
      fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== entry.size) throw Error('Release file incomplete');
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, entry.sha256].join(':');
      if (verified.get(filename) !== signature) {
        const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < stat.size) {
          const count = await new Promise((resolve, reject) => fs.read(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position, (error, bytesRead) => error ? reject(error) : resolve(bytesRead)));
          if (!count) throw Error('Release file truncated');
          hash.update(chunk.subarray(0, count)); position += count;
        }
        const after = fs.fstatSync(fd);
        if (hash.digest('hex') !== entry.sha256 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('Release checksum differs');
        verified.set(filename, signature);
      }
      if (response.destroyed) { fs.closeSync(fd); fd = undefined; return true; }
      const etag = '"sha256-' + entry.sha256 + '"';
      let start = 0, end = stat.size - 1, partial = false;
      const range = request.headers?.range;
      if (request.method === 'GET' && range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        let valid = Boolean(match && (match[1] || match[2]));
        if (valid) {
          if (!match[1]) {
            const length = Number(match[2]); valid = Number.isSafeInteger(length) && length > 0;
            if (valid) start = Math.max(0, stat.size - length);
          } else {
            start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
            valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < stat.size && end >= start;
            if (valid) end = Math.min(end, stat.size - 1);
          }
        }
        if (!valid) {
          fs.closeSync(fd); fd = undefined; response.setHeader('Content-Range', 'bytes */' + stat.size);
          failure(416, 'Dieser Dateibereich ist nicht verfügbar.'); return true;
        }
        partial = true;
      }
      response.setHeader('Accept-Ranges', 'bytes'); response.setHeader('ETag', etag);
      if (partial) response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
      const pdf = name.endsWith('.pdf');
      response.setHeader('Content-Type', pdf ? 'application/pdf' : name.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
      // Only this reviewed PDF may be embedded by this same-origin viewer.
      if (pdf) response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
      response.setHeader('Content-Disposition', (pdf ? 'inline' : 'attachment') + '; filename="' + name + '"');
      response.setHeader('Content-Length', end - start + 1);
      response.setHeader('X-Checksum-SHA256', entry.sha256);
      response.setHeader('Cache-Control', 'public, max-age=3600, immutable');
      if (request.method === 'HEAD') {
        fs.closeSync(fd); fd = undefined;
        response.writeHead(200); response.end();
        return true;
      }
      const stream = fs.createReadStream(filename, { fd, autoClose: true, start, end }); fd = undefined;
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      response.writeHead(partial ? 206 : 200); stream.pipe(response);
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      if (response.headersSent) response.destroy();
      else failure(503, 'Dieser Download ist momentan nicht verfügbar. Bitte später erneut versuchen.');
    }
    return true;
  };
}
export const serveSuiteRelease = createSuiteReleaseHandler();
