import { AppError, assert } from './errors.mjs';

export const COMMUNITY_BOT_ID = process.env.DISCORD_CLIENT_ID || '900000000000000002';
export const COMMUNITY_ACTIONS = Object.freeze(['community.state', 'community.save', 'community.publish', 'community.register',
  'community.report.list', 'community.report.moderate', 'community.voice.list', 'community.voice.control', 'community.ticket.list', 'community.ticket.close']);
export const CID = /^\d{17,20}$/;
export const REPORT_CATEGORIES = Object.freeze({ beleidigung: 'Beleidigung', belaestigung: 'Belästigung', spam: 'Spam', betrug: 'Betrug', regelverstoss: 'Regelverstoß', sonstiges: 'Sonstiges' });
const embed = (title, description) => ({ title, description, color: '#D4AF37', imageUrl: '', footer: 'Crazy_Batto Community' });
export function communityDefaults() {
  return {
    welcome: { enabled: false, channelId: '', message: 'Willkommen {mention}!', ...embed('Willkommen bei {server}', 'Schön, dass du da bist, {username}! Lies bitte unsere Regeln.'), imageUrl: 'https://crazybatto.de/assets/control/dragon-gold-welcome.png' },
    rules: { enabled: false, channelId: '', roleId: '', yesLabel: 'Ja, akzeptieren', noLabel: 'Nein', ...embed('Unsere Serverregeln', '1. Begegne anderen respektvoll. Hass, Diskriminierung, Beleidigungen und Belästigung sind nicht erlaubt.\n2. Kein Spam, Betrug, Phishing oder absichtliches Täuschen anderer Mitglieder.\n3. Veröffentliche persönliche Daten, Fotos oder private Gespräche nur mit Zustimmung der betroffenen Personen.\n4. Nutze die passenden Kanäle. Illegale und sexuell explizite Inhalte sind nicht erlaubt.\n5. Werbung und Einladungslinks nur mit vorheriger Erlaubnis des Teams.\n6. Störe Sprachkanäle nicht. Aufnahmen und Weitergabe von Gesprächen benötigen die Zustimmung aller Beteiligten.\n7. Nutze bei Konflikten ein Ticket oder die Meldefunktion mit nachvollziehbarer Begründung. Keine falschen Anschuldigungen.\n8. Respektiere Teamentscheidungen. Rückfragen und Beschwerden klären wir privat und sachlich.\n\nMit „Ja“ akzeptierst du diese Regeln und erhältst die eingestellte Mitgliedsrolle. „Nein“ vergibt keine Rolle und entfernt dich nicht vom Server.') },
    reports: { enabled: false, channelId: '', staffRoleIds: [], buttonLabel: 'Mitglied melden', ...embed('Mitglied melden', 'Wähle das betroffene Mitglied und anschließend die Art des Vorfalls. Beschreibe danach den Grund. Deine Meldung wird vertraulich an das Team übermittelt.') },
    tickets: { enabled: false, channelId: '', categoryId: '', staffRoleIds: [], buttonLabel: 'Ticket öffnen', ...embed('Privater Support', 'Öffne ein privates Ticket für dich und das Team.') },
    counter: { enabled: false, channelId: '', nameTemplate: '👥 Mitglieder: {count}' },
    birthday: { channelId: '', limit: 10, ...embed('Nächste Geburtstage', 'Trage deinen Geburtstag auf der Webseite ein und gib ihn für den Kalender frei.') },
    event: { channelId: '', startAt: '', endAt: '', location: '', ...embed('Community-Event', 'Alle Informationen zu unserem nächsten Event.') },
  };
}
export function text(value, max, label, minimum = 0) {
  assert(typeof value === 'string' && value.length <= max && value.trim().length >= minimum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), label + ' ist ungültig.');
  return value.trim();
}
export function discordId(value, optional = false) {
  assert(typeof value === 'string' && ((optional && value === '') || CID.test(value)), 'Bitte eine gültige Discord-ID wählen.'); return value;
}
export const safeName = value => String(value || 'Mitglied').replace(/[\u0000-\u001f\u007f@<>]/g, '').slice(0, 80);
export function validateSection(section, raw) {
  const defaults = communityDefaults();
  assert(Object.hasOwn(defaults, section), 'Dieser Community-Bereich ist ungültig.');
  const base = defaults[section];
  assert(base && raw && typeof raw === 'object' && !Array.isArray(raw), 'Dieser Community-Bereich ist ungültig.');
  assert(Object.keys(raw).every(key => Object.hasOwn(base, key)), 'Die Einstellungen enthalten unbekannte Felder.');
  const result = { ...base, ...raw };
  for (const [key, value] of Object.entries(result)) {
    if (key === 'enabled') assert(typeof value === 'boolean', 'Bitte aktiv oder deaktiviert auswählen.');
    else if (['channelId', 'roleId', 'categoryId'].includes(key)) discordId(value, true);
    else if (key === 'staffRoleIds') {
      assert(Array.isArray(value) && value.length <= 20, 'Höchstens 20 Teamrollen sind erlaubt.');
      result[key] = [...new Set(value.map(v => discordId(v)))];
    } else if (key === 'color') assert(/^#[a-f\d]{6}$/i.test(value), 'Bitte eine Hex-Farbe wählen.');
    else if (key === 'imageUrl') {
      text(value, 2048, 'Bildadresse');
      if (value) { let url; try { url = new URL(value); } catch { throw new AppError('validation', 'Ungültige Bildadresse.', 400); }
        assert(url.protocol === 'https:' && !url.username && !url.password && !url.port, 'Bilder benötigen eine HTTPS-Adresse ohne Zugangsdaten.'); }
    } else if (key === 'limit') assert(Number.isInteger(value) && value >= 1 && value <= 20, '1 bis 20 Geburtstage sind erlaubt.');
    else if (['startAt', 'endAt'].includes(key)) assert(value === '' || (typeof value === 'string' && Number.isFinite(Date.parse(value))), 'Ungültiger Event-Zeitpunkt.');
    else result[key] = text(value, ({ title: 256, description: 4000, message: 1800, footer: 2000, nameTemplate: 100, location: 200, yesLabel: 80, noLabel: 80, buttonLabel: 80 })[key], key);
  }
  if (result.enabled) {
    assert(!!result.channelId, 'Bitte zuerst einen Kanal auswählen.');
    if (section === 'rules') assert(!!result.roleId, 'Bitte eine Mitgliedsrolle auswählen.');
    if (['reports', 'tickets'].includes(section)) assert(result.staffRoleIds.length > 0, 'Bitte mindestens eine Teamrolle auswählen.');
  }
  if (section === 'counter') assert(result.nameTemplate.includes('{count}'), 'Der Kanalname benötigt {count}.');
  if ('title' in result) assert(result.title.length > 0, 'Bitte einen Titel eingeben.');
  return result;
}
export function renderTemplate(value, variables) {
  return String(value).replace(/\{(mention|username|server|memberCount)\}/g, (all, key) => String(variables[key] ?? all));
}
export function embedMessage(settings, variables = {}) {
  const value = key => renderTemplate(settings[key] || '', variables);
  const block = { title: value('title').slice(0, 256), description: value('description').slice(0, 4000), color: parseInt(settings.color.slice(1), 16) };
  if (settings.footer) block.footer = { text: value('footer').slice(0, 2000) };
  if (settings.imageUrl) block.image = { url: settings.imageUrl };
  assert(block.title.length + block.description.length + (block.footer?.text.length || 0) <= 6000, 'Die Einbettung ist zu lang.');
  return { embeds: [block], allowed_mentions: { parse: [], users: [], roles: [], replied_user: false } };
}
export function avatarUrl(user) {
  discordId(user?.id);
  if (typeof user.avatar === 'string' && /^(?:a_)?[a-f\d]{32}$/i.test(user.avatar)) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256`;
  const index = user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
export const ephemeral = content => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
