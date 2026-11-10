import { spawn } from 'node:child_process';
import { AppError, assert } from './errors.mjs';

export const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
export const AUDIO_MAX_SECONDS = 300;
const invalid = () => new AppError('validation', 'Die Audiodatei konnte nicht gelesen werden. Bitte eine gültige MP3-, WAV-, Ogg- oder WebM-Datei auswählen.');

export function decodeAudio(input) {
  assert(typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 180 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(input.name), 'Bitte einen gültigen Audiodateinamen verwenden.');
  assert(typeof input.mime === 'string' && /^(audio\/(?:ogg|webm|mpeg|wav|x-wav))(?:;\s*codecs=opus)?$/i.test(input.mime), 'Unterstützt werden MP3, WAV, Ogg und WebM.');
  const value = input.dataBase64;
  assert(typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(AUDIO_MAX_BYTES / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Die Audiodatei ist ungültig oder größer als 8 MB.');
  const bytes = Buffer.from(value, 'base64');
  assert(bytes.length >= 16 && bytes.length <= AUDIO_MAX_BYTES && bytes.toString('base64') === value, 'Die Audiodatei ist ungültig oder größer als 8 MB.');
  let format;
  if (bytes.subarray(0, 4).equals(Buffer.from('OggS'))) format = 'ogg';
  else if (bytes.readUInt32BE(0) === 0x1a45dfa3) format = 'matroska';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') format = 'wav';
  else if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 6) !== 0)) format = 'mp3';
  else throw invalid();
  const type = input.mime.toLowerCase().split(';')[0];
  assert(({ ogg: ['audio/ogg'], matroska: ['audio/webm'], wav: ['audio/wav', 'audio/x-wav'], mp3: ['audio/mpeg'] })[format].includes(type), 'Dateiformat und Audiotyp passen nicht zusammen.');
  return { bytes, format };
}

function runFfmpeg(bytes, args, maxBytes, { spawnImpl = spawn, timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, settled = false, count = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child?.kill('SIGKILL'); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(new AppError('timeout', 'Die Audioverarbeitung hat zu lange gedauert. Bitte eine kürzere Datei auswählen.', 408)), timeoutMs);
    timer.unref?.();
    try {
      child = spawnImpl('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
      child.once('error', error => finish(error.code === 'ENOENT' ? new AppError('unconfigured', 'Die Audioverarbeitung ist auf dem Server noch nicht verfügbar.', 503) : invalid()));
      child.stdout.on('data', chunk => {
        count += chunk.length;
        if (count > maxBytes) return finish(new AppError('too_large', 'Die Audiodatei überschreitet die Verarbeitungsgrenze.', 413));
        chunks.push(chunk);
      });
      child.stderr.on('data', () => {}); // Never expose decoder diagnostics or paths.
      child.stdin.on('error', () => {}); // A rejected/finished stream can close stdin early.
      child.once('close', code => finish(code === 0 && count > 0 ? null : invalid(), Buffer.concat(chunks)));
      child.stdin.end(bytes);
    } catch { finish(invalid()); }
  });
}

export function oggDuration(bytes) {
  let offset = 0, granule = null, preSkip = null, serial = null, ended = false;
  while (offset < bytes.length) {
    assert(offset + 27 <= bytes.length && bytes.toString('ascii', offset, offset + 4) === 'OggS' && bytes[offset + 4] === 0, 'Die verarbeitete Audiodatei ist ungültig.');
    const segments = bytes[offset + 26], head = offset + 27 + segments;
    assert(head <= bytes.length, 'Die verarbeitete Audiodatei ist ungültig.');
    let size = 0; for (let i = offset + 27; i < head; i++) size += bytes[i];
    assert(head + size <= bytes.length, 'Die verarbeitete Audiodatei ist ungültig.');
    const stream = bytes.readUInt32LE(offset + 14);
    if (serial === null) serial = stream;
    assert(stream === serial, 'Mehrere Audiostreams werden nicht unterstützt.');
    if (preSkip === null) {
      assert(size >= 19 && bytes.toString('ascii', head, head + 8) === 'OpusHead', 'Die verarbeitete Audiodatei ist kein Opus-Audio.');
      preSkip = bytes.readUInt16LE(head + 10);
    }
    const value = bytes.readBigUInt64LE(offset + 6);
    if (value !== 0xffffffffffffffffn) granule = value;
    ended = (bytes[offset + 5] & 4) !== 0;
    offset = head + size;
  }
  assert(ended && granule !== null && granule >= BigInt(preSkip), 'Die Audiodatei ist nicht vollständig.');
  const seconds = Number(granule - BigInt(preSkip)) / 48000;
  assert(Number.isFinite(seconds) && seconds > 0, 'Die Audiodatei enthält keinen Ton.');
  return seconds;
}

export function pcmWaveform(pcm) {
  assert(pcm.length >= 2 && pcm.length % 2 === 0, 'Die Audiovorschau konnte nicht erstellt werden.');
  const samples = pcm.length / 2, bins = Math.min(256, Math.max(1, Math.ceil(samples / 800))), peaks = Buffer.alloc(bins);
  for (let i = 0; i < bins; i++) {
    const begin = Math.floor(i * samples / bins), end = Math.floor((i + 1) * samples / bins);
    let energy = 0; for (let j = begin; j < end; j++) energy += (pcm.readInt16LE(j * 2) / 32768) ** 2;
    peaks[i] = Math.min(255, Math.round(Math.sqrt(energy / (end - begin)) * 255));
  }
  return peaks.toString('base64');
}

// Fixed demuxers and pipe-only protocols prevent files, playlists and network inputs.
// Decode one second beyond the limit so long inputs are rejected, never truncated silently.
export async function prepareVoiceAudio(input, options = {}) {
  const { bytes, format } = decodeAudio(input);
  const voice = await runFfmpeg(bytes, ['-protocol_whitelist', 'pipe', '-f', format, '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(AUDIO_MAX_SECONDS + 1), '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], AUDIO_MAX_BYTES, options);
  const durationSeconds = oggDuration(voice);
  assert(durationSeconds <= AUDIO_MAX_SECONDS, 'Sprachnachrichten dürfen höchstens 5 Minuten lang sein. Bitte die Aufnahme kürzen.', 'too_large', 413);
  const pcm = await runFfmpeg(voice, ['-protocol_whitelist', 'pipe', '-f', 'ogg', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], (AUDIO_MAX_SECONDS + 1) * 16000, options);
  return { bytes: voice, mime: 'audio/ogg', name: 'voice-message.ogg', durationSeconds, waveform: pcmWaveform(pcm) };
}
