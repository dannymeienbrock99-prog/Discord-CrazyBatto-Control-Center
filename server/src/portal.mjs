import { AppError, assert } from './errors.mjs';
import { equalHash, randomToken, sha256 } from './store.mjs';
import { publicUser } from './auth.mjs';

const LOGIN_MS = 10 * 60_000;
const cookie = (name, value, maxAge) => name + '=' + value + '; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=' + maxAge;
export const clearPortalCookie = () => cookie('ms_portal', '', 0);
export const clearPortalOAuthCookie = () => cookie('ms_portal_oauth', '', 0);

export class Portal {
  constructor(config, store, auth, access, { now = Date.now } = {}) {
    this.config = config; this.store = store; this.auth = auth; this.access = access; this.now = now;
  }
  start() {
    this.auth.configured(); this.access.configured();
    const state = randomToken(), browserSecret = randomToken(), verifier = randomToken(), stateHash = sha256(state), now = this.now();
    this.store.transaction(draft => {
      for (const [id, login] of Object.entries(draft.portalLogins)) if (login.expiresAt <= now || login.status !== 'pending') delete draft.portalLogins[id];
      for (const [hash, session] of Object.entries(draft.portalSessions)) if (session.expiresAt <= now) delete draft.portalSessions[hash];
      assert(Object.keys(draft.portalLogins).length < 2000, 'Zu viele Anmeldungen laufen gleichzeitig. Bitte später erneut versuchen.', 'rate_limited', 429);
      draft.portalLogins[stateHash] = { status: 'pending', purpose: 'portal', browserHash: sha256(browserSecret), verifier: this.auth.vault.seal(verifier), expiresAt: now + LOGIN_MS };
    });
    const url = new URL('https://discord.com/oauth2/authorize');
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.config.portalRedirectUri, response_type: 'code', scope: 'identify guilds guilds.members.read', state, prompt: 'consent', code_challenge: Buffer.from(sha256(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.toString(), cookie: cookie('ms_portal_oauth', browserSecret, LOGIN_MS / 1000) };
  }
  async callback({ state, code, error, browserSecret, previousToken }) {
    this.auth.configured(); this.access.configured();
    assert(typeof state === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(state), 'Die Registrierung konnte keiner Browser-Anmeldung zugeordnet werden.', 'auth', 401);
    const stateHash = sha256(state), login = this.store.data.portalLogins[stateHash];
    assert(login?.purpose === 'portal' && login.status === 'pending' && login.expiresAt > this.now(), 'Diese Browser-Anmeldung ist abgelaufen oder wurde bereits verwendet.', 'auth', 401);
    assert(typeof browserSecret === 'string' && equalHash(login.browserHash, sha256(browserSecret)), 'Die Anmeldung gehört nicht zu diesem Browser. Bitte neu anmelden.', 'auth', 401);
    const verifier = this.auth.vault.open(login.verifier);
    this.store.transaction(draft => { const current = draft.portalLogins[stateHash]; current.status = 'exchanging'; delete current.browserHash; delete current.verifier; });
    if (error) {
      this.store.transaction(draft => { delete draft.portalLogins[stateHash]; });
      throw new AppError('auth', 'Die Discord-Anmeldung wurde abgebrochen. Du kannst sie erneut starten.', 401);
    }
    try {
      assert(typeof code === 'string' && code.length > 0 && code.length <= 2048, 'Discord hat keinen gültigen Anmeldecode geliefert.', 'auth', 401);
      const tokens = this.auth.normalizeTokens(await this.auth.discord.tokenExchange({ grant_type: 'authorization_code', code, redirect_uri: this.config.portalRedirectUri, code_verifier: verifier }));
      const user = publicUser(await this.auth.discord.request('GET', '/users/@me', { token: tokens.accessToken }));
      const token = randomToken(48), csrfToken = randomToken(), expiresAt = this.now() + this.config.portalSessionLifetimeMs;
      this.store.transaction(draft => {
        const current = draft.portalLogins[stateHash];
        assert(current?.purpose === 'portal' && current.status === 'exchanging' && current.expiresAt > this.now(), 'Die Browser-Anmeldung wurde inzwischen beendet.', 'auth', 401);
        this.access.configured();
        draft.users[user.id] = { ...(draft.users[user.id] || {}), user, oauth: this.auth.vault.seal(tokens) };
        if (typeof previousToken === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(previousToken)) delete draft.portalSessions[sha256(previousToken)];
        draft.portalSessions[sha256(token)] = { userId: user.id, createdAt: this.now(), expiresAt, csrf: this.auth.vault.seal(csrfToken) };
        delete draft.portalLogins[stateHash];
      });
      return { user, cookie: cookie('ms_portal', token, Math.floor(this.config.portalSessionLifetimeMs / 1000)) };
    } catch (cause) {
      this.store.transaction(draft => { delete draft.portalLogins[stateHash]; });
      throw cause;
    }
  }
  session(token, { optional = false } = {}) {
    const miss = () => { if (optional) return null; throw new AppError('auth', 'Bitte auf der Website mit Discord anmelden.', 401); };
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return miss();
    const hash = sha256(token), row = this.store.data.portalSessions[hash];
    if (!row || row.expiresAt <= this.now()) return miss();
    const user = this.store.data.users[row.userId]?.user;
    if (!user) return miss();
    try { return { kind: 'portal', hash, userId: user.id, user, expiresAt: row.expiresAt, csrfToken: this.auth.vault.open(row.csrf) }; }
    catch { return miss(); }
  }
  requireCsrf(session, headers) {
    assert(headers.origin === this.config.publicOrigin, 'Diese Aktion muss von der Website der Crazy_Batto Discord App gestartet werden.', 'forbidden', 403);
    const csrf = headers['x-csrf-token'];
    assert(typeof csrf === 'string' && csrf.length <= 128 && equalHash(sha256(csrf), sha256(session.csrfToken)), 'Die Sicherheitsbestätigung ist abgelaufen. Bitte die Website neu laden.', 'forbidden', 403);
    assert(!headers['sec-fetch-site'] || headers['sec-fetch-site'] === 'same-origin', 'Die Browser-Anfrage gehört nicht zu dieser Website.', 'forbidden', 403);
  }
  info(session) {
    return { ok: true, configured: this.config.configured && this.config.accessConfigured,
      authenticated: !!session, user: session?.user || null,
      access: session && this.config.accessConfigured ? this.access.state(session.userId) : null,
      csrfToken: session?.csrfToken || null, expiresAt: session?.expiresAt || null,
      download: this.access.downloadInfo(session?.userId) };
  }
  logout(session) { this.store.transaction(draft => { delete draft.portalSessions[session.hash]; }); return { ok: true }; }
}
