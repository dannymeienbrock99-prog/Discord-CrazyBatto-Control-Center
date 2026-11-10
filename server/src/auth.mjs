import { AppError, assert } from './errors.mjs';
import { equalHash, randomToken, sha256, Vault } from './store.mjs';
import { validId } from './payloads.mjs';

const LOGIN_MS = 10 * 60_000;
const CLAIM_MS = 2 * 60_000;
const SCOPES = ['identify', 'guilds', 'guilds.members.read'];
const safeAccountText = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);

export function publicUser(raw) {
  assert(raw && validId(raw.id) && typeof raw.username === 'string' && raw.username.length > 0, 'Discord hat keine gültige Kontoidentität bestätigt.', 'auth', 401);
  const user = { id: raw.id, username: safeAccountText(raw.username), displayName: safeAccountText(raw.global_name || raw.username) };
  if (typeof raw.avatar === 'string' && /^(?:a_)?[a-f0-9]{32}$/.test(raw.avatar)) user.avatarUrl = 'https://cdn.discordapp.com/avatars/' + user.id + '/' + raw.avatar + '.png?size=128';
  return user;
}

export class Auth {
  constructor(config, store, discord, { now = Date.now } = {}) {
    this.config = config; this.store = store; this.discord = discord; this.now = now;
    this.vault = new Vault(config.encryptionKey); this.refreshes = new Map();
  }
  configured() {
    if (!this.config.configured) throw new AppError('unconfigured', 'Die Discord-Anmeldung ist auf dem Server noch nicht eingerichtet. ' + this.config.configurationMessage, 503);
  }
  start(challenge) {
    this.configured();
    assert(typeof challenge === 'string' && /^[a-f0-9]{64}$/.test(challenge), 'Die Gerätebindung ist ungültig.');
    const now = this.now(), loginId = randomToken(24), display = sha256(randomToken()).slice(0, 8).toUpperCase(), displayCode = display.slice(0, 4) + '-' + display.slice(4);
    this.store.transaction(draft => {
      for (const [id, login] of Object.entries(draft.logins)) if ((login.claimUntil || login.expiresAt) < now) delete draft.logins[id];
      for (const [hash, session] of Object.entries(draft.sessions)) if (session.expiresAt <= now) delete draft.sessions[hash];
      assert(Object.keys(draft.logins).length < 2000, 'Zu viele Anmeldungen laufen gleichzeitig. Bitte später erneut versuchen.', 'rate_limited', 429);
      draft.logins[loginId] = { loginId, challenge, displayCode, expiresAt: now + LOGIN_MS, status: 'pending', starts: 0 };
    });
    return { ok: true, loginId, authorizePath: '/oauth/start/' + loginId, displayCode, expiresAt: now + LOGIN_MS, intervalMs: 3000 };
  }
  browserStart(loginId) {
    this.configured();
    const login = this.store.data.logins[loginId];
    assert(login && login.expiresAt > this.now() && login.status === 'pending', 'Diese Geräteanmeldung ist abgelaufen oder bereits abgeschlossen.', 'auth', 401);
    assert(login.starts < 8, 'Diese Anmeldung wurde zu oft geöffnet. Bitte in der App neu anmelden.', 'auth', 401);
    const state = randomToken(), browserSecret = randomToken(), verifier = randomToken();
    this.store.transaction(draft => {
      const current = draft.logins[loginId];
      current.oauthStateHash = sha256(state); current.browserHash = sha256(browserSecret);
      current.pkce = this.vault.seal(verifier); current.starts++;
    });
    const url = new URL('https://discord.com/oauth2/authorize');
    for (const [key, value] of Object.entries({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state, prompt: 'consent', code_challenge: Buffer.from(sha256(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.toString(), cookie: 'ms_oauth=' + browserSecret + '; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600' };
  }
  async callback({ state, code, error, browserSecret }) {
    this.configured();
    assert(typeof state === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(state), 'Die Anmeldung konnte keinem Gerät zugeordnet werden.', 'auth', 401);
    const stateHash = sha256(state);
    const login = Object.values(this.store.data.logins).find(item => equalHash(item.oauthStateHash, stateHash));
    assert(login && login.status === 'pending' && login.expiresAt > this.now(), 'Die Anmeldung ist abgelaufen oder bereits verwendet worden.', 'auth', 401);
    assert(typeof browserSecret === 'string' && equalHash(login.browserHash, sha256(browserSecret)), 'Die Browser-Anmeldung gehört nicht zu dieser Sitzung. Bitte in der App neu beginnen.', 'auth', 401);
    const verifier = this.vault.open(login.pkce);
    this.store.transaction(draft => { const current = draft.logins[login.loginId]; delete current.oauthStateHash; delete current.browserHash; delete current.pkce; current.exchanging = !error; });
    if (error) {
      this.store.transaction(draft => { draft.logins[login.loginId].status = 'cancelled'; });
      throw new AppError('auth', 'Die Discord-Anmeldung wurde abgebrochen. Du kannst sie in der App erneut starten.', 401);
    }
    try {
      assert(typeof code === 'string' && code.length > 0 && code.length <= 2048, 'Discord hat keinen gültigen Anmeldecode geliefert.', 'auth', 401);
      const tokens = this.normalizeTokens(await this.discord.tokenExchange({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri, code_verifier: verifier }));
      const user = publicUser(await this.discord.request('GET', '/users/@me', { token: tokens.accessToken }));
      this.store.transaction(draft => {
        const current = draft.logins[login.loginId];
        assert(current && current.status === 'pending' && current.expiresAt > this.now(), 'Die Geräteanmeldung wurde inzwischen beendet.', 'auth', 401);
        draft.users[user.id] = { ...(draft.users[user.id] || {}), user, oauth: this.vault.seal(tokens) };
        current.status = 'authorized'; current.userId = user.id; current.exchanging = false;
      });
      return { user, displayCode: login.displayCode };
    } catch (cause) {
      this.store.transaction(draft => { const current = draft.logins[login.loginId]; if (current && current.status === 'pending') { current.status = 'failed'; current.exchanging = false; } });
      throw cause;
    }
  }
  verifyLogin(loginId, verifier) {
    assert(typeof loginId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(loginId) && typeof verifier === 'string' && verifier.length >= 32 && verifier.length <= 256, 'Die Geräteanmeldung ist ungültig.', 'auth', 401);
    const login = this.store.data.logins[loginId];
    assert(login && equalHash(login.challenge, sha256(verifier)), 'Die Geräteanmeldung konnte nicht bestätigt werden.', 'auth', 401);
    return login;
  }
  poll(loginId, verifier) {
    this.configured();
    const login = this.verifyLogin(loginId, verifier), now = this.now();
    if (login.status === 'claimed') {
      assert(login.claimUntil > now && login.sessionHash && this.store.data.sessions[login.sessionHash], 'Die Geräteanmeldung wurde bereits abgeschlossen. Bitte bei Bedarf erneut anmelden.', 'auth', 401);
      return { ok: true, status: 'authorized', ...this.vault.open(login.claim) };
    }
    assert(login.expiresAt > now && !['cancelled', 'failed'].includes(login.status), 'Die Geräteanmeldung ist abgelaufen oder abgebrochen. Bitte erneut anmelden.', 'auth', 401);
    if (login.status !== 'authorized') return { ok: true, status: 'pending', intervalMs: 3000 };
    const sessionToken = randomToken(48), expiresAt = now + this.config.sessionLifetimeMs;
    const user = this.store.data.users[login.userId]?.user;
    assert(user, 'Die Kontoanmeldung konnte nicht gelesen werden. Bitte erneut anmelden.', 'auth', 401);
    const result = { sessionToken, user, expiresAt };
    this.store.transaction(draft => {
      draft.sessions[sha256(sessionToken)] = { userId: user.id, createdAt: now, expiresAt };
      const current = draft.logins[loginId];
      current.status = 'claimed'; current.claimUntil = now + CLAIM_MS; current.sessionHash = sha256(sessionToken); current.claim = this.vault.seal(result);
    });
    return { ok: true, status: 'authorized', ...result };
  }
  cancel(loginId, verifier) {
    const login = this.verifyLogin(loginId, verifier);
    this.store.transaction(draft => { if (login.sessionHash) delete draft.sessions[login.sessionHash]; delete draft.logins[loginId]; });
    return { ok: true };
  }
  session(token) {
    this.configured();
    assert(typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token), 'Bitte mit Discord anmelden.', 'auth', 401);
    const hash = sha256(token), session = this.store.data.sessions[hash];
    assert(session && session.expiresAt > this.now(), 'Die App-Anmeldung ist abgelaufen. Bitte erneut mit Discord anmelden.', 'auth', 401);
    const user = this.store.data.users[session.userId]?.user;
    assert(user, 'Die Kontoanmeldung ist nicht mehr verfügbar. Bitte erneut anmelden.', 'auth', 401);
    return { hash, userId: user.id, user, expiresAt: session.expiresAt };
  }
  logout(session) { this.store.transaction(draft => { delete draft.sessions[session.hash]; }); return { ok: true }; }
  normalizeTokens(raw, previous = null) {
    assert(raw && typeof raw.access_token === 'string' && raw.access_token.length >= 16 && raw.access_token.length < 8192 && !/\s/.test(raw.access_token), 'Discord hat keine lesbare Anmeldebestätigung geliefert. Bitte später erneut versuchen.', 'network', 502);
    const refreshToken = raw.refresh_token || previous?.refreshToken;
    assert(typeof refreshToken === 'string' && refreshToken.length >= 16 && refreshToken.length < 8192 && !/\s/.test(refreshToken), 'Discord hat keine lesbare erneuerbare Anmeldung geliefert. Bitte später erneut versuchen.', 'network', 502);
    const scopes = String(raw.scope || previous?.scopes?.join(' ') || '').split(/\s+/);
    assert(SCOPES.every(scope => scopes.includes(scope)), 'Discord hat nicht alle benötigten Anmelderechte bestätigt. Bitte erneut anmelden.', 'auth', 401);
    assert(Number.isFinite(raw.expires_in) && raw.expires_in > 0 && raw.expires_in <= 366 * 86400, 'Discord hat eine ungültige Anmeldedauer geliefert. Bitte später erneut versuchen.', 'network', 502);
    return { accessToken: raw.access_token, refreshToken, scopes, expiresAt: this.now() + Math.floor(raw.expires_in * 1000) };
  }
  tokens(userId) {
    try { return this.vault.open(this.store.data.users[userId]?.oauth); }
    catch { throw new AppError('auth', 'Die gespeicherte Discord-Anmeldung konnte nicht gelesen werden. Bitte erneut anmelden.', 401); }
  }
  async refresh(userId) {
    if (this.refreshes.has(userId)) return this.refreshes.get(userId);
    const pending = (async () => {
      const previous = this.tokens(userId);
      try {
        const tokens = this.normalizeTokens(await this.discord.tokenExchange({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }), previous);
        this.store.transaction(draft => { assert(draft.users[userId], 'Das Konto ist nicht mehr vorhanden.', 'auth', 401); draft.users[userId].oauth = this.vault.seal(tokens); });
        return tokens;
      } catch (error) {
        if (error instanceof AppError && error.kind === 'auth') this.store.transaction(draft => { for (const [id, session] of Object.entries(draft.sessions)) if (session.userId === userId) delete draft.sessions[id]; for (const [id, session] of Object.entries(draft.portalSessions)) if (session.userId === userId) delete draft.portalSessions[id]; if (draft.users[userId]) delete draft.users[userId].oauth; });
        throw error;
      }
    })();
    this.refreshes.set(userId, pending);
    try { return await pending; } finally { this.refreshes.delete(userId); }
  }
  async userRequest(userId, path) {
    let tokens = this.tokens(userId);
    if (tokens.expiresAt <= this.now() + 30_000) tokens = await this.refresh(userId);
    try { return await this.discord.request('GET', path, { token: tokens.accessToken }); }
    catch (error) {
      if (!(error instanceof AppError) || error.kind !== 'auth') throw error;
      tokens = await this.refresh(userId);
      return this.discord.request('GET', path, { token: tokens.accessToken });
    }
  }
}
