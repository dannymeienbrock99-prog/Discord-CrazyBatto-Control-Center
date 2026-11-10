(() => {
  'use strict';
  const KEY = 'cb-cookie-choice-v1';
  const LIFETIME = 180 * 24 * 60 * 60 * 1000;
  let choice = null;
  let expiryTimer;
  let feedbackTimer;
  let memoryOverride = false;
  let returnFocus;
  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (value?.version === 1 && Number.isFinite(value.at)
        && value.at <= Date.now() && Date.now() - value.at < LIFETIME) return { version: 1, at: value.at };
    } catch { /* The notice remains usable when browser storage is unavailable. */ }
    return null;
  }
  choice = read();
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const dialog = make('dialog', '', 'cb-cookie-dialog');
  dialog.setAttribute('aria-labelledby', 'cbCookieTitle');
  dialog.setAttribute('aria-describedby', 'cbCookieIntro');
  const top = make('div', '', 'cb-cookie-top');
  const brand = make('img', '', 'cb-cookie-brand');
  brand.width = 300; brand.height = 100; brand.alt = 'Crazy_Batto';
  // Both assets are served by this website; the banner makes no provider request.
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const setBrand = () => { brand.src = motion.matches ? 'assets/header-poster.webp' : 'assets/cookie-banner.gif'; };
  setBrand(); motion.addEventListener('change', setBrand);
  const heading = make('div');
  heading.append(make('p', 'DEINE PRIVATSPHÄRE', 'cb-cookie-kicker'));
  const title = make('h2', 'Cookies & Speicher.'); title.id = 'cbCookieTitle'; heading.append(title);
  top.append(heading, brand); dialog.append(top);
  const intro = make('p', 'Für Anmeldung, Sicherheit und deine gewählten Player-Funktionen nutzen wir notwendigen Speicher. Es sind keine optionalen externen Player, externen Analyse- oder Werbetracker eingebunden. Aufrufe ohne Anmeldung zählen wir auf unserem Server ohne zusätzliche Cookies; mehr dazu unter „Cookies & Speicher“.');
  intro.id = 'cbCookieIntro'; dialog.append(intro);
  const details = make('div', '', 'cb-cookie-details'); details.hidden = true;
  const necessary = make('p', 'Dazu gehören deine Anmeldung, Sicherheit und gewählte Player-Einstellungen. Die Bestätigung dieses Hinweises wird für höchstens 180 Tage in diesem Browser gespeichert.');
  details.append(necessary); dialog.append(details);
  const actions = make('div', '', 'cb-cookie-actions');
  const button = (text, action) => { const item = make('button', text); item.type = 'button'; item.addEventListener('click', action); return item; };
  const acknowledge = button('Verstanden', () => save());
  const settings = button('Details anzeigen', () => { details.hidden = false; settings.hidden = true; acknowledge.focus(); });
  const close = button('Schließen', () => dismiss()); close.hidden = true;
  actions.append(acknowledge, settings, close); dialog.append(actions);
  const bottom = make('div', '', 'cb-cookie-bottom');
  const more = make('a', 'Cookies & Speicher'); more.href = 'cookies.html';
  bottom.append(more, make('span', 'Jederzeit über „Cookie-Einstellungen“ einsehbar.')); dialog.append(bottom);
  const feedback = make('p', '', 'cb-cookie-status'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  feedback.hidden = true;
  document.body.append(dialog, feedback);
  function announce() {
    // Older, still-open player pages must also stop their retired integration.
    window.dispatchEvent(new CustomEvent('cb-consent-change', { detail: { spotify: false } }));
    document.querySelectorAll('[data-cookie-current]').forEach(node => { node.textContent = choice ? 'Hinweis bestätigt. Es wird nur notwendiger Speicher verwendet.' : 'Es wird nur notwendiger Speicher verwendet.'; });
    clearTimeout(expiryTimer);
    if (choice) expiryTimer = setTimeout(() => { if (choice && Date.now() - choice.at >= LIFETIME) choice = null; announce(); }, Math.min(2_000_000_000, Math.max(1, choice.at + LIFETIME - Date.now())));
  }
  function dismiss() {
    dialog.close();
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function save() {
    choice = { version: 1, at: Date.now() };
    let persisted = true;
    try { localStorage.setItem(KEY, JSON.stringify(choice)); memoryOverride = false; } catch { persisted = false; memoryOverride = true; }
    announce(); dismiss();
    feedback.textContent = persisted ? 'Hinweis bestätigt. Es wird nur notwendiger Speicher verwendet.' : 'Hinweis bestätigt. Dein Browser konnte die Bestätigung nicht dauerhaft speichern.';
    feedback.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 6000);
  }
  function open(expand = true) {
    returnFocus = document.activeElement;
    details.hidden = !expand; settings.hidden = expand; close.hidden = false;
    if (dialog.open) dialog.close();
    dialog.showModal();
    acknowledge.focus();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  document.addEventListener('click', event => {
    if (!event.target.closest?.('[data-cookie-settings]')) return;
    event.preventDefault(); open(true);
  });
  const refreshChoice = () => { if (!memoryOverride) choice = read(); announce(); };
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) refreshChoice(); });
  window.addEventListener('pageshow', refreshChoice);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshChoice(); });
  window.CBConsent = Object.freeze({ allowsSpotify: () => false, openSettings: () => open(true) });
  announce();
  // Non-modal first visit notice: visitors can continue browsing immediately.
  if (!choice) { close.hidden = false; dialog.show(); }
})();
