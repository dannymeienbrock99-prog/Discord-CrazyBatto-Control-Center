'use strict';

const IMAGE_LIMIT = 8 * 1024 * 1024;
const TEMPLATE_STORE_LIMIT = 64 * 1024 * 1024;
function object(value, label = 'Eingabe') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}
function text(value, max, label, { required = false, min = 0 } = {}) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw new Error(`${label} muss Text sein.`);
  if (value.length > max || (required && value.trim().length < Math.max(1, min))) throw new Error(`${label}: ${required ? `${Math.max(1, min)} bis ` : 'höchstens '}${max} Zeichen erlaubt.`);
  return value;
}
function id(value, label = 'Discord-ID') {
  if (typeof value !== 'string' || !/^[0-9]{17,20}$/.test(value)) throw new Error(`${label} ist ungültig.`);
  return value;
}
function color(value) {
  if (value === '' || value == null) return undefined;
  if (typeof value !== 'string' || !/^#?[a-f\d]{6}$/i.test(value)) throw new Error('Bitte eine gültige Farbe im Format #D9B770 wählen.');
  return parseInt(value.replace('#', ''), 16);
}
function url(value, label = 'URL') {
  if (!value) return undefined;
  text(value, 2048, label);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} ist ungültig.`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(`${label} muss eine HTTPS-Adresse ohne Zugangsdaten sein.`);
  return parsed.href;
}
function imageData(value, maxBytes = IMAGE_LIMIT) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 128) throw new Error('Das Bild ist zu groß. Höchstens 8 MB sind erlaubt.');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('Bitte ein PNG-, JPG-, WebP- oder GIF-Bild wählen.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error('Das Bild ist leer oder größer als 8 MB.');
  const type = match[1];
  const valid = type === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new Error('Die Datei enthält kein gültiges Bild des angegebenen Typs.');
  return { bytes, mime: `image/${type}`, extension: type === 'jpeg' ? 'jpg' : type };
}
function safeFilename(name, extension) {
  const stem = typeof name === 'string' ? name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70) : '';
  return `${stem || 'bild'}.${extension}`;
}
function buildMessage(input, { allowEmpty = false } = {}) {
  object(input);
  const draft = object(input.draft || {}, 'Einbettung');
  const roles = input.roleIds == null ? [] : input.roleIds;
  if (!Array.isArray(roles) || roles.length > 100) throw new Error('Höchstens 100 Rollen sind erlaubt.');
  const roleIds = [...new Set(roles.map(value => id(value, 'Rollen-ID')))];
  const userContent = text(draft.content, 2000, 'Nachricht');
  const content = [roleIds.map(value => `<@&${value}>`).join(' '), userContent].filter(Boolean).join('\n');
  text(content, 2000, 'Nachricht einschließlich Rollen-Erwähnungen');
  const embed = {};
  let count = 0;
  for (const [key, max, label] of [['title',256,'Titel'],['description',4096,'Beschreibung']]) {
    const value = text(draft[key], max, label);
    if (value) { embed[key] = value; count += value.length; }
  }
  const parsedColor = color(draft.color);
  if (parsedColor !== undefined) embed.color = parsedColor;
  const link = url(draft.url, 'Titel-Link');
  if (link) embed.url = link;
  const author = text(typeof draft.author === 'object' && draft.author ? draft.author.name : draft.author, 256, 'Autor');
  if (author) { embed.author = { name: author }; count += author.length; }
  const footer = text(typeof draft.footer === 'object' && draft.footer ? draft.footer.text : draft.footer, 2048, 'Fußzeile');
  if (footer) { embed.footer = { text: footer }; count += footer.length; }
  for (const [key, value] of [['image',draft.imageUrl],['thumbnail',draft.thumbnailUrl]]) {
    const link = url(value, key === 'image' ? 'Bild-URL' : 'Vorschaubild-URL');
    if (link) embed[key] = { url: link };
  }
  if (draft.fields != null) {
    if (!Array.isArray(draft.fields) || draft.fields.length > 25) throw new Error('Eine Einbettung darf höchstens 25 Felder enthalten.');
    if (draft.fields.length) embed.fields = draft.fields.map(field => {
      object(field, 'Feld');
      const name = text(field.name, 256, 'Feldname', { required: true });
      const value = text(field.value, 1024, 'Feldinhalt', { required: true });
      count += name.length + value.length;
      return { name, value, inline: Boolean(field.inline) };
    });
  }
  if (count > 6000) throw new Error('Die Einbettung darf insgesamt höchstens 6.000 Textzeichen enthalten.');
  if (draft.timestamp) {
    const time = draft.timestamp === true ? new Date() : new Date(draft.timestamp);
    if (!Number.isFinite(time.getTime())) throw new Error('Der Zeitstempel ist ungültig.');
    embed.timestamp = time.toISOString();
  }
  let image;
  if (input.image) {
    object(input.image, 'Bild');
    image = imageData(input.image.dataUrl);
    image.name = safeFilename(input.image.name, image.extension);
    embed.image = { url: `attachment://${image.name}` };
  }
  const hasEmbed = Boolean(embed.title || embed.description || embed.author || embed.footer || embed.fields || embed.image || embed.thumbnail);
  if (!allowEmpty && !content.trim() && !hasEmbed) throw new Error('Bitte zuerst einen Text oder ein Bild hinzufügen.');
  const payload = { content, allowed_mentions: { parse: [], users: [], roles: roleIds, replied_user: false } };
  if (hasEmbed) payload.embeds = [embed];
  if (image) payload.attachments = [{ id: 0, filename: image.name }];
  return { payload, image, characterCount: count };
}
function externalUrl(value) {
  const parsed = new URL(url(value));
  const ok = parsed.hostname === 'crazybatto.de'
    || parsed.hostname === 'docs.discord.com'
    || (parsed.hostname === 'discord.com' && (/^\/developers(?:\/|$)/.test(parsed.pathname) || /^\/channels\/[0-9]+\/[0-9]+(?:\/[0-9]+)?\/?$/.test(parsed.pathname) || parsed.pathname === '/oauth2/authorize'))
    || (parsed.hostname === 'discord.gg' && /^\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname));
  if (!ok || parsed.port) throw new Error('Dieser externe Link ist in der App nicht freigegeben.');
  return parsed.href;
}
function cleanDraft(draft) {
  object(draft, 'Vorlage');
  const result = {};
  for (const [key, max] of [['content',2000],['title',256],['description',4096],['color',7],['url',2048],['author',256],['footer',2048],['imageUrl',2048],['thumbnailUrl',2048]]) {
    result[key] = text(draft[key], max, key);
  }
  result.timestamp = Boolean(draft.timestamp);
  if (draft.fields != null && !Array.isArray(draft.fields)) throw new Error('Die Vorlagenfelder müssen eine Liste sein.');
  result.fields = (draft.fields || []).map(field => {
    object(field, 'Feld');
    return {name: field.name, value: field.value, inline: Boolean(field.inline)};
  });
  if (draft.attachment) {
    object(draft.attachment, 'Vorlagenbild');
    const image = imageData(draft.attachment.dataUrl);
    result.attachment = {name:safeFilename(draft.attachment.name,image.extension),dataUrl:draft.attachment.dataUrl};
  }
  buildMessage({ draft: result, image: result.attachment }, { allowEmpty: true });
  return result;
}
module.exports = { object, text, id, color, url, imageData, safeFilename, buildMessage, externalUrl, cleanDraft, IMAGE_LIMIT, TEMPLATE_STORE_LIMIT };
