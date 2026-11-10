import { ApiError, getSession, errorText } from './account-client.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const MAX_RECORDING_MS = 5 * 60 * 1000;
const create = (tag, text = '', className = '') => { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; };
const sizeText = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.ceil(bytes / 1024)) + ' KB';
const timeText = milliseconds => { const seconds = Math.floor(milliseconds / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
const button = (label, action) => { const element = create('button', label, 'cc-button secondary'); element.type = 'button'; element.addEventListener('click', action); return element; };
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
let activeVoice = null, activeImageDialog = null;

function voiceBubble(src, { durationMs = null, preview = false } = {}) {
  const element = create('div', '', 'cm-voice'), audio = create('audio'), timeline = create('input');
  const main = create('div', '', 'cm-voice-main'), meta = create('div', '', 'cm-voice-meta'), times = create('span', '', 'cm-voice-time');
  const feedback = create('p', '', 'cm-voice-feedback'); feedback.setAttribute('role', 'status');
  element.setAttribute('role', 'group'); element.setAttribute('aria-label', preview ? 'Aufnahme vor dem Senden anhören' : 'Sprachnachricht');
  audio.hidden = true; audio.controls = false; audio.preload = 'none'; audio.src = src;
  audio.setAttribute('playsinline', ''); audio.setAttribute('aria-hidden', 'true');
  timeline.type = 'range'; timeline.min = '0'; timeline.max = '1'; timeline.step = '0.1'; timeline.value = '0'; timeline.disabled = true;
  timeline.className = 'cm-voice-seek'; timeline.setAttribute('aria-label', 'Position in der Sprachnachricht');
  let loading = false, playVersion = 0, disposed = false;
  const play = button('▶', () => void toggle()); play.className = 'cm-voice-play';
  const speed = button('1×', () => {
    const rates = [1, 1.5, 2], next = rates[(rates.indexOf(audio.playbackRate || 1) + 1) % rates.length];
    audio.playbackRate = next; speed.textContent = String(next).replace('.', ',') + '×';
    speed.setAttribute('aria-label', 'Geschwindigkeit ' + String(next).replace('.', ',') + '-fach. Tippen zum Ändern.');
  });
  speed.className = 'cm-voice-speed'; speed.setAttribute('aria-label', 'Geschwindigkeit 1-fach. Tippen zum Ändern.');
  meta.append(times, speed); main.append(create('span', preview ? 'Deine Aufnahme' : 'Sprachnachricht', 'cm-voice-label'), timeline, meta);
  element.append(audio, play, main, feedback);
  function duration() {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    if (Number.isFinite(durationMs) && durationMs > 0) return durationMs / 1000;
    try { const end = audio.seekable?.length ? audio.seekable.end(audio.seekable.length - 1) : 0; if (Number.isFinite(end) && end > 0) return end; } catch {}
    return 0;
  }
  function tell(message, error = false) { feedback.textContent = message; feedback.classList.toggle('is-error', error); }
  function update() {
    const total = duration(), current = Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : 0), playing = activeVoice?.audio === audio && (loading || !audio.paused);
    play.textContent = playing ? 'Ⅱ' : '▶'; play.setAttribute('aria-label', playing ? 'Sprachnachricht pausieren' : 'Sprachnachricht abspielen');
    play.setAttribute('aria-pressed', String(playing)); element.classList.toggle('is-playing', playing); element.classList.toggle('is-loading', loading);
    times.textContent = timeText(current * 1000) + (total ? ' / ' + timeText(total * 1000) : '');
    timeline.max = String(total || 1); timeline.value = String(Math.min(current, total || 0)); timeline.disabled = !total;
    timeline.setAttribute('aria-valuetext', timeText(current * 1000) + (total ? ' von ' + timeText(total * 1000) : ''));
  }
  function pause() {
    playVersion++; loading = false; audio.pause();
    if (activeVoice?.audio === audio) activeVoice = null;
    if (!disposed) { tell(''); update(); }
  }
  async function toggle() {
    if (disposed) return;
    if (activeVoice?.audio === audio && (loading || !audio.paused)) { pause(); return; }
    activeVoice?.pause(); activeVoice = { audio, pause };
    const version = ++playVersion; loading = true; tell('Wird geladen …'); update();
    try {
      if (audio.error) audio.load();
      if (audio.ended) audio.currentTime = 0;
      await audio.play();
      if (disposed || version !== playVersion || activeVoice?.audio !== audio) { audio.pause(); return; }
      loading = false; tell(''); update();
    } catch (error) {
      if (disposed || version !== playVersion) return;
      loading = false; if (activeVoice?.audio === audio) activeVoice = null;
      tell(error.name === 'NotAllowedError' ? 'Tippe erneut auf Wiedergabe, um die Sprachnachricht zu hören.' : 'Die Sprachnachricht konnte nicht geladen werden. Tippe auf Wiedergabe, um es erneut zu versuchen.', true); update();
    }
  }
  timeline.addEventListener('input', () => {
    const total = duration(); if (!total || disposed) return;
    try { audio.currentTime = Math.min(total, Math.max(0, Number(timeline.value) || 0)); update(); }
    catch { tell('Diese Stelle ist noch nicht geladen. Bitte starte zuerst die Wiedergabe.'); }
  });
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'seeked']) audio.addEventListener(event, update);
  audio.addEventListener('playing', () => { if (activeVoice?.audio !== audio) { audio.pause(); return; } loading = false; tell(''); update(); });
  audio.addEventListener('waiting', () => { if (activeVoice?.audio === audio) { loading = true; tell('Wird geladen …'); update(); } });
  audio.addEventListener('pause', () => { loading = false; if (activeVoice?.audio === audio) activeVoice = null; update(); });
  audio.addEventListener('ended', () => { loading = false; if (activeVoice?.audio === audio) activeVoice = null; tell(''); update(); });
  audio.addEventListener('error', () => { loading = false; if (activeVoice?.audio === audio) activeVoice = null; tell('Die Sprachnachricht ist gerade nicht verfügbar. Tippe auf Wiedergabe, um es erneut zu versuchen.', true); update(); });
  update();
  return { element, audio, dispose() { disposed = true; pause(); audio.removeAttribute('src'); audio.load(); } };
}

function imageView(src, name, { width, height } = {}) {
  const element = create('div', '', 'cm-image'), picture = create('img'), feedback = create('span', 'Bild wird geladen …', 'cm-image-status');
  const open = button('', () => {
    if (activeImageDialog) activeImageDialog.close();
    const dialog = create('dialog', '', 'cm-lightbox'), heading = create('div', '', 'cm-lightbox-heading'), stage = create('div', '', 'cm-lightbox-stage');
    const enlarged = create('img'); enlarged.src = src; enlarged.alt = name;
    const close = button('Schließen', () => dialog.close()), zoom = button('Vergrößern', () => {
      const zoomed = zoom.getAttribute('aria-pressed') !== 'true'; zoom.setAttribute('aria-pressed', String(zoomed));
      zoom.textContent = zoomed ? 'Einpassen' : 'Vergrößern'; stage.classList.toggle('is-zoomed', zoomed);
    });
    close.className = 'cm-lightbox-close'; zoom.className = 'cm-lightbox-zoom'; zoom.setAttribute('aria-pressed', 'false');
    dialog.setAttribute('aria-label', 'Bildansicht: ' + name); heading.append(create('strong', name), zoom, close); stage.append(enlarged); dialog.append(heading, stage); element.append(dialog);
    dialog.addEventListener('close', () => { if (activeImageDialog === dialog) activeImageDialog = null; dialog.remove(); if (open.isConnected) open.focus(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    enlarged.addEventListener('error', () => { stage.replaceChildren(create('p', 'Das Bild konnte nicht geladen werden. Schließe diese Ansicht und versuche es erneut.')); });
    activeImageDialog = dialog; dialog.showModal(); close.focus();
  });
  open.className = 'cm-image-open'; open.setAttribute('aria-label', name + ' im Chat vergrößern');
  picture.src = src; picture.alt = name; picture.loading = 'lazy'; picture.decoding = 'async';
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) { picture.width = width; picture.height = height; }
  picture.addEventListener('load', () => { feedback.textContent = 'Antippen zum Vergrößern'; element.classList.add('is-loaded'); });
  picture.addEventListener('error', () => { open.hidden = true; feedback.textContent = 'Keine Bildvorschau verfügbar. Du kannst die Datei herunterladen.'; element.classList.add('is-error'); });
  open.append(picture); element.append(open, feedback); return element;
}

window.addEventListener('pagehide', () => { activeVoice?.pause(); activeImageDialog?.close(); });

/** Files remain local until prepareUploads(). Call clear() only after the message is acknowledged. */
export function createChatMediaComposer({ threadId, onChange = () => {}, onError = () => {}, isAllowed = () => true }) {
  const element = create('section', '', 'cm-composer');
  element.setAttribute('aria-label', 'Dateien und Sprachnachrichten');
  const actions = create('div', '', 'cm-actions'), fileInput = create('input'), list = create('div', '', 'cm-drafts');
  const feedback = create('p', '', 'cm-feedback'), recordingBox = create('div', '', 'cm-recording'), recordingTime = create('span');
  feedback.setAttribute('role', 'status');
  recordingTime.setAttribute('aria-live', 'off');
  fileInput.type = 'file'; fileInput.multiple = true; fileInput.hidden = true; fileInput.setAttribute('aria-label', 'Dateien auswählen');
  const files = [];
  let disposed = false, disabled = false, uploading = false, generation = 0, recording = null;
  const activeRequests = new Set();
  const allowed = () => !disposed && isAllowed();
  const tell = (text, error = false) => { feedback.textContent = text; feedback.classList.toggle('is-error', error); };
  const fail = error => { if (!disposed) { tell(errorText(error), true); onError(error); } };
  const changed = () => { updateControls(); if (!disposed) onChange(); };
  const choose = button('Datei anhängen', () => { if (allowed() && !disabled && !uploading && !recording) fileInput.click(); });
  const record = button('Sprachnachricht aufnehmen', () => void beginRecording());
  const stop = button('Aufnahme beenden', () => finishRecording(false));
  const cancel = button('Verwerfen', () => finishRecording(true));
  recordingBox.hidden = true;
  recordingBox.append(create('span', '● Aufnahme', 'cm-recording-label'), recordingTime, stop, cancel);
  actions.append(choose, record, fileInput);
  element.append(actions, create('p', 'Bis zu 5 Dateien · je 20 MB · Sprachnachrichten bis 5 Minuten', 'cm-help'), recordingBox, list, feedback);

  function updateControls() {
    const blocked = !allowed() || disabled || uploading;
    choose.disabled = blocked || !!recording || files.length >= MAX_ATTACHMENTS;
    record.disabled = blocked || !!recording || files.length >= MAX_ATTACHMENTS;
    fileInput.disabled = choose.disabled;
    for (const item of files) item.remove.disabled = blocked;
    recordingBox.hidden = !recording;
    stop.disabled = !recording?.recorder || recording.recorder.state !== 'recording';
    cancel.disabled = !recording;
  }
  function status(item, text, error = false) {
    item.status.textContent = text;
    item.status.classList.toggle('is-error', error);
  }
  function discardItem(item) {
    if (item.voice) item.voice.dispose();
    if (item.url) URL.revokeObjectURL(item.url);
    item.row.remove();
  }
  function addFile(file, kind = 'file', durationMs = null) {
    if (!allowed()) return;
    if (!file.size) { fail(new Error('Diese Datei ist leer. Bitte wähle eine andere Datei.')); return; }
    if (file.size > MAX_BYTES) { fail(new Error('„' + file.name + '“ ist zu groß. Erlaubt sind höchstens 20 MB je Datei.')); return; }
    if (files.length >= MAX_ATTACHMENTS) { fail(new Error('Du kannst höchstens 5 Dateien pro Nachricht senden.')); return; }
    const item = { file, kind, durationMs, uploadId: crypto.randomUUID(), attachmentId: null, url: null };
    item.row = create('div', '', 'cm-draft');
    const info = create('div', '', 'cm-file-info');
    info.append(create('strong', kind === 'voice' ? 'Sprachnachricht · ' + timeText(durationMs || 0) : file.name), create('span', sizeText(file.size), 'cm-file-size'));
    item.status = create('span', 'Bereit zum Senden', 'cm-file-status');
    item.status.setAttribute('role', 'status');
    item.remove = button('Entfernen', () => {
      if (disabled || uploading || !allowed()) return;
      files.splice(files.indexOf(item), 1); discardItem(item); tell(''); changed(); choose.focus();
    });
    item.remove.setAttribute('aria-label', kind === 'voice' ? 'Sprachnachricht entfernen' : file.name + ' entfernen');
    item.row.append(info, item.remove);
    if (kind === 'voice') {
      item.url = URL.createObjectURL(file); item.voice = voiceBubble(item.url, { durationMs, preview: true }); item.row.append(item.voice.element);
    } else if (IMAGE_TYPES.has(file.type) && file.size <= 8 * 1024 * 1024) {
      item.url = URL.createObjectURL(file); item.row.append(imageView(item.url, file.name));
    }
    item.row.append(item.status); files.push(item); list.append(item.row); changed();
  }
  fileInput.addEventListener('change', () => {
    if (allowed() && !disabled && !uploading && !recording) { tell(''); for (const file of fileInput.files || []) addFile(file); }
    fileInput.value = '';
  });

  async function beginRecording() {
    if (!allowed() || disabled || uploading || recording || files.length >= MAX_ATTACHMENTS) return;
    activeVoice?.pause();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      fail(new Error('Dieser Browser kann keine Sprachnachrichten aufnehmen. Du kannst stattdessen eine Audiodatei anhängen.')); return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) { fail(new Error('Dein Browser unterstützt kein passendes Aufnahmeformat. Bitte hänge eine Audiodatei an.')); return; }
    const session = { stream: null, recorder: null, chunks: [], bytes: 0, cancelled: false, startedAt: 0, durationMs: 0, timer: null };
    recording = session; recordingTime.textContent = 'Mikrofon wird angefragt …'; tell('Erlaube den Mikrofonzugriff, um die Aufnahme zu starten.'); changed();
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed || session !== recording || session.cancelled || !allowed()) { stopTracks(session.stream); return; }
      session.recorder = new MediaRecorder(session.stream, { mimeType, audioBitsPerSecond: 96000 });
      session.recorder.addEventListener('dataavailable', event => {
        if (session.cancelled || disposed || session !== recording) return;
        if (event.data?.size) { session.chunks.push(event.data); session.bytes += event.data.size; }
        if (session.bytes > MAX_BYTES) { finishRecording(true); fail(new Error('Die Aufnahme ist zu groß geworden. Bitte nimm eine kürzere Nachricht auf.')); }
      });
      session.recorder.addEventListener('error', () => {
        if (session !== recording) return;
        finishRecording(true); fail(new Error('Die Aufnahme wurde unterbrochen. Bitte versuche es erneut.'));
      });
      session.recorder.addEventListener('stop', () => {
        stopTracks(session.stream); clearInterval(session.timer);
        if (session !== recording || disposed) return;
        recording = null; changed();
        if (session.cancelled) return;
        const durationMs = session.durationMs || Date.now() - session.startedAt;
        if (durationMs > MAX_RECORDING_MS + 1500) { fail(new Error('Die Aufnahme ist länger als 5 Minuten. Bitte nimm eine kürzere Nachricht auf.')); return; }
        const blob = new Blob(session.chunks, { type: session.recorder.mimeType || mimeType });
        if (!blob.size) { fail(new Error('Es wurde kein Ton aufgenommen. Bitte prüfe dein Mikrofon und versuche es erneut.')); return; }
        const extension = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
        addFile(new File([blob], 'Sprachnachricht-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + extension, { type: blob.type }), 'voice', Math.min(durationMs, MAX_RECORDING_MS));
        tell('Du kannst die Aufnahme anhören. Erst mit „Senden“ wird sie verschickt.');
      });
      session.recorder.start(1000); session.startedAt = Date.now(); recordingTime.textContent = '0:00 / 5:00';
      tell('Aufnahme läuft. Tippe auf „Aufnahme beenden“, wenn du fertig bist.'); changed();
      session.timer = setInterval(() => {
        if (session !== recording) return;
        const elapsed = Date.now() - session.startedAt;
        recordingTime.textContent = timeText(Math.min(elapsed, MAX_RECORDING_MS)) + ' / 5:00';
        if (elapsed >= MAX_RECORDING_MS) finishRecording(false);
      }, 250);
    } catch (error) {
      stopTracks(session.stream); clearInterval(session.timer);
      if (session !== recording || disposed) return;
      recording = null; changed();
      const message = ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'Der Mikrofonzugriff wurde nicht erlaubt. Gib das Mikrofon in den Browser-Einstellungen frei oder hänge eine Audiodatei an.'
        : error.name === 'NotFoundError' ? 'Es wurde kein Mikrofon gefunden. Schließe ein Mikrofon an oder hänge eine Audiodatei an.'
          : 'Das Mikrofon konnte nicht gestartet werden. Prüfe, ob eine andere App es gerade verwendet.';
      fail(new Error(message));
    }
  }
  function finishRecording(discard) {
    const session = recording;
    if (!session) return;
    session.cancelled = discard;
    session.durationMs = session.startedAt ? Date.now() - session.startedAt : 0;
    clearInterval(session.timer);
    if (discard) { recording = null; tell('Aufnahme verworfen.'); }
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    else if (!session.recorder) recording = null;
    stopTracks(session.stream); changed();
  }

  function upload(item, csrfToken, batchGeneration) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); activeRequests.add(xhr);
      let finished = false;
      const complete = (error, value) => {
        if (finished) return; finished = true; activeRequests.delete(xhr);
        if (error) { status(item, errorText(error) + ' Erneut auf „Senden“ tippen.', true); reject(error); } else resolve(value);
      };
      xhr.open('POST', '/api/community/threads/' + encodeURIComponent(threadId) + '/attachments');
      xhr.timeout = 120000; xhr.withCredentials = true;
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-CSRF-Token', csrfToken);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
      xhr.setRequestHeader('X-Attachment-Kind', item.kind);
      xhr.setRequestHeader('X-Upload-Id', item.uploadId);
      xhr.upload.addEventListener('progress', event => {
        if (disposed || batchGeneration !== generation) return;
        status(item, event.lengthComputable ? 'Wird hochgeladen … ' + Math.round(event.loaded / event.total * 100) + ' %' : 'Wird hochgeladen …');
      });
      xhr.addEventListener('load', () => {
        if (disposed || batchGeneration !== generation) { complete(new ApiError('Der Upload wurde abgebrochen.', 'UPLOAD_CANCELLED')); return; }
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { complete(new ApiError('Die Upload-Bestätigung fehlt.', 'INVALID_RESPONSE', xhr.status)); return; }
        if (xhr.status < 200 || xhr.status >= 300 || result?.error) { complete(new ApiError(result?.error?.message || 'Die Datei konnte nicht hochgeladen werden.', result?.error?.code || 'UPLOAD_FAILED', xhr.status)); return; }
        if (typeof result?.attachment?.id !== 'string') { complete(new ApiError('Die Upload-Bestätigung fehlt.', 'INVALID_RESPONSE', xhr.status)); return; }
        item.attachmentId = result.attachment.id; status(item, 'Hochgeladen · wird mit der Nachricht gesendet'); complete(null, item.attachmentId);
      });
      xhr.addEventListener('error', () => complete(new ApiError('Der Upload wurde unterbrochen. Deine Datei bleibt ausgewählt.', 'NETWORK_ERROR')));
      xhr.addEventListener('timeout', () => complete(new ApiError('Der Upload dauert zu lange. Deine Datei bleibt ausgewählt.', 'TIMEOUT')));
      xhr.addEventListener('abort', () => complete(new ApiError('Der Upload wurde abgebrochen.', 'UPLOAD_CANCELLED')));
      status(item, 'Wird hochgeladen …'); xhr.send(item.file);
    });
  }
  async function prepareUploads() {
    if (!allowed()) throw new ApiError('Dieser Chat ist nicht zum Senden freigegeben.', 'THREAD_CLOSED', 403);
    if (recording) throw new Error('Bitte beende zuerst deine Sprachnachricht.');
    if (uploading) throw new Error('Deine Dateien werden bereits hochgeladen.');
    if (!files.length) return [];
    const snapshot = [...files], batchGeneration = generation;
    uploading = true; updateControls();
    try {
      const session = await getSession();
      if (disposed || batchGeneration !== generation) throw new ApiError('Der Upload wurde abgebrochen.', 'UPLOAD_CANCELLED');
      if (!session.user || !session.csrfToken) throw new ApiError('Bitte melde dich erneut an.', 'LOGIN_REQUIRED', 401);
      const result = [];
      for (const item of snapshot) {
        if (disposed || batchGeneration !== generation || !allowed()) throw new ApiError('Der Upload wurde abgebrochen.', 'UPLOAD_CANCELLED');
        result.push(item.attachmentId || await upload(item, session.csrfToken, batchGeneration));
      }
      return result;
    } finally { uploading = false; updateControls(); }
  }
  function clear() {
    generation++; finishRecording(true);
    for (const xhr of activeRequests) xhr.abort();
    for (const item of files) discardItem(item);
    files.length = 0; fileInput.value = ''; tell(''); changed();
  }
  const onPageHide = () => finishRecording(true);
  window.addEventListener('pagehide', onPageHide);
  updateControls();
  return {
    element, prepareUploads, clear,
    hasPending: () => files.length > 0 || !!recording,
    isRecording: () => !!recording,
    setDisabled(value) { disabled = !!value; updateControls(); },
    dispose() {
      if (disposed) return; disposed = true;
      clear(); window.removeEventListener('pagehide', onPageHide); element.remove();
    },
  };
}

/** Render only private, same-origin attachment endpoints; names always stay plain text. */
export function renderChatAttachments(attachments = []) {
  const list = create('div', '', 'cm-attachments');
  if (!Array.isArray(attachments)) return list;
  for (const attachment of attachments) {
    let url;
    try { url = new URL(attachment.url || '', location.origin); } catch { continue; }
    if (url.origin !== location.origin || !/^\/api\/community\/threads\/[a-zA-Z0-9-]+\/attachments\/[a-zA-Z0-9-]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) continue;
    const item = create('div', '', 'cm-attachment'), name = typeof attachment.name === 'string' ? attachment.name : attachment.kind === 'voice' ? 'Sprachnachricht' : 'Datei';
    if (attachment.kind === 'voice') {
      const durationMs = Number.isFinite(attachment.durationSeconds) ? attachment.durationSeconds * 1000 : attachment.durationMs;
      item.classList.add('is-voice'); item.append(voiceBubble(url.href, { durationMs }).element); list.append(item); continue;
    }
    if (typeof attachment.previewUrl === 'string' && (!attachment.previewMimeType || IMAGE_TYPES.has(attachment.previewMimeType))) {
      let preview;
      try { preview = new URL(attachment.previewUrl, location.origin); } catch {}
      if (preview && preview.origin === location.origin && preview.pathname === url.pathname + '/preview' && !preview.username && !preview.password && !preview.search && !preview.hash) {
        item.classList.add('is-image'); item.append(imageView(preview.href, name, attachment));
      }
    }
    const link = create('a', name, 'cm-download'); link.href = url.href; link.download = name;
    item.append(link);
    if (Number.isFinite(attachment.size) && attachment.size >= 0) item.append(create('span', sizeText(attachment.size), 'cm-file-size'));
    list.append(item);
  }
  return list;
}
