import { randomUUID } from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { inspectImageBytes, MAX_IMAGE_BYTES } from './payloads.mjs';
import { imageStorageId } from './image-storage.mjs';
import { sha256 } from './store.mjs';
import { ChatAttachments, CHAT_ATTACHMENT_LIMITS } from './chat-attachments.mjs';
import { ChatPush } from './chat-push.mjs';

const PROFILES = [['sarah', 'Sarah / L4e ImLuNa'], ['michelle', 'Michelle'], ['faelan', 'Fáelán'], ['g-gaming', 'G___Gaming'], ['devilwolf666', 'Devilwolf666']];
const CHAT_ADMINISTRATION_NOTICE = 'Administratoren können Nachrichtenanfragen und Nachrichten dieses Profil-Chats einsehen, Anfragen bearbeiten sowie Chats sperren und entsperren. Andere Mitglieder haben keinen Zugriff.';
const DIRECT_CHAT_NOTICE = 'Dieser private Chat ist nur für die beiden Beteiligten zugänglich. Neue Nachrichten sind nach Annahme der Anfrage möglich.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const IMAGE = /^gallery_[a-f0-9]{64}$/;
const MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const COMMUNITY_LIMITS = Object.freeze({ bio: 2000, socialLinks: 8, post: 4000, comment: 1000,
  note: 1000, message: 4000, maxImageBytes: MAX_IMAGE_BYTES, maxImagesPerProfile: 100,
  maxProfileImageBytes: 100 * 1024 * 1024 });

function text(value, maximum, minimum = 0) {
  assert(typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Der Text ist ungültig oder zu lang.');
  const result = value.trim(); assert(result.length >= minimum, 'Bitte einen Text eintragen.'); return result;
}
function fields(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'Die Angaben sind unvollständig oder enthalten unbekannte Felder.');
}
async function body(req) {
  assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'], 'Bitte unkomprimierte JSON-Daten senden.', 'validation', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; assert(size <= 16 * 1024, 'Die Anfrage ist zu groß.', 'validation', 413); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); assert(value && typeof value === 'object' && !Array.isArray(value), 'Ungültige Angaben.'); return value; }
  catch { throw new AppError('validation', 'Die Anfrage enthält kein gültiges JSON.', 400); }
}
function links(value) {
  assert(Array.isArray(value) && value.length <= COMMUNITY_LIMITS.socialLinks, 'Höchstens acht Links sind erlaubt.');
  return value.map(row => {
    fields(row, ['label', 'url']); const label = text(row.label, 60, 1), raw = text(row.url, 1000, 1);
    assert(!/[\s\\]/.test(raw), 'Die Link-Adresse enthält ungültige Zeichen.');
    let url; try { url = new URL(raw); } catch { throw new AppError('validation', 'Bitte einen vollständigen HTTPS-Link eintragen.'); }
    assert(url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname && url.href.length <= 1000, 'Links müssen HTTPS ohne Zugangsdaten oder besondere Ports verwenden.');
    return { label, url: url.href };
  });
}
function cursor(value) {
  if (value === null) return null;
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value), 'Der Seitenverweis ist ungültig.');
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new AppError('validation', 'Der Seitenverweis ist ungültig.'); }
  assert(decoded && typeof decoded === 'object' && !Array.isArray(decoded) && Object.keys(decoded).length === 2 &&
    Number.isSafeInteger(decoded.at) && decoded.at >= 0 && typeof decoded.id === 'string' && UUID.test(decoded.id), 'Der Seitenverweis ist ungültig.');
  return decoded;
}
function page(rows, maximum, timestamp = 'created_at') {
  const selected = rows.slice(0, maximum), last = selected.at(-1);
  return { rows: selected, nextCursor: rows.length > maximum ? Buffer.from(JSON.stringify({ at: last[timestamp], id: last.id })).toString('base64url') : null };
}

// Community owns a separate additive schema. Neither email identities nor
// existing Discord/CMS records are inferred to be profile owners or team roles.
export class Community {
  constructor(accounts) {
    this.accounts = accounts; this.store = accounts.store; this.now = accounts.now;
    this.storage = accounts.imageStorage; this.uploads = 0;
    this.store.transaction(() => {
      this.store.db.exec(`
        CREATE TABLE IF NOT EXISTS community_schema (version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS community_team (
          user_id TEXT PRIMARY KEY REFERENCES accounts(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
          updated_by TEXT NOT NULL REFERENCES accounts(id), updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS community_profiles (
          slug TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT REFERENCES accounts(id), bio TEXT NOT NULL DEFAULT '',
          social_links TEXT NOT NULL DEFAULT '[]', portrait_id TEXT, revision INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS community_images (
          profile_slug TEXT NOT NULL REFERENCES community_profiles(slug), id TEXT NOT NULL,
          filename TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
          uploaded_by TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL, PRIMARY KEY(profile_slug,id));
        CREATE INDEX IF NOT EXISTS community_images_id ON community_images(id);
        CREATE TABLE IF NOT EXISTS community_posts (
          id TEXT PRIMARY KEY, profile_slug TEXT NOT NULL REFERENCES community_profiles(slug), author_id TEXT NOT NULL REFERENCES accounts(id),
          text TEXT NOT NULL, image_id TEXT, created_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES accounts(id),
          FOREIGN KEY(profile_slug,image_id) REFERENCES community_images(profile_slug,id));
        CREATE INDEX IF NOT EXISTS community_posts_profile ON community_posts(profile_slug,created_at,id);
        CREATE TABLE IF NOT EXISTS community_comments (
          id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES community_posts(id), author_id TEXT NOT NULL REFERENCES accounts(id),
          text TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER, deleted_by TEXT REFERENCES accounts(id));
        CREATE INDEX IF NOT EXISTS community_comments_post ON community_comments(post_id,created_at,id);
        CREATE TABLE IF NOT EXISTS community_likes (
          post_id TEXT NOT NULL REFERENCES community_posts(id), user_id TEXT NOT NULL REFERENCES accounts(id), created_at INTEGER NOT NULL,
          PRIMARY KEY(post_id,user_id));
        CREATE TABLE IF NOT EXISTS community_threads (
          id TEXT PRIMARY KEY, profile_slug TEXT NOT NULL REFERENCES community_profiles(slug),
          requester_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','blocked')), note TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK(requester_id<>recipient_id),
          UNIQUE(profile_slug,requester_id,recipient_id));
        CREATE INDEX IF NOT EXISTS community_threads_requester ON community_threads(requester_id,updated_at);
        CREATE INDEX IF NOT EXISTS community_threads_recipient ON community_threads(recipient_id,updated_at);
        CREATE TABLE IF NOT EXISTS community_thread_controls (
          thread_id TEXT PRIMARY KEY REFERENCES community_threads(id),
          administrator_blocked INTEGER NOT NULL DEFAULT 0 CHECK(administrator_blocked IN (0,1)),
          revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
          updated_by TEXT NOT NULL REFERENCES accounts(id), updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS community_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES community_threads(id),
          sender_id TEXT NOT NULL REFERENCES accounts(id), body TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS community_messages_thread ON community_messages(thread_id,seq);
        CREATE TABLE IF NOT EXISTS community_direct_threads (
          id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES accounts(id), recipient_id TEXT NOT NULL REFERENCES accounts(id),
          participant_low TEXT NOT NULL REFERENCES accounts(id), participant_high TEXT NOT NULL REFERENCES accounts(id),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','blocked')), note TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK(requester_id<>recipient_id),
          CHECK(participant_low<participant_high), UNIQUE(participant_low,participant_high));
        CREATE INDEX IF NOT EXISTS community_direct_threads_requester ON community_direct_threads(requester_id,updated_at);
        CREATE INDEX IF NOT EXISTS community_direct_threads_recipient ON community_direct_threads(recipient_id,updated_at);
        CREATE TABLE IF NOT EXISTS community_direct_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL REFERENCES community_direct_threads(id),
          sender_id TEXT NOT NULL REFERENCES accounts(id), body TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS community_direct_messages_thread ON community_direct_messages(thread_id,seq);
        CREATE TABLE IF NOT EXISTS community_message_receipts (
          thread_id TEXT NOT NULL, sender_id TEXT NOT NULL REFERENCES accounts(id), client_id TEXT NOT NULL,
          message_id TEXT NOT NULL UNIQUE, PRIMARY KEY(thread_id,sender_id,client_id));`);
      const versions = this.store.all('SELECT version FROM community_schema');
      assert(versions.length === 0 || versions.length === 1 && versions[0].version === 1, 'Die Community-Datenbankversion wird nicht unterstützt.', 'unconfigured', 503);
      if (!versions.length) this.store.run('INSERT INTO community_schema(version) VALUES (1)');
      for (const [slug, name] of PROFILES) this.store.run('INSERT OR IGNORE INTO community_profiles(slug,name,created_at,updated_at) VALUES (?,?,?,?)', slug, name, this.now(), this.now());
    });
    this.attachments = new ChatAttachments(this);
    this.push = new ChatPush(accounts);
  }
  exclusive(fn) { return this.accounts.gallery.exclusive(fn); }
  member(id) { return this.store.get('SELECT a.*,COALESCE(t.enabled,0) AS is_team FROM accounts a LEFT JOIN community_team t ON t.user_id=a.id WHERE a.id=?', id); }
  team(row) { return !!row?.confirmed && !row.suspended && (!!row.is_admin || !!row.is_team); }
  isTeamId(id) { return this.team(this.member(id)); }
  actor(context, { admin = false, team = false } = {}) {
    const current = this.accounts.assertCurrent(context, { admin }); const row = this.member(current.id);
    if (team) assert(this.team(row), 'Diese Aktion ist nur für das Team verfügbar.', 'forbidden', 403);
    return row;
  }
  profile(slug) { const row = this.store.get('SELECT * FROM community_profiles WHERE slug=?', slug); assert(row, 'Dieses Profil ist nicht vorhanden.', 'not_found', 404); return row; }
  canEdit(row, profile) { return this.team(row) && (!!row.is_admin || profile.owner_id === row.id); }
  editor(context, slug, admin = false) {
    const actor = this.actor(context, { admin, team: true }), profile = this.profile(slug);
    assert(admin ? !!actor.is_admin : this.canEdit(actor, profile), 'Du darfst dieses Profil nicht bearbeiten.', 'forbidden', 403);
    return { actor, profile };
  }
  viewer(context, profile = null) {
    const row = context ? this.member(context.user.id) : null;
    const active = !!row?.confirmed && !row.suspended;
    return { userId: active ? row.id : null, isAdmin: active && !!row.is_admin, isTeam: this.team(row),
      ...(profile ? { canEdit: this.canEdit(row, profile), canInteract: this.team(row),
        canRequestMessage: active && !!profile.owner_id && profile.owner_id !== row.id && this.team(this.member(profile.owner_id)) } : {}) };
  }
  image(slug, id) {
    const row = this.store.get('SELECT * FROM community_images WHERE profile_slug=? AND id=?', slug, id);
    assert(row, 'Dieses Bild ist nicht vorhanden.', 'not_found', 404); return row;
  }
  imageView(row) { return { id: row.id, url: '/api/community/profiles/' + row.profile_slug + '/images/' + row.id,
    name: row.filename, mimeType: row.mime_type, size: row.size, width: row.width, height: row.height }; }
  libraryImage(row) {
    const isPortrait = this.profile(row.profile_slug).portrait_id === row.id;
    const postCount = this.store.get('SELECT COUNT(*) AS n FROM community_posts WHERE profile_slug=? AND image_id=? AND deleted_at IS NULL', row.profile_slug, row.id).n;
    return { ...this.imageView(row), isPortrait, postCount, inUse: isPortrait || postCount > 0, canDelete: !isPortrait && postCount === 0 };
  }
  hasImage(id) { return !!this.store.get('SELECT 1 FROM community_images WHERE id=? LIMIT 1', id); }
  published(slug, id) { return this.profile(slug).portrait_id === id || !!this.store.get('SELECT 1 FROM community_posts WHERE profile_slug=? AND image_id=? AND deleted_at IS NULL LIMIT 1', slug, id); }
  profileView(row, { admin = false } = {}) {
    return { slug: row.slug, name: row.name, bio: row.bio, socialLinks: JSON.parse(row.social_links),
      portrait: row.portrait_id ? this.imageView(this.image(row.slug, row.portrait_id)) : null,
      revision: row.revision, assigned: !!row.owner_id, administrationNotice: CHAT_ADMINISTRATION_NOTICE,
      ...(admin ? { ownerId: row.owner_id } : {}) };
  }
  commentView(row, actor, profile) { return { id: row.id, text: row.text, authorName: this.member(row.author_id)?.name || 'Team',
    createdAt: row.created_at, canDelete: this.team(actor) && (actor.id === row.author_id || this.canEdit(actor, profile)) }; }
  post(id) { assert(UUID.test(id), 'Dieser Beitrag ist nicht vorhanden.', 'not_found', 404); const row = this.store.get('SELECT * FROM community_posts WHERE id=? AND deleted_at IS NULL', id); assert(row, 'Dieser Beitrag ist nicht vorhanden.', 'not_found', 404); return row; }
  likeView(id, actor) { return { likeCount: this.store.get('SELECT COUNT(*) AS n FROM community_likes WHERE post_id=?', id).n,
    isLiked: !!actor && !!this.store.get('SELECT 1 FROM community_likes WHERE post_id=? AND user_id=?', id, actor.id) }; }
  comments(post, actor, before = null) {
    const profile = this.profile(post.profile_slug), args = [post.id];
    if (before) args.push(before.at, before.at, before.id);
    const result = page(this.store.all('SELECT * FROM community_comments WHERE post_id=? AND deleted_at IS NULL' +
      (before ? ' AND (created_at<? OR (created_at=? AND id<?))' : '') + ' ORDER BY created_at DESC,id DESC LIMIT 51', ...args), 50);
    return { comments: result.rows.reverse().map(row => this.commentView(row, actor, profile)), nextCursor: result.nextCursor };
  }
  postView(row, actor) {
    const profile = this.profile(row.profile_slug), comments = this.comments(row, actor);
    return { id: row.id, profileSlug: row.profile_slug, text: row.text,
      image: row.image_id ? this.imageView(this.image(row.profile_slug, row.image_id)) : null,
      authorName: this.member(row.author_id)?.name || profile.name, createdAt: row.created_at,
      ...this.likeView(row.id, actor), canDelete: this.canEdit(actor, profile),
      comments: comments.comments, commentsNextCursor: comments.nextCursor,
      commentCount: this.store.get('SELECT COUNT(*) AS n FROM community_comments WHERE post_id=? AND deleted_at IS NULL', row.id).n };
  }
  accountView(row) { return { id: row.id, name: row.name, email: row.email, confirmed: !!row.confirmed,
    suspended: !!row.suspended, isAdmin: !!row.is_admin, isTeam: this.team(row) }; }
  seal(threadId, senderId, value) { return JSON.stringify(this.accounts.vault.seal({ threadId, senderId, text: value })); }
  open(threadId, senderId, value) {
    try { const plain = this.accounts.vault.open(JSON.parse(value)); if (plain.threadId !== threadId || plain.senderId !== senderId || typeof plain.text !== 'string') throw new Error(); return plain.text; }
    catch { throw new AppError('unconfigured', 'Diese Nachricht kann momentan nicht gelesen werden.', 503); }
  }
  thread(id, actorId) {
    assert(UUID.test(id), 'Diese Unterhaltung ist nicht vorhanden.', 'not_found', 404);
    const row = this.store.get('SELECT * FROM community_threads WHERE id=? AND (requester_id=? OR recipient_id=?)', id, actorId, actorId) ||
      this.store.get("SELECT *,NULL AS profile_slug,'direct' AS kind FROM community_direct_threads WHERE id=? AND (requester_id=? OR recipient_id=?)", id, actorId, actorId);
    assert(row, 'Diese Unterhaltung ist nicht vorhanden.', 'not_found', 404); return row;
  }
  chatTables(row) { return row.kind === 'direct' ? { threads: 'community_direct_threads', messages: 'community_direct_messages' } : { threads: 'community_threads', messages: 'community_messages' }; }
  threadControl(id) {
    return this.store.get('SELECT * FROM community_thread_controls WHERE thread_id=?', id) || { administrator_blocked: 0, revision: 0 };
  }
  updateThreadControl(id, actorId, blocked) {
    const current = this.threadControl(id);
    assert(Number.isSafeInteger(current.revision) && current.revision < Number.MAX_SAFE_INTEGER, 'Die Chatversion ist ungültig.', 'conflict', 409);
    this.store.run(`INSERT INTO community_thread_controls(thread_id,administrator_blocked,revision,updated_by,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET administrator_blocked=excluded.administrator_blocked,
      revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, id, Number(blocked), current.revision + 1, actorId, this.now());
  }
  chatParticipantsActive(row) {
    return [row.requester_id, row.recipient_id].every(id => { const user = this.member(id); return !!user?.confirmed && !user.suspended; });
  }
  threadView(row, actorId) {
    const direct = row.kind === 'direct', control = direct ? { administrator_blocked: 0, revision: 0 } : this.threadControl(row.id), adminBlocked = !!control.administrator_blocked;
    const participant = [row.requester_id, row.recipient_id].includes(actorId), active = this.chatParticipantsActive(row);
    const latest = this.store.get('SELECT id,sender_id,seq,created_at FROM ' + this.chatTables(row).messages + ' WHERE thread_id=? ORDER BY seq DESC LIMIT 1', row.id);
    return { id: row.id, kind: direct ? 'direct' : 'profile', profileSlug: row.profile_slug, profileName: direct ? 'Privater Chat' : this.profile(row.profile_slug).name,
      requesterId: row.requester_id, requesterName: this.member(row.requester_id)?.name || 'Mitglied',
      recipientId: row.recipient_id, recipientName: this.member(row.recipient_id)?.name || 'Mitglied',
      status: row.status, note: this.open(row.id, row.requester_id, row.note), createdAt: row.created_at, updatedAt: row.updated_at,
      adminBlocked, moderationRevision: control.revision, administrationNotice: direct ? DIRECT_CHAT_NOTICE : CHAT_ADMINISTRATION_NOTICE,
      canDecide: !adminBlocked && row.recipient_id === actorId && ['pending', 'approved'].includes(row.status),
      canBlock: !adminBlocked && participant && row.status === 'approved' && (direct || row.recipient_id === actorId),
      canSend: !adminBlocked && participant && row.status === 'approved' && active,
      isRequester: row.requester_id === actorId, isIncomingRequest: row.status === 'pending' && row.recipient_id === actorId,
      latestMessage: latest ? { id: latest.id, senderId: latest.sender_id, seq: latest.seq, createdAt: latest.created_at } : null };
  }
  messageView(row) { return { id: row.id, seq: row.seq, senderId: row.sender_id, text: this.open(row.thread_id, row.sender_id, row.body), createdAt: row.created_at, attachments: this.attachments.forMessage(row.id) }; }
  adminThread(slug, id) {
    this.profile(slug);
    assert(UUID.test(id), 'Diese Unterhaltung ist nicht vorhanden.', 'not_found', 404);
    const row = this.store.get('SELECT * FROM community_threads WHERE id=? AND profile_slug=?', id, slug);
    assert(row, 'Diese Unterhaltung ist nicht vorhanden.', 'not_found', 404); return row;
  }
  adminThreadView(row, adminId) {
    const view = this.threadView(row, adminId);
    return { ...view, canSend: false, canDecide: false,
      canApprove: !view.adminBlocked && row.status === 'pending' && this.chatParticipantsActive(row),
      canReject: !view.adminBlocked && row.status === 'pending', canBlock: !view.adminBlocked, canUnblock: view.adminBlocked };
  }
  async upload(req, context, slug, portrait = false) {
    this.editor(context, slug, portrait);
    assert(this.uploads < 4, 'Es werden bereits Bilder übertragen. Bitte kurz warten.', 'rate_limited', 429);
    this.uploads++;
    try {
      const length = Number(req.headers['content-length']), mime = String(req.headers['content-type'] || '').split(';')[0].trim();
      assert(/^\d+$/.test(req.headers['content-length'] || '') && Number.isSafeInteger(length) && length > 0 && length <= MAX_IMAGE_BYTES, 'Das Bild darf höchstens 8 MiB groß sein und benötigt eine Größenangabe.', 'validation', 413);
      assert(!req.headers['content-encoding'] && MIME.has(mime), 'Erlaubt sind unverpackte JPG-, PNG- und WebP-Bilder.', 'validation', 415);
      let filename; try { filename = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw new AppError('validation', 'Der Bilddateiname ist ungültig.'); }
      assert(filename && filename.length <= 160 && !/[\u0000-\u001f\u007f/\\:]/.test(filename), 'Bitte einen gültigen Bilddateinamen übergeben.');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; assert(size <= length, 'Die Datei ist größer als angegeben.', 'validation', 413); chunks.push(chunk); }
      assert(size === length, 'Die Datei ist unvollständig.');
      const bytes = Buffer.concat(chunks), dimensions = inspectImageBytes(bytes, mime), id = imageStorageId('gallery', sha256(bytes));
      return await this.exclusive(async () => {
        this.editor(context, slug, portrait);
        const old = this.store.get('SELECT 1 FROM community_images WHERE profile_slug=? AND id=?', slug, id);
        if (!old) {
          const quota = this.store.get('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM community_images WHERE profile_slug=?', slug);
          assert(quota.n < COMMUNITY_LIMITS.maxImagesPerProfile && quota.bytes + size <= COMMUNITY_LIMITS.maxProfileImageBytes, 'Der Bildspeicher dieses Profils ist voll.', 'conflict', 409);
        }
        await this.storage.put(id, bytes, { mimeType: mime, ...dimensions });
        const { actor, profile } = this.editor(context, slug, portrait);
        this.store.transaction(() => {
          if (!old) this.store.run('INSERT INTO community_images(profile_slug,id,filename,mime_type,size,width,height,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', slug, id, filename, mime, size, dimensions.width, dimensions.height, actor.id, this.now());
          if (portrait) { assert(profile.revision < Number.MAX_SAFE_INTEGER, 'Die Profilversion ist ungültig.', 'conflict', 409); this.store.run('UPDATE community_profiles SET portrait_id=?,revision=revision+1,updated_at=? WHERE slug=?', id, this.now(), slug); }
          this.store.audit(actor.id, portrait ? 'community.portrait_uploaded' : 'community.image_uploaded', slug, { imageId: id }, this.now());
        });
        return this.imageView(this.image(slug, id));
      });
    } finally { this.uploads--; }
  }
  async removeImage(context, slug, id) {
    return this.exclusive(async () => {
      const { actor } = this.editor(context, slug), before = this.image(slug, id);
      const unreferenced = () => {
        this.editor(context, slug); const current = this.image(slug, id);
        assert(!this.published(slug, id), 'Dieses Bild wird noch als Profilbild oder in einem Beitrag verwendet.', 'conflict', 409);
        assert(current.mime_type === before.mime_type && current.size === before.size && current.width === before.width && current.height === before.height, 'Die Bildangaben wurden geändert.', 'conflict', 409);
      };
      unreferenced();
      const shared = this.accounts.memberProfile?.hasImage(id) || this.accounts.gamingSetups?.hasImage(id) || this.accounts.pcSupport?.hasImage(id) || this.store.get('SELECT 1 FROM setup_images WHERE id=?', id) ||
        this.store.get('SELECT 1 FROM community_images WHERE id=? AND profile_slug<>? LIMIT 1', id, slug);
      if (!shared) {
        // Keep metadata on uncertain failures. A retry may finish cleanup when
        // the preceding confirmed quarantine outlived the user's permission.
        try { await this.storage.remove(id); } catch (error) { if (error.status !== 404) throw error; }
        try { unreferenced(); }
        catch (error) { this.store.audit(actor.id, 'community.quarantined_pending_metadata', slug, { imageId: id }, this.now()); throw error; }
      }
      this.store.transaction(() => {
        this.store.run('UPDATE community_posts SET image_id=NULL WHERE profile_slug=? AND image_id=? AND deleted_at IS NOT NULL', slug, id);
        this.store.run('DELETE FROM community_images WHERE profile_slug=? AND id=?', slug, id);
        this.store.audit(actor.id, 'community.image_removed', slug, { imageId: id, shared: !!shared }, this.now());
      });
      return { ok: true };
    });
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://community.invalid'), route = url.pathname, method = req.method;
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const profileMatch = /^\/api\/community\/profiles\/([a-z0-9-]+)$/.exec(route);
    const imageMatch = /^\/api\/community\/profiles\/([a-z0-9-]+)\/images\/(gallery_[a-f0-9]{64})$/.exec(route);
    const publicComments = /^\/api\/community\/posts\/([a-f0-9-]{36})\/comments$/.exec(route);
    const publicRead = method === 'GET' && (route === '/api/community/profiles' || profileMatch || publicComments) || ['GET', 'HEAD'].includes(method) && imageMatch;
    const hasSession = !!req.headers.authorization || /(?:^|;)\s*__Host-cb_account=/.test(req.headers.cookie || '');
    let context = null;
    if (!publicRead || hasSession) {
      try { context = await this.accounts.authenticateRequest(req, { mutation: !['GET', 'HEAD'].includes(method), requireAdmin: route.startsWith('/api/admin/') }); }
      catch (error) { if (!publicRead || error.status !== 401) throw error; }
    }
    const readActor = () => {
      if (!context) return null;
      try { return this.actor(context); }
      catch (error) { if (!publicRead || error.status !== 401) throw error; context = null; return null; }
    };
    const actor = readActor();
    if (await this.push.handle(req, res, context)) return true;
    if (route === '/api/community/profiles' && method === 'GET') {
      const storage = await this.storage.status(); readActor();
      send({ profiles: PROFILES.map(([slug]) => this.profileView(this.profile(slug))), viewer: this.viewer(context), storage }); return true;
    }
    if (profileMatch && method === 'GET') {
      const before = cursor(url.searchParams.get('before'));
      const storage = await this.storage.status(); const currentActor = readActor();
      const profile = this.profile(profileMatch[1]), args = [profile.slug];
      if (before) args.push(before.at, before.at, before.id);
      const result = page(this.store.all('SELECT * FROM community_posts WHERE profile_slug=? AND deleted_at IS NULL' +
        (before ? ' AND (created_at<? OR (created_at=? AND id<?))' : '') + ' ORDER BY created_at DESC,id DESC LIMIT 31', ...args), 30);
      send({ profile: { ...this.profileView(profile), posts: result.rows.map(row => this.postView(row, currentActor)) }, nextCursor: result.nextCursor, viewer: this.viewer(context, profile), limits: COMMUNITY_LIMITS, storage }); return true;
    }
    if (imageMatch && ['GET', 'HEAD'].includes(method)) {
      const [, slug, id] = imageMatch;
      const authorize = () => { readActor(); this.image(slug, id); if (!this.published(slug, id)) { assert(context, 'Dieses Bild ist nicht veröffentlicht.', 'not_found', 404); this.editor(context, slug); } };
      authorize(); const before = this.image(slug, id);
      const bytes = await this.storage.read(id, { mimeType: before.mime_type, size: before.size, width: before.width, height: before.height });
      authorize(); const after = this.image(slug, id);
      assert(after.mime_type === before.mime_type && after.size === before.size && after.width === before.width && after.height === before.height, 'Die Bildangaben wurden geändert.', 'conflict', 409);
      res.writeHead(200, { 'Content-Type': after.mime_type, 'Content-Length': bytes.length, 'X-Content-Type-Options': 'nosniff' }); res.end(method === 'HEAD' ? undefined : bytes); return true;
    }
    if (imageMatch && method === 'DELETE') {
      this.accounts.limit('community-image-remove:' + actor.id, 60, 3600_000);
      send(await this.removeImage(context, imageMatch[1], imageMatch[2])); return true;
    }
    if (profileMatch && method === 'PATCH') {
      const value = await body(req); fields(value, ['expectedRevision', 'bio', 'socialLinks']);
      const bio = text(value.bio, COMMUNITY_LIMITS.bio), social = links(value.socialLinks);
      const { actor: editor, profile } = this.editor(context, profileMatch[1]);
      assert(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision === profile.revision && profile.revision < Number.MAX_SAFE_INTEGER, 'Dieses Profil wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
      this.store.transaction(() => { this.store.run('UPDATE community_profiles SET bio=?,social_links=?,revision=revision+1,updated_at=? WHERE slug=?', bio, JSON.stringify(social), this.now(), profile.slug); this.store.audit(editor.id, 'community.profile_updated', profile.slug, {}, this.now()); });
      send({ profile: this.profileView(this.profile(profile.slug)) }); return true;
    }
    const uploadMatch = /^\/api\/community\/profiles\/([a-z0-9-]+)\/images$/.exec(route);
    if (uploadMatch && method === 'GET') {
      this.editor(context, uploadMatch[1]); const storage = await this.storage.status(); this.editor(context, uploadMatch[1]);
      send({ images: this.store.all('SELECT * FROM community_images WHERE profile_slug=? ORDER BY created_at DESC,id DESC', uploadMatch[1]).map(row => this.libraryImage(row)), storage, limits: COMMUNITY_LIMITS }); return true;
    }
    if (uploadMatch && method === 'POST') { this.accounts.limit('community-image:' + actor.id, 20, 3600_000); send({ image: await this.upload(req, context, uploadMatch[1]) }, 201); return true; }
    const postCreate = /^\/api\/community\/profiles\/([a-z0-9-]+)\/posts$/.exec(route);
    if (postCreate && method === 'POST') {
      const value = await body(req); fields(value, ['text', 'imageId'], ['text']); const content = text(value.text, COMMUNITY_LIMITS.post), imageId = value.imageId ?? null;
      assert(content || imageId, 'Bitte Text oder ein Bild hinzufügen.');
      const initial = this.editor(context, postCreate[1]); this.accounts.limit('community-post:' + initial.actor.id, 30, 3600_000);
      if (imageId !== null) assert(typeof imageId === 'string' && IMAGE.test(imageId), 'Der Bildverweis ist ungültig.');
      const result = await this.exclusive(async () => {
        this.editor(context, postCreate[1]);
        if (imageId !== null) {
          const image = this.image(postCreate[1], imageId);
          await this.storage.read(imageId, { mimeType: image.mime_type, size: image.size, width: image.width, height: image.height });
          const current = this.image(postCreate[1], imageId);
          assert(current.mime_type === image.mime_type && current.size === image.size && current.width === image.width && current.height === image.height, 'Die Bildangaben wurden geändert.', 'conflict', 409);
        }
        const { actor: editor, profile } = this.editor(context, postCreate[1]), id = randomUUID();
        this.store.transaction(() => { this.store.run('INSERT INTO community_posts(id,profile_slug,author_id,text,image_id,created_at) VALUES (?,?,?,?,?,?)', id, profile.slug, editor.id, content, imageId, this.now()); this.store.audit(editor.id, 'community.post_created', id, {}, this.now()); });
        return this.postView(this.post(id), editor);
      });
      send({ post: result }, 201); return true;
    }
    const postMatch = /^\/api\/community\/posts\/([a-f0-9-]{36})(?:\/(like|comments))?$/.exec(route);
    if (postMatch) {
      const post = this.post(postMatch[1]);
      if (postMatch[2] === 'comments' && method === 'GET') { send(this.comments(post, actor, cursor(url.searchParams.get('before')))); return true; }
      if (!postMatch[2] && method === 'DELETE') {
        const editor = this.editor(context, post.profile_slug).actor;
        this.store.transaction(() => { this.store.run('UPDATE community_posts SET deleted_at=?,deleted_by=? WHERE id=? AND deleted_at IS NULL', this.now(), editor.id, post.id); this.store.audit(editor.id, 'community.post_deleted', post.id, {}, this.now()); }); send({ ok: true }); return true;
      }
      if (postMatch[2] === 'like' && ['POST', 'DELETE'].includes(method)) {
        const member = this.actor(context, { team: true }); this.accounts.limit('community-like:' + member.id, 120);
        if (method === 'POST') this.store.run('INSERT OR IGNORE INTO community_likes(post_id,user_id,created_at) VALUES (?,?,?)', post.id, member.id, this.now());
        else this.store.run('DELETE FROM community_likes WHERE post_id=? AND user_id=?', post.id, member.id);
        send(this.likeView(post.id, member)); return true;
      }
      if (postMatch[2] === 'comments' && method === 'POST') {
        const value = await body(req); fields(value, ['text']); const content = text(value.text, COMMUNITY_LIMITS.comment, 1), member = this.actor(context, { team: true }); this.post(post.id);
        this.accounts.limit('community-comment:' + member.id, 30, 3600_000); const id = randomUUID();
        this.store.run('INSERT INTO community_comments(id,post_id,author_id,text,created_at) VALUES (?,?,?,?,?)', id, post.id, member.id, content, this.now());
        send({ comment: this.commentView(this.store.get('SELECT * FROM community_comments WHERE id=?', id), member, this.profile(post.profile_slug)) }, 201); return true;
      }
    }
    const commentMatch = /^\/api\/community\/comments\/([a-f0-9-]{36})$/.exec(route);
    if (commentMatch && method === 'DELETE') {
      const member = this.actor(context, { team: true }), comment = this.store.get('SELECT * FROM community_comments WHERE id=? AND deleted_at IS NULL', commentMatch[1]);
      assert(comment, 'Dieser Kommentar ist nicht vorhanden.', 'not_found', 404); const post = this.post(comment.post_id);
      assert(comment.author_id === member.id || this.canEdit(member, this.profile(post.profile_slug)), 'Du darfst diesen Kommentar nicht entfernen.', 'forbidden', 403);
      this.store.transaction(() => { this.store.run('UPDATE community_comments SET deleted_at=?,deleted_by=? WHERE id=?', this.now(), member.id, comment.id); this.store.audit(member.id, 'community.comment_deleted', comment.id, {}, this.now()); }); send({ ok: true }); return true;
    }
    if (route === '/api/community/members' && method === 'GET') {
      const member = this.actor(context), query = text(url.searchParams.get('q') || '', 80);
      const members = this.store.all('SELECT id,name FROM accounts WHERE confirmed=1 AND suspended=0 AND id<>? AND instr(lower(name),lower(?))>0 ORDER BY lower(name),id LIMIT 101', member.id, query);
      send({ members: members.slice(0, 100), hasMore: members.length > 100 }); return true;
    }
    if (route === '/api/community/threads' && method === 'POST') {
      const value = await body(req); fields(value, ['recipientId', 'note'], ['recipientId']);
      assert(typeof value.recipientId === 'string' && UUID.test(value.recipientId), 'Bitte ein Mitglied auswählen.');
      const note = text(value.note ?? '', COMMUNITY_LIMITS.note), requester = this.actor(context), recipient = this.member(value.recipientId);
      assert(recipient?.confirmed && !recipient.suspended, 'Dieses Mitglied kann zurzeit keine Nachrichten empfangen.', 'not_found', 404);
      assert(requester.id !== recipient.id, 'Du kannst dir nicht selbst eine Nachricht schicken.');
      const [low, high] = [requester.id, recipient.id].sort();
      let thread = this.store.get("SELECT *,NULL AS profile_slug,'direct' AS kind FROM community_direct_threads WHERE participant_low=? AND participant_high=?", low, high);
      let created = false;
      if (!thread) {
        this.accounts.limit('community-request:' + requester.id, 10, 3600_000);
        const id = randomUUID(), now = this.now();
        this.store.transaction(() => {
          this.store.run("INSERT INTO community_direct_threads(id,requester_id,recipient_id,participant_low,participant_high,status,note,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?)", id, requester.id, recipient.id, low, high, this.seal(id, requester.id, note), now, now);
          this.push.enqueue({ type: 'request', threadId: id, recipientId: recipient.id, eventId: id });
        });
        thread = this.thread(id, requester.id); created = true;
      }
      send({ thread: this.threadView(thread, requester.id), created }, created ? 201 : 200); return true;
    }
    const requestMatch = /^\/api\/community\/profiles\/([a-z0-9-]+)\/message-request$/.exec(route);
    if (requestMatch && method === 'POST') {
      const value = await body(req); fields(value, ['note']); const note = text(value.note, COMMUNITY_LIMITS.note), requester = this.actor(context), profile = this.profile(requestMatch[1]), recipient = this.member(profile.owner_id);
      assert(this.team(recipient), 'Dieses Profil kann noch keine Nachrichtenanfragen empfangen.', 'conflict', 409);
      assert(requester.id !== recipient.id, 'Du kannst dir nicht selbst eine Nachrichtenanfrage schicken.');
      let thread = this.store.get('SELECT * FROM community_threads WHERE profile_slug=? AND requester_id=? AND recipient_id=?', profile.slug, requester.id, recipient.id);
      if (!thread) {
        this.accounts.limit('community-request:' + requester.id, 10, 3600_000);
        const id = randomUUID(), now = this.now(), encrypted = this.seal(id, requester.id, note);
        this.store.transaction(() => {
          this.store.run("INSERT INTO community_threads(id,profile_slug,requester_id,recipient_id,status,note,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?)", id, profile.slug, requester.id, recipient.id, encrypted, now, now);
          this.push.enqueue({ type: 'request', threadId: id, recipientId: recipient.id, eventId: id });
        });
        thread = this.thread(id, requester.id);
      }
      send({ thread: this.threadView(thread, requester.id) }); return true;
    }
    if (route === '/api/community/inbox' && method === 'GET') {
      const member = this.actor(context), before = cursor(url.searchParams.get('before')), args = [member.id, member.id];
      if (before) args.push(before.at, before.at, before.id);
      const result = page(this.store.all("SELECT * FROM (SELECT id,profile_slug,requester_id,recipient_id,status,note,created_at,updated_at,'profile' AS kind FROM community_threads UNION ALL SELECT id,NULL AS profile_slug,requester_id,recipient_id,status,note,created_at,updated_at,'direct' AS kind FROM community_direct_threads) WHERE (requester_id=? OR recipient_id=?)" +
        (before ? ' AND (updated_at<? OR (updated_at=? AND id<?))' : '') + ' ORDER BY updated_at DESC,id DESC LIMIT 101', ...args), 100, 'updated_at');
      send({ threads: result.rows.map(row => this.threadView(row, member.id)), nextCursor: result.nextCursor, viewer: this.viewer(context), attachmentLimits: CHAT_ATTACHMENT_LIMITS }); return true;
    }
    const attachmentMatch = /^\/api\/community\/threads\/([a-f0-9-]{36})\/attachments(?:\/([a-f0-9-]{36})(\/preview)?)?$/.exec(route);
    if (attachmentMatch && !attachmentMatch[2] && method === 'POST') { send({ attachment: await this.attachments.upload(req, context, attachmentMatch[1]) }, 201); return true; }
    if (attachmentMatch?.[2] && ['GET', 'HEAD'].includes(method)) { await this.attachments.serve(req, res, context, attachmentMatch[1], attachmentMatch[2], !!attachmentMatch[3]); return true; }
    const threadMatch = /^\/api\/community\/threads\/([a-f0-9-]{36})\/(decision|messages)$/.exec(route);
    if (threadMatch) {
      if (threadMatch[2] === 'decision' && method === 'POST') {
        const value = await body(req); fields(value, ['status']); assert(['approved', 'rejected', 'blocked'].includes(value.status), 'Die Entscheidung ist ungültig.');
        const member = this.actor(context), thread = this.thread(threadMatch[1], member.id);
        assert(!this.threadControl(thread.id).administrator_blocked, 'Dieser Chat wurde von einem Administrator gesperrt.', 'forbidden', 403);
        const directBlock = thread.kind === 'direct' && value.status === 'blocked' && thread.status === 'approved';
        assert(thread.recipient_id === member.id || directBlock, 'Nur der Empfänger entscheidet über diese Anfrage.', 'forbidden', 403);
        assert(value.status === thread.status || thread.status === 'pending' || thread.status === 'approved' && value.status === 'blocked', 'Eine geschlossene Anfrage kann nicht erneut geöffnet werden.', 'conflict', 409);
        if (value.status === 'approved') assert(this.chatParticipantsActive(thread), 'Ein beteiligtes Konto ist gesperrt oder nicht bestätigt.', 'forbidden', 403);
        this.store.transaction(() => {
          if (thread.kind !== 'direct') this.updateThreadControl(thread.id, member.id, false);
          this.store.run('UPDATE ' + this.chatTables(thread).threads + ' SET status=?,updated_at=? WHERE id=?', value.status, this.now(), thread.id);
        });
        send({ thread: this.threadView(this.thread(thread.id, member.id), member.id) }); return true;
      }
      if (threadMatch[2] === 'messages' && method === 'GET') {
        const member = this.actor(context), thread = this.thread(threadMatch[1], member.id), before = url.searchParams.get('before'), after = url.searchParams.get('after');
        assert(!(before !== null && after !== null), 'Bitte nur einen Nachrichten-Cursor verwenden.');
        assert(before === null || /^[1-9]\d{0,14}$/.test(before) && Number.isSafeInteger(Number(before)), 'Der Nachrichten-Cursor ist ungültig.');
        assert(after === null || /^(?:0|[1-9]\d{0,14})$/.test(after) && Number.isSafeInteger(Number(after)), 'Der Nachrichten-Cursor ist ungültig.');
        const incremental = after !== null, table = this.chatTables(thread).messages;
        const found = this.store.all('SELECT * FROM ' + table + ' WHERE thread_id=? AND seq' + (incremental ? '>? ORDER BY seq ASC' : '<? ORDER BY seq DESC') + ' LIMIT 51', thread.id, incremental ? Number(after) : before ? Number(before) : Number.MAX_SAFE_INTEGER), selected = found.slice(0, 50), rows = incremental ? selected : selected.reverse();
        send({ thread: this.threadView(thread, member.id), messages: rows.map(row => this.messageView(row)),
          nextCursor: !incremental && found.length > 50 ? String(rows[0].seq) : null,
          latestCursor: String(rows.at(-1)?.seq ?? (incremental ? Number(after) : 0)), hasMore: incremental && found.length > 50 }); return true;
      }
      if (threadMatch[2] === 'messages' && method === 'POST') {
        const value = await body(req); fields(value, ['text', 'clientId', 'attachmentIds'], []);
        assert(value.clientId === undefined || typeof value.clientId === 'string' && UUID.test(value.clientId), 'Die Nachrichtenkennung ist ungültig.');
        const attachmentIds = value.attachmentIds ?? [];
        assert(Array.isArray(attachmentIds) && attachmentIds.length <= CHAT_ATTACHMENT_LIMITS.maxFiles && attachmentIds.every(id => typeof id === 'string' && UUID.test(id)) && new Set(attachmentIds).size === attachmentIds.length, 'Bitte höchstens fünf verschiedene Dateien hinzufügen.');
        const content = text(value.text ?? '', COMMUNITY_LIMITS.message), member = this.actor(context), thread = this.thread(threadMatch[1], member.id);
        assert(content || attachmentIds.length, 'Bitte einen Text, eine Datei oder eine Sprachnachricht hinzufügen.');
        assert(!this.threadControl(thread.id).administrator_blocked, 'Dieser Chat wurde von einem Administrator gesperrt.', 'forbidden', 403);
        assert(this.threadView(thread, member.id).canSend, 'Nachrichten sind erst nach Freigabe durch den Empfänger möglich.', 'forbidden', 403);
        const tables = this.chatTables(thread);
        if (value.clientId) {
          const previous = this.store.get('SELECT m.* FROM community_message_receipts r JOIN ' + tables.messages + ' m ON m.id=r.message_id WHERE r.thread_id=? AND r.sender_id=? AND r.client_id=? AND m.thread_id=r.thread_id AND m.sender_id=r.sender_id', thread.id, member.id, value.clientId);
          if (previous) {
            assert(this.open(thread.id, member.id, previous.body) === content && JSON.stringify(this.attachments.forMessage(previous.id).map(row => row.id)) === JSON.stringify(attachmentIds), 'Diese Nachrichtenkennung wurde bereits für einen anderen Inhalt verwendet.', 'conflict', 409);
            send({ message: this.messageView(previous) }); return true;
          }
        }
        this.accounts.limit('community-message:' + member.id, 60); const id = randomUUID(), now = this.now();
        this.store.transaction(() => {
          this.store.run('INSERT INTO ' + tables.messages + '(id,thread_id,sender_id,body,created_at) VALUES (?,?,?,?,?)', id, thread.id, member.id, this.seal(thread.id, member.id, content), now);
          this.attachments.claim(attachmentIds, thread.id, member.id, id);
          if (value.clientId) this.store.run('INSERT INTO community_message_receipts(thread_id,sender_id,client_id,message_id) VALUES (?,?,?,?)', thread.id, member.id, value.clientId, id);
          this.store.run('UPDATE ' + tables.threads + ' SET updated_at=? WHERE id=?', now, thread.id);
          this.push.enqueue({ type: 'message', threadId: thread.id, recipientId: thread.requester_id === member.id ? thread.recipient_id : thread.requester_id, eventId: id });
        });
        send({ message: this.messageView(this.store.get('SELECT * FROM ' + tables.messages + ' WHERE id=?', id)) }, 201); return true;
      }
    }
    const adminChats = /^\/api\/admin\/community\/profiles\/([a-z0-9-]+)\/threads(?:\/([a-f0-9-]{36})\/(messages|decision))?$/.exec(route);
    if (adminChats) {
      const [, slug, threadId, action] = adminChats;
      const admin = this.actor(context, { admin: true }), profile = this.profile(slug);
      if (!threadId && method === 'GET') {
        const before = cursor(url.searchParams.get('before')), args = [slug];
        if (before) args.push(before.at, before.at, before.id);
        const result = page(this.store.all('SELECT * FROM community_threads WHERE profile_slug=?' +
          (before ? ' AND (updated_at<? OR (updated_at=? AND id<?))' : '') + ' ORDER BY updated_at DESC,id DESC LIMIT 101', ...args), 100, 'updated_at');
        const threads = result.rows.map(row => this.adminThreadView(row, admin.id));
        this.store.transaction(() => {
          for (const row of result.rows) this.store.audit(admin.id, 'community.admin_chat_listed', row.id, { profileSlug: slug }, this.now());
        });
        send({ profile: { slug, name: profile.name }, threads, nextCursor: result.nextCursor, administrationNotice: CHAT_ADMINISTRATION_NOTICE }); return true;
      }
      if (action === 'messages' && method === 'GET') {
        const thread = this.adminThread(slug, threadId), before = url.searchParams.get('before');
        assert(before === null || /^[1-9]\d{0,14}$/.test(before) && Number.isSafeInteger(Number(before)), 'Der Nachrichten-Cursor ist ungültig.');
        const found = this.store.all('SELECT * FROM community_messages WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 51', thread.id, before ? Number(before) : Number.MAX_SAFE_INTEGER), rows = found.slice(0, 50);
        const messages = [...rows].reverse().map(row => ({ id: row.id, senderId: row.sender_id, senderName: this.member(row.sender_id)?.name || 'Mitglied', text: this.open(thread.id, row.sender_id, row.body), createdAt: row.created_at }));
        const view = this.adminThreadView(thread, admin.id);
        this.store.audit(admin.id, 'community.admin_chat_read', thread.id, { profileSlug: slug, messageCount: rows.length }, this.now());
        send({ thread: view, messages, nextCursor: found.length > 50 ? String(rows.at(-1).seq) : null, administrationNotice: CHAT_ADMINISTRATION_NOTICE }); return true;
      }
      if (action === 'decision' && method === 'POST') {
        const value = await body(req); fields(value, ['action', 'expectedRevision']);
        assert(['approve', 'reject', 'block', 'unblock'].includes(value.action), 'Die Chatentscheidung ist ungültig.');
        // Check current administrator rights after reading the complete request.
        const currentAdmin = this.actor(context, { admin: true }), thread = this.adminThread(slug, threadId), control = this.threadControl(thread.id);
        assert(Number.isSafeInteger(value.expectedRevision) && value.expectedRevision === control.revision, 'Dieser Chat wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
        const allowed = { approve: 'canApprove', reject: 'canReject', block: 'canBlock', unblock: 'canUnblock' };
        assert(this.adminThreadView(thread, currentAdmin.id)[allowed[value.action]], 'Diese Chatentscheidung ist im aktuellen Zustand nicht möglich. Bitte neu laden.', 'conflict', 409);
        const nextStatus = value.action === 'approve' ? 'approved' : value.action === 'reject' ? 'rejected' : thread.status;
        const blocked = value.action === 'block' ? true : value.action === 'unblock' ? false : !!control.administrator_blocked;
        const auditAction = { approve: 'approved', reject: 'rejected', block: 'blocked', unblock: 'unblocked' }[value.action];
        this.store.transaction(() => {
          this.updateThreadControl(thread.id, currentAdmin.id, blocked);
          this.store.run('UPDATE community_threads SET status=?,updated_at=? WHERE id=?', nextStatus, this.now(), thread.id);
          this.store.audit(currentAdmin.id, 'community.admin_chat_' + auditAction, thread.id,
            { profileSlug: slug, previousStatus: thread.status, status: nextStatus, previousAdminBlocked: !!control.administrator_blocked, adminBlocked: blocked }, this.now());
        });
        send({ thread: this.adminThreadView(this.adminThread(slug, thread.id), currentAdmin.id) }); return true;
      }
      throw new AppError('not_found', 'Diese Chatfunktion ist nicht vorhanden.', 404);
    }
    if (route === '/api/admin/community' && method === 'GET') {
      const storage = await this.storage.status(); this.actor(context, { admin: true }); const users = this.store.all('SELECT id FROM accounts ORDER BY created_at DESC').map(row => this.member(row.id));
      send({ profiles: PROFILES.map(([slug]) => this.profileView(this.profile(slug), { admin: true })), accounts: users.map(row => this.accountView(row)), team: users.filter(row => this.team(row)).map(row => row.id), storage }); return true;
    }
    const teamMatch = /^\/api\/admin\/community\/team\/([a-f0-9-]{36})$/.exec(route);
    if (teamMatch && method === 'PATCH') {
      const value = await body(req); fields(value, ['enabled']); assert(typeof value.enabled === 'boolean', 'Die Teamfreigabe muss Ja oder Nein sein.');
      const admin = this.actor(context, { admin: true }), target = this.member(teamMatch[1]); assert(target, 'Dieses Konto ist nicht vorhanden.', 'not_found', 404);
      assert(!value.enabled || target.confirmed && !target.suspended, 'Nur bestätigte aktive Konten können ins Team aufgenommen werden.');
      this.store.transaction(() => { this.store.run('INSERT INTO community_team(user_id,enabled,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at', target.id, Number(value.enabled), admin.id, this.now()); this.store.audit(admin.id, 'community.team_changed', target.id, { enabled: value.enabled }, this.now()); });
      send({ account: this.accountView(this.member(target.id)) }); return true;
    }
    const adminProfile = /^\/api\/admin\/community\/profiles\/([a-z0-9-]+)(?:\/(portrait))?$/.exec(route);
    if (adminProfile && !adminProfile[2] && method === 'PATCH') {
      const value = await body(req); fields(value, ['ownerId']); assert(value.ownerId === null || typeof value.ownerId === 'string' && UUID.test(value.ownerId), 'Bitte ein vorhandenes Konto auswählen.');
      const admin = this.actor(context, { admin: true }), profile = this.profile(adminProfile[1]);
      if (value.ownerId) assert(this.team(this.member(value.ownerId)), 'Bitte zuerst dieses bestätigte aktive Konto für das Team freigeben.');
      assert(profile.revision < Number.MAX_SAFE_INTEGER, 'Die Profilversion ist ungültig.', 'conflict', 409);
      this.store.transaction(() => { this.store.run('UPDATE community_profiles SET owner_id=?,revision=revision+1,updated_at=? WHERE slug=?', value.ownerId, this.now(), profile.slug); this.store.audit(admin.id, 'community.owner_assigned', profile.slug, { previousOwnerId: profile.owner_id, ownerId: value.ownerId }, this.now()); });
      send({ profile: this.profileView(this.profile(profile.slug), { admin: true }) }); return true;
    }
    if (adminProfile?.[2] === 'portrait' && method === 'POST') {
      this.accounts.limit('community-portrait:' + actor.id, 20, 3600_000); await this.upload(req, context, adminProfile[1], true);
      send({ profile: this.profileView(this.profile(adminProfile[1]), { admin: true }) }); return true;
    }
    throw new AppError('not_found', 'Dieser Community-Bereich ist nicht vorhanden.', 404);
  }
}
