'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebsiteService } = require('../electron/website.cjs');
const { allowedTransportPath } = require('../electron/workspace-operations.cjs');

const NOW = Date.parse('2026-11-12T12:00:00Z');
const TOKEN = 'visitor_stats_test_session_'.repeat(2);
const USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin', email: 'admin@example.test', confirmed: true, isAdmin: true, suspended: false };
const report = days => ({
  startedAt: '2026-11-11T12:00:00.000Z', generatedAt: '2026-11-12T12:00:00.000Z',
  timeZone: 'Europe/Berlin', retentionDays: 90, rangeDays: days,
  today: { date: '2026-11-12', views: 5, visitors: 3 },
  totals: { views: 13, visitorDays: 7 }, period: { views: 13, visitorDays: 7 },
  daily: [{ date: '2026-11-11', views: 8, visitors: 4 }, { date: '2026-11-12', views: 5, visitors: 3 }],
  pages: [{ path: '/', label: 'Startseite', views: 13 }], partial: false, method: 'daily-ip-hmac',
});
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => body });
function fixture(handler = (url) => reply(report(Number(new URL(url).searchParams.get('days')))), user = USER) {
  const calls = [];
  const service = new WebsiteService({
    now: () => NOW,
    connections: { run: async (_action, payload) => ({ ...payload, id: 'test-website-profile' }) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/account/login')) return reply({ user, token: TOKEN, expiresAt: NOW + 60_000 });
      if (url.endsWith('/api/account/logout')) return reply({ ok: true });
      return handler(url, options);
    },
  });
  return {
    service, calls,
    login: () => service.run('website.login', { email: USER.email, password: 'test-only-password' }),
    get: body => service.run('website.request', { operation: 'visitorStats.get', ...(body === undefined ? {} : { body }) }),
  };
}

test('visitor statistics use only fixed authenticated GET routes and retain genuine aggregate values', async () => {
  const f = fixture(); await f.login();
  for (const [body, days] of [[undefined, 30], [{}, 30], [{ days: 7 }, 7], [{ days: 30 }, 30], [{ days: 90 }, 90]]) {
    assert.deepEqual(await f.get(body), report(days));
    const { url, options } = f.calls.at(-1);
    assert.equal(url, `https://crazybatto.de/api/admin/visitor-stats?days=${days}`);
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['X-Client-Type'], 'native');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
});

test('visitor range and renderer route overrides are rejected before network access', async () => {
  const f = fixture(); await f.login(); const before = f.calls.length;
  for (const body of [null, [], '30', { days: '30' }, { days: 0 }, { days: -7 }, { days: 365 }, { days: 7.5 }, { days: true }, { days: null }, { days: '7&other=1' }, { days: 30, url: 'https://other.example' }, { days: 30, token: 'injected' }]) {
    await assert.rejects(f.get(body), error => error.code === 'validation');
  }
  await assert.rejects(f.service.run('website.request', { operation: 'visitorStats.get', body: { days: 30 }, url: 'https://other.example' }));
  assert.equal(f.calls.length, before);
});

test('visitor transport permits only one exact numeric days query parameter', () => {
  for (const days of [7, 30, 90]) assert.equal(allowedTransportPath(`/api/admin/visitor-stats?days=${days}`), true);
  for (const path of [
    '/api/admin/visitor-stats?days=30&days=7', '/api/admin/visitor-stats?days=30&other=1',
    '/api/admin/visitor-stats?days=30#private', '/api/admin/visitor-stats?days=030',
    '/api/admin/visitor-stats?days=%33%30', '/api/admin/visitor-stats?days=30/',
    '/api/admin/visitor-stats?days=', '/api/admin/visitor-stats?days=365',
    'https://other.example/api/admin/visitor-stats?days=30',
    '//other.example/api/admin/visitor-stats?days=30',
  ]) assert.equal(allowedTransportPath(path), false, path);
});

test('visitor statistics require a confirmed administrator session', async () => {
  const f = fixture();
  await assert.rejects(f.get({ days: 30 }), error => error.code === 'auth' && error.status === 401);
  assert.equal(f.calls.length, 0);
  for (const user of [{ ...USER, isAdmin: false }, { ...USER, confirmed: false }, { ...USER, suspended: true }]) {
    const rejected = fixture(undefined, user);
    await assert.rejects(rejected.login(), error => error.code === 'forbidden' && error.status === 403);
    await assert.rejects(rejected.get({ days: 7 }), error => error.code === 'auth');
    assert.equal(rejected.calls.filter(call => call.url.includes('visitor-stats')).length, 0);
  }
});

test('server rejection shows an error rather than zero counts and expired sessions are cleared', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'forbidden'], [503, 'unavailable']]) {
    const f = fixture(() => reply({ ok: false, error: { code, message: `Zugriff abgelehnt ${TOKEN}` } }, status));
    await f.login();
    await assert.rejects(f.get({ days: 30 }), error => error.status === status && error.code === code && !error.message.includes(TOKEN));
    assert.equal(f.service.state().connected, status !== 401);
    assert.equal(f.calls.filter(call => call.url.includes('visitor-stats')).length, 1, 'failed statistics are not retried automatically');
  }
});

test('a report requested before logout cannot appear in the next account session', async () => {
  let resolveReport;
  const f = fixture(() => new Promise(resolve => { resolveReport = resolve; }));
  await f.login();
  const pending = f.get({ days: 7 });
  await f.service.run('website.disconnect');
  resolveReport(reply(report(7)));
  await assert.rejects(pending, error => error.code === 'session_changed' && error.status === 409);
  assert.equal(f.service.state().connected, false);
});
