import { assert } from './errors.mjs';
import { sha256 } from './store.mjs';

export const CATEGORIES = Object.freeze(['modstempel', 'stream', 'big_match', 'general', 'poll']);
export const STREAM_ANSWERS = Object.freeze(['Bin dabei', 'Komme später', 'Kann heute nicht']);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const validId = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
export const validOperationId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const text = (value, min, max, name) => {
  assert(typeof value === 'string', name + ' fehlt.');
  const result = value.trim();
  assert(result.length >= min && result.length <= max, name + ' muss ' + min + '–' + max + ' Zeichen enthalten.');
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result), name + ' enthält ungültige Steuerzeichen.');
  return result;
};
const timestamp = (value, name) => {
  assert(Number.isSafeInteger(value) && value > 0 && value < 8_640_000_000_000_000, name + ' ist kein gültiger Zeitpunkt.');
  return value;
};
const duration = (value, name) => {
  assert(Number.isSafeInteger(value) && value >= 0 && value <= 10 * 366 * 24 * 60 * 60 * 1000, name + ' ist ungültig.');
  return value;
};

function normalizePoll(raw, defaults) {
  assert(isObject(raw), 'Die Umfrage fehlt.');
  const question = text(raw.question ?? defaults?.question, 1, 300, 'Umfragefrage');
  const answers = defaults?.answers || raw.answers;
  assert(Array.isArray(answers) && answers.length >= 2 && answers.length <= 10, 'Die Umfrage braucht 2–10 Antworten.');
  const cleanAnswers = answers.map(answer => text(answer, 1, 55, 'Antwort'));
  assert(new Set(cleanAnswers).size === cleanAnswers.length, 'Die Antworten müssen sich unterscheiden.');
  const durationHours = raw.durationHours ?? 24;
  assert(Number.isInteger(durationHours) && durationHours >= 1 && durationHours <= 168, 'Die Umfrage-Laufzeit muss 1–168 Stunden betragen.');
  return { question, answers: cleanAnswers, durationHours };
}

export function normalizeImage(raw) {
  assert(isObject(raw), 'Die Bildangaben fehlen.');
  const match = typeof raw.ref === 'string' && /^([a-f0-9]{64})\.(jpg|png|webp)$/.exec(raw.ref);
  assert(match, 'Der Bildverweis ist ungültig.');
  const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[match[2]];
  assert(raw.mime === mime && raw.name === 'Modstempel-Bild.' + match[2], 'Bildname oder Bildformat stimmen nicht überein.');
  assert(Number.isInteger(raw.size) && raw.size > 0 && raw.size <= MAX_IMAGE_BYTES, 'Das Bild darf höchstens 8 MiB groß sein.');
  assert(Number.isInteger(raw.width) && Number.isInteger(raw.height) && raw.width > 0 && raw.height > 0 && raw.width <= 8192 && raw.height <= 8192 && raw.width * raw.height <= 32_000_000, 'Das Bild überschreitet die erlaubten Abmessungen.');
  return { ref: raw.ref, name: raw.name, mime, size: raw.size, width: raw.width, height: raw.height };
}

export function normalizeOperation(raw) {
  assert(isObject(raw), 'Der Auftrag fehlt.');
  assert(validOperationId(raw.id), 'Die Auftrags-ID ist ungültig.');
  assert(['post', 'stamp', 'scheduled_event'].includes(raw.type), 'Der Auftragstyp ist unbekannt.');
  assert(validId(raw.actorId) && validId(raw.guildId), 'Konto oder Server sind ungültig.');
  const op = { id: raw.id, type: raw.type, actorId: raw.actorId, guildId: raw.guildId, createdAt: timestamp(raw.createdAt, 'Erstellzeitpunkt') };
  if (raw.deliveryRevision != null) {
    assert(Number.isSafeInteger(raw.deliveryRevision) && raw.deliveryRevision >= 0, 'Die Version der Server-Einrichtung ist ungültig.');
    op.deliveryRevision = raw.deliveryRevision;
  }
  if (raw.deliveryPolicy != null) {
    const policy = raw.deliveryPolicy;
    assert(op.type === 'stamp' && isObject(policy) && Object.keys(policy).length === 4 && ['channelId', 'mentionMode', 'roleId', 'moderatorRoleId'].every(key => Object.hasOwn(policy, key)), 'Die bestätigte Dienst-Zielregel ist ungültig.');
    assert((policy.channelId === null || validId(policy.channelId)) && ['none', 'role', 'everyone'].includes(policy.mentionMode)
      && (policy.mentionMode === 'role' ? validId(policy.roleId) && policy.roleId !== raw.guildId : policy.roleId === null)
      && validId(policy.moderatorRoleId) && policy.moderatorRoleId !== raw.guildId, 'Die bestätigte Dienst-Zielregel ist ungültig.');
    op.deliveryPolicy = { channelId: policy.channelId, mentionMode: policy.mentionMode, roleId: policy.roleId, moderatorRoleId: policy.moderatorRoleId };
  }
  if (raw.sendBefore != null) op.sendBefore = timestamp(raw.sendBefore, 'Versandfrist');
  assert(isObject(raw.data), 'Die Auftragsdaten fehlen.');
  const data = raw.data;
  if (op.type === 'scheduled_event') {
    assert(!raw.image && !raw.channelId && !raw.moderatorRoleId, 'Server-Events haben keinen Nachrichtenkanal und keinen Dateianhang.');
    op.data = {
      title: text(data.title, 1, 100, 'Event-Titel'), description: text(data.description ?? '', 0, 1000, 'Beschreibung'),
      startsAt: timestamp(data.startsAt, 'Event-Beginn'), endsAt: timestamp(data.endsAt, 'Event-Ende'),
      location: text(data.location, 1, 100, 'Event-Ort')
    };
    assert(op.data.endsAt > op.data.startsAt, 'Das Event-Ende muss nach dem Beginn liegen.');
    return op;
  }
  assert(validId(raw.channelId), 'Der Nachrichtenkanal fehlt.');
  assert(CATEGORIES.includes(raw.category), 'Die Kategorie ist unbekannt.');
  op.channelId = raw.channelId; op.category = raw.category;
  if (op.category === 'modstempel') {
    assert(validId(raw.moderatorRoleId) && raw.moderatorRoleId !== raw.guildId, 'Bitte eine Moderatorrolle auswählen.');
    op.moderatorRoleId = raw.moderatorRoleId;
  } else {
    assert(!raw.moderatorRoleId, 'Diese Kategorie verwendet keine Moderatorrolle.');
  }
  if (op.type === 'stamp') {
    assert(op.category === 'modstempel' && !raw.image && !data.poll, 'Stempelmeldungen erlauben weder Bild noch Umfrage.');
    assert(['start', 'pause', 'resume', 'finish'].includes(data.action), 'Der Stempelvorgang ist unbekannt.');
    assert(validOperationId(data.sessionId), 'Die Dienst-ID ist ungültig.');
    op.data = {
      action: data.action, at: timestamp(data.at, 'Stempelzeitpunkt'), sessionId: data.sessionId,
      name: text(data.name ?? '', 0, 80, 'Anzeigename'), team: text(data.team ?? '', 0, 200, 'Team'),
      note: text(data.note ?? '', 0, 800, 'Notiz'), activeMs: duration(data.activeMs, 'Dienstzeit'),
      pauseMs: duration(data.pauseMs, 'Pausenzeit'), totalMs: duration(data.totalMs, 'Gesamtdauer'),
      startedAt: timestamp(data.startedAt, 'Dienstbeginn')
    };
    assert(op.data.activeMs + op.data.pauseMs === op.data.totalMs, 'Dienstzeit und Pausenzeit passen nicht zur Gesamtdauer.');
    return op;
  }
  op.data = { title: text(data.title, 1, 120, 'Titel'), text: text(data.text ?? '', 0, 1800, 'Text') };
  if (data.startsAt != null) op.data.startsAt = timestamp(data.startsAt, 'Beginn');
  if (op.category === 'stream') {
    op.data.poll = normalizePoll(data.poll || {}, { question: 'Wer ist beim Stream dabei?', answers: STREAM_ANSWERS });
  } else if (op.category === 'poll') op.data.poll = normalizePoll(data.poll);
  else assert(!data.poll, 'Für diese Kategorie ist keine Umfrage vorgesehen.');
  if (raw.image) op.image = normalizeImage(raw.image);
  return op;
}

export function validateImageBytes(meta, bytes, contentType) {
  assert(Buffer.isBuffer(bytes) && bytes.length === meta.size && bytes.length <= MAX_IMAGE_BYTES, 'Die hochgeladene Bildgröße stimmt nicht mit den Angaben überein.');
  assert(!contentType || contentType === meta.mime || contentType === 'application/octet-stream', 'Der Dateityp stimmt nicht mit dem Bild überein.');
  assert(sha256(bytes) === meta.ref.slice(0, 64), 'Das Bild wurde bei der Übertragung verändert. Bitte erneut auswählen.');
  const { width, height } = inspectImageBytes(bytes, meta.mime);
  assert(width > 0 && height > 0 && width === meta.width && height === meta.height, 'Die Bildabmessungen stimmen nicht mit der Datei überein.');
  return true;
}

// Shared format/dimension parser. Callers apply their own byte/pixel limits.
export function inspectImageBytes(bytes, mime) {
  assert(Buffer.isBuffer(bytes) && ['image/png', 'image/jpeg', 'image/webp'].includes(mime), 'Das Bildformat ist ungültig.');
  let width = 0, height = 0;
  if (mime === 'image/png') {
    assert(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'Die PNG-Datei ist ungültig.');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    assert(bytes.subarray(-12, -8).readUInt32BE(0) === 0 && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND', 'Die PNG-Datei ist unvollständig.');
  } else if (mime === 'image/jpeg') {
    assert(bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9, 'Die JPEG-Datei ist ungültig oder unvollständig.');
    let offset = 2;
    while (offset + 4 < bytes.length) {
      assert(bytes[offset] === 0xff, 'Die JPEG-Dateistruktur ist ungültig.');
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      assert(offset + 2 <= bytes.length, 'Die JPEG-Datei ist unvollständig.');
      const length = bytes.readUInt16BE(offset);
      assert(length >= 2 && offset + length <= bytes.length, 'Die JPEG-Datei ist unvollständig.');
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        assert(length >= 8, 'Die JPEG-Abmessungen fehlen.');
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else {
    assert(bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length, 'Die WebP-Datei ist ungültig oder unvollständig.');
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') { assert(bytes.length >= 30, 'Die WebP-Datei ist unvollständig.'); width = bytes.readUIntLE(24, 3) + 1; height = bytes.readUIntLE(27, 3) + 1; }
    else if (type === 'VP8L') {
      assert(bytes[20] === 0x2f, 'Die WebP-Datei ist ungültig.');
      const bits = bytes.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === 'VP8 ') {
      assert(bytes.length >= 30, 'Die WebP-Datei ist unvollständig.');
      assert(bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a, 'Die WebP-Datei ist ungültig.');
      width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff;
    }
  }
  assert(width > 0 && height > 0, 'Die Bildabmessungen konnten nicht gelesen werden.');
  return { width, height };
}

export function operationPhases(op) {
  if (op.type === 'scheduled_event') return ['event'];
  if (op.image && op.data.poll) return ['image', 'poll'];
  return [op.data.poll ? 'poll' : 'message'];
}

export function mentions(op, enabled = true) {
  if (!enabled) return { content: '', allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
  // The server freezes this policy when accepting a new operation. A caller's
  // raw delivery object is never trusted or copied by normalizeOperation.
  if (op.delivery) {
    if (op.delivery.mentionMode === 'role') return { content: '<@&' + op.delivery.roleId + '>', allowed_mentions: { parse: [], roles: [op.delivery.roleId], users: [], replied_user: false } };
    if (op.delivery.mentionMode === 'everyone') return { content: '@everyone', allowed_mentions: { parse: ['everyone'], roles: [], users: [], replied_user: false } };
    return { content: '', allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
  }
  return op.category === 'modstempel'
    ? { content: '<@&' + op.moderatorRoleId + '>', allowed_mentions: { parse: [], roles: [op.moderatorRoleId], users: [], replied_user: false } }
    : { content: '@everyone', allowed_mentions: { parse: ['everyone'], roles: [], users: [], replied_user: false } };
}

export const messageUrl = (guildId, channelId, messageId) => 'https://discord.com/channels/' + guildId + '/' + channelId + '/' + messageId;
export const eventUrl = (guildId, eventId) => 'https://discord.com/events/' + guildId + '/' + eventId;
const discordTime = value => '<t:' + Math.floor(value / 1000) + ':F>';
const displayDuration = value => { const seconds = Math.floor(value / 1000); return Math.floor(seconds / 3600) + ':' + String(Math.floor(seconds / 60) % 60).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'); };
const COLORS = { modstempel: 0x65d6ae, stream: 0x8f83ff, big_match: 0xffb45c, general: 0x77b9ff, poll: 0xc18bff };
const LABELS = { modstempel: 'Modstempel', stream: 'Stream', big_match: 'BIG Match', general: 'Allgemein', poll: 'Umfrage' };
const STAMPS = { start: 'Dienst begonnen', pause: 'Pause begonnen', resume: 'Dienst fortgesetzt', finish: 'Dienst beendet' };

export function buildPayload(op, phase, actor, { imageMessageId } = {}) {
  if (phase === 'event') return {
    name: op.data.title, description: op.data.description || undefined,
    privacy_level: 2, entity_type: 3, channel_id: null,
    entity_metadata: { location: op.data.location },
    scheduled_start_time: new Date(op.data.startsAt).toISOString(),
    scheduled_end_time: new Date(op.data.endsAt).toISOString()
  };
  const secondPoll = phase === 'poll' && !!imageMessageId;
  const payload = {
    ...mentions(op, !secondPoll),
    nonce: sha256(op.actorId + ':' + op.id + ':' + phase).slice(0, 25), enforce_nonce: true
  };
  if (op.type === 'stamp') {
    const fields = [
      { name: 'Moderator', value: actor.displayName + ' · ' + actor.id, inline: false },
      { name: 'Zeitpunkt', value: discordTime(op.data.at), inline: false },
      { name: 'Dienstzeit', value: displayDuration(op.data.activeMs), inline: true },
      { name: 'Pause', value: displayDuration(op.data.pauseMs), inline: true }
    ];
    if (op.data.team) fields.push({ name: 'Team', value: op.data.team, inline: false });
    if (op.data.note) fields.push({ name: 'Notiz', value: op.data.note, inline: false });
    if (op.data.action === 'finish') fields.push({ name: 'Dienstbeginn', value: discordTime(op.data.startedAt), inline: false }, { name: 'Gesamtdauer', value: displayDuration(op.data.totalMs), inline: true });
    payload.embeds = [{ title: STAMPS[op.data.action], color: COLORS.modstempel, timestamp: new Date(op.data.at).toISOString(), fields, footer: { text: 'Crazy_Batto Discord App · Dienst ' + op.data.sessionId } }];
    return payload;
  }
  const fields = [{ name: 'Erstellt von', value: actor.displayName + ' · ' + actor.id, inline: false }];
  if (op.data.startsAt) fields.push({ name: 'Beginn', value: discordTime(op.data.startsAt), inline: false });
  const embed = {
    title: (secondPoll ? 'Abstimmung · ' : '') + op.data.title,
    description: secondPoll ? '[Bild und Details öffnen](' + messageUrl(op.guildId, op.channelId, imageMessageId) + ')' : op.data.text || undefined,
    color: COLORS[op.category], fields, footer: { text: 'Crazy_Batto Discord App · ' + LABELS[op.category] },
    timestamp: new Date(op.createdAt).toISOString()
  };
  if (op.image && !secondPoll) {
    embed.image = { url: 'attachment://' + op.image.name };
    payload.attachments = [{ id: 0, filename: op.image.name, description: 'Bild zum ' + LABELS[op.category] + '-Beitrag' }];
  }
  payload.embeds = [embed];
  if (op.data.poll && phase !== 'image') payload.poll = {
    question: { text: op.data.poll.question },
    answers: op.data.poll.answers.map(answer => ({ poll_media: { text: answer } })),
    duration: op.data.poll.durationHours, allow_multiselect: false, layout_type: 1
  };
  return payload;
}

export function summarizePoll(raw, now, previous = null) {
  const retain = () => previous ? { ...structuredClone(previous), stale: true } : null;
  if (!raw || !Array.isArray(raw.answers) || raw.answers.length < 2 || raw.answers.length > 10 || typeof raw.question?.text !== 'string' || raw.question.text.length > 300) return retain();
  const answers = raw.answers.map(answer => ({ answer_id: answer?.answer_id, poll_media: { text: answer?.poll_media?.text } }));
  if (answers.some(answer => !Number.isInteger(answer.answer_id) || answer.answer_id < 1 || typeof answer.poll_media.text !== 'string' || answer.poll_media.text.length > 55) || new Set(answers.map(answer => answer.answer_id)).size !== answers.length) return retain();
  const counts = raw.results?.answer_counts;
  const known = Array.isArray(counts) && counts.every(entry => answers.some(answer => answer.answer_id === entry?.id) && Number.isSafeInteger(entry.count) && entry.count >= 0) && new Set(counts.map(entry => entry.id)).size === counts.length;
  const expiry = Date.parse(raw.expiry || '');
  const result = { question: { text: raw.question.text }, answers, expiry: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null, allow_multiselect: raw.allow_multiselect === true, layout_type: 1, stale: !known, updatedAt: known ? now : null };
  if (known) result.results = { answer_counts: counts.map(entry => ({ id: entry.id, count: entry.count })), is_finalized: raw.results.is_finalized === true };
  else if (previous?.results && Array.isArray(previous.answers) && previous.answers.length === answers.length && answers.every(answer => previous.answers.some(old => old.answer_id === answer.answer_id && old.poll_media?.text === answer.poll_media.text))) {
    result.results = structuredClone(previous.results); result.updatedAt = previous.updatedAt ?? null;
  }
  return result;
}
