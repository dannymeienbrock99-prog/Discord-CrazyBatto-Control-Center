import { AppError, assert } from './errors.mjs';

export const SUITE_APP_ID = 'batto-3-in-1';
export const SUITE_VERSION = '1.20.0';
export const SUITE_LICENSE_SETTING = 'batto_suite_license_v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validSuiteLicenseKey(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 512 &&
    value === value.trim() && !/[\p{Cc}]/u.test(value);
}

// Reuses the existing account/session boundary. No key is part of public
// configuration, app listings, session objects, request records, or audit data.
export class SuiteLicenseAccess {
  constructor(accounts) { this.accounts = accounts; }

  operator() {
    const id = this.accounts.config.suiteOwnerId;
    assert(UUID.test(id || ''), 'Die persönliche Lizenzfreigabe wird noch eingerichtet.', 'unconfigured', 503);
    const owner = this.accounts.store.get('SELECT * FROM accounts WHERE id=?', id);
    assert(owner?.is_admin && owner.confirmed && !owner.suspended,
      'Die persönliche Lizenzfreigabe ist momentan nicht verfügbar.', 'unconfigured', 503);
    return id;
  }

  canDecide(user) {
    try { return !!user?.isAdmin && !!user.confirmed && !user.suspended && user.id === this.operator(); }
    catch { return false; }
  }

  requireOperator(context) {
    const user = this.accounts.assertCurrent(context, { admin: true });
    assert(user.id === this.operator(), 'Nur Crazy_Batto persönlich kann diese Lizenzanfrage entscheiden.', 'forbidden', 403);
    return user;
  }

  requirePersonalApproval(user) {
    assert(user?.confirmed && !user.suspended, 'Bitte mit deinem bestätigten Konto anmelden.', 'forbidden', 403);
    const ownerId = this.operator();
    const request = this.accounts.store.get('SELECT * FROM app_requests WHERE user_id=? AND app_id=?', user.id, SUITE_APP_ID);
    assert(request?.status === 'approved' && Number.isSafeInteger(request.reviewed_at),
      'Deine Lizenzanfrage wurde noch nicht persönlich freigegeben.', 'app_access', 403);
    const approval = this.accounts.store.get(
      "SELECT id FROM account_audit WHERE actor_id=? AND action='app.approved' AND target_id=? AND created_at=? LIMIT 1",
      ownerId, request.id, request.reviewed_at);
    assert(approval, 'Für diese Lizenz fehlt die persönliche Freigabe von Crazy_Batto.', 'app_access', 403);
    return request;
  }

  reveal(context) {
    const user = this.accounts.assertCurrent(context);
    const request = this.requirePersonalApproval(user);
    let key;
    try {
      const encrypted = this.accounts.store.setting(SUITE_LICENSE_SETTING);
      if (typeof encrypted !== 'string' || encrypted.length > 8192) throw Error();
      const value = this.accounts.vault.open(JSON.parse(encrypted));
      if (value?.version !== 1 || !validSuiteLicenseKey(value.key)) throw Error();
      key = value.key;
    } catch {
      throw new AppError('unconfigured', 'Deine Freigabe ist vorhanden; die Lizenzbereitstellung ist momentan nicht verfügbar.', 503);
    }
    this.accounts.store.audit(user.id, 'suite.license.viewed', request.id, { appId: SUITE_APP_ID, version: SUITE_VERSION }, this.accounts.now());
    return { appId: SUITE_APP_ID, version: SUITE_VERSION, licenseKey: key };
  }
}

// For an explicitly authorized private server provisioning step only. The key
// must arrive through private stdin, never a command-line value or a web asset.
export function storeSuiteLicense({ store, vault, operatorId, key, now = Date.now }) {
  assert(UUID.test(operatorId || ''), 'Die Betreiberzuordnung ist ungültig.');
  assert(validSuiteLicenseKey(key), 'Das Lizenzformat ist ungültig.');
  const owner = store.get('SELECT * FROM accounts WHERE id=?', operatorId);
  assert(owner?.is_admin && owner.confirmed && !owner.suspended, 'Das Betreiberkonto ist nicht freigegeben.', 'forbidden', 403);
  const encrypted = JSON.stringify(vault.seal({ version: 1, key }));
  store.transaction(() => {
    store.setSetting(SUITE_LICENSE_SETTING, encrypted);
    store.audit(operatorId, 'suite.license.configured', null, { appId: SUITE_APP_ID, version: SUITE_VERSION }, now());
  });
  return { configured: true, appId: SUITE_APP_ID };
}
