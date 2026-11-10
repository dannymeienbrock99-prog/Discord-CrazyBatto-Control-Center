import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { AppError, assert, safeMessage } from './errors.mjs';
import { COMMUNITY_BOT_ID, CID, discordId, embedMessage, text } from './community-schema.mjs';
import { P, has, channelPermissions } from './permissions.mjs';

const KEY = 'setup_panel_v1';
const LINK = 'https://crazybatto.de/eure-gaming-setups.html#mein-setup';
const FIELDS = ['channelId', 'title', 'description', 'imageUrl', 'buttonLabel'];
export const SETUP_PANEL_ACTIONS = Object.freeze(['setup.panel.state', 'setup.panel.save', 'setup.panel.publish']);
const defaults = () => ({
  channelId: '', title: 'Eure Gaming Setups',
  description: 'Zeig uns deinen Gaming-PC und dein Setup! Registriere dich auf crazybatto.de oder melde dich mit deinem Website-Konto an. Lade eigene Bilder hoch und ergänze deine Hardware. Reiche dein Setup anschließend zur Prüfung ein. Nach der Admin-Freigabe erscheint es auf der Website und im Discord-Forum unter deinem Namen.',
  imageUrl: '', buttonLabel: 'Mein Setup einreichen'
});
const cleanText = (value, max, label, min = 0) => {
  const result = text(value, max, label, min);
  assert(!/[\u202a-\u202e\u2066-\u2069]/u.test(result), `${label} enthält ungültige Steuerzeichen.`);
  return result;
};
function publicImage(value) {
  assert(typeof value === 'string' && value.length <= 2048, 'Der Bildlink darf höchstens 2048 Zeichen enthalten.');
  if (value === '') return '';
  let url; try { url = new URL(value); } catch { throw new AppError('validation', 'Bitte einen öffentlichen HTTPS-Bildlink verwenden.'); }
  const host = url.hostname.toLowerCase();
  assert(!/[\s\\\u0000-\u001f\u007f]/u.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    !isIP(host) && !host.includes(':') && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) &&
    !/(?:^|\.)(?:localhost|localdomain|local|internal|lan|home|test|invalid|example|onion)$/.test(host) && !/(?:^|\.)home\.arpa$/.test(host),
  'Bitte einen öffentlichen HTTPS-Bildlink ohne Zugangsdaten, Sonderport oder Fragment verwenden.');
  let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw new AppError('validation', 'Der Bildlink ist ungültig.'); }
  assert(!/\.(?:m3u8|mp4|flv|mpd|ts|webm|mov|m4v)$/i.test(pathname), 'Bitte ein Bild statt eines Video- oder Streamlinks verwenden.');
  return url.href;
}
function settings(raw) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(raw, key)), 'Die Setup-Karte benötigt alle vorgesehenen Felder.');
  return { channelId: discordId(raw.channelId, true), title: cleanText(raw.title, 256, 'Titel', 1),
    description: cleanText(raw.description, 4000, 'Beschreibung', 1), imageUrl: publicImage(raw.imageUrl), buttonLabel: cleanText(raw.buttonLabel, 80, 'Schaltflächentext', 1) };
}
const failure = error => error instanceof AppError ? safeMessage(error.message) : 'Discord hat die Veröffentlichung nicht eindeutig bestätigt. Bitte den Kanal prüfen.';

export class SetupPanel {
  constructor(service, { now = Date.now } = {}) {
    this.service = service; this.community = service.communityControl; this.store = service.accounts.store; this.now = now;
    this.queue = Promise.resolve();
    if (this.data().publishAttempt?.status === 'sending') this.mutate(data => {
      data.publishAttempt.status = 'uncertain';
      data.publishAttempt.error = 'Der Versand wurde unterbrochen. Bitte den Discord-Kanal prüfen.';
    });
  }
  data() {
    const raw = this.store.setting(KEY);
    if (!raw) return { revision: 0, settings: defaults(), publication: null, publishAttempt: null };
    let data; try {
      data = JSON.parse(raw);
      assert(data && Number.isSafeInteger(data.revision) && data.revision >= 0, 'Ungültige Version.');
      data.settings = settings(data.settings);
      if (data.publication) assert(CID.test(data.publication.channelId) && CID.test(data.publication.messageId) && Number.isSafeInteger(data.publication.revision), 'Ungültige Veröffentlichung.');
      if (data.publishAttempt) assert(['sending', 'published', 'failed', 'uncertain'].includes(data.publishAttempt.status) && ['create', 'edit'].includes(data.publishAttempt.operation) && CID.test(data.publishAttempt.channelId) && Number.isSafeInteger(data.publishAttempt.revision), 'Ungültiger Versandstatus.');
    } catch { throw new AppError('storage', 'Die gespeicherte Setup-Karte ist ungültig und wurde nicht verändert.', 503); }
    return { publication: null, publishAttempt: null, ...data };
  }
  mutate(fn) { return this.store.transaction(() => { const data = this.data(); const result = fn(data); this.store.setSetting(KEY, JSON.stringify(data)); return result; }); }
  current(context) { assert(context, 'Eine Administrator-Anmeldung ist erforderlich.', 'auth', 401); this.community.current(context); this.community.identity(); }
  state(context) {
    this.current(context); const data = this.data(), p = data.publication, a = data.publishAttempt;
    return { revision: data.revision, settings: data.settings,
      publication: p ? { channelId: p.channelId, messageId: p.messageId, revision: p.revision, publishedAt: p.publishedAt, updatedAt: p.updatedAt, url: `https://discord.com/channels/${this.service.config.discordGuildId}/${p.channelId}/${p.messageId}` } : null,
      publishAttempt: a ? { status: a.status, channelId: a.channelId, revision: a.revision, operation: a.operation, messageId: a.messageId || null, at: a.at, error: a.error || '' } : null };
  }
  revision(expected) { const data = this.data(); assert(Number.isSafeInteger(expected) && expected === data.revision, 'Die Setup-Karte wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409); return data; }
  assertRetry(data) {
    const attempt = data.publishAttempt;
    assert(attempt?.status !== 'sending', 'Die Setup-Karte wird gerade veröffentlicht. Bitte kurz warten.', 'conflict', 409);
    const knownEdit = attempt?.operation === 'edit' && data.publication?.channelId === attempt.channelId && data.publication?.messageId === attempt.messageId && data.settings.channelId === attempt.channelId;
    assert(attempt?.status !== 'uncertain' || knownEdit, 'Die letzte Veröffentlichung ist unklar. Bitte den bisherigen Kanal prüfen; es wird keine zweite Karte erstellt.', 'uncertain', 409);
  }
  canSend(auth) {
    this.community.sendable(auth);
    assert(has(channelPermissions(auth.guild, auth.member, auth.channel, this.now()), P.READ_MESSAGE_HISTORY), 'Der Bot braucht im Zielkanal auch Zugriff auf den Nachrichtenverlauf.', 'forbidden', 403);
  }
  async run(context, action, payload = {}) {
    this.current(context);
    assert(SETUP_PANEL_ACTIONS.includes(action), 'Unbekannte Setup-Karten-Aktion.');
    assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'Bitte gültige Karten-Einstellungen senden.');
    assert(!payload.guildId || payload.guildId === this.service.config.discordGuildId, 'Falscher Discord-Server.', 'forbidden', 403);
    if (action === 'setup.panel.state') return this.state(context);
    assert(payload.confirm === true, 'Bitte die Aktion für die Setup-Karte bestätigen.');
    const allowed = action === 'setup.panel.save' ? ['guildId', 'expectedRevision', 'settings', 'confirm'] : ['guildId', 'expectedRevision', 'confirm'];
    assert(Object.keys(payload).every(key => allowed.includes(key)), 'Diese Aktion enthält unbekannte Felder.');
    // Copy input before joining the queue so a later caller cannot mutate it.
    const input = structuredClone(payload);
    const operation = this.queue.then(() => { this.current(context); return action === 'setup.panel.save' ? this.save(context, input) : this.publish(context, input); });
    this.queue = operation.catch(() => {}); return operation;
  }
  async save(context, payload) {
    const value = settings(payload.settings); this.revision(payload.expectedRevision);
    if (value.channelId) { const auth = await this.community.authority(context, 0n, value.channelId); this.canSend(auth); }
    this.current(context);
    this.mutate(data => {
      assert(data.revision === payload.expectedRevision, 'Die Setup-Karte wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      assert(data.publishAttempt?.status !== 'sending', 'Die Setup-Karte wird gerade veröffentlicht. Bitte kurz warten.', 'conflict', 409);
      data.settings = value; data.revision++;
    });
    return this.state(context);
  }
  message(value) {
    const message = embedMessage({ ...value, color: '#D4AF37', footer: 'Crazy_Batto · Eure Gaming Setups' });
    message.content = ''; message.attachments = [];
    message.components = [{ type: 1, components: [{ type: 2, style: 5, label: value.buttonLabel, url: LINK }] }];
    return this.community.validateMessage(message);
  }
  ownMessage(message, channelId, messageId = '') {
    assert(CID.test(message?.id || '') && (!messageId || message.id === messageId) && message.channel_id === channelId && message.author?.id === COMMUNITY_BOT_ID && message.author.bot === true && !message.webhook_id,
      'Discord hat keine eindeutig eigene Setup-Karte bestätigt. Bitte den vorhandenen Beitrag prüfen.', 'uncertain', 502);
  }
  async publish(context, payload) {
    const data = this.revision(payload.expectedRevision); this.assertRetry(data);
    const channelId = discordId(data.settings.channelId), publication = data.publication;
    const alreadyConfirmed = publication?.channelId === channelId && publication.revision === data.revision && data.publishAttempt?.status === 'published';
    const editing = publication?.channelId === channelId;
    let auth = await this.community.authority(context, 0n, channelId); this.canSend(auth);
    if (editing) {
      const before = await this.community.request(context, 'GET', `/channels/${channelId}/messages/${publication.messageId}`);
      this.current(context); this.ownMessage(before, channelId, publication.messageId);
      auth = await this.community.authority(context, 0n, channelId); this.canSend(auth);
    }
    this.current(context); this.assertRetry(this.revision(payload.expectedRevision));
    if (alreadyConfirmed) return this.state(context);
    const message = this.message(data.settings), attemptId = randomUUID(), nonce = randomBytes(12).toString('hex');
    this.mutate(latest => {
      assert(latest.revision === data.revision, 'Die Setup-Karte wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409); this.assertRetry(latest);
      latest.publishAttempt = { id: attemptId, status: 'sending', channelId, revision: data.revision, operation: editing ? 'edit' : 'create', messageId: editing ? publication.messageId : null, at: this.now(), error: '', nonce };
    });
    try {
      this.current(context);
      const fresh = this.revision(data.revision);
      assert(fresh.publishAttempt?.id === attemptId && fresh.publishAttempt.status === 'sending', 'Der Versandstand wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      const sent = await this.community.request(context, editing ? 'PATCH' : 'POST', editing ? `/channels/${channelId}/messages/${publication.messageId}` : `/channels/${channelId}/messages`, editing ? message : { ...message, nonce, enforce_nonce: true });
      this.ownMessage(sent, channelId, editing ? publication.messageId : '');
      // Save a confirmed delivery even if the session was revoked while awaiting
      // Discord. Never lose its ID and accidentally create the same card again.
      this.mutate(latest => {
        assert(latest.publishAttempt?.id === attemptId, 'Der Versandstand ist unklar. Bitte den Kanal prüfen.', 'uncertain', 409);
        latest.publication = { channelId, messageId: sent.id, revision: data.revision, publishedAt: editing ? publication.publishedAt : this.now(), updatedAt: this.now() };
        latest.publishAttempt.status = 'published'; latest.publishAttempt.messageId = sent.id; latest.publishAttempt.error = '';
      });
    } catch (error) {
      const rejected = error instanceof AppError && error.status >= 400 && error.status < 500 && error.kind !== 'uncertain';
      this.mutate(latest => { if (latest.publishAttempt?.id === attemptId) { latest.publishAttempt.status = rejected ? 'failed' : 'uncertain'; latest.publishAttempt.error = failure(error); } });
      throw error;
    }
    return this.state(context);
  }
}
