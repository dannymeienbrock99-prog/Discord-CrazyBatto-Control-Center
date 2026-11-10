import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError, assert } from './errors.mjs';

// The Discord identity still owns Discord operations. App permission comes only
// from a separately verified email account, scoped to this request/async job.
export function attachEmailAccess(service) {
  const context = new AsyncLocalStorage();
  const access = service.access;
  const legacyOwner = access.requireOwner.bind(access);
  service.accountContext = context;
  const current = () => {
    const auth = context.getStore();
    assert(auth, 'Bitte mit deinem E-Mail-Konto anmelden und den App-Zugang beantragen.', 'account_auth', 401);
    try { return service.accounts.assertNativeAuthorization(auth, 'discord-app'); }
    catch (error) {
      if (error instanceof AppError && [401, 403].includes(error.status)) error.kind = error.status === 401 ? 'account_auth' : 'account_access';
      throw error;
    }
  };
  access.requireApprovedUser = () => {
    const user = current();
    return { status: 'approved', canUseApp: true, isOwner: !!user.isAdmin, version: 0,
      requestedAt: null, updatedAt: null, reviewedAt: null, reason: '' };
  };
  access.requireApp = session => { access.requireCurrentAppSession(session); return access.requireApprovedUser(session.userId); };
  access.requireOwner = session => {
    const user = current();
    assert(user.isAdmin, 'Diese Funktion ist nur für den Betreiber freigegeben.', 'forbidden', 403);
    legacyOwner(session);
  };
  return context;
}
