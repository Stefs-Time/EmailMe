'use strict';

/**
 * End-to-end acceptance tests against a REAL listmonk + PostgreSQL
 * (scope §10). Skipped unless INTEGRATION=1. Required env (see README):
 *   DATABASE_URL, LISTMONK_URL, LISTMONK_ADMIN_USER, LISTMONK_ADMIN_PASSWORD
 *   (the suite uses the portal's self-bootstrap to obtain its API token, and
 *   the admin login to enable bounce webhooks)
 *
 * WARNING: creates and deletes test contacts (@mh-test.example). Never run
 * against production.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');

const enabled = process.env.INTEGRATION === '1';
const RUN = Date.now().toString(36);
const addr = (n) => `${n}.${RUN}@mh-test.example`;

let server; let base; let pool; let sync; let lm; let config;
const jar = { admin: new Map(), viewer: new Map() };
const csrf = {};

async function http(who, method, path, body, { raw } = {}) {
  const headers = { Accept: 'application/json' };
  const cookies = [...jar[who].entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) headers.Cookie = cookies;
  if (method !== 'GET' && csrf[who]) headers['X-CSRF-Token'] = csrf[who];
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[who].set(kv.slice(0, i), kv.slice(i + 1));
  }
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function login(who, email, password) {
  const s = await http(who, 'GET', '/api/auth/session');
  csrf[who] = s.data.csrfToken;
  const r = await http(who, 'POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r));
  csrf[who] = r.data.csrfToken;
}

/** Enables listmonk's bounce webhook so tests can inject bounces (TC05/06/11). */
async function enableBounceWebhook() {
  const url = config.LISTMONK_URL;
  const page = await fetch(`${url}/admin/login`);
  const cookie = page.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())[1];
  const res = await fetch(`${url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ username: process.env.LISTMONK_ADMIN_USER, password: process.env.LISTMONK_ADMIN_PASSWORD, nonce }),
  });
  const session = [cookie, ...res.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
  const put = async (key, value) => {
    const r = await fetch(`${url}/api/settings/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: session }, body: JSON.stringify(value) });
    assert.ok(r.ok, `settings ${key}: ${r.status}`);
  };
  await put('bounce.enabled', true);
  await put('bounce.webhooks_enabled', true);
  // listmonk restarts its internals after a settings change.
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await lm.settings().catch(() => null);
    if (s && s['bounce.webhooks_enabled']) return;
  }
  throw new Error('listmonk did not apply bounce webhook setting');
}

async function uploadCsv(who, name, csv) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), name);
  return http(who, 'POST', '/api/imports', form);
}

async function runImport(csv, options) {
  const up = await uploadCsv('admin', 'test.csv', csv);
  assert.equal(up.status, 201, JSON.stringify(up));
  const pv = await http('admin', 'POST', `/api/imports/${up.data.id}/preview`, { mapping: up.data.mapping, options });
  assert.equal(pv.status, 200, JSON.stringify(pv));
  const preview = pv.data.import.summary.preview;
  if (!pv.data.import.summary.importable) return { preview, result: {} };
  const c = await http('admin', 'POST', `/api/imports/${up.data.id}/commit`);
  assert.equal(c.status, 202);
  for (let i = 0; i < 60; i += 1) {
    const s = await http('admin', 'GET', `/api/imports/${up.data.id}`);
    if (s.data.status === 'completed') return { preview, result: s.data.summary };
    assert.notEqual(s.data.status, 'failed', s.data.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('import did not finish');
}

const contactByEmail = async (email) => {
  const r = await http('admin', 'GET', `/api/contacts?q=${encodeURIComponent(email)}`);
  return r.data.find((c) => c.email === email);
};

let adminApi;
/** Injects a bounce as listmonk would record it (admin session; the portal's own API user cannot post bounces). */
async function bounce(email, type, meta) {
  if (!adminApi) {
    const { loginSession } = require('../../src/lib/listmonkAdmin');
    adminApi = await loginSession(config.LISTMONK_URL, config.LISTMONK_ADMIN_USER, config.LISTMONK_ADMIN_PASSWORD);
  }
  await adminApi('POST', '/webhooks/bounce', { email, type, source: 'test', meta });
  await sync.runOnce();
}

before(async () => {
  if (!enabled) return;
  const { loadConfig } = require('../../src/config');
  const { createPool } = require('../../src/db/pool');
  const { migrate } = require('../../src/db/migrate');
  const { ListmonkClient } = require('../../src/lib/listmonk');
  const { SyncWorker } = require('../../src/modules/sync/worker');
  const { createApp } = require('../../src/app');
  const argon2 = require('argon2');
  const { resolveListmonkCredentials, ensureEnvAdmin } = require('../../src/lib/startup');
  config = loadConfig({ ...process.env, NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), LISTMONK_API_TOKEN: '',
    ADMIN_EMAIL: `envadmin-${RUN}@mh-test.example`, ADMIN_PASSWORD: 'Env-admin-pass-1' });
  const logger = pino({ level: 'silent' });
  pool = createPool(config);
  await migrate(pool, logger);
  await ensureEnvAdmin(pool, config, logger);
  const creds = await resolveListmonkCredentials(pool, config, logger);
  lm = new ListmonkClient({ baseUrl: config.LISTMONK_URL, apiUser: creds.user, apiToken: creds.token, logger });
  sync = new SyncWorker({ pool, listmonk: lm, config, logger });
  const hash = await argon2.hash('Test-password-123');
  for (const [email, role] of [[`admin-${RUN}@mh-test.example`, 'admin'], [`viewer-${RUN}@mh-test.example`, 'viewer']]) {
    await pool.query(`INSERT INTO portal.users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)`, [email, role, role, hash]);
  }
  const app = createApp({ pool, lm, config, logger, sync, track: () => {} });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await login('admin', `admin-${RUN}@mh-test.example`, 'Test-password-123');
  await login('viewer', `viewer-${RUN}@mh-test.example`, 'Test-password-123');
  await enableBounceWebhook();
  await sync.runOnce(); // catch up on any pre-existing data
});

after(async () => {
  if (!enabled) return;
  // Clean up test contacts in listmonk and test users.
  const { rows } = await pool.query(`SELECT id FROM subscribers WHERE email LIKE $1`, [`%.${RUN}@mh-test.example`]);
  for (const r of rows) await lm.deleteSubscriber(r.id).catch(() => {});
  await pool.query(`DELETE FROM portal.users WHERE email LIKE $1`, [`%${RUN}@mh-test.example`]);
  server?.close();
  await pool?.end();
});

const t = (name, fn) => test(name, { skip: !enabled && 'set INTEGRATION=1' }, fn);
let listId;

t('security: state-changing request without CSRF token is rejected', async () => {
  const saved = csrf.admin;
  csrf.admin = '';
  const r = await http('admin', 'POST', '/api/lists', { name: 'x' });
  csrf.admin = saved;
  assert.equal(r.status, 403);
  assert.equal(r.error.code, 'CSRF_FAILED');
});

t('security: viewer cannot write or export personal data', async () => {
  assert.equal((await http('viewer', 'POST', '/api/lists', { name: 'x' })).status, 403);
  assert.equal((await http('viewer', 'GET', '/api/exports/contacts.csv', undefined, { raw: true })).status, 403);
  assert.equal((await http('viewer', 'GET', '/api/contacts')).status, 200);
});

t('setup: create a list', async () => {
  const r = await http('admin', 'POST', '/api/lists', { name: `Test ${RUN}`, optin: 'single', type: 'private' });
  assert.equal(r.status, 201, JSON.stringify(r));
  listId = r.data.id;
});

t('TC02/TC03: CSV import validates, de-duplicates and requires consent', async () => {
  const csv = [
    'Email,First Name,Surname,Company,consent_method,city',
    `${addr('alice')},Alice,Anders,Acme,web_form,Durban`,
    `${addr('bob')},Bob,Botha,,web_form,Pretoria`,
    `${addr('carol')},Carol,Cele,,web_form,`,
    `${addr('dave')},Dave,Dlamini,,web_form,`,
    `${addr('erin')},Erin,Els,,web_form,`,
    `${addr('frank')},Frank,Fourie,,web_form,`,
    `${addr('alice').toUpperCase()},Dup,Licate,,web_form,`,
    'not-an-email,Bad,Row,,web_form,',
    `${addr('noconsent')},No,Consent,,,`,
  ].join('\n');
  const { preview, result } = await runImport(csv, { listIds: [listId], source: 'test-import', subscriptionStatus: 'confirmed', consent: { method: '' } });
  assert.equal(preview.new, 6);
  assert.equal(preview.duplicate, 1);
  assert.equal(preview.invalid_email, 1);
  assert.equal(preview.missing_consent, 1);
  assert.equal(result.imported, 6);
  const alice = await contactByEmail(addr('alice'));
  assert.equal(alice.status, 'active');
  assert.equal(alice.attribs.city, 'Durban');
  assert.equal(alice.attribs.consent.method, 'web_form');
  const detail = await http('admin', 'GET', `/api/contacts/${alice.id}`);
  assert.equal(detail.data.consent[0].action, 'granted');
});

t('TC03: re-importing an existing contact creates no duplicate', async () => {
  const { preview } = await runImport(`email\n${addr('alice')}`, { listIds: [listId], consent: { method: 'web_form' } });
  assert.equal(preview.existing_unchanged, 1);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM subscribers WHERE LOWER(email) = $1', [addr('alice')]);
  assert.equal(rows[0].n, 1);
});

t('TC05: hard bounce suppresses and blocklists the contact', async () => {
  await bounce(addr('bob'), 'hard', { classify_reason: 'smtp_status=5.1.1' });
  const c = await contactByEmail(addr('bob'));
  assert.equal(c.status, 'hard_bounced');
  assert.equal(c.listmonk_status, 'blocklisted');
  assert.equal(c.suppression_reason, 'hard_bounce');
});

t('TC06: soft bounce is recorded but contact stays eligible', async () => {
  await bounce(addr('carol'), 'soft', { classify_reason: 'smtp_status=4.2.2' });
  const c = await contactByEmail(addr('carol'));
  assert.equal(c.status, 'soft_bounced');
  assert.equal(c.listmonk_status, 'enabled');
});

t('5.7.1 policy rejection is held for review (not suppressed) and can be released', async () => {
  await bounce(addr('dave'), 'hard', { classify_reason: 'smtp_status=5.7.1' });
  let c = await contactByEmail(addr('dave'));
  assert.equal(c.status, 'pending_review');
  assert.equal(c.listmonk_status, 'blocklisted', 'held contacts must be excluded from sends');
  assert.equal(c.suppression_reason, null);
  const r = await http('admin', 'POST', `/api/contacts/${c.id}/review`, { resolution: 'valid', note: 'DMARC fixed' });
  assert.equal(r.status, 200, JSON.stringify(r));
  await sync.runOnce();
  c = await contactByEmail(addr('dave'));
  assert.equal(c.listmonk_status, 'enabled');
  assert.ok(c.list_ids.includes(listId), 'subscription restored');
});

t('TC08: unsubscribe suppresses immediately', async () => {
  const c = await contactByEmail(addr('erin'));
  const r = await http('admin', 'POST', '/api/contacts/actions', { action: 'unsubscribe', ids: [c.id], note: 'phone request' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const after = await contactByEmail(addr('erin'));
  assert.equal(after.status, 'unsubscribed');
  assert.equal(after.listmonk_status, 'blocklisted');
});

t('unsubscribe via listmonk (public link) becomes a global suppression', async () => {
  const c = await contactByEmail(addr('frank'));
  await lm.manageLists({ ids: [c.id], action: 'unsubscribe', listIds: [listId] });
  await sync.runOnce();
  await sync.runOnce();
  const after = await contactByEmail(addr('frank'));
  assert.equal(after.suppression_reason, 'unsubscribe');
  assert.equal(after.listmonk_status, 'blocklisted');
});

t('TC11: complaint blocklists the contact', async () => {
  await bounce(addr('carol'), 'complaint', {});
  const c = await contactByEmail(addr('carol'));
  assert.equal(c.status, 'complaint');
  assert.equal(c.listmonk_status, 'blocklisted');
});

t('TC09/TC10: re-importing unsubscribed and hard-bounced contacts keeps them suppressed', async () => {
  const csv = `email,consent_method\n${addr('erin')},web_form\n${addr('bob')},web_form\n${addr('carol')},web_form`;
  const { preview } = await runImport(csv, { listIds: [listId], consent: { method: 'web_form' } });
  assert.equal(preview.suppressed, 3);
  assert.equal(preview.new || 0, 0);
  for (const n of ['erin', 'bob', 'carol']) assert.equal((await contactByEmail(addr(n))).listmonk_status, 'blocklisted');
});

t('adding to a list never re-subscribes someone who unsubscribed from it', async () => {
  const alice = await contactByEmail(addr('alice'));
  // Simulate list-level unsubscribe without global suppression by unsubscribing and then lifting.
  await lm.manageLists({ ids: [alice.id], action: 'unsubscribe', listIds: [listId] });
  const r = await http('admin', 'POST', '/api/contacts/actions', { action: 'add_to_lists', ids: [alice.id], listIds: [listId] });
  assert.equal(r.data.changed, 0);
  const { rows } = await pool.query('SELECT status FROM subscriber_lists WHERE subscriber_id = $1 AND list_id = $2', [alice.id, listId]);
  assert.equal(rows[0].status, 'unsubscribed');
});

t('TC12/enforcement: a suppressed contact re-enabled directly in listmonk is blocked again', async () => {
  const bob = await contactByEmail(addr('bob'));
  await lm.patchSubscriber(bob.id, { status: 'enabled' });
  await sync.runOnce();
  const after = await contactByEmail(addr('bob'));
  assert.equal(after.listmonk_status, 'blocklisted');
  const { rows } = await pool.query(`SELECT 1 FROM portal.alerts WHERE key = 'suppression_reenforced' AND resolved_at IS NULL`);
  assert.equal(rows.length, 1);
});

t('manual add of a suppressed address is refused', async () => {
  const r = await http('admin', 'POST', '/api/contacts', { email: addr('newbie'), consent: { method: 'web_form' } });
  assert.equal(r.status, 201, JSON.stringify(r));
  const s = await http('admin', 'POST', '/api/suppressions', { emails: [addr('blocked')], note: 'legal' });
  assert.equal(s.data.added, 1);
  const r2 = await http('admin', 'POST', '/api/contacts', { email: addr('blocked'), consent: { method: 'web_form' } });
  assert.equal(r2.status, 409);
});

t('reactivation requires an admin, a reason and a new permission basis', async () => {
  const list = await http('admin', 'GET', `/api/suppressions?q=${encodeURIComponent(addr('erin'))}`);
  const sup = list.data[0];
  const weak = await http('admin', 'POST', `/api/suppressions/${sup.id}/lift`, { reason: 'because', consent: { method: 'web_form' } });
  assert.equal(weak.status, 422);
  const ok = await http('admin', 'POST', `/api/suppressions/${sup.id}/lift`, {
    reason: 'Re-subscribed via signed form 2026-11-10', resubscribe: true,
    consent: { method: 'paper_form', evidence: 'Form ref 991', purpose: 'Newsletter' } });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  await sync.runOnce();
  const erin = await contactByEmail(addr('erin'));
  assert.equal(erin.listmonk_status, 'enabled');
  assert.equal(erin.status, 'active');
});

t('TC13: campaign report and exports respond', async () => {
  const r = await http('admin', 'GET', '/api/reports/campaigns');
  assert.equal(r.status, 200);
  const res = await http('admin', 'GET', '/api/exports/contacts.csv?status=suppressed', undefined, { raw: true });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes(addr('bob')));
  assert.ok(!text.includes(addr('newbie')), 'active contacts are not in the suppressed export');
  const consent = await (await http('admin', 'GET', '/api/exports/consent.csv', undefined, { raw: true })).text();
  assert.ok(consent.includes('withdrawn'));
});

t('POPIA erasure deletes the contact but keeps a hashed suppression', async () => {
  const c = await contactByEmail(addr('frank'));
  const r = await http('admin', 'POST', `/api/contacts/${c.id}/erase`, { confirm: 'ERASE' });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(await contactByEmail(addr('frank')), undefined);
  const { preview } = await runImport(`email,consent_method\n${addr('frank')},web_form`, { listIds: [listId], consent: { method: '' } });
  assert.equal(preview.suppressed, 1, 'erased person cannot be re-imported');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM portal.suppressions WHERE email = $1`, [addr('frank')]);
  assert.equal(rows[0].n, 0, 'no plaintext email retained');
});

t('TC14: unreachable listmonk raises an administrative alert', async () => {
  const { SyncWorker } = require('../../src/modules/sync/worker');
  const { ListmonkClient } = require('../../src/lib/listmonk');
  const bad = new ListmonkClient({ baseUrl: 'http://127.0.0.1:1', apiUser: 'x', apiToken: 'y', timeoutMs: 1000 });
  const w = new SyncWorker({ pool, listmonk: bad, config, logger: pino({ level: 'silent' }) });
  await w.healthChecks();
  const { rows } = await pool.query(`SELECT severity FROM portal.alerts WHERE key = 'listmonk_unreachable' AND resolved_at IS NULL`);
  assert.equal(rows[0]?.severity, 'critical');
  await sync.healthChecks();
  const { rows: after } = await pool.query(`SELECT 1 FROM portal.alerts WHERE key = 'listmonk_unreachable' AND resolved_at IS NULL`);
  assert.equal(after.length, 0, 'alert resolves when listmonk is back');
});

t('auth: wrong password is a clean 401, and 10 failures lock the account', async () => {
  jar.probe = new Map();
  const s1 = await http('probe', 'GET', '/api/auth/session');
  csrf.probe = s1.data.csrfToken;
  const email = `viewer-${RUN}@mh-test.example`;
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await http('probe', 'POST', '/api/auth/login', { email, password: 'wrong-password-1' })).status);
  assert.deepEqual([...new Set(statuses)], [401]);
  const locked = await http('probe', 'POST', '/api/auth/login', { email, password: 'Test-password-123' });
  assert.equal(locked.status, 429, 'correct password refused while locked');
  await pool.query(`UPDATE portal.users SET locked_until = NULL, failed_logins = 0 WHERE email = $1`, [email]);
});

t('env admin: exists, is admin, and cannot be demoted, disabled or re-passworded in the UI', async () => {
  const { rows } = await pool.query(`SELECT id, role, managed_by_env FROM portal.users WHERE email = $1`, [`envadmin-${RUN}@mh-test.example`]);
  assert.equal(rows[0].role, 'admin');
  assert.equal(rows[0].managed_by_env, true);
  const id = rows[0].id;
  assert.equal((await http('admin', 'PATCH', `/api/users/${id}`, { role: 'viewer' })).status, 400);
  assert.equal((await http('admin', 'PATCH', `/api/users/${id}`, { status: 'disabled' })).status, 400);
  assert.equal((await http('admin', 'PATCH', `/api/users/${id}`, { password: 'Another-pass-123' })).status, 400);
  assert.equal((await http('admin', 'PATCH', `/api/users/${id}`, { name: 'Owner', role: 'admin', status: 'active' })).status, 200, 'renaming is allowed');
  // A changed ADMIN_PASSWORD is applied on the next start.
  const { ensureEnvAdmin } = require('../../src/lib/startup');
  await ensureEnvAdmin(pool, { ...config, ADMIN_PASSWORD: 'Rotated-admin-pass-2' }, pino({ level: 'silent' }));
  jar.env = new Map();
  await login('env', `envadmin-${RUN}@mh-test.example`, 'Rotated-admin-pass-2');
  const cp = await http('env', 'POST', '/api/auth/change-password', { currentPassword: 'Rotated-admin-pass-2', newPassword: 'Something-else-123' });
  assert.equal(cp.status, 422, 'password changes must go through the variable');
});

t('bulk select: ids endpoint returns every matching contact (managers only)', async () => {
  const r = await http('admin', 'GET', `/api/contacts/ids?q=${encodeURIComponent(`.${RUN}@mh-test.example`)}`);
  assert.equal(r.status, 200);
  assert.ok(r.data.ids.length >= 3);
  assert.equal(r.data.truncated, false);
  assert.equal((await http('viewer', 'GET', '/api/contacts/ids')).status, 403);
});

t('self-bootstrap: a revoked listmonk token is replaced automatically', async () => {
  const { resolveListmonkCredentials } = require('../../src/lib/startup');
  const { setSecret } = require('../../src/lib/secrets');
  await setSecret(pool, config.SESSION_SECRET, 'listmonk_api_token', 'not-a-valid-token');
  const creds = await resolveListmonkCredentials(pool, config, pino({ level: 'silent' }));
  assert.equal(creds.source, 'created');
  lm.setCredentials(creds.user, creds.token);
  assert.ok(await lm.getLists(), 'new token works');
  const again = await resolveListmonkCredentials(pool, config, pino({ level: 'silent' }));
  assert.equal(again.source, 'stored', 'a working stored token is reused, not recreated');
});
