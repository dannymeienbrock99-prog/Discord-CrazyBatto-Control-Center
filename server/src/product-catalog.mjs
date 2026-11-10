import { isIP } from 'node:net';
import { assert } from './errors.mjs';

const SETTING = 'product_catalog_v1';
const PRODUCT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IMAGE_ID = /^gallery_[a-f0-9]{64}$/;
const DEFAULT_IMAGES = Object.freeze({
  gr120: '/assets/product-rog-gr120.jpeg',
  glacial: '/assets/product-rog-glacial.jpeg'
});

function defaults() {
  return {
    revision: 0,
    products: [
      {
        id: 'gr120', title: 'ASUS ROG EURUX GR120',
        description: 'Weiße ARGB-Reverse-Lüfter im 3er-Set. Bilder und weitere Produktinformationen findest du bei Galaxus.',
        url: 'https://www.galaxus.de/de/s1/product/asus-luefter-rog-eurux-gr120-fan-argb-reverse-white-3in1-120-mm-3x-pc-luefter-72151569',
        imageId: '', published: true
      },
      {
        id: 'glacial', title: 'ASUS ROG Crosshair X870E Glacial',
        description: 'AM5-Mainboard mit AMD-X870E-Chipsatz im E-ATX-Format. Bilder und weitere Produktinformationen findest du bei Galaxus.',
        url: 'https://www.galaxus.de/de/s1/product/asus-rog-crosshair-x870e-glacial-am5-amd-x870e-e-atx-mainboard-66127645',
        imageId: '', published: true
      }
    ],
    links: {
      rgb: {
        title: 'RGB Slotcover', description: 'Beleuchtete Slotblenden und Ideen für dein Setup.',
        url: 'https://www.rgb-slotcover.com/'
      },
      myasus: {
        title: 'MyASUS', description: 'Zur offiziellen ASUS-Seite für MyASUS.',
        url: 'https://www.asus.com/de/support/myasus-deeplink/'
      }
    }
  };
}

function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function text(value, maximum, label, required = false) {
  assert(typeof value === 'string' && value.length <= maximum, `${label} ist ungültig oder zu lang.`);
  const result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim();
  assert(!required || result.length > 0, `${label} darf nicht leer sein.`);
  return result;
}

function externalUrl(value) {
  assert(typeof value === 'string' && value.length <= 2048 && value.trim() === value && !/[\s\u0000-\u001f\u007f\\]/.test(value), 'Bitte einen gültigen öffentlichen HTTPS-Link eingeben.');
  let url;
  try { url = new URL(value); } catch { assert(false, 'Bitte einen gültigen öffentlichen HTTPS-Link eingeben.'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    !isIP(hostname) && !hostname.includes(':') &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(hostname) &&
    !/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(hostname),
  'Bitte einen öffentlichen HTTPS-Link ohne Zugangsdaten oder besondere Portnummer eingeben.');
  return url.href;
}

export class ProductCatalog {
  constructor(store, gallery, { now = Date.now } = {}) {
    this.store = store; this.gallery = gallery; this.now = now;
  }
  current() {
    const stored = this.store.setting(SETTING);
    if (stored === undefined) return defaults();
    const value = JSON.parse(stored);
    assert(value && Number.isSafeInteger(value.revision) && value.revision >= 0 &&
      Array.isArray(value.products) && value.links, 'Der Produktbereich kann momentan nicht gelesen werden.', 'unavailable', 503);
    return value;
  }
  view({ admin = false } = {}) {
    const current = this.current();
    return {
      revision: current.revision,
      products: current.products.filter(product => admin || product.published).map(product => ({
        ...product,
        imageUrl: product.imageId
          ? '/api/' + (admin ? 'admin/' : '') + 'setup/images/' + product.imageId
          : Object.hasOwn(DEFAULT_IMAGES, product.id) ? DEFAULT_IMAGES[product.id] : ''
      })),
      links: current.links
    };
  }
  // Called by SetupGallery, without looking back into its slot/reference methods.
  // Draft references prevent deletion; only published references permit public reads.
  hasImage(id, { publicOnly = false } = {}) {
    return this.current().products.some(product => product.imageId === id && (!publicOnly || product.published));
  }
  async save(body, authorize) {
    return this.gallery.exclusive(() => {
      const user = authorize();
      assert(fields(body, ['expectedRevision', 'products', 'links']), 'Bitte Produktliste, Links und Versionsnummer übergeben.');
      assert(Array.isArray(body.products) && body.products.length <= 100, 'Es sind höchstens 100 Produkte möglich.');
      assert(fields(body.links, ['rgb', 'myasus']), 'Bitte beide Website-Verknüpfungen übergeben.');
      const seen = new Set();
      const products = body.products.map(product => {
        assert(fields(product, ['id', 'title', 'description', 'url', 'imageId', 'published']), 'Ein Produkteintrag ist unvollständig oder ungültig.');
        assert(typeof product.id === 'string' && PRODUCT_ID.test(product.id) && !seen.has(product.id), 'Jedes Produkt benötigt einen eindeutigen gültigen Verweis.');
        assert(typeof product.imageId === 'string' && (product.imageId === '' || IMAGE_ID.test(product.imageId)), 'Der Produktbild-Verweis ist ungültig.');
        assert(typeof product.published === 'boolean', 'Bitte angeben, ob das Produkt öffentlich sichtbar ist.');
        if (product.imageId) this.gallery.row(product.imageId);
        seen.add(product.id);
        return {
          id: product.id, title: text(product.title, 120, 'Der Produktname', true),
          description: text(product.description, 2000, 'Die Produktbeschreibung'),
          url: externalUrl(product.url), imageId: product.imageId, published: product.published
        };
      });
      const links = Object.fromEntries(['rgb', 'myasus'].map(key => {
        const link = body.links[key];
        assert(fields(link, ['title', 'description', 'url']), 'Eine Website-Verknüpfung ist unvollständig oder ungültig.');
        return [key, {
          title: text(link.title, 80, 'Der Linkname', true),
          description: text(link.description, 400, 'Die Linkbeschreibung'),
          url: externalUrl(link.url)
        }];
      }));
      this.store.transaction(() => {
        const current = this.current();
        assert(Number.isSafeInteger(body.expectedRevision) && body.expectedRevision === current.revision &&
          current.revision < Number.MAX_SAFE_INTEGER, 'Der Produktbereich wurde inzwischen geändert. Bitte neu laden.', 'conflict', 409);
        authorize();
        const next = { revision: current.revision + 1, products, links };
        this.store.setSetting(SETTING, JSON.stringify(next));
        this.store.audit(user.id, 'products.updated', SETTING, {
          revision: next.revision, count: products.length, published: products.filter(product => product.published).length
        }, this.now());
      });
      return this.view({ admin: true });
    });
  }
}
