// One same-origin account boundary for the website and music player.
let currentSession = null;
let sessionGeneration = 0;

function accountChanged(user) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('cb-account-changed', { detail: { user } }));
  try { localStorage.setItem('cb-account-change', JSON.stringify({ at: Date.now(), nonce: Math.random(), userId: user?.id || null })); } catch {}
}

async function clearChatDeviceBinding(generation) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const worker = registration?.active || navigator.serviceWorker.controller;
    if (worker && generation === sessionGeneration) worker.postMessage({ type: 'CHAT_BIND', userId: null, enabled: false });
  } catch {}
}

async function unregisterChatDevice(generation) {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription || generation !== sessionGeneration) return;
    try { await api('/api/community/push', { method: 'DELETE', body: { endpoint: subscription.endpoint }, timeout: 4000 }); } catch {}
    if (generation === sessionGeneration) await subscription.unsubscribe().catch(() => {});
  } catch {}
}

export class ApiError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, raw = false, headers = {}, timeout = 20000, csrf = true } = {}) {
  const generation = sessionGeneration;
  if (!path.startsWith('/api/')) throw new ApiError('Ungültige Serveradresse.', 'INVALID_API_PATH');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (!['GET', 'HEAD'].includes(method) && csrf) {
      if (!currentSession?.csrfToken) await getSession();
      if (generation !== sessionGeneration) throw new ApiError('Die Anmeldung hat sich geändert. Bitte die Aktion erneut auswählen.', 'SESSION_CHANGED', 409);
      if (!currentSession?.user || !currentSession.csrfToken) throw new ApiError('Bitte melde dich zuerst an.', 'LOGIN_REQUIRED', 401);
      requestHeaders['X-CSRF-Token'] = currentSession.csrfToken;
    }
    if (body !== undefined && !raw) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', headers: requestHeaders,
      signal: controller.signal, ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new ApiError('Der Server hat keine lesbare Antwort geliefert. Bitte später erneut versuchen.', 'INVALID_RESPONSE', response.status); }
    if (!response.ok || result?.error) {
      if (response.status === 401 && generation === sessionGeneration) currentSession = null;
      throw new ApiError(result?.error?.message || result?.message || 'Die Anfrage konnte nicht abgeschlossen werden.', result?.error?.code || result?.kind || 'REQUEST_FAILED', response.status);
    }
    if (!result || typeof result !== 'object') throw new ApiError('Die Bestätigung des Servers fehlt.', 'INVALID_RESPONSE', response.status);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') throw new ApiError('Der Server antwortet gerade nicht. Bitte erneut versuchen.', 'TIMEOUT');
    throw new ApiError('Die Verbindung zum Server ist nicht verfügbar. Bitte prüfe deine Internetverbindung.', 'NETWORK_ERROR');
  } finally { clearTimeout(timer); }
}

export async function getSession() {
  const generation = sessionGeneration;
  const result = await api('/api/account/session');
  if (!Object.hasOwn(result, 'user') || (result.user && (typeof result.user.id !== 'string' || typeof result.csrfToken !== 'string'))) {
    if (generation === sessionGeneration) currentSession = null;
    throw new ApiError('Deine Anmeldung konnte nicht bestätigt werden.', 'INVALID_SESSION');
  }
  if (generation === sessionGeneration) currentSession = result;
  return result;
}

export async function login(email, password) {
  const generation = ++sessionGeneration;
  currentSession = null;
  const result = await api('/api/account/login', { method: 'POST', body: { email, password }, csrf: false });
  if (!result.user || typeof result.csrfToken !== 'string') throw new ApiError('Deine Anmeldung konnte nicht bestätigt werden.', 'INVALID_SESSION');
  if (generation === sessionGeneration) { sessionGeneration++; currentSession = result; accountChanged(result.user); }
  return result;
}

export async function register(name, email, password, birthDate, birthdayShared = false) {
  return api('/api/account/register', { method: 'POST', body: { name, email, password, birthDate, birthdayShared }, csrf: false });
}

export async function logout() {
  const generation = ++sessionGeneration;
  await unregisterChatDevice(generation);
  if (generation !== sessionGeneration) throw new ApiError('Die Anmeldung hat sich geändert. Bitte erneut auswählen.', 'SESSION_CHANGED', 409);
  const result = await api('/api/account/logout', { method: 'POST', body: {} });
  if (generation === sessionGeneration) { sessionGeneration++; currentSession = null; accountChanged(null); await clearChatDeviceBinding(sessionGeneration); }
  return result;
}

export function errorText(error) { return error?.message || 'Die Anfrage konnte nicht abgeschlossen werden.'; }

export function storageStatusText(storage) {
  if (storage?.configured === false) return 'Der Musikspeicher ist noch nicht eingerichtet. Uploads und Wiedergabe stehen nach der Einrichtung zur Verfügung.';
  if (storage?.online === true) return 'Musikspeicher verbunden.';
  if (storage?.configured === true) return 'Der Musikspeicher ist offline. Uploads und Wiedergabe sind derzeit nicht verfügbar. Bitte die Speicherverbindung prüfen.';
  return 'Der Status des Musikspeichers ist gerade nicht verfügbar. Bitte die Seite aktualisieren.';
}

export function statusLabel(status) {
  return ({ pending: 'Wartet auf Freigabe', approved: 'Freigegeben', rejected: 'Abgelehnt', revoked: 'Zugang gesperrt' })[status] || 'Unbekannter Status';
}

export function formatDate(value) {
  if (value === null || value === undefined || value === '') return '–';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}
