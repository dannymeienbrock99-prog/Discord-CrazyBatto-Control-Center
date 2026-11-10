(() => {
  const root = document.getElementById('cb-website');
  if (!root) return;
  import('./chat-notifications.js').then(module => module.startChatNotifications()).catch(() => {});
  const pwa = document.createElement('script');
  pwa.src = '/assets/pwa.js';
  pwa.defer = true;
  document.head.append(pwa);
  root.querySelectorAll('.cb-nav').forEach(nav => {
    for (const link of nav.querySelectorAll('a[href="discord-app.html"],a[href="musik-app.html"]')) link.remove();
    if (nav.querySelector('a[href="apps.html"]')) return;
    const link = document.createElement('a');
    link.href = 'apps.html'; link.textContent = 'Apps & Downloads';
    if (location.pathname === '/apps.html') link.setAttribute('aria-current', 'page');
    const account = nav.querySelector('a[href="registrierung.html"]');
    if (account) account.before(link); else nav.append(link);
  });
  root.querySelectorAll('.cb-nav').forEach(nav => {
    if (nav.querySelector('a[href="discord-server.html"],a[href="/discord-server.html"]')) return;
    const link = document.createElement('a');
    link.href = 'discord-server.html'; link.textContent = 'Discord-Server';
    const app = nav.querySelector('a[href="discord-app.html"]');
    if (app) app.after(link); else nav.append(link);
  });
  root.querySelectorAll('.cb-nav').forEach(nav => {
    if (nav.querySelector('a[href="geburtstage.html"]')) return;
    const link = document.createElement('a');
    link.href = 'geburtstage.html'; link.textContent = 'Geburtstage';
    if (location.pathname.startsWith('/geburtstage')) link.setAttribute('aria-current', 'page');
    const account = nav.querySelector('a[href="registrierung.html"]');
    if (account) account.after(link); else nav.append(link);
  });
  root.querySelectorAll('.cb-nav').forEach(nav => {
    if (nav.querySelector('a[href="eure-gaming-setups.html"],a[href="/eure-gaming-setups.html"]')) return;
    const link = document.createElement('a');
    link.href = 'eure-gaming-setups.html'; link.textContent = 'Eure Gaming Setups';
    if (location.pathname === '/eure-gaming-setups.html') link.setAttribute('aria-current', 'page');
    const account = nav.querySelector('a[href="mein-profil.html"],a[href="registrierung.html"]');
    if (account) account.after(link); else nav.append(link);
  });
  root.querySelectorAll('.cb-header-row .cb-nav').forEach((nav, index) => {
    if (nav.dataset.collapsible === 'true') return;
    nav.dataset.collapsible = 'true';
    nav.id ||= `cb-main-navigation-${index + 1}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cb-nav-toggle cursor-interaction';
    button.setAttribute('aria-controls', nav.id);
    const icon = document.createElement('span');
    icon.className = 'cb-nav-toggle-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '☰';
    const label = document.createElement('span');
    label.textContent = 'Start';
    const chevron = document.createElement('span');
    chevron.className = 'cb-nav-toggle-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    button.append(icon, label, chevron);
    nav.before(button);
    nav.classList.add('cb-nav-panel');
    for (const link of nav.querySelectorAll('a')) {
      if (link.textContent.trim() === 'Start') link.textContent = 'Startseite';
    }
    const setOpen = (open, returnFocus = false) => {
      nav.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      button.title = open ? 'Navigation schließen' : 'Navigation öffnen';
      if (returnFocus) button.focus({ preventScroll: true });
    };
    button.addEventListener('click', () => setOpen(nav.hidden));
    nav.addEventListener('click', event => {
      if (event.target.closest('a') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) setOpen(false);
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !nav.hidden && (nav.contains(document.activeElement) || button === document.activeElement)) {
        event.preventDefault(); setOpen(false, true);
      }
    });
    document.addEventListener('pointerdown', event => {
      if (!nav.hidden && !nav.contains(event.target) && !button.contains(event.target)) setOpen(false);
    });
    setOpen(false);
  });
  const assetData = root.querySelector('[data-cb-assets]');
  if (assetData) {
    const assets = JSON.parse(assetData.textContent);
    root.querySelectorAll('[data-asset]').forEach(el => {
      if (assets[el.dataset.asset]) el.src = assets[el.dataset.asset];
    });
  }

  const motion = root.querySelector('[data-header-motion]');
  const still = root.querySelector('[data-header-still]');
  const toggle = root.querySelector('.cb-motion-toggle');
  if (motion && still && toggle) {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let paused = false;
    function setPaused(value) {
      paused = value;
      motion.hidden = value;
      still.hidden = !value;
      toggle.textContent = value ? 'Animation abspielen' : 'Animation pausieren';
      toggle.setAttribute('aria-pressed', String(value));
      if (motion.tagName === 'VIDEO') {
        if (value) motion.pause();
        else motion.play().catch(() => setPaused(true));
      }
    }
    toggle.addEventListener('click', () => setPaused(!paused));
    preference.addEventListener('change', event => setPaused(event.matches));
    setPaused(preference.matches);
  }

  root.querySelectorAll('[data-gallery]').forEach(gallery => {
    const picks = Array.from(gallery.querySelectorAll('[data-gallery-pick]'));
    const mainPhoto = gallery.querySelector('.cb-gallery-main');
    const caption = gallery.querySelector('[data-gallery-caption]');
    const counter = gallery.querySelector('.cb-gallery-count');
    const originalLink = gallery.querySelector('[data-gallery-original]');
    if (!mainPhoto || !caption || !counter) return;
    picks.forEach((button, index) => {
      button.addEventListener('click', () => {
        const source = button.querySelector('img');
        if (!source) return;
        mainPhoto.src = source.currentSrc || source.src;
        mainPhoto.alt = source.alt;
        mainPhoto.width = Number(source.getAttribute('width'));
        mainPhoto.height = Number(source.getAttribute('height'));
        caption.textContent = button.dataset.caption;
        counter.textContent = `${index + 1} / ${picks.length}`;
        counter.setAttribute('aria-label', `Bild ${index + 1} von ${picks.length}`);
        if (originalLink && button.dataset.fullSrc) originalLink.href = button.dataset.fullSrc;
        picks.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      });
    });
  });

  if (root.dataset.preview === 'true') {
    const pages = Array.from(root.querySelectorAll('[data-page]'));
    const banner = root.querySelector('[data-home-banner]');
    function showPage(name, hash, scroll) {
      const page = pages.find(item => item.dataset.page === name);
      if (!page) return;
      pages.forEach(item => { item.hidden = item !== page; });
      if (banner) banner.hidden = name !== 'home';
      root.querySelectorAll('[data-nav]').forEach(link => {
        if (link.dataset.nav === name) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      if (scroll) {
        const target = hash ? root.querySelector(`[id="${hash}"]`) : root.querySelector('.cb-header-row');
        if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }
    root.querySelectorAll('a[data-page-link]').forEach(link => {
      link.addEventListener('click', event => {
        event.preventDefault();
        const hash = (link.getAttribute('href').split('#')[1] || '');
        showPage(link.dataset.pageLink, hash, true);
      });
    });
    showPage(root.dataset.startPage || 'home', '', false);
  }
})();
