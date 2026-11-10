(function () {
  'use strict';
  const APP_NAME = 'Crazy_Batto Discord App';
  const $ = id => document.getElementById(id);
  const text = value => typeof value === 'string' ? value.trim() : '';
  const list = (value, maximum) => Array.isArray(value) ? value.slice(0, maximum) : [];
  const imageIds = /^(?:brand-dragon|discord-app|img_[a-f0-9]{64})$/;
  let imageMap = new Map(), requestId = 0, lastContent = null;
  function show(node, visible) { node.hidden = !visible; }
  function make(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = value;
    return element;
  }
  function icon(name) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('class', 'icon'); node.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/site/assets/icons.svg#' + name); node.append(use); return node;
  }
  function safeLink(value) {
    if (value === '/portal') return value;
    if (typeof value !== 'string' || value.length > 1000 || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.hostname ? url.href : null;
    } catch (_) { return null; }
  }
  function imagePath(id) {
    if (id === 'brand-dragon') return '/site/assets/brand-dragon.jpeg';
    if (id === 'discord-app') return '/site/assets/discord-app.png';
    return typeof id === 'string' && /^img_[a-f0-9]{64}$/.test(id) ? '/site/media/' + id : null;
  }
  function imagesFrom(value) {
    const images = new Map();
    for (const image of list(value, 102)) {
      if (!image || !imageIds.test(image.id) || image.url !== imagePath(image.id)) continue;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) continue;
      if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 32000000) continue;
      images.set(image.id, { id: image.id, url: imagePath(image.id), width: image.width, height: image.height });
    }
    return images;
  }
  function textBlock(id, value) {
    const node = $(id); node.textContent = text(value); show(node, !!text(value));
  }
  function aboutText(value) {
    const node = $('about-text'), content = text(value), lines = content.split('\n');
    node.replaceChildren();
    // A short first line can serve as the personal name. All content stays
    // editable plain text, and textContent preserves the original line breaks.
    const hasName = lines.length > 1 && lines[0].length > 0 && lines[0].length <= 100;
    lines.forEach((line, index) => {
      if (index) node.append(document.createTextNode('\n'));
      const element = make(hasName && index === 0 ? 'strong' : 'span',
        hasName && index === 0 ? 'about-name' : 'about-line', line);
      if (element.className === 'about-line' && line.includes('Team TABH')) {
        element.replaceChildren();
        line.split('Team TABH').forEach((part, partIndex) => {
          if (partIndex) element.append(make('strong', 'about-team', 'Team TABH'));
          element.append(document.createTextNode(part));
        });
      }
      node.append(element);
    });
    show(node, !!content);
  }
  function linkNode(url, label, className) {
    const link = make('a', className);
    link.href = url;
    if (url !== '/portal') { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    link.append(make('span', '', label), icon(url === '/portal' ? 'arrow-right' : 'external'));
    return link;
  }
  function media(id, altValue, captionValue, onFailure) {
    const source = imageMap.get(id);
    if (!source) return null;
    const alt = text(altValue), caption = text(captionValue);
    const figure = make('figure', 'media-figure');
    const open = make('button', 'image-open');
    open.type = 'button'; open.setAttribute('aria-label', alt ? alt + ' – vergrößern' : 'Bild vergrößern');
    const img = make('img'); img.src = source.url; img.alt = alt;
    img.width = source.width; img.height = source.height; img.loading = 'lazy'; img.decoding = 'async';
    img.addEventListener('error', () => { figure.remove(); if (onFailure) onFailure(); }, { once: true });
    open.append(img); figure.append(open);
    if (caption) figure.append(make('figcaption', 'media-caption', caption));
    open.addEventListener('click', () => openImage(source, alt, caption));
    return figure;
  }
  function openImage(source, alt, caption) {
    const dialog = $('image-dialog');
    $('large-image').src = source.url; $('large-image').alt = alt;
    $('image-title').textContent = alt;
    $('image-caption').textContent = caption; show($('image-caption'), !!caption);
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('dialog-open');
  }
  function sectionState(id, navId, visible) {
    show($(id), visible); show($(navId), visible);
  }
  function navigationState() {
    const any = ['ueber-mich', 'mein-setup', 'meine-apps'].some(id => !$(id).hidden);
    show(document.querySelector('.section-nav'), any);
    show($('registration-end'), any);
  }
  function renderAbout(value) {
    const about = value && typeof value === 'object' ? value : {};
    $('about-title').textContent = text(about.title) || 'Über mich';
    aboutText(about.text);
    const holder = $('about-media'); holder.replaceChildren();
    const update = () => {
      show(holder, !!holder.childElementCount);
      $('ueber-mich').classList.toggle('has-media', !!holder.childElementCount);
      sectionState('ueber-mich', 'nav-about', !!text(about.text) || !!holder.childElementCount);
      navigationState();
    };
    const figure = media(about.imageId, about.imageAlt, '', update);
    if (figure) holder.append(figure);
    update();
  }
  function renderSetup(value) {
    const setup = value && typeof value === 'object' ? value : {};
    $('setup-title').textContent = text(setup.title) || 'Mein Setup';
    textBlock('setup-text', setup.text);
    const components = $('setup-components'), gallery = $('setup-gallery');
    components.replaceChildren(); gallery.replaceChildren();
    for (const row of list(setup.components, 24)) {
      if (!row || !text(row.label) || !text(row.value)) continue;
      const item = make('div'); item.append(make('dt', '', text(row.label)), make('dd', '', text(row.value))); components.append(item);
    }
    const update = () => {
      show(components, !!components.childElementCount); show(gallery, !!gallery.childElementCount);
      sectionState('mein-setup', 'nav-setup', !!text(setup.text) || !!components.childElementCount || !!gallery.childElementCount);
      navigationState();
    };
    for (const entry of list(setup.images, 12)) {
      if (!entry) continue;
      const figure = media(entry.imageId, entry.alt, entry.caption, update);
      if (figure) gallery.append(figure);
    }
    update();
  }
  function renderApps(value) {
    const holder = $('app-list'); holder.replaceChildren();
    for (const entry of list(value, 8)) {
      if (!entry || !text(entry.name)) continue;
      const row = make('article', 'app-row');
      const image = imageMap.get(entry.imageId);
      const figure = media(entry.imageId, entry.imageAlt, '', () => { row.classList.remove('has-media'); });
      if (figure) {
        figure.classList.add('app-media');
        if (image.height > image.width * 1.2) figure.classList.add('is-portrait');
        row.classList.add('has-media'); row.append(figure);
      }
      const copy = make('div', 'app-text'); copy.append(make('h3', '', text(entry.name)));
      if (text(entry.description)) copy.append(make('p', 'app-description', text(entry.description)));
      const url = safeLink(entry.url);
      if (url) copy.append(linkNode(url, text(entry.buttonLabel) || (url === '/portal' ? 'Zugang anfragen' : 'Projekt ansehen'), url === '/portal' ? 'button' : 'text-link'));
      row.append(copy); holder.append(row);
    }
    sectionState('meine-apps', 'nav-apps', !!holder.childElementCount);
  }
  function renderLinks(value) {
    const holder = $('social-links'); holder.replaceChildren();
    for (const entry of list(value, 12)) {
      if (!entry || !text(entry.label)) continue;
      const url = safeLink(entry.url); if (!url) continue;
      const link = make('a', '', text(entry.label)); link.href = url;
      if (url !== '/portal') { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      holder.append(link);
    }
    show(holder, !!holder.childElementCount);
  }
  function render(content, images) {
    imageMap = imagesFrom(images);
    const title = text(content.heroTitle) || APP_NAME;
    $('hero-title').textContent = title;
    if (title === APP_NAME) $('hero-title').replaceChildren(document.createTextNode('Crazy_Batto '), make('span', '', 'Discord App'));
    textBlock('hero-text', content.heroText);
    renderAbout(content.about); renderSetup(content.setup); renderApps(content.apps); renderLinks(content.socialLinks); navigationState();
  }
  async function loadContent() {
    const serial = ++requestId;
    const retry = $('retry-content'); retry.disabled = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/site/api/content', { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error('content_http');
      const raw = await response.text();
      if (raw.length > 256000) throw new Error('content_large');
      const result = JSON.parse(raw);
      if (!result || result.ok !== true || !result.content || typeof result.content !== 'object' || Array.isArray(result.content) || !Array.isArray(result.images)) throw new Error('content_invalid');
      if (serial !== requestId) return;
      lastContent = result; render(result.content, result.images); show($('site-notice'), false);
    } catch (_) {
      if (serial !== requestId) return;
      // Keep only the server-published last successful view, never draft or demo content.
      if (!lastContent) render({ heroTitle: APP_NAME }, []);
      show($('site-notice'), true);
    } finally { clearTimeout(timeout); if (serial === requestId) retry.disabled = false; }
  }
  $('retry-content').addEventListener('click', loadContent);
  $('close-image').addEventListener('click', () => $('image-dialog').close());
  $('image-dialog').addEventListener('close', () => { document.body.classList.remove('dialog-open'); $('large-image').removeAttribute('src'); });
  $('image-dialog').addEventListener('click', event => {
    if (event.target !== $('image-dialog')) return;
    const box = $('image-dialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('image-dialog').close();
  });
  loadContent();
}());
