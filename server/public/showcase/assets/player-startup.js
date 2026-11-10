(() => {
  'use strict';

  let initialized = false;
  let finished = false;
  let timer = null;

  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  window.addEventListener('cb-player-initialized', () => {
    initialized = true;
    finished = true;
    clearTimer();
  }, { once: true });

  const start = () => {
    if (initialized) return;
    const list = document.getElementById('trackList');
    const loading = document.getElementById('playerLoading');
    const moduleScript = document.getElementById('playerModule');
    const feedback = document.getElementById('playerFeedback');
    if (!list || !loading || loading.parentNode !== list) return;

    const showFailure = (localFile = false) => {
      if (initialized || finished || loading.parentNode !== list) return;
      // A rendered playlist always takes precedence over this startup notice.
      if (Array.from(list.children).some((item) => item !== loading)) return;
      finished = true;
      clearTimer();

      const title = document.createElement('strong');
      title.textContent = localFile
        ? 'Bitte starte die lokale Vorschau.'
        : 'Der Musikplayer konnte nicht gestartet werden.';
      const explanation = document.createElement('span');
      explanation.textContent = localFile
        ? 'Öffne START-TEST.cmd im Projektordner. Danach kannst du den Player über den folgenden Link öffnen.'
        : 'Lade die Seite erneut. Deine gespeicherten Titel werden dabei nicht gelöscht.';
      const retry = document.createElement('a');
      retry.href = localFile
        ? 'http://127.0.0.1:4173/media-player.html'
        : window.location.href;
      retry.textContent = localFile ? 'Lokalen Musikplayer öffnen' : 'Seite neu laden';

      loading.classList.add('is-error');
      loading.replaceChildren(title, explanation, retry);
      if (feedback) feedback.textContent = title.textContent + ' ' + explanation.textContent;
    };

    if (window.location.protocol === 'file:') {
      showFailure(true);
      return;
    }

    if (moduleScript) moduleScript.addEventListener('error', () => showFailure(), { once: true });
    timer = window.setTimeout(() => showFailure(), 10000);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
