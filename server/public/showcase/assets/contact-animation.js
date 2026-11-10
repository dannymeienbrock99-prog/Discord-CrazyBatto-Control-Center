(() => {
  'use strict';
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.querySelectorAll('[data-contact-animation]').forEach(figure => {
    const motion = figure.querySelector('[data-contact-motion]');
    const still = figure.querySelector('[data-contact-still]');
    const toggle = figure.querySelector('[data-contact-toggle]');
    if (!motion || !still || !toggle) return;
    let paused = preference.matches;
    let visible = !('IntersectionObserver' in window);
    let failed = false;
    const update = () => {
      const playing = visible && !paused && !failed;
      if (playing && !motion.getAttribute('src')) motion.src = motion.dataset.src;
      motion.hidden = !playing;
      still.hidden = playing;
      if (!playing) motion.removeAttribute('src');
      toggle.textContent = failed ? 'Animation nicht verfügbar' : paused ? 'Animation abspielen' : 'Animation pausieren';
      toggle.setAttribute('aria-pressed', String(paused));
      toggle.disabled = failed;
    };
    motion.addEventListener('error', () => { if (!motion.getAttribute('src')) return; failed = true; update(); });
    toggle.hidden = false;
    toggle.addEventListener('click', () => { paused = !paused; update(); });
    preference.addEventListener('change', event => { paused = event.matches; update(); });
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting; update();
      }, { rootMargin: '100px' });
      observer.observe(figure);
    }
    update();
  });
})();
