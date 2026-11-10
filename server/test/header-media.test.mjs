import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createHttpServer } from '../src/http.mjs';

const videoPath = '/assets/control/gaming-setups-header.mp4';
const video = fs.readFileSync(new URL('../public/showcase/assets/control/gaming-setups-header.mp4', import.meta.url));
async function request(url, { method = 'GET', headers = {} } = {}) {
  const chunks = [], values = new Map();
  const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  response.setHeader = (name, value) => values.set(name.toLowerCase(), String(value));
  response.writeHead = (status, more = {}) => { response.status = status; response.headersSent = true; for (const [name, value] of Object.entries(more)) response.setHeader(name, value); };
  const done = once(response, 'finish');
  const server = createHttpServer({ config: {}, now: Date.now }, { rateLimits: false });
  server.emit('request', { url, method, headers, socket: { remoteAddress: '127.0.0.1' } }, response);
  await done;
  return { status: response.status, headers: values, body: Buffer.concat(chunks) };
}
test('public video streams the original bytes and declares its media type', async () => {
  const result = await request(videoPath);
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), 'video/mp4');
  assert.equal(result.headers.get('accept-ranges'), 'bytes'); assert.deepEqual(result.body, video);
});
test('video seeking returns exact bounded, open-ended and suffix ranges', async () => {
  for (const [range, start, end] of [['bytes=17-255', 17, 255], [`bytes=${video.length-20}-`, video.length-20, video.length-1], ['bytes=-12', video.length-12, video.length-1], [`bytes=0-${video.length+100}`, 0, video.length-1]]) {
    const result = await request(videoPath, { headers: { range } });
    assert.equal(result.status, 206); assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.equal(Number(result.headers.get('content-length')), end-start+1); assert.deepEqual(result.body, video.subarray(start, end+1));
  }
});
test('unsatisfiable ranges return 416 without a body', async () => {
  for (const range of [`bytes=${video.length}-`, 'bytes=-0']) {
    const result = await request(videoPath, { headers: { range } });
    assert.equal(result.status, 416); assert.equal(result.headers.get('content-range'), `bytes */${video.length}`); assert.equal(result.body.length, 0);
  }
});
test('HEAD ignores ranges; malformed, multiple and unvalidated If-Range requests get the full representation', async () => {
  const head = await request(videoPath, { method: 'HEAD', headers: { range: 'bytes=0-9' } });
  assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers.get('content-length')), video.length);
  for (const headers of [{ range:'bytes=0-1,4-5' }, { range:'bytes=10-2' }, { range:'bytes=9007199254740993-' }, { range:'bytes=0-9', 'if-range':'"unknown"' }]) {
    const result = await request(videoPath, { headers }); assert.equal(result.status, 200); assert.deepEqual(result.body, video);
  }
});
test('new Discord banners and video poster are public with the right content types', async () => {
  for (const [name, type] of [['dragon-gold-pc-help.png','image/png'],['dragon-gold-rules.png','image/png'],['dragon-gold-announcement.png','image/png'],['gaming-setups-header.jpg','image/jpeg']]) {
    const result = await request('/assets/control/'+name);
    assert.equal(result.status, 200); assert.equal(result.headers.get('content-type'), type); assert(result.body.length > 10000);
  }
});
test('unlisted files stay unavailable', async () => { assert.equal((await request('/assets/control/private.json')).status, 404); });
