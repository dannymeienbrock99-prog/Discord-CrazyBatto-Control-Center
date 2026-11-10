import { api, getSession, errorText } from './account-client.js';
import { element, imageFrame, readCatalog } from './products.js';

const $ = id => document.getElementById(id);
const root = $('productsAdmin');
const endpoint = '/api/admin/products';
let catalog = null, identity = null, generation = 0;
let busy = false, dirty = false, conflict = false, uncertain = false;

function message(text, error = false) {
  $('productsAdminStatus').textContent = text;
  $('productsAdminStatus').classList.toggle('is-error', error);
}
function clearPrivate() {
  catalog = null; identity = null; dirty = false; conflict = false; uncertain = false;
  $('productsEntries').replaceChildren(); $('productsLinks').replaceChildren();
  $('productsEditor').hidden = true; $('productsAdminCount').textContent = '';
}
function gate(text) {
  clearPrivate(); $('productsGate').hidden = false;
  $('productsGateText').textContent = text || 'Melde dich mit deinem bestätigten Administratorkonto an, um Produkte zu bearbeiten.';
}
function syncControls() {
  root.setAttribute('aria-busy', String(busy));
  root.querySelectorAll('button,input,textarea').forEach(control => { control.disabled = busy; });
  $('productsSave').disabled = busy || !catalog || !dirty || conflict || uncertain;
  $('productsAdd').disabled = busy || !catalog || catalog.products.length >= 100;
  catalog?.products.forEach((product, index) => {
    const row = document.getElementById(`edit-product-${product.id}`);
    if (!row) return;
    row.querySelector('[data-move="-1"]').disabled = busy || index === 0;
    row.querySelector('[data-move="1"]').disabled = busy || index === catalog.products.length - 1;
    row.querySelector('[data-remove-image]').disabled = busy || !product.imageId;
  });
  $('productsDraftState').textContent = uncertain
    ? 'Die Speicherbestätigung fehlt. Lade den gespeicherten Stand, bevor du weitere Änderungen speicherst.'
    : conflict
    ? 'Der gespeicherte Stand wurde inzwischen geändert. Deine Eingaben bleiben hier erhalten. Bitte den aktuellen Stand neu laden.'
    : dirty
    ? 'Ungespeicherte Änderungen. Erst „Änderungen speichern“ übernimmt deine Auswahl.'
    : 'Die angezeigten Einträge entsprechen dem zuletzt geladenen Stand.';
}
function markDirty() { dirty = true; syncControls(); }
async function access(ticket, expected = null) {
  const session = await getSession();
  if (ticket !== generation) return null;
  if (!session.user?.isAdmin || !session.user.confirmed || session.user.suspended) {
    gate(session.user ? 'Dieses Konto hat keine bestätigte Administratorfreigabe.' : undefined);
    return null;
  }
  const next = `${session.user.id}:${session.csrfToken}`;
  if ((identity && identity !== next) || (expected && expected !== next)) {
    clearPrivate(); identity = next; $('productsGate').hidden = true;
    message('Die Anmeldung hat sich geändert. Bitte den gespeicherten Stand neu laden.', true);
    return null;
  }
  identity = next; $('productsGate').hidden = true;
  return next;
}
function install(value) {
  catalog = readCatalog(value, true); dirty = false; conflict = false; uncertain = false;
  $('productsEditor').hidden = false; renderProducts(); renderLinks();
}
function field(label, id, value, maxLength, { multiline = false, required = false, type = 'text', onInput } = {}) {
  const wrapper = element('label', label), input = element(multiline ? 'textarea' : 'input');
  wrapper.htmlFor = id; input.id = id; input.value = value; input.maxLength = maxLength; input.required = required;
  if (multiline) input.rows = 4;
  else { input.type = type; input.autocomplete = 'off'; }
  if (type === 'url') { input.placeholder = 'https://…'; input.spellcheck = false; }
  input.addEventListener('input', () => { onInput(input.value); markDirty(); });
  wrapper.append(input); return wrapper;
}
function moveProduct(product, offset) {
  if (busy || !catalog) return;
  const index = catalog.products.indexOf(product), next = index + offset;
  if (index < 0 || next < 0 || next >= catalog.products.length) return;
  [catalog.products[index], catalog.products[next]] = [catalog.products[next], catalog.products[index]];
  dirty = true; renderProducts();
  document.getElementById(`product-title-${product.id}`)?.focus();
}
function renderProducts() {
  const fragment = document.createDocumentFragment();
  catalog.products.forEach((product, index) => {
    const row = element('section', '', 'cb-account-card cb-product-editor'); row.id = `edit-product-${product.id}`;
    const heading = element('h3', `${index + 1}. ${product.title || 'Neues Produkt'}`); heading.id = `${row.id}-heading`;
    row.setAttribute('aria-labelledby', heading.id);
    const state = element('span', product.published ? 'Öffentlich nach dem Speichern' : 'Entwurf · nicht öffentlich', 'cb-product-editor-state');
    const top = element('div', '', 'cb-product-editor-heading'); top.append(heading, state); row.append(top);
    const picture = element('div', '', 'cb-product-editor-picture'); picture.append(imageFrame(product, true));
    const upload = element('button', 'Bild hochladen', 'cb-account-button secondary'); upload.type = 'button';
    const files = element('input'); files.type = 'file'; files.accept = 'image/jpeg,image/png,image/webp'; files.hidden = true;
    files.setAttribute('aria-label', `${product.title || 'Neues Produkt'}: Bild auswählen`);
    const removeImage = element('button', 'Eigenes Bild entfernen', 'cb-account-button secondary'); removeImage.type = 'button'; removeImage.dataset.removeImage = '';
    const uploadStatus = element('p', '', 'cb-product-upload-status'); uploadStatus.setAttribute('role', 'status'); uploadStatus.setAttribute('aria-live', 'polite');
    upload.addEventListener('click', () => { if (!busy) files.click(); });
    files.addEventListener('change', () => {
      const file = files.files?.[0]; files.value = '';
      if (file) void uploadImage(product, file, uploadStatus);
    });
    removeImage.addEventListener('click', () => {
      if (busy || !product.imageId) return;
      product.imageId = ''; dirty = true; renderProducts();
      message('Eigenes Bild aus dem Entwurf entfernt. Bei den beiden Beispielprodukten erscheint wieder das Original-Produktbild.');
    });
    picture.append(upload, files, removeImage, uploadStatus); row.append(picture);
    const fields = element('div', '', 'cb-product-editor-fields');
    fields.append(field('Produktname', `product-title-${product.id}`, product.title, 120, { required: true, onInput: value => {
      product.title = value; heading.textContent = `${index + 1}. ${value || 'Neues Produkt'}`;
    } }));
    fields.append(field('Deine Beschreibung', `product-description-${product.id}`, product.description, 2000, { multiline: true, onInput: value => { product.description = value; } }));
    fields.append(field('Produktlink', `product-url-${product.id}`, product.url, 2048, { required: true, type: 'url', onInput: value => { product.url = value; } }));
    const visible = element('label', '', 'cb-admin-toggle'), checkbox = element('input');
    checkbox.type = 'checkbox'; checkbox.checked = product.published; checkbox.id = `product-published-${product.id}`; visible.htmlFor = checkbox.id;
    visible.append(checkbox, element('span', 'Öffentlich anzeigen'));
    checkbox.addEventListener('change', () => {
      product.published = checkbox.checked; state.textContent = product.published ? 'Öffentlich nach dem Speichern' : 'Entwurf · nicht öffentlich'; markDirty();
    });
    fields.append(visible);
    const actions = element('div', '', 'cb-account-actions');
    for (const [offset, label] of [[-1, 'Nach oben'], [1, 'Nach unten']]) {
      const button = element('button', label, 'cb-account-button secondary'); button.type = 'button'; button.dataset.move = String(offset);
      button.setAttribute('aria-label', `Produkt ${index + 1}: ${label}`);
      button.addEventListener('click', () => moveProduct(product, offset)); actions.append(button);
    }
    const remove = element('button', 'Produkt entfernen', 'cb-account-button secondary'); remove.type = 'button';
    remove.addEventListener('click', () => {
      if (busy || !catalog) return;
      catalog.products = catalog.products.filter(item => item !== product); dirty = true; renderProducts();
      message('Produkt aus deinem Entwurf entfernt. Mit „Änderungen speichern“ übernehmen.'); $('productsAdd').focus();
    });
    actions.append(remove); fields.append(actions); row.append(fields); fragment.append(row);
  });
  $('productsEntries').replaceChildren(fragment);
  $('productsAdminEmpty').hidden = catalog.products.length > 0;
  $('productsAdminCount').textContent = `${catalog.products.length} von 100 Produkten · Reihenfolge wie auf der öffentlichen Seite.`;
  syncControls();
}
function renderLinks() {
  const fragment = document.createDocumentFragment();
  for (const [key, label] of [['rgb', 'RGB Slotcover'], ['myasus', 'MyASUS']]) {
    const item = catalog.links[key], group = element('fieldset'); group.append(element('legend', label));
    group.append(field('Anzeigename', `product-link-${key}-title`, item.title, 80, { required: true, onInput: value => { item.title = value; } }));
    group.append(field('Beschreibung', `product-link-${key}-description`, item.description, 400, { multiline: true, onInput: value => { item.description = value; } }));
    group.append(field('Website-Link', `product-link-${key}-url`, item.url, 2048, { required: true, type: 'url', onInput: value => { item.url = value; } }));
    fragment.append(group);
  }
  $('productsLinks').replaceChildren(fragment); syncControls();
}
async function uploadImage(product, file, target) {
  if (busy || !catalog || !identity) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) {
    target.textContent = 'Bitte JPG, PNG oder WebP bis 8 MiB auswählen. Animierte Bilder sind nicht erlaubt.'; target.classList.add('is-error'); return;
  }
  if (!file.name || file.name.length > 160 || /[\\/:\x00-\x1f\x7f]/.test(file.name)) {
    target.textContent = 'Bitte einen Dateinamen bis 160 Zeichen ohne Ordnerpfad oder Doppelpunkt verwenden.'; target.classList.add('is-error'); return;
  }
  const ticket = ++generation, expected = identity; busy = true; syncControls();
  target.classList.remove('is-error'); target.textContent = 'Bild wird auf deinem NAS gespeichert …';
  try {
    if (!await access(ticket, expected) || ticket !== generation) return;
    const value = await api('/api/admin/setup/images', {
      method: 'POST', raw: true, body: file, timeout: 120000,
      headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) },
    });
    if (ticket !== generation || !await access(ticket, expected) || ticket !== generation) return;
    if (!/^gallery_[a-f0-9]{64}$/.test(value.image?.id || '')) throw new Error('Die Bildbestätigung ist unvollständig. Bitte den Upload erneut auswählen.');
    if (!catalog.products.includes(product)) return;
    product.imageId = value.image.id; dirty = true; renderProducts();
    message('Bild auf deinem NAS gespeichert. Mit „Änderungen speichern“ dem Produkt zuweisen.');
  } catch (error) {
    if (ticket !== generation) return;
    if ([401, 403].includes(error.status)) gate('Deine Anmeldung oder Administratorfreigabe ist nicht mehr gültig. Bitte erneut anmelden.');
    else { target.textContent = errorText(error); target.classList.add('is-error'); }
    message(errorText(error), true);
  } finally { if (ticket === generation) { busy = false; syncControls(); } }
}
async function loadCatalog() {
  if (busy) return;
  const ticket = ++generation; busy = true; syncControls(); message('Berechtigung und gespeicherte Produkte werden geladen …');
  try {
    const who = await access(ticket);
    if (!who || ticket !== generation) return;
    const value = await api(endpoint);
    if (ticket !== generation || !await access(ticket, who) || ticket !== generation) return;
    install(value); message('Gespeicherte Produktauswahl geladen.');
  } catch (error) {
    if (ticket !== generation) return;
    if ([401, 403].includes(error.status)) gate('Deine Anmeldung oder Administratorfreigabe ist nicht mehr gültig. Bitte erneut anmelden.');
    message(errorText(error), true);
  } finally { if (ticket === generation) { busy = false; syncControls(); } }
}
async function saveCatalog() {
  if (busy || !catalog || !dirty || conflict || uncertain || !identity) return;
  const ticket = ++generation, expected = identity;
  let submitted = false; busy = true; syncControls(); message('Produktauswahl wird gespeichert …');
  try {
    if (!await access(ticket, expected) || ticket !== generation) return;
    const payload = {
      expectedRevision: catalog.revision,
      products: catalog.products.map(item => ({ id: item.id, title: item.title.trim(), description: item.description.trim(), url: item.url.trim(), imageId: item.imageId, published: item.published })),
      links: Object.fromEntries(Object.entries(catalog.links).map(([key, item]) => [key, { title: item.title.trim(), description: item.description.trim(), url: item.url.trim() }])),
    };
    submitted = true;
    const value = await api(endpoint, { method: 'PUT', body: payload });
    if (ticket !== generation || !await access(ticket, expected) || ticket !== generation) return;
    install(value); message('Gespeichert. Öffentlich markierte Produkte und deine Links sind jetzt auf der Website sichtbar.');
  } catch (error) {
    if (ticket !== generation) return;
    if ([401, 403].includes(error.status)) gate('Deine Anmeldung oder Administratorfreigabe ist nicht mehr gültig. Bitte erneut anmelden.');
    else if (error.status === 409) {
      conflict = true;
      message('Zwischenzeitlich wurde die Auswahl an anderer Stelle geändert. Deine Eingaben bleiben hier erhalten. Lade den gespeicherten Stand, bevor du erneut speicherst.', true);
      return;
    } else if (submitted && (!error.status || error.status >= 500 || ['INVALID_RESPONSE', 'TIMEOUT', 'NETWORK_ERROR'].includes(error.code))) {
      uncertain = true;
      message('Die Speicherbestätigung fehlt. Möglicherweise wurde die Änderung bereits übernommen. Deine Eingaben bleiben hier erhalten; lade zuerst den gespeicherten Stand.', true);
      return;
    }
    message(errorText(error), true);
  } finally { if (ticket === generation) { busy = false; syncControls(); } }
}
$('productsEditor').addEventListener('submit', event => { event.preventDefault(); void saveCatalog(); });
$('productsAdd').addEventListener('click', () => {
  if (busy || !catalog || catalog.products.length >= 100) return;
  const item = { id: crypto.randomUUID(), title: '', description: '', url: '', imageId: '', published: false };
  catalog.products.push(item); dirty = true; renderProducts(); document.getElementById(`product-title-${item.id}`)?.focus();
});
$('productsReload').addEventListener('click', () => {
  if (busy) return;
  if (dirty && !window.confirm('Deine ungespeicherten Eingaben verwerfen und den gespeicherten Stand laden?')) return;
  void loadCatalog();
});
function accountChanged() {
  generation++; busy = false; gate(); syncControls();
  message('Die Anmeldung hat sich geändert. Berechtigung wird erneut geprüft …');
  void loadCatalog();
}
window.addEventListener('cb-account-changed', accountChanged);
window.addEventListener('storage', event => { if (event.key === 'cb-account-change' || event.key === null) accountChanged(); });
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pageshow', event => { if (event.persisted) accountChanged(); });
syncControls();
void loadCatalog();
