import { api, getSession, errorText } from './account-client.js';

const $ = id => document.getElementById(id);
const SPEC_LABELS = { cpu: 'Prozessor', gpu: 'Grafikkarte', ram: 'Arbeitsspeicher', storage: 'Speicher / SSD', mainboard: 'Mainboard', cooling: 'Kühlung', case: 'Gehäuse', monitor: 'Monitor / Fernseher', peripherals: 'Geräte & Zubehör' };
const STATUS_LABELS = { draft: 'Privater Entwurf', pending: 'Wartet auf Freigabe', published: 'Veröffentlicht', hidden: 'Vom Team ausgeblendet', withdrawn: 'Zurückgezogen' };
const DEFAULT_LIMITS = { title: 100, description: 2000, spec: 160, maxImages: 4, maxImageBytes: 8 * 1024 * 1024, maxUploads: 20 };
const SETUP_LINK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const form = $('gs-form'), fields = $('gs-edit-fields');
let viewer = null, privateState = null, selectedImageIds = [], galleryEntries = [], generation = 0, galleryGeneration = 0, busy = false, dirty = false, detailOpener = null;
let cleanupGalleryMedia = () => {};

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}
function status(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('is-error', kind === 'error');
  node.classList.toggle('is-success', kind === 'success');
}
function safeImageUrl(value, privateImage = false) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, location.origin);
    const prefix = privateImage ? '/api/account/gaming-setup/images/' : '/api/gaming-setups/images/';
    return url.origin === location.origin && url.pathname.startsWith(prefix) && !url.username && !url.password && !url.hash ? url.href : '';
  } catch { return ''; }
}
function safeDiscordUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'discord.com' && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/channels\/\d{17,20}\/\d{17,20}(?:\/\d{17,20})?$/.test(url.pathname) ? url.href : '';
  } catch { return ''; }
}
function photo(value, alt, privateImage = false) {
  const src = safeImageUrl(value, privateImage);
  if (!src) return null;
  const img = element('img');
  img.src = src; img.alt = alt; img.loading = 'lazy'; img.decoding = 'async';
  img.addEventListener('error', () => {
    const message = element('div', 'gs-card-placeholder', 'Bild gerade nicht verfügbar');
    img.replaceWith(message);
  }, { once: true });
  return img;
}
function date(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}
function limits() { return { ...DEFAULT_LIMITS, ...(privateState?.limits || {}) }; }
function markDirty() { dirty = true; status('gs-save-status', 'Ungespeicherte Änderungen.'); }
function current(epoch, userId) { return epoch === generation && viewer?.id === userId; }
function hasPublicVersion(setup) {
  return !!(setup?.hasPublicVersion || setup?.published || setup?.status === 'published');
}
function setBusy(value) {
  busy = value; fields.disabled = value;
  $('gs-refresh-own').disabled = value;
  $('gs-withdraw').disabled = value;
  $('gs-publish').disabled = value || !privateState?.enabled;
}
function resetPrivate() {
  form.reset(); form.hidden = true; privateState = null; selectedImageIds = []; dirty = false;
  $('gs-images').replaceChildren(); $('gs-discord-status').replaceChildren(); $('gs-discord-status').hidden = true;
  $('gs-withdraw-row').hidden = true; $('gs-signin').hidden = true;
  $('gs-author').textContent = ''; status('gs-save-status', ''); status('gs-upload-status', '');
  if ($('gs-confirm').open) $('gs-confirm').close();
  setBusy(false);
}
function renderDiscordStatus() {
  const box = $('gs-discord-status'), setup = privateState?.setup;
  box.replaceChildren(); box.hidden = !setup;
  if (!setup) return;
  const redaction = setup.discordOperation === 'redact';
  const messages = {
    none: setup.status === 'pending' ? 'Discord: Dein Beitrag wartet auf die Freigabe des Teams.' : 'Discord: Noch kein bestätigter Beitrag.',
    queued: redaction ? 'Discord: Die Rücknahme eines vorhandenen Bot-Beitrags ist vorgemerkt.' : 'Discord: Die Veröffentlichung ist vorgemerkt.',
    sending: redaction ? 'Discord: Ein vorhandener Bot-Beitrag wird gerade zurückgezogen.' : 'Discord: Dein Beitrag wird gerade übertragen.',
    sent: redaction ? 'Discord: Kein aktiver Bot-Beitrag zu diesem Setup. Eventuelle Antworten anderer Mitglieder bleiben erhalten.' : 'Discord: Die Übertragung wurde bestätigt.',
    failed: redaction ? 'Discord: Die Rücknahme ist fehlgeschlagen. Bitte das Team um Prüfung im Control Center bitten.' : 'Discord: Die Übertragung ist fehlgeschlagen. Dein Entwurf bleibt erhalten. Das Team kann den Versand im Control Center prüfen.',
    uncertain: redaction ? 'Discord: Die Rücknahme konnte noch nicht bestätigt werden. Bitte das Team um Prüfung bitten.' : 'Discord: Es ist noch unklar, ob die Übertragung angekommen ist. Es wird nichts automatisch doppelt gesendet. Bitte das Team um Prüfung bitten.'
  };
  box.append(element('strong', '', 'Stand deines Beitrags'), element('p', '', messages[setup.discordStatus] || 'Discord: Der Versandstatus ist noch nicht bekannt.'));
  const url = safeDiscordUrl(setup.discordUrl);
  if (url) { const link = element('a', '', 'Beitrag in Discord öffnen ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; box.append(link); }
  box.append(element('p', 'gs-small', 'Nach einer kurzen Wartezeit kannst du mit „Gespeicherten Stand laden“ den aktuellen Versandstatus abrufen.'));
}
function renderImages() {
  const container = $('gs-images'); container.replaceChildren();
  const all = Array.isArray(privateState?.images) ? privateState.images : [];
  const ordered = [...all].sort((a, b) => {
    const ai = selectedImageIds.indexOf(a.id), bi = selectedImageIds.indexOf(b.id);
    return ai < 0 ? bi < 0 ? 0 : 1 : bi < 0 ? -1 : ai - bi;
  });
  for (const image of ordered) {
    if (typeof image?.id !== 'string') continue;
    const index = selectedImageIds.indexOf(image.id), card = element('div', `gs-image-choice${index >= 0 ? ' selected' : ''}`);
    const img = photo(image.url, image.name || 'Dein Setup-Foto', true);
    if (img) card.append(img);
    const label = element('label'), checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = index >= 0;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selectedImageIds.length >= limits().maxImages) {
        checkbox.checked = false; status('gs-upload-status', `Bitte höchstens ${limits().maxImages} Bilder auswählen.`, 'error'); return;
      }
      selectedImageIds = checkbox.checked ? [...selectedImageIds, image.id] : selectedImageIds.filter(id => id !== image.id);
      markDirty(); renderImages();
    });
    label.append(checkbox, element('span', '', image.name || 'Setup-Foto')); card.append(label);
    if (index >= 0) {
      const order = element('div', 'gs-image-order'); order.append(element('span', '', index === 0 ? 'Titelbild' : `Bild ${index + 1}`));
      if (index > 0) {
        const earlier = element('button', '', '←'); earlier.type = 'button'; earlier.setAttribute('aria-label', `${image.name || 'Bild'} nach vorn verschieben`);
        earlier.addEventListener('click', () => { [selectedImageIds[index - 1], selectedImageIds[index]] = [selectedImageIds[index], selectedImageIds[index - 1]]; markDirty(); renderImages(); });
        order.append(earlier);
      }
      card.append(order);
    }
    container.append(card);
  }
  $('gs-photo-count').textContent = `${selectedImageIds.length} / ${limits().maxImages} Bilder ausgewählt · ${all.length} / ${limits().maxUploads} Bilder hochgeladen`;
}
function acceptPrivate(result) {
  if (!result || result.user?.id !== viewer?.id || !Array.isArray(result.images) || !Object.hasOwn(result, 'setup')) throw new Error('Dein Setup konnte nicht eindeutig deinem Konto zugeordnet werden. Bitte neu anmelden.');
  privateState = result;
  const setup = result.setup;
  $('gs-author').textContent = result.user.name || viewer.name;
  $('gs-publication-state').textContent = STATUS_LABELS[setup?.status] || 'Noch kein Beitrag';
  $('gs-policy').textContent = !result.enabled ? 'Neue Veröffentlichungen sind gerade pausiert. Deinen Entwurf kannst du weiter bearbeiten.' : result.publicationPolicy === 'review' ? 'Das Team prüft neue Beiträge und eingereichte Änderungen. Erst nach der Freigabe erscheinen sie auf der Website und in Discord. Beim erneuten Einreichen wird dein bisheriger Beitrag bis zur Freigabe ausgeblendet.' : 'Nach deiner Bestätigung erscheint dein Setup auf der Website. Der Discord-Beitrag wird anschließend automatisch erstellt oder aktualisiert.';
  $('gs-publish').textContent = result.publicationPolicy === 'review' ? 'Zur Freigabe einreichen' : 'Auf Website & Discord veröffentlichen';
  $('gs-setup-title').value = setup?.title || '';
  $('gs-description').value = setup?.description || '';
  for (const key of Object.keys(SPEC_LABELS)) form.elements.namedItem(key).value = setup?.specs?.[key] || '';
  const owned = new Set(result.images.map(image => image.id));
  const selected = setup?.imageIds || setup?.images?.map(image => image.id) || [];
  selectedImageIds = [...new Set(selected)].filter(id => owned.has(id)).slice(0, limits().maxImages);
  $('gs-consent').checked = false;
  $('gs-withdraw-row').hidden = !setup || !(hasPublicVersion(setup) || setup.status === 'pending' || ['queued', 'sending', 'sent', 'uncertain'].includes(setup.discordStatus));
  $('gs-photo-help').textContent = `Bis zu ${limits().maxImages} Bilder für deinen Beitrag · JPG, PNG oder WebP · jeweils höchstens ${Math.floor(limits().maxImageBytes / 1024 / 1024)} MiB.`;
  form.hidden = false; $('gs-signin').hidden = true; dirty = false; renderImages(); renderDiscordStatus(); setBusy(busy);
}
async function loadAccount() {
  const epoch = ++generation; viewer = null; resetPrivate(); status('gs-account-status', 'Deine Anmeldung wird geprüft …');
  try {
    const session = await getSession(); if (epoch !== generation) return;
    viewer = session.user;
    if (!viewer) { $('gs-signin').hidden = false; status('gs-account-status', 'Melde dich an, um dein eigenes Setup vorzustellen.'); return; }
    if (!viewer.confirmed || viewer.suspended) { $('gs-signin').hidden = false; status('gs-account-status', viewer.suspended ? 'Dieses Konto ist gesperrt. Bitte wende dich an das Team.' : 'Bitte bestätige zuerst deine E-Mail-Adresse.', 'error'); return; }
    const userId = viewer.id; const result = await api('/api/account/gaming-setup');
    if (!current(epoch, userId)) return;
    acceptPrivate(result); status('gs-account-status', `Angemeldet als ${result.user.name || viewer.name}.`);
  } catch (error) { if (epoch === generation) { form.hidden = true; if (error.status === 401) { viewer = null; $('gs-signin').hidden = false; } status('gs-account-status', errorText(error), 'error'); } }
}
function requestBody(publish) {
  const specs = Object.fromEntries(Object.keys(SPEC_LABELS).map(key => [key, form.elements.namedItem(key).value.trim()]));
  return { expectedRevision: privateState?.setup?.revision || 0, title: $('gs-setup-title').value.trim(), description: $('gs-description').value.trim(), specs, imageIds: [...selectedImageIds], publish, consent: publish && $('gs-consent').checked };
}
async function save(event) {
  event.preventDefault();
  if (busy || !viewer || !privateState) return;
  const publish = event.submitter?.value === 'publish';
  if (publish && !privateState.enabled) { status('gs-save-status', 'Neue Veröffentlichungen sind gerade pausiert.', 'error'); return; }
  if (publish && !$('gs-consent').checked) { status('gs-save-status', 'Bitte bestätige zuerst, dass diese Angaben und Bilder öffentlich auf Website und Discord erscheinen dürfen.', 'error'); $('gs-consent').focus(); return; }
  if (!form.reportValidity()) return;
  const body = requestBody(publish), epoch = generation, userId = viewer.id;
  setBusy(true); status('gs-save-status', publish ? 'Dein Beitrag wird eingereicht …' : 'Dein Entwurf wird gespeichert …');
  try {
    const result = await api('/api/account/gaming-setup', { method: 'PUT', body });
    if (!current(epoch, userId)) return;
    acceptPrivate(result);
    status('gs-save-status', publish ? result.setup?.status === 'pending' ? 'Eingereicht. Dein Beitrag wartet jetzt auf die Freigabe des Teams.' : 'Auf der Website veröffentlicht. Den Discord-Versandstatus findest du darunter.' : 'Privater Entwurf gespeichert. Ein vorhandener öffentlicher Beitrag bleibt unverändert.', 'success');
    if (publish) await loadGallery();
  } catch (error) {
    if (current(epoch, userId) && error.status === 401) { loadAccount(); return; }
    if (current(epoch, userId)) status('gs-save-status', ['TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE'].includes(error.code) ? 'Die Speicherung konnte nicht bestätigt werden. Bitte zuerst den gespeicherten Stand laden und prüfen, bevor du erneut veröffentlichst.' : errorText(error), 'error');
  } finally { if (current(epoch, userId)) setBusy(false); }
}
async function upload(event) {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length || busy || !viewer || !privateState) return;
  const rules = limits();
  if (files.length + privateState.images.length > rules.maxUploads) { status('gs-upload-status', `Du kannst insgesamt höchstens ${rules.maxUploads} Bilder hochladen.`, 'error'); return; }
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > rules.maxImageBytes) { status('gs-upload-status', `„${file.name}“ ist kein unterstütztes Bild bis ${Math.floor(rules.maxImageBytes / 1024 / 1024)} MiB. Bitte JPG, PNG oder WebP wählen.`, 'error'); return; }
  }
  const epoch = generation, userId = viewer.id; setBusy(true); let added = 0;
  try {
    for (const [index, file] of files.entries()) {
      if (!current(epoch, userId)) return;
      status('gs-upload-status', `Bild ${index + 1} von ${files.length} wird hochgeladen …`);
      const result = await api('/api/account/gaming-setup/images', { method: 'POST', raw: true, body: file, timeout: 60000, headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) } });
      if (!current(epoch, userId)) return;
      if (typeof result.image?.id !== 'string' || !safeImageUrl(result.image.url, true)) throw new Error('Der Server hat das hochgeladene Bild nicht eindeutig bestätigt. Bitte den gespeicherten Stand neu laden.');
      privateState.images = [...privateState.images.filter(image => image.id !== result.image.id), result.image];
      if (!selectedImageIds.includes(result.image.id) && selectedImageIds.length < rules.maxImages) selectedImageIds.push(result.image.id);
      added++; markDirty(); renderImages();
    }
    status('gs-upload-status', `${added} ${added === 1 ? 'Bild hochgeladen' : 'Bilder hochgeladen'}. Speichere deinen Entwurf oder bestätige die Veröffentlichung.`, 'success');
  } catch (error) { if (current(epoch, userId) && error.status === 401) { loadAccount(); return; } if (current(epoch, userId)) status('gs-upload-status', `${added ? `${added} Bilder wurden bereits hochgeladen. ` : ''}${errorText(error)}`, 'error'); }
  finally { if (current(epoch, userId)) setBusy(false); }
}
async function withdraw() {
  if (busy || !viewer || !privateState?.setup) return;
  $('gs-confirm').close(); const epoch = generation, userId = viewer.id, expectedRevision = privateState.setup.revision;
  setBusy(true); status('gs-save-status', 'Die Veröffentlichung wird zurückgezogen …');
  try {
    const result = await api('/api/account/gaming-setup/withdraw', { method: 'POST', body: { expectedRevision } });
    if (!current(epoch, userId)) return;
    acceptPrivate(result); status('gs-save-status', 'Aus der öffentlichen Website-Galerie zurückgezogen. Der Discord-Stand wird darunter angezeigt.', 'success'); await loadGallery();
  } catch (error) { if (current(epoch, userId) && error.status === 401) { loadAccount(); return; } if (current(epoch, userId)) status('gs-save-status', errorText(error), 'error'); }
  finally { if (current(epoch, userId)) setBusy(false); }
}
function setupCard(setup) {
  const card = element('article', 'gs-card');
  const cover = setup.images?.[0], img = cover && photo(cover.url, `${setup.title || 'Gaming-Setup'} von ${setup.authorName || 'einem Community-Mitglied'}`);
  if (img) { img.className = 'gs-card-cover'; card.append(img); }
  else { const placeholder = element('div', 'gs-card-placeholder'); placeholder.append(element('span', '', '⌘'), element('small', '', 'Ein Platz für Gaming')); card.append(placeholder); }
  const body = element('div', 'gs-card-body');
  body.append(element('span', 'gs-card-author', setup.authorName || 'Community-Mitglied'), element('h3', '', setup.title || 'Gaming-Setup'));
  if (setup.description) body.append(element('p', 'gs-card-description', setup.description));
  const tags = element('div', 'gs-card-tags');
  for (const key of ['cpu', 'gpu']) if (setup.specs?.[key]) tags.append(element('span', '', setup.specs[key]));
  if (tags.childNodes.length) body.append(tags);
  const button = element('button', 'cb-button', 'Setup ansehen ↗'); button.type = 'button'; button.addEventListener('click', () => openDetail(setup, button)); body.append(button); card.append(body); return card;
}
function emptyCommunityStage() {
  const stage = element('div', 'gs-empty gs-empty-stage');
  const media = element('figure', 'gs-stage-media'), video = element('video');
  video.src = '/assets/control/gaming-setups-header.mp4';
  video.poster = '/assets/control/gaming-setups-header.jpg';
  video.controls = true; video.muted = true; video.defaultMuted = true; video.loop = true; video.playsInline = true; video.preload = 'none';
  video.width = 1440; video.height = 480;
  video.setAttribute('aria-label', 'Crazy_Batto Community-Header – Video abspielen oder pausieren');
  media.append(video);
  const copy = element('div', 'gs-stage-copy');
  copy.append(element('p', 'cb-eyebrow', 'DEINE HARDWARE. DEIN STIL. DEINE COMMUNITY.'), element('h3', '', 'Dein Setup verdient diesen Platz.'), element('p', '', 'Hier startet eure Setup-Galerie. Zeig uns deinen Gaming-PC, deine Konsole oder deinen Schreibtisch – mit Bildern und den Details, die ihn besonders machen. Nach der Freigabe durch das Team erscheint dein Beitrag unter deinem Namen auf der Website und in Discord.'));
  const actions = element('div', 'gs-stage-actions'), submit = element('a', 'cb-button cb-button-gold', 'Mein Setup einreichen ↗');
  submit.href = '#mein-setup'; actions.append(submit); copy.append(actions);
  copy.append(element('p', 'gs-small', 'Noch kein Konto? Registriere dich auf crazybatto.de, bestätige deine E-Mail und warte auf die Mitgliederfreigabe.'));
  stage.append(media, copy);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let observer;
  const pauseForPreference = () => { if (motion.matches) video.pause(); };
  const pauseHidden = () => { if (document.hidden) video.pause(); };
  motion.addEventListener('change', pauseForPreference);
  document.addEventListener('visibilitychange', pauseHidden);
  if (!motion.matches && !navigator.connection?.saveData && typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(entries => {
      if (motion.matches || document.hidden || !entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      // One automatic start only: a visitor's later pause is respected.
      video.play().catch(() => {});
    }, { threshold: 0.25 });
    observer.observe(video);
  }
  cleanupGalleryMedia = () => { observer?.disconnect(); video.pause(); video.removeAttribute('src'); video.load(); motion.removeEventListener('change', pauseForPreference); document.removeEventListener('visibilitychange', pauseHidden); };
  return stage;
}
function renderGallery() {
  cleanupGalleryMedia(); cleanupGalleryMedia = () => {};
  const query = $('gs-search').value.trim().toLocaleLowerCase('de-DE');
  const entries = galleryEntries.filter(setup => [setup.authorName, setup.title, setup.description, ...Object.values(setup.specs || {})].filter(value => typeof value === 'string').join(' ').toLocaleLowerCase('de-DE').includes(query));
  const gallery = $('gs-gallery'); gallery.replaceChildren();
  $('gs-gallery-count').textContent = `${entries.length} ${entries.length === 1 ? 'Setup' : 'Setups'}${query ? ` von ${galleryEntries.length}` : ''}`;
  if (!entries.length) {
    if (!query && !galleryEntries.length) gallery.append(emptyCommunityStage());
    else { const empty = element('div', 'gs-empty'); empty.append(element('span', '', '⌕'), element('h3', '', 'Noch kein passendes Setup gefunden'), element('p', '', 'Versuche einen anderen Namen oder eine andere Komponente.')); gallery.append(empty); }
    return;
  }
  for (const setup of entries) gallery.append(setupCard(setup));
}
async function loadGallery() {
  const epoch = ++galleryGeneration; $('gs-refresh-gallery').disabled = true; status('gs-gallery-status', 'Die Setups werden geladen …');
  try {
    const result = await api('/api/gaming-setups');
    if (epoch !== galleryGeneration) return;
    if (!Array.isArray(result.setups)) throw new Error('Die Galerie hat keine gültige Antwort geliefert. Bitte später erneut laden.');
    galleryEntries = result.setups.filter(setup => setup && typeof setup.id === 'string'); renderGallery(); status('gs-gallery-status', '');
  } catch (error) { if (epoch === galleryGeneration) status('gs-gallery-status', errorText(error), 'error'); }
  finally { if (epoch === galleryGeneration) $('gs-refresh-gallery').disabled = false; }
}
function openDetail(setup, opener = null) {
  detailOpener = opener; const content = $('gs-detail-content'); content.replaceChildren();
  content.append(element('span', 'gs-eyebrow', setup.authorName || 'Community-Mitglied'));
  const title = element('h2', '', setup.title || 'Gaming-Setup'); title.id = 'gs-detail-title'; content.append(title);
  if (setup.description) content.append(element('p', '', setup.description));
  const photos = element('div', 'gs-detail-images');
  for (const [index, image] of (setup.images || []).entries()) { const img = photo(image.url, `${setup.title || 'Setup'}, Bild ${index + 1}`); if (img) photos.append(img); }
  if (photos.childNodes.length) content.append(photos);
  const specs = element('dl', 'gs-detail-specs');
  for (const [key, label] of Object.entries(SPEC_LABELS)) if (setup.specs?.[key]) { const pair = element('div'); pair.append(element('dt', '', label), element('dd', '', setup.specs[key])); specs.append(pair); }
  if (specs.childNodes.length) content.append(specs);
  const updated = date(setup.updatedAt); if (updated) content.append(element('p', 'gs-small', `Zuletzt aktualisiert: ${updated}`));
  const url = safeDiscordUrl(setup.discordUrl);
  if (url) { const link = element('a', 'gs-detail-link', 'In Discord ansehen ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link); }
  if (!$('gs-detail').open) $('gs-detail').showModal();
}
async function openLinkedSetup() {
  const hashId = /^#setup-([a-zA-Z0-9_-]{1,90})$/.exec(location.hash)?.[1];
  const linkedId = hashId || (!location.hash ? new URLSearchParams(location.search).get('setup') : '');
  // Page anchors such as #setup-galerie are navigation, not public setup IDs.
  if (!linkedId || !SETUP_LINK_ID.test(linkedId)) return;
  const id = linkedId.toLowerCase();
  const existing = galleryEntries.find(setup => setup.id === id); if (existing) { openDetail(existing); return; }
  try { const result = await api('/api/gaming-setups/' + encodeURIComponent(id)); if (result.setup?.id === id) openDetail(result.setup); }
  catch (error) { status('gs-gallery-status', 'Dieses Setup ist nicht öffentlich verfügbar. ' + errorText(error), 'error'); }
}

form.addEventListener('submit', save);
form.addEventListener('input', event => { if (event.target !== $('gs-files') && event.target !== $('gs-consent')) markDirty(); });
$('gs-files').addEventListener('change', upload);
$('gs-search').addEventListener('input', renderGallery);
$('gs-refresh-gallery').addEventListener('click', loadGallery);
$('gs-refresh-own').addEventListener('click', () => { if (!busy && (!dirty || window.confirm('Deine ungespeicherten Änderungen werden durch den gespeicherten Stand ersetzt. Neu laden?'))) loadAccount(); });
$('gs-withdraw').addEventListener('click', () => { if (!busy) { $('gs-confirm').showModal(); $('gs-cancel-withdraw').focus(); } });
$('gs-cancel-withdraw').addEventListener('click', () => $('gs-confirm').close());
$('gs-confirm-withdraw').addEventListener('click', withdraw);
$('gs-close-detail').addEventListener('click', () => $('gs-detail').close());
$('gs-detail').addEventListener('close', () => detailOpener?.focus());
window.addEventListener('cb-account-changed', loadAccount);
window.addEventListener('storage', event => { if (event.key === 'cb-account-change') loadAccount(); });
window.addEventListener('hashchange', openLinkedSetup);
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
loadAccount();
loadGallery().then(openLinkedSetup);
