import { AppError, assert } from './errors.mjs';
import { MAX_IMAGE_BYTES } from './payloads.mjs';

export const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 128 * 1024;

export async function readBody(request, maximum = 64 * 1024) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maximum) throw new AppError('validation', 'Die Anfrage ist zu groß.', 413);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new AppError('validation', 'Die Anfrage ist zu groß.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJson(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Die JSON-Anfrage ist ungültig.');
    return value;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('validation', 'Die JSON-Anfrage konnte nicht gelesen werden.', 400);
  }
}

export function parseMultipart(bytes, contentType) {
  const boundary = /(?:^|;)\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))(?:\s*;|\s*$)/i.exec(contentType);
  assert(boundary, 'Die Upload-Begrenzung fehlt.');
  const marker = Buffer.from('--' + (boundary[1] || boundary[2]));
  const nextMarker = Buffer.concat([Buffer.from('\r\n'), marker]);
  assert(bytes.subarray(0, marker.length).equals(marker), 'Der Bild-Upload ist unvollständig.');
  const fields = {}; let cursor = marker.length, parts = 0, finished = false;
  while (cursor < bytes.length) {
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) {
      const trailing = bytes.subarray(cursor + 2);
      assert(trailing.length === 0 || trailing.equals(Buffer.from('\r\n')), 'Der Bild-Upload enthält unerwartete Daten.');
      finished = true;
      break;
    }
    assert(bytes.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n')), 'Der Bild-Upload ist ungültig.');
    cursor += 2;
    const headerEnd = bytes.indexOf('\r\n\r\n', cursor, 'utf8');
    assert(headerEnd >= cursor && headerEnd - cursor <= 8192, 'Die Upload-Kopfdaten sind ungültig.');
    const header = bytes.toString('latin1', cursor, headerEnd);
    const disposition = /^Content-Disposition:\s*form-data;\s*name="(operation|image)"(?:;\s*filename="[^"\r\n]{1,180}")?\s*$/im.exec(header);
    assert(disposition && !fields[disposition[1]], 'Der Upload enthält unbekannte oder doppelte Felder.');
    const name = disposition[1];
    const bodyStart = headerEnd + 4;
    const next = bytes.indexOf(nextMarker, bodyStart);
    assert(next >= bodyStart, 'Der Bild-Upload wurde nicht vollständig übertragen.');
    const data = bytes.subarray(bodyStart, next);
    assert(name !== 'operation' || data.length <= 64 * 1024, 'Die Auftragsdaten sind zu groß.');
    const type = /^Content-Type:\s*([^;\r\n]+).*$/im.exec(header)?.[1]?.trim().toLowerCase();
    fields[name] = { bytes: data, contentType: type };
    cursor = next + nextMarker.length;
    parts++;
    assert(parts <= 2, 'Der Upload enthält zu viele Felder.');
  }
  assert(finished && fields.operation, 'Der Upload ist unvollständig oder enthält keine Auftragsdaten.');
  return { operation: parseJson(fields.operation.bytes), image: fields.image || null };
}
