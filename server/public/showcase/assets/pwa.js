(() => {
  if (window.cbPwaReady) return;
  window.cbPwaReady = true;
  const admin = location.pathname === '/admin.html';
  const chat = location.pathname === '/nachrichten.html';
  const appName = admin ? 'CB Verwaltung' : chat ? 'Crazy_Batto Chat' : 'Crazy_Batto';
  const manifestPath = admin ? '/admin.webmanifest' : chat ? '/chat.webmanifest' : '/manifest.webmanifest';
  function head(tag, attributes) {
    const selector = tag === 'meta' ? `meta[name="${attributes.name}"]` : `link[rel="${attributes.rel}"][href="${attributes.href}"]`;
    const node = document.querySelector(selector) || document.createElement(tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    if (!node.parentNode) document.head.append(node);
  }
  const manifest = document.querySelector('link[rel="manifest"]');
  if (!manifest) head('link', { rel: 'manifest', href: manifestPath });
  else if (chat && manifest.getAttribute('href') !== manifestPath) manifest.setAttribute('href', manifestPath);
  head('link', { rel: 'apple-touch-icon', href: '/assets/app-icon-180.png' });
  head('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  head('meta', { name: 'apple-mobile-web-app-title', content: appName });
  head('link', { rel: 'stylesheet', href: '/assets/pwa.css' });
  let prompt = null, registration = null;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const nativeChat = () => chat && ['android', 'ios'].includes(new URLSearchParams(location.search).get('native'));
  const buttons = () => document.querySelectorAll('[data-cb-install]');
  const updateButtons = () => {
    const installed = standalone();
    if (chat) document.documentElement.classList.toggle('cb-chat-app', installed || nativeChat());
    buttons().forEach(button => {
      // Standalone only describes this window, not which app was installed.
      button.textContent = chat ? 'Installation & Hilfe' : installed ? 'App ist geöffnet' : admin ? 'Verwaltungs-App installieren' : 'Webseite als App installieren';
      button.disabled = installed && !chat;
    });
  };
  matchMedia('(display-mode: standalone)').addEventListener?.('change', updateButtons);
  window.addEventListener('cb-install-controls-ready', updateButtons);
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; updateButtons(); });
  window.addEventListener('appinstalled', () => { prompt = null; updateButtons(); });
  let dialog;
  function instructions() {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'cb-install-dialog';
      dialog.setAttribute('aria-labelledby', 'cb-install-title');
      const title = document.createElement('h2'); title.id = 'cb-install-title'; title.tabIndex = -1; title.setAttribute('autofocus', ''); title.textContent = admin ? 'Deine Verwaltungs-App' : chat ? 'Crazy_Batto Chat auf deinem Handy' : 'Crazy_Batto auf deinem Handy';
      const intro = document.createElement('p'); intro.textContent = chat
        ? 'Die Android-App kannst du als APK herunterladen und installieren. Sie benötigt Android 8 oder neuer, einen aktuellen Chrome-Browser und eine Internetverbindung. Für das iPhone steht derzeit die Web-App bereit; eine iPhone-App zum Herunterladen ist noch nicht verfügbar.'
        : 'Ein Symbol auf deinem Startbildschirm öffnet die App direkt. Die Inhalte werden beim Öffnen über das Internet aktualisiert.';
      const steps = document.createElement('ol');
      for (const text of [
        chat ? 'Android: Lade die APK herunter und öffne sie unter „Downloads“. Tippe auf „Installieren“. Falls Android nachfragt, erlaube die Installation für deinen Browser oder deine Dateien-App.' : 'Android: Öffne diese Seite in Chrome. Tippe im Browsermenü auf „App installieren“ oder „Zum Startbildschirm hinzufügen“.',
        'iPhone: Öffne diese Seite in Safari. Tippe auf „Teilen“ und „Zum Home-Bildschirm“. Aktiviere „Als Web-App öffnen“, falls diese Option angezeigt wird, und tippe auf „Hinzufügen“.',
        admin ? 'Öffne danach „CB Verwaltung“ und melde dich mit deinem Administratorkonto an. Neue Anfragen erscheinen automatisch, solange die Verwaltung geöffnet ist.'
          : chat ? 'Öffne danach „Crazy_Batto Chat“ bzw. „CB Chat“ auf deinem Startbildschirm und melde dich mit deinem Webseitenkonto an.'
          : 'Öffne danach „Crazy_Batto“. Dein Konto und die App-Downloads findest du im Menü.',
        ...(chat ? ['Aktiviere in der Chat-App „Benachrichtigungen einschalten“, damit neue Nachrichten auch bei geschlossener App gemeldet werden. Auf dem iPhone wird dafür iOS 16.4 oder neuer benötigt.'] : [])
      ]) { const item = document.createElement('li'); item.textContent = text; steps.append(item); }
      const note = document.createElement('p'); note.textContent = chat
        ? 'Die Android-App öffnet deinen bestehenden Chat. Bei der ersten Nutzung Mikrofon und Benachrichtigungen nach Bedarf erlauben. Für die iPhone-Web-App kopiere den Link unten nach Safari. In einem Browser innerhalb einer anderen App fehlt die Installation häufig.'
        : 'In einem eingebauten App-Browser fehlen Installationsfunktionen manchmal. Nutze dann Chrome oder Safari. Die Installation kann je nach Gerät eine erneute Anmeldung erfordern.';
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Verstanden'; close.addEventListener('click', () => dialog.close());
      dialog.append(title, intro);
      if (chat) {
        const apk = document.createElement('a'); apk.href = '/downloads/Crazy_Batto-Chat-1.0.0.apk'; apk.className = 'cb-chat-apk-download'; apk.textContent = 'Android-App herunterladen';
        dialog.append(apk);
        const linkLabel = document.createElement('label'); linkLabel.textContent = 'Link für deinen Handy-Browser'; linkLabel.htmlFor = 'cb-chat-install-link';
        const link = document.createElement('input'); link.id = 'cb-chat-install-link'; link.type = 'url'; link.readOnly = true;
        link.value = 'https://crazybatto.de/nachrichten.html?app=chat#chat-install';
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Link kopieren';
        const feedback = document.createElement('p'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
        copy.addEventListener('click', async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(link.value);
            feedback.textContent = 'Link kopiert. Öffne Chrome oder Safari und füge ihn in die Adresszeile ein.';
          } catch {
            link.focus(); link.select();
            feedback.textContent = 'Halte den markierten Link gedrückt und wähle „Kopieren“. Öffne ihn anschließend in Chrome oder Safari.';
          }
        });
        dialog.append(linkLabel, link, copy, feedback);
      }
      dialog.append(steps, note, close); document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-cb-install]');
    if (!button) return;
    event.preventDefault();
    if (standalone() && !chat) return;
    if (chat) { instructions(); return; }
    if (!prompt) { instructions(); return; }
    const available = prompt; prompt = null;
    try { await available.prompt(); await available.userChoice; }
    catch { instructions(); }
    updateButtons();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
      .then(value => { registration = value; return value.update(); }).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && registration) registration.update().catch(() => {});
    });
  }
  updateButtons();
})();
