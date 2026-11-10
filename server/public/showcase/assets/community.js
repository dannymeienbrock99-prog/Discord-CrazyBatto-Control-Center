import { api, getSession, errorText, formatDate } from './account-client.js';

import { initPrivateChat } from './private-chat.js';

const root = document.querySelector('[data-community-page]');
const page = root?.dataset.communityPage;
const content = document.getElementById('communityContent');
const feedback = document.getElementById('communityStatus');
const refresh = document.getElementById('communityRefresh');
const people = [
  { slug: 'sarah', name: 'Sarah / L4e ImLuNa', initial: 'S' },
  { slug: 'michelle', name: 'Michelle', initial: 'M' },
  { slug: 'faelan', name: 'Fáelán', initial: 'F' },
  { slug: 'g-gaming', name: 'G___Gaming', initial: 'G' },
  { slug: 'devilwolf666', name: 'Devilwolf666', initial: 'D' },
];
const providers = ['TikTok', 'Discord', 'Instagram', 'Twitch', 'YouTube'];
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxImageBytes = 8 * 1024 * 1024;
const state = { busy: false, profile: null, viewer: null, storage: null, postsNextCursor: null, threads: [], inboxNextCursor: null, selected: null, threadSequence: 0, inboxUserId: null, drafts: new Map(), adminProfileSlug: null };
const profileSlug = new URLSearchParams(location.search).get('person');
const endpoint = slug => '/api/community/profiles/' + encodeURIComponent(slug);
const threadEndpoint = id => '/api/community/threads/' + encodeURIComponent(id);
const statusNames = { pending: 'Anfrage offen', approved: 'Angenommen', rejected: 'Abgelehnt', blocked: 'Blockiert' };
const administrationNotice = 'Administratoren können Anfragen und Nachrichten einsehen, Anfragen annehmen oder ablehnen und Chats sperren oder entsperren. Nachrichten werden nicht öffentlich angezeigt.';

function element(tag, text = '', className = '') {
  const item = document.createElement(tag);
  if (text !== '') item.textContent = text;
  if (className) item.className = className;
  return item;
}
function status(target, text, error = false) {
  target.textContent = text;
  target.classList.toggle('is-error', error);
}
function localFeedback() {
  const item = element('p', '', 'cc-feedback');
  item.setAttribute('role', 'status'); item.setAttribute('aria-live', 'polite');
  return item;
}
function button(text, action, className = 'secondary') {
  const item = element('button', text, 'cc-button ' + className); item.type = 'button';
  if (action) item.addEventListener('click', action);
  return item;
}
function link(text, href, className = 'cc-button secondary') {
  const item = element('a', text, className); item.href = href; return item;
}
function actions(...items) { const row = element('div', '', 'cc-actions'); row.append(...items); return row; }
function field(label, type = 'text', value = '', maxLength = null) {
  const wrap = element('label', label);
  const input = element(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.value = value;
  if (maxLength) input.maxLength = maxLength;
  wrap.append(input);
  return { wrap, input };
}
function formButton(text) { const item = button(text, null, ''); item.type = 'submit'; return item; }
function badge(thread) { const item = element('span', statusNames[thread.status] || 'Status unbekannt', 'cc-badge'); item.dataset.state = thread.status; return item; }
function adminBlockBadge() { const item = element('span', 'Vom Administrator gesperrt', 'cc-badge'); item.dataset.state = 'blocked'; return item; }
function chatNotice(value) { return element('p', typeof value === 'string' && value.trim() ? value : administrationNotice, 'cc-chat-notice'); }
function adminLinks(viewer) { document.querySelectorAll('[data-community-admin-link]').forEach(item => { item.hidden = !viewer?.isAdmin; }); }
function requireArray(value) { if (!Array.isArray(value)) throw new Error('Die Serverantwort ist unvollständig. Bitte erneut laden.'); return value; }
function mergedById(first, second) { return [...new Map([...first, ...second].map(item => [item.id, item])).values()]; }
function imageUrl(image, slug) {
  if (!image || typeof image.url !== 'string') throw new Error('Der Bildverweis fehlt.');
  const url = new URL(image.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith(endpoint(slug) + '/images/') || url.search || url.hash) throw new Error('Der Bildverweis ist ungültig.');
  return url.pathname;
}
function portrait(profile) {
  const person = people.find(item => item.slug === profile.slug) || { initial: '?', name: 'Partnerprofil' };
  const wrap = element('div', '', 'cc-portrait cc-portrait-' + profile.slug);
  const initial = element('strong', person.initial); initial.setAttribute('aria-hidden', 'true');
  const hint = element('span', 'Bild folgt'); wrap.append(initial, hint);
  if (profile.portrait) {
    try {
      const image = element('img'); image.alt = 'Porträt von ' + (profile.name || person.name); image.loading = 'lazy';
      image.src = imageUrl(profile.portrait, profile.slug);
      image.addEventListener('error', () => { image.remove(); hint.textContent = 'Bild gerade nicht erreichbar'; }, { once: true });
      wrap.append(image);
    } catch { hint.textContent = 'Bild gerade nicht erreichbar'; }
  }
  return wrap;
}
function postImage(image, slug) {
  const wrap = element('figure');
  try {
    const img = element('img', '', 'cc-post-image'); img.src = imageUrl(image, slug); img.alt = 'Bild zum Beitrag'; img.loading = 'lazy';
    img.addEventListener('error', () => { wrap.replaceChildren(element('p', 'Das Bild konnte gerade nicht vom NAS geladen werden.', 'cc-empty')); }, { once: true });
    wrap.append(img);
  } catch { wrap.append(element('p', 'Der Bildverweis konnte nicht geladen werden.', 'cc-empty')); }
  return wrap;
}
function safeSocial(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : null; }
  catch { return null; }
}
function socialLinks(items) {
  const row = element('div', '', 'cc-socials');
  for (const item of items || []) {
    const url = safeSocial(item.url); if (!url) continue;
    const a = link(item.label + ' ↗', url); a.target = '_blank'; a.rel = 'noopener noreferrer'; row.append(a);
  }
  return row;
}
function storageText(storage) {
  if (storage?.configured === false) return 'Der NAS-Bildspeicher ist noch nicht eingerichtet.';
  if (storage?.online === false) return 'Der NAS-Bildspeicher ist gerade nicht erreichbar. Bild-Uploads sind momentan nicht möglich.';
  if (storage?.online === true) return 'NAS-Bildspeicher verbunden.';
  return 'Bilder werden auf dem NAS gespeichert. Der Speicher wird beim Upload geprüft.';
}
function imageField() {
  const item = field('Bild auswählen · optional', 'file');
  item.input.accept = 'image/jpeg,image/png,image/webp';
  return item;
}
function checkedFile(input) {
  const file = input.files?.[0];
  if (!file) return null;
  if (!imageTypes.has(file.type)) throw new Error('Bitte ein JPG-, PNG- oder WebP-Bild wählen. Animierte Bilder werden nicht unterstützt.');
  if (!file.size || file.size > maxImageBytes) throw new Error('Das Bild darf höchstens 8 MiB groß sein und nicht leer sein.');
  return file;
}
async function uploadImage(path, file) {
  return api(path, { method: 'POST', raw: true, body: file, timeout: 120000,
    headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent((file.name || 'Bild').slice(0, 160)) } });
}
function imageHelp() { return element('p', 'JPG, PNG oder WebP · ohne Animation · bis 8 MiB pro Bild. Deine Originaldatei wird auf dem NAS gespeichert.', 'cc-help'); }
function gate(text = 'Bitte melde dich mit deinem bestätigten Konto an.') {
  const box = element('section', '', 'cc-panel'); box.append(element('h2', 'Anmeldung erforderlich'), element('p', text), actions(link('Zur Anmeldung', 'registrierung.html')));
  content.replaceChildren(box);
}
async function perform(target, action, pending = 'Wird gespeichert …') {
  if (state.busy) return;
  state.busy = true; root.setAttribute('aria-busy', 'true');
  const controls = [...root.querySelectorAll('button,input,select,textarea')].map(item => [item, item.disabled]);
  controls.forEach(([item]) => { item.disabled = true; });
  status(target, pending);
  try { await action(); }
  catch (error) {
    if ((page === 'admin' || page === 'inbox') && [401, 403].includes(error.status)) {
      state.threads = []; state.selected = null; state.threadSequence++; state.drafts.clear();
      gate(page === 'admin' ? 'Diese Seite benötigt dein aktives Administratorkonto.' : undefined);
      status(feedback, errorText(error), true);
    } else status(target.isConnected ? target : feedback, errorText(error), true);
  } finally {
    controls.forEach(([item, disabled]) => { item.disabled = disabled; });
    state.busy = false; root.setAttribute('aria-busy', 'false');
  }
}
function bindForm(form, target, action, pending) {
  form.addEventListener('submit', event => { event.preventDefault(); void perform(target, action, pending); });
}

async function loadHome() {
  const result = await api('/api/community/profiles');
  const profiles = requireArray(result.profiles);
  const grid = document.getElementById('teamProfiles');
  const cards = people.map(person => {
    const profile = profiles.find(item => item.slug === person.slug);
    if (!profile) throw new Error('Ein Partnerprofil fehlt in der Serverantwort. Bitte erneut laden.');
    const card = link('', 'profile.html?person=' + person.slug, 'cc-team-card');
    const copy = element('div', '', 'cc-team-copy');
    copy.append(element('span', 'Kooperationspartner', 'cc-kicker'), element('h3', profile.name || person.name), element('span', 'Profil entdecken ↗', 'cc-card-link'));
    card.append(portrait(profile), copy); return card;
  });
  grid.replaceChildren(...cards); adminLinks(result.viewer);
  status(feedback, '');
}

function profileEditor(profile) {
  const panel = element('details', '', 'cc-panel'); panel.append(element('summary', 'Mein Profil bearbeiten'));
  panel.append(element('p', 'Deine Beschreibung und Social-Media-Links sind öffentlich. Das Hauptporträt verwaltet Crazy_Batto.', 'cc-help'));
  const form = element('form', '', 'cc-form'), note = localFeedback();
  const bio = field('Über mich', 'textarea', profile.bio || '', 2000); bio.input.rows = 6;
  const socialFields = element('div', '', 'cc-social-fields');
  const inputs = providers.map(label => {
    const existing = (profile.socialLinks || []).find(item => item.label.toLowerCase() === label.toLowerCase());
    const entry = field(label + ' · vollständiger HTTPS-Link', 'url', existing?.url || '', 1000); entry.input.placeholder = 'https://…';
    socialFields.append(entry.wrap); return { label, input: entry.input };
  });
  form.append(bio.wrap, socialFields, formButton('Profil speichern'), note); panel.append(form);
  bindForm(form, note, async () => {
    const socialLinks = inputs.filter(item => item.input.value.trim()).map(item => {
      const url = safeSocial(item.input.value.trim());
      if (!url) throw new Error('Bitte für ' + item.label + ' einen vollständigen HTTPS-Link ohne Zugangsdaten eingeben.');
      return { label: item.label, url };
    });
    const extras = (profile.socialLinks || []).filter(item => !providers.some(provider => provider.toLowerCase() === item.label.toLowerCase()));
    await api(endpoint(profile.slug), { method: 'PATCH', body: { expectedRevision: profile.revision, bio: bio.input.value.trim(), socialLinks: [...socialLinks, ...extras] } });
    await loadProfile(); status(feedback, 'Dein Profil wurde gespeichert.');
  });
  return panel;
}
function messageRequest(profile, viewer) {
  const panel = element('details', '', 'cc-panel'); panel.append(element('summary', 'Persönliche Nachricht anfragen'), chatNotice(profile.administrationNotice));
  if (!viewer.userId) {
    panel.append(element('p', 'Melde dich an, um eine persönliche Nachrichtenanfrage zu schicken.'), actions(link('Zur Anmeldung', 'registrierung.html')));
  } else if (!viewer.canRequestMessage) {
    panel.append(element('p', profile.assigned ? 'Für dieses Profil kannst du keine neue Nachrichtenanfrage stellen. Vorhandene Unterhaltungen findest du in deinen Nachrichten.' : 'Dieses Profil hat noch kein zugeordnetes Konto. Nachrichtenanfragen sind danach möglich.'), actions(link('Meine Nachrichten', 'nachrichten.html')));
  } else {
    panel.append(element('p', 'Stelle dich kurz vor. Erst wenn deine Anfrage angenommen wurde, könnt ihr euch Nachrichten schreiben.'));
    const form = element('form', '', 'cc-form'), note = localFeedback();
    const introduction = field('Deine Anfrage', 'textarea', '', 1000); introduction.input.placeholder = 'Worum geht es?';
    form.append(introduction.wrap, formButton('Anfrage senden'), note);
    bindForm(form, note, async () => {
      const result = await api(endpoint(profile.slug) + '/message-request', { method: 'POST', body: { note: introduction.input.value.trim() } });
      if (!result.thread?.id) throw new Error('Die Nachrichtenanfrage konnte nicht bestätigt werden. Bitte deine Nachrichten öffnen.');
      panel.replaceChildren(element('summary', 'Deine Nachrichtenanfrage'), chatNotice(profile.administrationNotice), element('p', 'Status: ' + (statusNames[result.thread.status] || result.thread.status)), actions(link('Unterhaltung öffnen', 'nachrichten.html?thread=' + encodeURIComponent(result.thread.id))));
      panel.open = true; status(feedback, 'Die Anfrage wurde gespeichert.');
    }, 'Anfrage wird gesendet …');
    panel.append(form);
  }
  return panel;
}
function postComposer(profile) {
  const panel = element('section', '', 'cc-panel'); panel.append(element('h2', 'Neuen Beitrag schreiben'), element('p', 'Deine Beiträge sind auf deinem Profil öffentlich sichtbar.', 'cc-help'));
  const form = element('form', '', 'cc-form'), note = localFeedback();
  const text = field('Dein Beitrag', 'textarea', '', 4000), picture = imageField();
  text.input.rows = 5;
  const fileInfo = element('p', '', 'cc-help');
  let staged = null;
  picture.input.addEventListener('change', () => {
    staged = null;
    try { const file = checkedFile(picture.input); fileInfo.textContent = file ? file.name + ' · ' + (file.size / 1024 / 1024).toFixed(2) + ' MiB' : ''; status(note, ''); }
    catch (error) { fileInfo.textContent = ''; status(note, errorText(error), true); }
  });
  picture.input.disabled = state.storage?.online === false;
  form.append(text.wrap, picture.wrap, fileInfo, imageHelp(), element('p', storageText(state.storage), 'cc-help'), formButton('Beitrag veröffentlichen'), note); panel.append(form);
  bindForm(form, note, async () => {
    const bodyText = text.input.value.trim(), file = checkedFile(picture.input);
    if (!bodyText && !file) throw new Error('Bitte einen Text schreiben oder ein Bild auswählen.');
    if (file && !staged) {
      status(note, 'Bild wird auf dem NAS gespeichert …');
      const result = await uploadImage(endpoint(profile.slug) + '/images', file);
      if (!result.image?.id) throw new Error('Der Bild-Upload konnte nicht bestätigt werden.');
      staged = result.image;
    }
    await api(endpoint(profile.slug) + '/posts', { method: 'POST', body: { text: bodyText, imageId: staged?.id || null } });
    form.reset(); staged = null; fileInfo.textContent = '';
    await loadPosts(); status(note, 'Dein Beitrag ist veröffentlicht.');
  }, 'Beitrag wird veröffentlicht …');
  return panel;
}
function imageLibrary(profile) {
  const panel = element('details', '', 'cc-panel'); panel.append(element('summary', 'Meine Bilder verwalten'));
  panel.append(element('p', 'Unbenutzte Bilder kannst du entfernen und ihren Speicherplatz wieder freigeben. Hauptporträts und Bilder in veröffentlichten Beiträgen bleiben geschützt. Die Bibliothek ist nur für die Profilbearbeitung sichtbar.', 'cc-help'));
  const note = localFeedback(), usage = element('p', '', 'cc-help'), list = element('div', '', 'cc-image-library');
  let loaded = false;
  const clear = () => { loaded = false; list.replaceChildren(); usage.textContent = ''; };
  const load = async () => {
    // An expired or changed session must not leave private thumbnails visible.
    clear();
    const result = await api(endpoint(profile.slug) + '/images'), images = requireArray(result.images);
    const countLimit = result.limits?.maxImagesPerProfile || 100, bytesLimit = result.limits?.maxProfileImageBytes || 100 * 1024 * 1024;
    const total = images.reduce((sum, image) => sum + image.size, 0);
    usage.textContent = images.length + ' von ' + countLimit + ' Bildern · ' + (total / 1024 / 1024).toFixed(2) + ' von ' + (bytesLimit / 1024 / 1024).toFixed(0) + ' MiB';
    list.replaceChildren();
    if (!images.length) list.append(element('p', 'Noch keine Bilder in dieser Profilbibliothek.', 'cc-empty'));
    for (const image of images) {
      const card = element('article', '', 'cc-library-image');
      card.append(postImage(image, profile.slug), element('strong', image.name || 'Profilbild'), element('p', (image.size / 1024 / 1024).toFixed(2) + ' MiB', 'cc-help'));
      const inUse = image.inUse || !image.canDelete;
      card.append(element('p', image.isPortrait ? 'Aktuelles Hauptporträt · nur vom Administrator änderbar' : inUse ? 'Wird im Profil verwendet · geschützt' : 'Unbenutzt · kann entfernt werden', 'cc-help'));
      const remove = button('Unbenutztes Bild entfernen', () => {
        if (!confirm('Dieses unbenutzte Bild aus der Profilbibliothek entfernen?')) return;
        void perform(note, async () => {
          try { await api(endpoint(profile.slug) + '/images/' + encodeURIComponent(image.id), { method: 'DELETE' }); }
          catch (error) { if ([401, 403].includes(error.status)) clear(); throw error; }
          await load(); status(note, 'Das unbenutzte Bild wurde entfernt. Der Bibliotheksplatz ist wieder frei.');
        }, 'Bild wird entfernt …');
      }, 'danger');
      remove.disabled = Boolean(inUse || result.storage?.online === false); card.append(remove); list.append(card);
    }
    loaded = true; status(note, storageText(result.storage));
  };
  panel.append(actions(button('Bildbibliothek aktualisieren', () => { void perform(note, load, 'Bildbibliothek wird geladen …'); })), usage, note, list);
  panel.addEventListener('toggle', () => { if (panel.open && !loaded) void perform(note, load, 'Bildbibliothek wird geladen …'); });
  return panel;
}
function renderPosts(profile, viewer) {
  const container = element('div', '', 'cc-posts'); container.id = 'communityPosts';
  const posts = requireArray(profile.posts);
  if (!posts.length) { container.append(element('p', 'Hier sind noch keine Beiträge veröffentlicht.', 'cc-empty')); return container; }
  for (const post of posts) {
    const item = element('article', '', 'cc-post'), heading = element('div', '', 'cc-post-heading'), author = element('div');
    author.append(element('strong', post.authorName || profile.name), element('span', formatDate(post.createdAt), 'cc-date'));
    heading.append(author); const note = localFeedback();
    if (post.canDelete) heading.append(button('Beitrag löschen', () => {
      if (!confirm('Diesen veröffentlichten Beitrag mit seinen Kommentaren löschen?')) return;
      void perform(note, async () => { await api('/api/community/posts/' + encodeURIComponent(post.id), { method: 'DELETE' }); await loadPosts(); status(feedback, 'Der Beitrag wurde entfernt.'); });
    }, 'danger'));
    item.append(heading);
    if (post.text) item.append(element('p', post.text, 'cc-copy'));
    if (post.image) item.append(postImage(post.image, profile.slug));
    const like = button((post.isLiked ? '♥ ' : '♡ ') + Number(post.likeCount || 0) + ' · Gefällt mir', () => {
      void perform(note, async () => {
        await api('/api/community/posts/' + encodeURIComponent(post.id) + '/like', { method: post.isLiked ? 'DELETE' : 'POST', ...(post.isLiked ? {} : { body: {} }) });
        await loadPosts(); status(feedback, post.isLiked ? 'Dein Like wurde entfernt.' : 'Dein Like wurde gespeichert.');
      });
    });
    like.setAttribute('aria-pressed', String(Boolean(post.isLiked))); like.disabled = !viewer.canInteract;
    item.append(actions(like), note);
    const comments = element('details', '', 'cc-comments');
    let records = requireArray(post.comments || []), commentsCursor = post.commentsNextCursor;
    comments.append(element('summary', Number(post.commentCount ?? records.length) + ' Kommentare'));
    const commentList = element('div');
    const drawComments = () => {
      commentList.replaceChildren();
      for (const comment of records) {
        const row = element('div', '', 'cc-comment');
        row.append(element('strong', comment.authorName), element('p', formatDate(comment.createdAt), 'cc-date'), element('p', comment.text, 'cc-copy'));
        if (comment.canDelete) row.append(actions(button('Kommentar löschen', () => {
          if (!confirm('Diesen Kommentar löschen?')) return;
          void perform(note, async () => { await api('/api/community/comments/' + encodeURIComponent(comment.id), { method: 'DELETE' }); await loadPosts(); status(feedback, 'Der Kommentar wurde entfernt.'); });
        }, 'danger')));
        commentList.append(row);
      }
    };
    const olderComments = button('Ältere Kommentare laden', () => {
      void perform(note, async () => {
        const result = await api('/api/community/posts/' + encodeURIComponent(post.id) + '/comments?before=' + encodeURIComponent(commentsCursor));
        records = mergedById(requireArray(result.comments), records); commentsCursor = result.nextCursor;
        olderComments.hidden = !commentsCursor; drawComments(); status(note, 'Ältere Kommentare geladen.');
      }, 'Kommentare werden geladen …');
    }); olderComments.hidden = !commentsCursor;
    drawComments(); comments.append(olderComments, commentList);
    if (viewer.canInteract) {
      const form = element('form', '', 'cc-form'), comment = field('Dein Kommentar', 'textarea', '', 1000), commentNote = localFeedback(); comment.input.required = true;
      form.append(comment.wrap, formButton('Kommentieren'), commentNote);
      bindForm(form, commentNote, async () => {
        if (!comment.input.value.trim()) throw new Error('Bitte einen Kommentar eingeben.');
        await api('/api/community/posts/' + encodeURIComponent(post.id) + '/comments', { method: 'POST', body: { text: comment.input.value.trim() } });
        await loadPosts(); status(feedback, 'Dein Kommentar wurde veröffentlicht.');
      }); comments.append(form);
    } else comments.append(element('p', 'Kommentieren und Likes sind freigeschalteten Teammitgliedern vorbehalten.', 'cc-help'));
    item.append(comments); container.append(item);
  }
  if (state.postsNextCursor) container.append(button('Ältere Beiträge laden', () => {
    void perform(feedback, async () => {
      const result = await api(endpoint(profileSlug) + '?before=' + encodeURIComponent(state.postsNextCursor));
      state.profile.posts = mergedById(state.profile.posts, requireArray(result.profile?.posts));
      state.viewer = result.viewer; state.postsNextCursor = result.nextCursor;
      container.replaceWith(renderPosts(state.profile, state.viewer)); status(feedback, 'Ältere Beiträge geladen.');
    }, 'Beiträge werden geladen …');
  }));
  return container;
}
async function loadPosts() {
  const previousCount = state.profile?.posts?.length || 0;
  const result = await api(endpoint(profileSlug)); state.profile = result.profile; state.viewer = result.viewer; state.postsNextCursor = result.nextCursor;
  // Keep already opened older posts reachable after liking or deleting one.
  while (state.postsNextCursor && state.profile.posts.length < previousCount) {
    const older = await api(endpoint(profileSlug) + '?before=' + encodeURIComponent(state.postsNextCursor));
    const prior = state.postsNextCursor; state.profile.posts = mergedById(state.profile.posts, requireArray(older.profile?.posts)); state.postsNextCursor = older.nextCursor;
    if (state.postsNextCursor === prior) throw new Error('Die nächste Beitragsseite konnte nicht geladen werden. Bitte aktualisieren.');
  }
  document.getElementById('communityPosts')?.replaceWith(renderPosts(result.profile, result.viewer));
}
async function loadProfile() {
  if (!people.some(person => person.slug === profileSlug)) throw new Error('Dieses Partnerprofil gibt es nicht. Bitte über die Partnerübersicht ein Profil auswählen.');
  const result = await api(endpoint(profileSlug)), profile = result.profile, viewer = result.viewer;
  if (!profile || profile.slug !== profileSlug || !viewer) throw new Error('Das Profil konnte nicht vollständig geladen werden.');
  state.profile = profile; state.viewer = viewer; state.storage = result.storage || null; state.postsNextCursor = result.nextCursor; adminLinks(viewer);
  const hero = element('section', '', 'cc-profile-hero'), copy = element('div', '', 'cc-profile-copy');
  copy.append(element('p', 'Kooperationspartner', 'cb-eyebrow'), element('h1', profile.name), element('p', profile.bio || 'Hier gibt es bald mehr über mich.', 'cc-copy'));
  const socials = socialLinks(profile.socialLinks); copy.append(socials);
  if (!socials.children.length) copy.append(element('p', 'Social-Media-Links folgen.', 'cc-help'));
  hero.append(portrait(profile), copy);
  const children = [hero];
  if (viewer.canEdit) children.push(profileEditor(profile));
  children.push(messageRequest(profile, viewer));
  if (viewer.canEdit) children.push(postComposer(profile), imageLibrary(profile));
  children.push(element('h2', 'Beiträge'));
  if (!viewer.canInteract) children.push(element('p', 'Beiträge lesen können alle. Likes und Kommentare sind für freigeschaltete Teammitglieder verfügbar.', 'cc-help'));
  children.push(renderPosts(profile, viewer));
  content.replaceChildren(...children); document.title = profile.name + ' – Kooperationspartner'; status(feedback, '');
}

function threadTitle(thread) { return thread.isRequester ? (thread.recipientName || thread.profileName) : thread.requesterName; }
function renderMessages(box, messages, thread, { admin = false } = {}) {
  box.replaceChildren();
  if (!messages.length) { box.append(element('p', 'Noch keine Nachrichten vorhanden.', 'cc-empty')); return; }
  for (const message of [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    const own = !admin && message.senderId === state.viewer?.userId;
    const sender = admin ? (message.senderName || (message.senderId === thread.requesterId ? thread.requesterName : message.senderId === thread.recipientId ? thread.recipientName : '') || 'Konto') : own ? 'Du' : threadTitle(thread);
    const row = element('article', '', 'cc-message' + (own ? ' is-own' : ''));
    row.append(element('strong', sender), element('p', message.text, 'cc-copy'), element('span', formatDate(message.createdAt), 'cc-date')); box.append(row);
  }
}
function confirmAdminChat({ title, message, confirmLabel, danger }) {
  if (document.getElementById('communityAdminConfirm')) return Promise.resolve(false);
  const trigger = document.activeElement;
  const dialog = element('dialog', '', 'cc-confirm-dialog'); dialog.id = 'communityAdminConfirm';
  const heading = element('h2', title); heading.id = 'communityAdminConfirmTitle';
  const copy = element('p', message); copy.id = 'communityAdminConfirmCopy';
  dialog.setAttribute('aria-labelledby', heading.id); dialog.setAttribute('aria-describedby', copy.id);
  const cancel = button('Abbrechen', () => dialog.close('cancel')); cancel.autofocus = true;
  const approve = button(confirmLabel, () => dialog.close('confirm'), danger ? 'danger' : '');
  dialog.append(heading, copy, actions(cancel, approve)); root.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close('cancel'); });
    dialog.addEventListener('close', () => {
      const accepted = dialog.returnValue === 'confirm'; dialog.remove();
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else refresh?.focus({ preventScroll: true });
      resolve(accepted);
    }, { once: true });
    dialog.showModal(); cancel.focus({ preventScroll: true });
  });
}

function adminChats(profiles) {
  const section = element('section', '', 'cc-panel cc-admin-chats'); section.id = 'communityChatAdmin';
  section.append(element('h2', 'Chats pro Partnerprofil verwalten'), element('p', 'Wähle ein Profil, um seine Nachrichtenanfragen und Unterhaltungen einzusehen. Die Beteiligten sehen einen Hinweis auf den Administratorzugriff. Lesezugriffe und Entscheidungen werden protokolliert.', 'cc-help'));
  const form = element('form', '', 'cc-form'), profileField = element('div', '', 'cc-chat-profile-field'), label = element('label', 'Partnerprofil auswählen'), select = element('select'); select.required = true; select.id = 'communityChatProfile'; label.htmlFor = select.id;
  const empty = element('option', 'Bitte ein Profil auswählen'); empty.value = ''; select.append(empty);
  for (const profile of profiles) { const option = element('option', profile.name); option.value = profile.slug; select.append(option); }
  select.value = profiles.some(profile => profile.slug === state.adminProfileSlug) ? state.adminProfileSlug : '';
  profileField.append(label, select); form.append(profileField, formButton('Chats laden'));
  const note = localFeedback(), layout = element('div', '', 'cc-inbox'), aside = element('aside'), list = element('div', '', 'cc-thread-list'), view = element('div', '', 'cc-thread-view');
  aside.setAttribute('aria-label', 'Unterhaltungen des ausgewählten Partnerprofils'); aside.append(list); layout.append(aside, view); section.append(form, note, layout);
  let activeSlug = '', threads = [], nextCursor = null, selectedId = null, sequence = 0;
  const base = () => '/api/admin/community/profiles/' + encodeURIComponent(activeSlug) + '/threads';
  const title = thread => (thread.requesterName || 'Anfragendes Konto') + ' → ' + (thread.recipientName || thread.profileName || 'Empfangendes Konto');
  const clear = () => { ++sequence; activeSlug = ''; threads = []; nextCursor = null; selectedId = null; list.replaceChildren(); view.replaceChildren(); };
  const prompt = () => view.replaceChildren(element('p', 'Wähle ein Profil und lade seine Chats. Öffne anschließend eine Unterhaltung.', 'cc-empty'));
  prompt();
  const drawList = () => {
    list.replaceChildren();
    if (!threads.length) list.append(element('p', 'Für dieses Profil gibt es noch keine Nachrichtenanfragen.', 'cc-empty'));
    for (const thread of threads) {
      const item = button('', () => { if (state.busy) return; selectedId = thread.id; drawList(); void perform(note, () => open(thread.id), 'Unterhaltung wird geladen …'); });
      item.className = 'cc-thread-button'; item.setAttribute('aria-pressed', String(selectedId === thread.id));
      item.append(element('strong', title(thread)), badge(thread), element('span', formatDate(thread.updatedAt), 'cc-date'));
      if (thread.adminBlocked) item.append(adminBlockBadge());
      list.append(item);
    }
    if (nextCursor) list.append(button('Ältere Unterhaltungen laden', () => {
      void perform(note, async () => {
        const cursor = nextCursor, result = await api(base() + '?before=' + encodeURIComponent(cursor));
        if (result.nextCursor && result.nextCursor === cursor) throw new Error('Die nächste Seite konnte nicht geladen werden. Bitte die Chats erneut laden.');
        threads = mergedById(threads, requireArray(result.threads)); nextCursor = result.nextCursor; drawList(); status(note, 'Ältere Unterhaltungen geladen.');
      }, 'Unterhaltungen werden geladen …');
    }));
  };
  const open = async id => {
    const token = ++sequence, path = base() + '/' + encodeURIComponent(id);
    view.replaceChildren(element('p', 'Unterhaltung wird geladen …', 'cc-empty'));
    const result = await api(path + '/messages');
    if (token !== sequence || !section.isConnected) return;
    const thread = result.thread;
    if (!thread || thread.id !== id || !Number.isSafeInteger(thread.moderationRevision)) throw new Error('Die Unterhaltung konnte nicht vollständig geladen werden. Bitte erneut laden.');
    let messages = requireArray(result.messages), cursor = result.nextCursor;
    threads = threads.map(item => item.id === id ? thread : item); drawList();
    const panel = element('section', '', 'cc-panel'), decisions = actions(), detailNote = localFeedback();
    panel.append(element('h3', title(thread)), badge(thread), element('p', 'Profil: ' + thread.profileName + ' · Anfrage vom ' + formatDate(thread.createdAt), 'cc-help'));
    if (thread.adminBlocked) panel.append(adminBlockBadge());
    panel.append(chatNotice(result.administrationNotice), element('p', 'Du liest diesen Verlauf als Administrator. Antworten im Namen der Beteiligten sind hier nicht möglich.', 'cc-help'));
    if (thread.note) panel.append(element('h4', 'Die Anfrage'), element('p', thread.note, 'cc-copy'));
    const decide = async action => {
      if (state.busy) return;
      const prompts = { approve: 'Diese Anfrage als Administrator annehmen? Danach können beide Beteiligten Nachrichten schreiben.', reject: 'Diese Anfrage als Administrator ablehnen? Neue Nachrichten sind dann nicht möglich.', block: 'Diesen Chat als Administrator sperren? Beide Beteiligten können dann weder neue Nachrichten senden noch die Anfrage bearbeiten.', unblock: 'Die Administratorsperre aufheben? Eine Ablehnung oder Blockierung durch den Empfänger bleibt bestehen. Offene Anfragen werden dadurch nicht angenommen.' };
      const labels = { approve: 'Anfrage annehmen', reject: 'Anfrage ablehnen', block: 'Chat sperren', unblock: 'Administratorsperre aufheben' };
      if (!await confirmAdminChat({ title: labels[action] + '?', message: prompts[action], confirmLabel: labels[action], danger: ['reject', 'block'].includes(action) })) return;
      if (!panel.isConnected || token !== sequence) { status(note, 'Die Unterhaltung wurde inzwischen gewechselt. Bitte erneut öffnen.', true); return; }
      void perform(detailNote, async () => {
        try { await api(path + '/decision', { method: 'POST', body: { action, expectedRevision: thread.moderationRevision } }); }
        catch (error) { if (error.status === 409) { await open(id); throw new Error('Der Chat wurde inzwischen geändert. Der aktuelle Stand ist geladen. Bitte deine Entscheidung erneut prüfen.'); } throw error; }
        await open(id);
        status(note, { approve: 'Die Anfrage wurde angenommen.', reject: 'Die Anfrage wurde abgelehnt.', block: 'Die Administratorsperre ist aktiv.', unblock: 'Die Administratorsperre wurde aufgehoben. Der ursprüngliche Anfragestatus bleibt erhalten.' }[action]);
      }, 'Entscheidung wird gespeichert …');
    };
    if (thread.canApprove) decisions.append(button('Anfrage annehmen', () => decide('approve'), ''));
    if (thread.canReject) decisions.append(button('Anfrage ablehnen', () => decide('reject')));
    if (thread.canBlock) decisions.append(button('Chat sperren', () => decide('block'), 'danger'));
    if (thread.canUnblock) decisions.append(button('Administratorsperre aufheben', () => decide('unblock')));
    if (decisions.children.length) panel.append(decisions);
    if (thread.adminBlocked) panel.append(element('p', 'Die Administratorsperre verhindert das Senden und Bearbeiten der Anfrage für beide Beteiligten.', 'cc-help'));
    panel.append(detailNote, element('h4', 'Nachrichtenverlauf'));
    const box = element('div', '', 'cc-messages'); box.setAttribute('aria-label', 'Nachrichtenverlauf in der Administration'); renderMessages(box, messages, thread, { admin: true });
    const more = button('Ältere Nachrichten laden', () => {
      void perform(detailNote, async () => {
        const previous = cursor, older = await api(path + '/messages?before=' + encodeURIComponent(previous));
        if (token !== sequence || !panel.isConnected) return;
        if (older.nextCursor && older.nextCursor === previous) throw new Error('Der ältere Verlauf konnte nicht geladen werden. Bitte die Unterhaltung erneut öffnen.');
        messages = mergedById(requireArray(older.messages), messages); cursor = older.nextCursor; more.hidden = !cursor; renderMessages(box, messages, thread, { admin: true }); status(detailNote, 'Ältere Nachrichten geladen.');
      }, 'Nachrichten werden geladen …');
    }); more.hidden = !cursor;
    panel.append(more, box); view.replaceChildren(panel); status(note, 'Unterhaltung geladen. Administratorzugriff wird protokolliert.');
  };
  select.addEventListener('change', () => { clear(); state.adminProfileSlug = select.value || null; prompt(); status(note, ''); });
  bindForm(form, note, async () => {
    clear(); activeSlug = select.value;
    if (!profiles.some(profile => profile.slug === activeSlug)) throw new Error('Bitte ein Partnerprofil auswählen.');
    state.adminProfileSlug = activeSlug;
    const result = await api(base()); threads = requireArray(result.threads); nextCursor = result.nextCursor;
    drawList(); view.replaceChildren(element('p', 'Wähle eine Unterhaltung, um die Anfrage und ihren Nachrichtenverlauf zu öffnen.', 'cc-empty'));
    status(note, 'Chats für ' + profiles.find(profile => profile.slug === activeSlug).name + ' geladen.');
  }, 'Chats werden geladen …');
  return section;
}

function adminAccounts(accounts, profiles) {
  const section = element('section', '', 'cc-panel'); section.append(element('h2', 'Konten & Teamrechte'), element('p', 'Teammitglieder dürfen kommentieren und liken. Ein zugeordnetes Profil können sie selbst beschreiben und mit Beiträgen füllen. Administratoren haben diese Rechte ebenfalls.', 'cc-help'));
  const search = field('Konten durchsuchen', 'search', '', 254), list = element('div', '', 'cc-admin-list'); search.input.placeholder = 'Name oder E-Mail';
  const searchForm = element('div', '', 'cc-form'); searchForm.append(search.wrap); section.append(searchForm, list);
  const draw = () => {
    const filter = search.input.value.trim().toLocaleLowerCase('de-DE'); list.replaceChildren();
    for (const account of accounts.filter(item => (item.name + ' ' + item.email).toLocaleLowerCase('de-DE').includes(filter))) {
      const row = element('article', '', 'cc-admin-account'); row.append(element('h3', account.name), element('p', account.email), element('p', account.suspended ? 'Konto gesperrt' : account.confirmed ? 'E-Mail bestätigt' : 'E-Mail noch nicht bestätigt', 'cc-help'));
      const owned = profiles.filter(profile => profile.ownerId === account.id); if (owned.length) row.append(element('p', 'Zugeordnet: ' + owned.map(profile => profile.name).join(', '), 'cc-help'));
      if (account.isAdmin) row.append(element('p', 'Administrator · Teamrechte vorhanden', 'cc-help'));
      const form = element('form', '', 'cc-form'), label = element('label', '', 'cc-check'), check = element('input'); check.type = 'checkbox'; check.checked = Boolean(account.isTeam); check.disabled = Boolean(account.suspended || !account.confirmed || account.isAdmin);
      label.append(check, element('span', 'Teammitglied')); const submit = formButton('Teamrecht speichern'); submit.disabled = check.disabled;
      const note = localFeedback(); form.append(label, submit, note); row.append(form);
      bindForm(form, note, async () => {
        await api('/api/admin/community/team/' + encodeURIComponent(account.id), { method: 'PATCH', body: { enabled: check.checked } });
        await loadAdmin(); status(feedback, 'Die Teamrechte wurden gespeichert.');
      }); list.append(row);
    }
    if (!list.children.length) list.append(element('p', 'Keine passenden Konten gefunden.', 'cc-empty'));
  };
  search.input.addEventListener('input', draw); draw(); return section;
}
function adminProfile(profile, accounts) {
  const panel = element('section', '', 'cc-panel'); panel.append(element('h3', profile.name), portrait(profile), link('Öffentliches Profil öffnen ↗', 'profile.html?person=' + profile.slug));
  panel.append(actions(button('Chats dieses Profils verwalten', () => {
    if (state.busy) return;
    const select = document.getElementById('communityChatProfile');
    select.value = profile.slug; select.dispatchEvent(new Event('change')); select.form.requestSubmit();
    document.getElementById('communityChatAdmin').scrollIntoView({ block: 'start' }); select.focus({ preventScroll: true });
  })));
  const form = element('form', '', 'cc-form'), label = element('label', 'Profil einem Konto zuordnen'), select = element('select');
  const blank = element('option', 'Noch keinem Konto zugeordnet'); blank.value = ''; select.append(blank);
  for (const account of accounts.filter(account => account.confirmed && !account.suspended && (account.isTeam || account.isAdmin))) {
    const option = element('option', account.name + ' · ' + account.email); option.value = account.id; select.append(option);
  }
  if (profile.ownerId && ![...select.options].some(item => item.value === profile.ownerId)) {
    const account = accounts.find(item => item.id === profile.ownerId), unavailable = element('option', (account?.name || 'Bisheriges Konto') + ' · nicht freigeschaltet');
    unavailable.value = profile.ownerId; unavailable.disabled = true; select.append(unavailable);
  }
  select.value = profile.ownerId || ''; label.append(select); const note = localFeedback(); form.append(label, element('p', 'Zuerst Teamrechte aktivieren. Eine Neuzuordnung überträgt die Profilbearbeitung; Unterhaltungen bleiben ihren bisherigen Teilnehmern zugeordnet. Administratoren können sie in der Chatverwaltung einsehen.', 'cc-help'), formButton('Zuordnung speichern'), note); panel.append(form);
  bindForm(form, note, async () => {
    await api('/api/admin/community/profiles/' + profile.slug, { method: 'PATCH', body: { ownerId: select.value || null } });
    await loadAdmin(); status(feedback, 'Die Profilzuordnung wurde gespeichert.');
  });
  const upload = element('form', '', 'cc-form'), image = imageField(), uploadNote = localFeedback(); image.wrap.firstChild.textContent = 'Hauptporträt auswählen'; image.input.required = true;
  const submit = formButton('Hauptporträt speichern'); image.input.disabled = submit.disabled = state.storage?.online === false;
  upload.append(image.wrap, imageHelp(), submit, uploadNote); panel.append(upload);
  bindForm(upload, uploadNote, async () => {
    const file = checkedFile(image.input); if (!file) throw new Error('Bitte ein Hauptporträt auswählen.');
    await uploadImage('/api/admin/community/profiles/' + profile.slug + '/portrait', file);
    await loadAdmin(); status(feedback, 'Das Hauptporträt wurde gespeichert und ist jetzt öffentlich sichtbar.');
  }, 'Hauptporträt wird auf dem NAS gespeichert …');
  return panel;
}
async function loadAdmin() {
  content.replaceChildren(element('p', 'Administrator-Rechte werden geprüft …', 'cc-empty'));
  const session = await getSession();
  if (!session.user?.isAdmin || !session.user.confirmed || session.user.suspended) { gate('Diese Seite benötigt dein bestätigtes Administratorkonto.'); status(feedback, 'Zugriff nur für Administratoren.'); return; }
  const result = await api('/api/admin/community'), accounts = requireArray(result.accounts), profiles = requireArray(result.profiles);
  state.storage = result.storage || null;
  const description = element('section', '', 'cc-panel'); description.append(element('h2', 'Hauptporträts & Profilzuordnung'), element('p', 'Die Hauptporträts kannst nur du als Administrator ändern. Ohne Foto bleibt die Initialenfläche sichtbar.'), element('p', storageText(state.storage), 'cc-help'));
  const grid = element('div', '', 'cc-admin-profiles');
  for (const person of people) {
    const profile = profiles.find(item => item.slug === person.slug); if (!profile) throw new Error('Ein Partnerprofil fehlt in der Verwaltung.');
    grid.append(adminProfile(profile, accounts));
  }
  content.replaceChildren(adminAccounts(accounts, profiles), adminChats(profiles), description, grid); status(feedback, 'Du bist als Administrator angemeldet. Änderungen werden direkt gespeichert.');
}

if (root && page === 'inbox') {
  void initPrivateChat({ root, content, feedback, refresh });
} else if (root) {
  const load = { home: loadHome, profile: loadProfile, admin: loadAdmin }[page];
  if (load) {
    refresh?.addEventListener('click', () => { void perform(feedback, load, 'Wird aktualisiert …'); });
    void perform(feedback, load, page === 'admin' ? 'Administrator-Rechte werden geprüft …' : 'Wird geladen …');
  }
}
