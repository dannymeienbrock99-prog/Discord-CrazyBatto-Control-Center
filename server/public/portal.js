(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const states = ['unregistered', 'pending', 'approved', 'rejected', 'revoked'];
  let session = null, busy = false, pollTimer = null, returnFocus = null;
  const show = (id, visible) => { $(id).hidden = !visible; };
  const setText = (id, value) => { const node = typeof id === 'string' ? $(id) : id; node.textContent = String(value == null ? '' : value); };
  const dateTime = value => Number.isFinite(value) ? new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'Noch nicht vorhanden';
  function statusMessage(value) { setText('portal-status', value); }
  function errorMessage(error) { setText('portal-error', String(error && error.message || 'Die Verbindung ist gerade nicht verfügbar. Bitte erneut prüfen.').slice(0, 1000)); show('portal-error', true); }
  function clearDownload() { show('download-section', false); $('download-link').removeAttribute('href'); }
  function lock(value) {
    busy = value;
    $('portal-main').setAttribute('aria-busy', String(value));
    ['register-button', 'refresh-button', 'retry-button'].forEach(id => { $(id).disabled = value; });
    document.querySelectorAll('.logout-button').forEach(button => { button.disabled = value; });
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (document.hidden || !session || !session.authenticated) return;
    // Refresh an open portal after decisions without a background push service.
    pollTimer = setTimeout(() => refresh(false), session.access && session.access.status === 'pending' ? 15000 : 60000);
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        if (!session || typeof session.csrfToken !== 'string' || !session.csrfToken) throw new Error('Bitte melde dich erneut mit Discord an.');
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.headers['X-CSRF-Token'] = session.csrfToken;
        options.body = JSON.stringify(body);
      }
      const response = await fetch(path, options);
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('Der Server hat keine lesbare Antwort geliefert. Bitte erneut prüfen.'); }
      if (!response.ok || !result || !result.ok) {
        const error = new Error(result && result.message || 'Die Anfrage konnte nicht abgeschlossen werden.');
        error.kind = result && result.kind; error.status = response.status;
        if (response.status === 401) { session = null; clearDownload(); render(); }
        throw error;
      }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Die Antwort dauert zu lange. Bitte prüfe deinen Status erneut.');
      if (error instanceof TypeError) throw new Error('Der Server ist gerade nicht erreichbar. Bitte prüfe deine Verbindung.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function render() {
    const signedIn = !!(session && session.authenticated && session.user);
    const access = signedIn && session.access;
    const state = access && states.includes(access.status) ? access.status : null;
    show('welcome-view', !signedIn);
    show('registration-view', signedIn && state === 'unregistered');
    show('status-view', signedIn && state !== 'unregistered');
    const configured = session && session.configured === true;
    $('login-link').setAttribute('aria-disabled', String(!configured));
    if (configured) $('login-link').setAttribute('href', '/portal/login');
    else $('login-link').removeAttribute('href');
    document.querySelectorAll('[data-account-name]').forEach(node => setText(node, signedIn ? session.user.displayName || session.user.username || 'Discord-Konto' : ''));
    document.querySelectorAll('[data-account-handle]').forEach(node => setText(node, signedIn && session.user.username ? '@' + session.user.username : ''));
    clearDownload();
    show('download-unavailable', false);
    show('review-note', false);
    if (!signedIn) return;
    if (!state) {
      setText('status-title', 'Zugang wird geprüft'); setText('status-copy', 'Der Freigabestatus ist noch nicht verfügbar. Bitte prüfe die Verbindung erneut.');
      setText('access-label', 'Nicht bestätigt'); show('requested-row', false); show('reviewed-row', false); return;
    }
    const copy = {
      unregistered: ['', '', 'Noch nicht angefragt'],
      pending: ['Deine Anfrage wird geprüft', 'Deine Registrierung ist eingegangen. Du erhältst Zugang, sobald sie persönlich freigegeben wurde.', 'Wartet auf Freigabe'],
      approved: ['Dein Zugang ist freigegeben', 'Du kannst die Crazy_Batto Discord App jetzt herunterladen und dich in der App mit diesem Discord-Konto anmelden.', 'Freigegeben'],
      rejected: ['Deine Anfrage wurde abgelehnt', 'Für dieses Discord-Konto ist der Zugang zur Crazy_Batto Discord App derzeit nicht freigegeben. Bei Rückfragen wende dich an die Verwaltung.', 'Abgelehnt'],
      revoked: ['Dein Zugang wurde gesperrt', 'Die Freigabe für dieses Discord-Konto wurde zurückgenommen. Die App-Verbindung und neue Downloads sind gesperrt.', 'Gesperrt']
    }[state];
    setText('status-title', copy[0]); setText('status-copy', copy[1]); setText('access-label', copy[2]);
    show('requested-row', Number.isFinite(access.requestedAt)); setText('requested-at', dateTime(access.requestedAt));
    show('reviewed-row', Number.isFinite(access.reviewedAt)); setText('reviewed-at', dateTime(access.reviewedAt));
    if (access.reason) { show('review-note', true); setText('review-reason', access.reason); }
    const approved = state === 'approved' && access.canUseApp === true;
    const downloadReady = approved && session.download && session.download.available === true;
    show('download-section', !!downloadReady); show('download-unavailable', approved && !downloadReady);
    if (downloadReady) {
      // The server alone selects the private file. No arbitrary download URL from JSON.
      $('download-link').setAttribute('href', '/portal/download');
      const version = typeof session.download.version === 'string' && /^[\w.+-]{1,40}$/.test(session.download.version) ? session.download.version : '';
      setText('download-meta', version ? 'Version ' + version + ' · APK für Android' : 'APK für Android');
      $('server-address').value = location.origin;
    }
    $('refresh-button').classList.toggle('is-secondary', approved);
  }
  async function refresh(manual) {
    if (busy) return;
    clearTimeout(pollTimer); lock(true); show('portal-error', false); show('retry-button', false);
    if (manual) statusMessage('Status wird geprüft …');
    try {
      const result = await api('/portal/api/session');
      if (result.authenticated && (!result.user || typeof result.user.id !== 'string' || !/^\d{17,20}$/.test(result.user.id))) throw new Error('Die bestätigte Kontoidentität fehlt. Bitte melde dich erneut an.');
      session = result;
      render();
      if (!result.configured) { errorMessage(new Error('Diese App-Instanz wird noch eingerichtet. Die Registrierung ist noch nicht verfügbar.')); show('retry-button', true); statusMessage(''); }
      else statusMessage(manual ? 'Status aktualisiert · ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : '');
    } catch (error) {
      // A previous green state does not keep offering a download after loss of the live check.
      clearDownload(); errorMessage(error); show('retry-button', true); statusMessage('Der aktuelle Freigabestatus konnte nicht bestätigt werden.');
    } finally { lock(false); schedule(); }
  }
  async function register(event) {
    event.preventDefault();
    if (busy || !session || !session.authenticated || !session.access || session.access.status !== 'unregistered') return;
    lock(true); clearTimeout(pollTimer); show('portal-error', false); statusMessage('Deine Anfrage wird gesendet …');
    try {
      const note = $('registration-note').value.trim();
      if (note.length > 500) throw new Error('Deine Nachricht darf höchstens 500 Zeichen haben.');
      const result = await api('/portal/api/register', { note });
      if (!result.access || !states.includes(result.access.status)) throw new Error('Die Bestätigung fehlt. Bitte prüfe deinen Status, bevor du erneut sendest.');
      session.access = result.access;
      $('registration-note').value = '';
      render(); statusMessage('Deine Anfrage wurde gespeichert.'); $('status-title').tabIndex = -1; $('status-title').focus({ preventScroll: true });
    } catch (error) { errorMessage(error); statusMessage('Bitte prüfe den Status, wenn eine Bestätigung fehlt.'); show('retry-button', true); }
    finally { lock(false); schedule(); }
  }
  async function logout() {
    if (busy) return;
    lock(true); clearTimeout(pollTimer); show('portal-error', false);
    try { await api('/portal/api/logout', {}); session = { ok: true, configured: true, authenticated: false }; render(); statusMessage('Du bist abgemeldet.'); }
    catch (error) { errorMessage(error); }
    finally { lock(false); schedule(); }
  }
  function openDialog(id) { returnFocus = document.activeElement; $(id).showModal(); $(id).querySelector('.dialog-close').focus(); }
  document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true }); }));
  $('privacy-open').addEventListener('click', () => openDialog('privacy-dialog'));
  $('admin-open').addEventListener('click', () => openDialog('admin-dialog'));
  $('registration-form').addEventListener('submit', register);
  $('copy-server').addEventListener('click', async () => {
    const address = $('server-address');
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(address.value);
      statusMessage('Serveradresse kopiert. Du kannst sie in der App einfügen.');
    } catch (_) { address.focus(); address.select(); statusMessage('Die Serveradresse ist markiert. Kopiere sie über das Auswahlmenü.'); }
  });
  $('refresh-button').addEventListener('click', () => refresh(true));
  $('retry-button').addEventListener('click', () => refresh(true));
  document.querySelectorAll('.logout-button').forEach(button => button.addEventListener('click', logout));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); else clearTimeout(pollTimer); });
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(false); });
  render(); refresh(false);
}());
