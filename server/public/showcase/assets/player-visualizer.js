(() => {
  'use strict';

  function initializeVisualizer() {
    const audio = document.getElementById('audioPlayer');
    const canvas = document.getElementById('visualizer');
    if (!audio || !canvas || typeof canvas.getContext !== 'function') return;

    const painter = canvas.getContext('2d');
    if (!painter) return;

    const Context = window.AudioContext || window.webkitAudioContext;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let audioContext = null;
    let source = null;
    let analyser = null;
    let frequencyData = null;
    let initialization = null;
    let unavailable = !Context;
    let connected = false;
    let frame = 0;
    let lastPaint = 0;
    let width = 160;
    let height = 64;
    let buffering = false;

    function drawBaseline() {
      painter.clearRect(0, 0, width, height);
      painter.fillStyle = 'rgba(235, 186, 68, 0.28)';
      painter.fillRect(2, Math.max(0, height - 3), Math.max(0, width - 4), 1);
    }

    function fitCanvas() {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.round(bounds.width || 160));
      height = Math.max(1, Math.round(bounds.height || 64));
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      painter.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawBaseline();
    }

    function stopAnimation() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastPaint = 0;
      drawBaseline();
    }

    function canAnimate() {
      return connected && analyser && audioContext?.state === 'running'
        && !audio.paused && !audio.ended && !buffering
        && audio.readyState >= 2 && !document.hidden;
    }

    function drawFrequencies() {
      analyser.getByteFrequencyData(frequencyData);
      drawBaseline();

      const barCount = Math.max(8, Math.min(28, Math.floor(width / 7)));
      const spacing = (width - 4) / barCount;
      const barWidth = Math.max(1, Math.floor(spacing - 2));
      const blockHeight = 3;
      const blockStep = 5;
      const maximumBlocks = Math.max(1, Math.floor((height - 6) / blockStep));
      const nyquist = audioContext.sampleRate / 2;
      const lowestFrequency = 45;
      const highestFrequency = Math.min(14000, nyquist);
      const gradient = painter.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#fff0a4');
      gradient.addColorStop(0.45, '#f6ce63');
      gradient.addColorStop(1, '#d4a22d');
      painter.fillStyle = gradient;

      for (let bar = 0; bar < barCount; bar += 1) {
        const startFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** (bar / barCount);
        const endFrequency = lowestFrequency * (highestFrequency / lowestFrequency) ** ((bar + 1) / barCount);
        const startBin = Math.min(frequencyData.length - 1, Math.floor(startFrequency / nyquist * frequencyData.length));
        const endBin = Math.min(frequencyData.length, Math.max(startBin + 1, Math.ceil(endFrequency / nyquist * frequencyData.length)));
        let sum = 0;
        for (let bin = startBin; bin < endBin; bin += 1) sum += frequencyData[bin] ** 2;
        const level = Math.sqrt(sum / (endBin - startBin)) / 255;
        const blocks = Math.floor(level ** 0.85 * maximumBlocks);
        const x = Math.round(2 + bar * spacing);
        for (let block = 0; block < blocks; block += 1) {
          painter.fillRect(x, height - 6 - block * blockStep, barWidth, blockHeight);
        }
      }
    }

    function animate(timestamp) {
      frame = 0;
      if (!canAnimate()) {
        stopAnimation();
        return;
      }
      // The reduced-motion setting keeps real measurements but greatly slows changes.
      const interval = reducedMotion.matches ? 250 : 1000 / 30;
      if (!lastPaint || timestamp - lastPaint >= interval) {
        drawFrequencies();
        lastPaint = timestamp;
      }
      frame = window.requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (canAnimate() && !frame) frame = window.requestAnimationFrame(animate);
    }

    async function connectAnalyser() {
      if (unavailable) return false;
      if (initialization) return initialization;
      initialization = (async () => {
        try {
          if (!audioContext) {
            audioContext = new Context();
            audioContext.addEventListener('statechange', () => {
              if (audioContext.state === 'running') startAnimation();
              else stopAnimation();
            });
          }
          // Do not capture the media element until an audio context can actually play.
          if (audioContext.state === 'suspended') await audioContext.resume();
          if (audioContext.state !== 'running') return false;
          if (!source) {
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.74;
            analyser.minDecibels = -85;
            analyser.maxDecibels = -15;
            frequencyData = new Uint8Array(analyser.frequencyBinCount);
            source = audioContext.createMediaElementSource(audio);
            // A direct output preserves playback independently of the visual branch.
            source.connect(audioContext.destination);
            source.connect(analyser);
            connected = true;
          }
          return connected;
        } catch {
          // Unsupported or blocked Web Audio leaves an unobtrusive, still baseline.
          // A media source, once created, is deliberately never recreated.
          if (source || !audioContext) unavailable = true;
          return false;
        }
      })();
      try {
        return await initialization;
      } finally {
        initialization = null;
      }
    }

    async function handlePlayback() {
      if (await connectAnalyser()) startAnimation();
    }

    // AudioContext creation is deferred until genuine playback begins.
    audio.addEventListener('play', () => { void handlePlayback(); });
    audio.addEventListener('playing', () => {
      buffering = false;
      void handlePlayback();
    });
    audio.addEventListener('waiting', () => {
      buffering = true;
      stopAnimation();
    });
    for (const event of ['pause', 'ended', 'emptied', 'error']) {
      audio.addEventListener(event, () => {
        buffering = false;
        stopAnimation();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAnimation();
      else if (!audio.paused && !audio.ended) void handlePlayback();
    });
    reducedMotion.addEventListener?.('change', () => {
      stopAnimation();
      startAnimation();
    });
    if ('ResizeObserver' in window) new ResizeObserver(fitCanvas).observe(canvas);
    else window.addEventListener('resize', fitCanvas, { passive: true });
    fitCanvas();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeVisualizer, { once: true });
  } else {
    initializeVisualizer();
  }
})();
