import { AppError, assert } from './errors.mjs';

export function validPublicAuthConfig(url, key) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
      || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) return false;
    if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) return true;
    const claims = JSON.parse(Buffer.from(String(key).split('.')[1], 'base64url').toString());
    return claims.role === 'anon' && String(key).split('.').length === 3;
  } catch { return false; }
}

// Uses only the public Auth API. No admin/service-role credential, Auth schema
// mutation or browser-visible Supabase session is needed.
export class SupabaseIdentity {
  constructor({ url, key, fetchImpl = fetch, now = Date.now }) {
    this.configured = validPublicAuthConfig(url, key);
    this.base = this.configured ? new URL('/auth/v1', url).href : '';
    this.key = key; this.fetch = fetchImpl; this.now = now; this.settingsUntil = 0;
  }
  async call(route, { method = 'GET', body, accessToken } = {}) {
    assert(this.configured, 'Die E-Mail-Anmeldung ist noch nicht eingerichtet.', 'unconfigured', 503);
    let response;
    try {
      response = await this.fetch(this.base + route, { method, redirect: 'error', signal: AbortSignal.timeout(12_000),
        headers: { apikey: this.key, ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AppError('identity_unavailable', 'Die Kontoanmeldung ist gerade nicht erreichbar. Bitte später erneut versuchen.', 503); }
    if (response.status === 204) return {};
    let value;
    try { const text = await response.text(); if (text.length > 256 * 1024) throw new Error(); value = JSON.parse(text); }
    catch { throw new AppError('identity_unavailable', 'Die Kontoanmeldung hat keine gültige Antwort geliefert.', 503); }
    if (!response.ok) {
      if (response.status === 429) throw new AppError('rate_limited', 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.', 429);
      if (response.status >= 500) throw new AppError('identity_unavailable', 'Die Kontoanmeldung ist gerade nicht verfügbar.', 503);
      if (value.code === 'email_not_confirmed' || value.error_code === 'email_not_confirmed') throw new AppError('email_unconfirmed', 'Bitte zuerst den Link in deiner Bestätigungs-E-Mail öffnen.', 403);
      throw new AppError('auth', 'Anmeldung nicht möglich. E-Mail, Passwort und E-Mail-Bestätigung prüfen.', 401);
    }
    return value;
  }
  async requireConfirmation() {
    if (this.settingsUntil > this.now()) return;
    const settings = await this.call('/settings');
    assert(settings.external?.email === true && settings.mailer_autoconfirm === false,
      'Die E-Mail-Anmeldung benötigt aktivierte E-Mail-Bestätigungen im Anmeldedienst.', 'unconfigured', 503);
    this.settingsUntil = this.now() + 60_000;
  }
  async register({ name, email, password, redirectTo }) {
    await this.requireConfirmation();
    const result = await this.call('/signup?redirect_to=' + encodeURIComponent(redirectTo), { method: 'POST', body: { email, password, data: { name } } });
    if (result.access_token) {
      await this.logout(result.access_token).catch(() => {});
      throw new AppError('unconfigured', 'Die Registrierung benötigt eine Bestätigung per E-Mail.', 503);
    }
    return result.user || result;
  }
  async login({ email, password }) {
    await this.requireConfirmation();
    return this.call('/token?grant_type=password', { method: 'POST', body: { email, password } });
  }
  refresh(refreshToken) { return this.call('/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } }); }
  user(accessToken) { return this.call('/user', { accessToken }); }
  logout(accessToken) { return this.call('/logout?scope=local', { method: 'POST', accessToken }); }
}
