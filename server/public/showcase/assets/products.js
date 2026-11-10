import { api, getSession, errorText } from './account-client.js';

const imageIds = /^gallery_[a-f0-9]{64}$/;
const productIds = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const seedImages = { gr120: '/assets/product-rog-gr120.jpeg', glacial: '/assets/product-rog-glacial.jpeg' };

export function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function productLink(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Ein Produktlink konnte nicht gelesen werden.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Ein Produktlink ist ungültig.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Produktlinks müssen sichere HTTPS-Adressen sein.');
  return url.href;
}
export function productImage(product, admin = false) {
  if (product.imageId) {
    if (!imageIds.test(product.imageId)) throw new Error('Der Bildverweis ist ungültig.');
    return `/api/${admin ? 'admin/' : ''}setup/images/${product.imageId}`;
  }
  return Object.hasOwn(seedImages, product.id) ? seedImages[product.id] : '';
}
export function readCatalog(value, admin = false) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.products) || value.products.length > 100) {
    throw new Error('Die Produktauswahl konnte nicht vollständig gelesen werden. Bitte erneut laden.');
  }
  const ids = new Set();
  const products = value.products.map(product => {
    if (!product || typeof product.id !== 'string' || !productIds.test(product.id) || ids.has(product.id)
      || typeof product.title !== 'string' || !product.title.trim() || product.title.length > 120
      || typeof product.description !== 'string' || product.description.length > 2000
      || typeof product.imageId !== 'string' || (product.imageId && !imageIds.test(product.imageId))
      || typeof product.published !== 'boolean' || (!admin && !product.published)) throw new Error('Ein Produkteintrag ist unvollständig.');
    ids.add(product.id);
    const entry = { id: product.id, title: product.title, description: product.description, url: productLink(product.url), imageId: product.imageId, published: product.published };
    if (product.imageUrl !== productImage(entry, admin)) throw new Error('Ein Produktbild konnte nicht sicher zugeordnet werden.');
    return entry;
  });
  const links = {};
  for (const key of ['rgb', 'myasus']) {
    const link = value.links?.[key];
    if (!link || typeof link.title !== 'string' || !link.title.trim() || link.title.length > 80
      || typeof link.description !== 'string' || link.description.length > 400) throw new Error('Die zusätzlichen Links sind unvollständig.');
    links[key] = { title: link.title, description: link.description, url: productLink(link.url) };
  }
  return { revision: value.revision, products, links };
}
export function imageFrame(product, admin = false) {
  const frame = element('div', '', 'cb-product-image');
  const placeholder = element('span', 'Bild folgt', 'cb-product-image-placeholder');
  const source = productImage(product, admin);
  frame.dataset.empty = String(!source);
  if (source) {
    const image = element('img');
    image.src = source; image.alt = product.title || 'Produktbild'; image.loading = 'lazy'; image.decoding = 'async';
    placeholder.hidden = true;
    image.addEventListener('error', () => {
      image.hidden = true; placeholder.hidden = false; placeholder.textContent = 'Bild gerade nicht verfügbar'; frame.dataset.empty = 'true';
    }, { once: true });
    frame.append(image);
  }
  frame.append(placeholder);
  return frame;
}
function installLinks(links) {
  for (const node of document.querySelectorAll('[data-product-link]')) {
    const item = links[node.dataset.productLink];
    if (!item) continue;
    node.href = productLink(item.url);
    node.querySelector('[data-product-link-title]').textContent = item.title;
    node.querySelector('[data-product-link-description]').textContent = item.description;
  }
}

const publicRoot = document.querySelector('[data-products-page]');
const homeRoot = document.querySelector('[data-products-home]');
if (publicRoot || homeRoot) {
  const list = publicRoot?.querySelector('[data-products-list]');
  const feedback = publicRoot?.querySelector('[data-products-status]');
  const retry = publicRoot?.querySelector('[data-products-retry]');
  let loading = false, loadGeneration = 0;
  async function loadProducts() {
    if (loading) return;
    const ticket = ++loadGeneration; loading = true;
    if (list) list.setAttribute('aria-busy', 'true');
    if (retry) retry.hidden = true;
    if (feedback) { feedback.textContent = 'Produkte werden geladen …'; feedback.classList.remove('is-error'); }
    try {
      const catalog = readCatalog(await api('/api/products'));
      if (ticket !== loadGeneration) return;
      installLinks(catalog.links);
      if (!publicRoot) return;
      const fragment = document.createDocumentFragment();
      for (const product of catalog.products) {
        const card = element('article', '', 'cb-product-card');
        const heading = element('h3', product.title);
        heading.id = `product-${product.id}`; card.setAttribute('aria-labelledby', heading.id);
        const copy = element('div', '', 'cb-product-copy');
        copy.append(heading);
        if (product.description) copy.append(element('p', product.description));
        const link = element('a', '', 'cb-button');
        link.href = productLink(product.url); link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', `${product.title}: Produkt beim Anbieter ansehen (neuer Tab)`);
        const arrow = element('span', '↗'); arrow.setAttribute('aria-hidden', 'true');
        link.append(element('span', 'Produkt ansehen'), arrow);
        copy.append(link, element('span', new URL(product.url).hostname.replace(/^www\./, ''), 'cb-product-host'));
        card.append(imageFrame(product), copy); fragment.append(card);
      }
      list.replaceChildren(fragment);
      publicRoot.querySelector('[data-products-empty]').hidden = catalog.products.length > 0;
      publicRoot.querySelector('[data-products-count]').textContent = `${catalog.products.length} ${catalog.products.length === 1 ? 'Produkt' : 'Produkte'}`;
      feedback.textContent = catalog.products.length ? 'Aktuelle Auswahl geladen.' : 'Noch keine Produkte veröffentlicht.';
    } catch (error) {
      if (ticket !== loadGeneration) return;
      if (feedback) { feedback.textContent = 'Die Produktauswahl ist gerade nicht erreichbar. ' + errorText(error); feedback.classList.add('is-error'); }
      if (retry) retry.hidden = false;
    } finally {
      if (ticket === loadGeneration) {
        loading = false;
        if (list) list.setAttribute('aria-busy', 'false');
      }
    }
  }
  retry?.addEventListener('click', () => void loadProducts());
  void loadProducts();
  const adminLink = document.querySelector('[data-products-admin-link]');
  if (adminLink) {
    let sessionTicket = 0;
    async function showAdminLink() {
      const ticket = ++sessionTicket;
      adminLink.hidden = true;
      try {
        const session = await getSession();
        if (ticket === sessionTicket) adminLink.hidden = !(session.user?.isAdmin && session.user.confirmed && !session.user.suspended);
      } catch {}
    }
    window.addEventListener('cb-account-changed', () => void showAdminLink());
    window.addEventListener('storage', event => { if (event.key === 'cb-account-change' || event.key === null) void showAdminLink(); });
    void showAdminLink();
  }
}
