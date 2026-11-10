(() => {
  'use strict';

  function initializeEffects() {
    const stage = document.querySelector('.cb-player-page');
    const button = document.getElementById('effectsButton');
    const label = document.getElementById('effectsButtonLabel');
    const status = document.getElementById('playerEffectsStatus');
    if (!stage || !button || !label || !status) return;
    if (stage.dataset.fxInitialized === 'true') return;
    stage.dataset.fxInitialized = 'true';

    const storageKey = 'cb-player-effects-v1';
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let enabled = true;
    let intersecting = false;
    let pageHidden = false;
    let minimized = stage.classList.contains('is-minimized');

    try {
      const savedPreference = window.localStorage.getItem(storageKey);
      if (savedPreference === 'false') enabled = false;
      else if (savedPreference === 'true') enabled = true;
    } catch {
      // Effects remain usable when browser storage is unavailable.
    }

    function updateEffects() {
      const reducedMotion = Boolean(motionPreference?.matches);
      const running = enabled && !reducedMotion && !document.hidden
        && intersecting && !minimized && !pageHidden;
      stage.classList.toggle('cb-fx-enabled', enabled);
      stage.classList.toggle('cb-fx-running', running);
      button.setAttribute('aria-pressed', String(enabled));
      button.setAttribute('aria-label', enabled ? 'Effekte ausschalten' : 'Effekte einschalten');
      const labelText = enabled ? 'Effekte: an' : 'Effekte: aus';
      if (label.textContent !== labelText) label.textContent = labelText;
      const statusText = !enabled
        ? 'Die Lichteffekte sind ausgeschaltet.'
        : reducedMotion
          ? 'Die Lichteffekte bleiben ruhig, weil du reduzierte Bewegung eingestellt hast.'
          : 'Sanfte Lichteffekte sind eingeschaltet.';
      if (status.textContent !== statusText) status.textContent = statusText;
    }

    button.addEventListener('click', () => {
      enabled = !enabled;
      try {
        window.localStorage.setItem(storageKey, String(enabled));
      } catch {
        // The chosen setting still applies for this page visit.
      }
      updateEffects();
    });

    document.addEventListener('visibilitychange', updateEffects);
    window.addEventListener('pagehide', () => {
      pageHidden = true;
      updateEffects();
    });
    window.addEventListener('pageshow', () => {
      pageHidden = false;
      updateEffects();
    });

    if (typeof motionPreference?.addEventListener === 'function') {
      motionPreference.addEventListener('change', updateEffects);
    } else if (typeof motionPreference?.addListener === 'function') {
      motionPreference.addListener(updateEffects);
    }

    if ('MutationObserver' in window) {
      new MutationObserver(() => {
        const nextMinimized = stage.classList.contains('is-minimized');
        // Our effect classes also change; only the minimize transition needs work.
        if (nextMinimized === minimized) return;
        minimized = nextMinimized;
        updateEffects();
      }).observe(stage, { attributes: true, attributeFilter: ['class'] });
    }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        const entry = entries.find((item) => item.target === stage);
        if (!entry) return;
        intersecting = entry.isIntersecting && entry.intersectionRatio > 0;
        updateEffects();
      }, { threshold: [0, 0.001] }).observe(stage);
    } else {
      function updateViewportVisibility() {
        const bounds = stage.getBoundingClientRect();
        intersecting = bounds.width > 0 && bounds.height > 0
          && bounds.bottom > 0 && bounds.right > 0
          && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
        minimized = stage.classList.contains('is-minimized');
        updateEffects();
      }
      window.addEventListener('scroll', updateViewportVisibility, { passive: true });
      window.addEventListener('resize', updateViewportVisibility, { passive: true });
      window.addEventListener('pageshow', updateViewportVisibility);
      updateViewportVisibility();
    }

    updateEffects();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeEffects, { once: true });
  } else {
    initializeEffects();
  }
})();
