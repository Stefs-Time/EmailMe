'use strict';

/**
 * End-to-end acceptance tests (scope §10) against a real PostgreSQL database
 * and a local SMTP server (test/helpers/smtpSink.js).
 *
 *   TEST_DATABASE_URL=postgres://…/mailharbor_test npm run test:integration
 *
 * SAFETY: the suite drops and recreates the `portal` schema, so it refuses to
 * run unless the database name contains "test".
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pino = require('pino');
const { startSink } = require('../helpers/smtpSink');

const DB = process.env.TEST_DATABASE_URL;
const enabled = Boolean(DB) && /test/i.test(new URL(DB || 'postgres://x/x').pathname);
const t = (name, fn) => test(name, { skip: !enabled && 'set TEST_DATABASE_URL to a database whose name contains "test"' }, fn);

let sink; let server; let base; let pool; let worker; let settings;
const jar = {};
const csrf = {};
let listId; let doubleListId; let campaignId;

async function http(who, method, path, body, { raw } = {}) {
  jar[who] ||= new Map();
  const headers = { Accept: 'application/json' };
  const cookies = [...jar[who].entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) headers.Cookie = cookies;
  if (method !== 'GET' && csrf[who]) headers['X-CSRF-Token'] = csrf[who];
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar[who].set(kv.slice(0, i), kv.slice(i + 1));
  }
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

async function session(who) {
  const s = await http(who, 'GET', '/api/auth/session');
  csrf[who] = s.data.csrfToken;
  return s.data;
}

async function login(who, email, password) {
  await session(who);
  const r = await http(who, 'POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r));
  csrf[who] = r.data.csrfToken;
}

/** Runs the sender until nothing more can be sent right now. */
async function drain() {
  for (let i = 0; i < 50; i += 1) {
    worker.sender.tokens = 1000;
    if (!(await worker.sender.tick())) break;
  }
  await new Promise((r) => setTimeout(r, 200));
}

const sinkTo = (email) => sink.messages.filter((m) => m.envelope.rcptTo.some((r) => r.address === email));

async function contact(email) {
  const r = await http('admin', 'GET', `/api/contacts?q=${encodeURIComponent(email)}`);
  return r.data.find((c) => c.email === email);
}

async function webhook(event) {
  const { rows } = await pool.query(`SELECT value FROM portal.settings WHERE key = 'webhook_token'`);
  return fetch(`${base}/webhooks/bounce?token=${rows[0].value}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
}

async function addContact(email, extra = {}) {
  const r = await http('admin', 'POST', '/api/contacts', { email, firstName: email.split('@')[0], listIds: [listId], consent: { method: 'web_form' }, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.data.id;
}

async function newCampaign(name, lists = [listId], body = '<p>Hello {{ first_name | "friend" }}, <a href="https://example.org/offer">see the offer</a>.</p>') {
  const c = await http('admin', 'POST', '/api/campaigns', { name });
  const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, {
    name, subject: `${name} for {{ first_name }}`, preheader: 'Preview', from_name: 'Acme', from_email: 'news@acme.example', reply_to: '',
    template_id: c.data.template_id, editor: 'visual', body_html: body, body_text: '', track_opens: true, track_clicks: true, list_ids: lists,
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  return c.data.id;
}

async function runImport(csv, options) {
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'test.csv');
  const up = await http('admin', 'POST', '/api/imports', form);
  assert.equal(up.status, 201, JSON.stringify(up));
  const pv = await http('admin', 'POST', `/api/imports/${up.data.id}/preview`, { mapping: up.data.mapping, options });
  assert.equal(pv.status, 200, JSON.stringify(pv));
  const preview = pv.data.import.summary.preview;
  if (!pv.data.import.summary.importable) return { preview, result: {} };
  assert.equal((await http('admin', 'POST', `/api/imports/${up.data.id}/commit`)).status, 202);
  for (let i = 0; i < 100; i += 1) {
    const s = await http('admin', 'GET', `/api/imports/${up.data.id}`);
    if (s.data.status === 'completed') return { preview, result: s.data.summary };
    assert.notEqual(s.data.status, 'failed', s.data.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
}

before(async () => {
  if (!enabled) return;
  sink = await startSink();
  const { loadConfig } = require('../../src/config');
  const { createPool } = require('../../src/db/pool');
  const { migrate } = require('../../src/db/migrate');
  const { getOrCreate } = require('../../src/lib/secrets');
  const { Settings } = require('../../src/lib/settings');
  const { createTransport } = require('../../src/engine/mailer');
  const { Worker } = require('../../src/engine/worker');
  const { ensureDefaultTemplate } = require('../../src/modules/templates/routes');
  const { announceSetupCode } = require('../../src/modules/settings/routes');
  const { createApp } = require('../../src/app');
  const config = loadConfig({ DATABASE_URL: DB, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_USER: sink.user, SMTP_PASSWORD: sink.pass,
    SMTP_REQUIRE_TLS: 'false', NODE_ENV: 'test', WORKERS: 'false', LOG_LEVEL: 'silent' });
  const logger = pino({ level: 'silent' });
  pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS portal CASCADE');
  await migrate(pool, logger);
  settings = new Settings(pool, await getOrCreate(pool, 'enc_key'), config);
  await ensureDefaultTemplate(pool);
  await announceSetupCode(pool, logger);
  const transport = createTransport(config);
  worker = new Worker({ pool, settings, transport, logger });
  const app = createApp({ pool, config, logger, settings, transport, worker, track: () => {}, sessionSecret: 'x'.repeat(40) });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!enabled) return;
  server?.close();
  await worker?.stop();
  await pool?.end();
  await sink?.close();
});

// ---- Setup & security -------------------------------------------------------
t('first-run setup requires the code from the log, then creates the administrator', async () => {
  const s = await session('admin');
  assert.equal(s.setupNeeded, true);
  const body = { name: 'Owner', email: 'owner@acme.example', password: 'Owner-pass-2026', org_name: 'Acme Trading',
    public_url: 'https://mail.acme.example', from_email: 'news@acme.example' };
  assert.equal((await http('admin', 'POST', '/api/setup', { ...body, code: 'WRONGCODE1' })).status, 403);
  const { rows } = await pool.query(`SELECT value FROM portal.app_secrets WHERE key = 'setup_code'`);
  const r = await http('admin', 'POST', '/api/setup', { ...body, code: rows[0].value });
  assert.equal(r.status, 201, JSON.stringify(r));
  csrf.admin = r.data.csrfToken;
  await session('other');
  assert.equal((await http('other', 'POST', '/api/setup', { ...body, code: rows[0].value })).status, 409, 'setup cannot be repeated');
  const st = await http('admin', 'PUT', '/api/settings', { org_address: '12 Main Road, Rosebank', send_rate_per_second: 50 });
  assert.equal(st.data.org_name, 'Acme Trading', 'partial settings updates keep other values');
  assert.equal(st.data.public_url, 'https://mail.acme.example');
});

t('security: CSRF required; viewer is read-only; wrong password is 401 and 10 failures lock', async () => {
  const saved = csrf.admin;
  csrf.admin = '';
  assert.equal((await http('admin', 'POST', '/api/lists', { name: 'x' })).status, 403);
  csrf.admin = saved;
  const u = await http('admin', 'POST', '/api/users', { email: 'viewer@acme.example', name: 'Viewer', role: 'viewer', password: 'Viewer-pass-2026' });
  assert.equal(u.status, 201);
  await login('viewer', 'viewer@acme.example', 'Viewer-pass-2026');
  assert.equal((await http('viewer', 'POST', '/api/lists', { name: 'x' })).status, 403);
  assert.equal((await http('viewer', 'POST', '/api/campaigns', { name: 'x' })).status, 403);
  assert.equal((await http('viewer', 'GET', '/api/settings')).status, 403);
  assert.equal((await http('viewer', 'GET', '/api/exports/contacts.csv', undefined, { raw: true })).status, 403);
  await session('probe');
  const codes = [];
  for (let i = 0; i < 10; i += 1) codes.push((await http('probe', 'POST', '/api/auth/login', { email: 'viewer@acme.example', password: 'nope-nope-1' })).status);
  assert.deepEqual([...new Set(codes)], [401]);
  assert.equal((await http('probe', 'POST', '/api/auth/login', { email: 'viewer@acme.example', password: 'Viewer-pass-2026' })).status, 429);
  await pool.query(`UPDATE portal.users SET locked_until = NULL WHERE email = 'viewer@acme.example'`);
});

// ---- Contacts & import -----------------------------------------------------
t('setup data: lists', async () => {
  listId = (await http('admin', 'POST', '/api/lists', { name: 'Newsletter' })).data.id;
  doubleListId = (await http('admin', 'POST', '/api/lists', { name: 'Confirmed only', optin: 'double' })).data.id;
  assert.ok(listId && doubleListId);
});

t('TC02/TC03: CSV import validates, de-duplicates and requires consent', async () => {
  const csv = ['Email,First Name,Surname,Company,consent_method,city',
    'alice@ok.example,Alice,Anders,Acme,web_form,Durban', 'bob@ok.example,Bob,Botha,,web_form,', 'carol@ok.example,Carol,Cele,,web_form,',
    'hard-dan@ok.example,Dan,Dube,,web_form,', 'soft-eve@ok.example,Eve,Els,,web_form,', 'policy-pat@ok.example,Pat,Pillay,,web_form,',
    'ALICE@ok.example,Dup,Licate,,web_form,', 'not-an-email,Bad,Row,,web_form,', 'noconsent@ok.example,No,Consent,,,'].join('\n');
  const { preview, result } = await runImport(csv, { listIds: [listId], source: 'import-1', subscriptionStatus: 'confirmed', consent: { method: '' } });
  assert.deepEqual([preview.new, preview.duplicate, preview.invalid_email, preview.missing_consent], [6, 1, 1, 1]);
  assert.equal(result.imported, 6);
  const alice = await contact('alice@ok.example');
  assert.equal(alice.status, 'active');
  assert.equal(alice.attribs.city, 'Durban');
  assert.equal(alice.company, 'Acme');
  const again = await runImport('email,consent_method\nalice@ok.example,web_form', { listIds: [listId], consent: { method: '' } });
  assert.equal(again.preview.existing_unchanged, 1, 'TC03: no duplicate record');
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM portal.contacts WHERE LOWER(email) = 'alice@ok.example'`);
  assert.equal(rows[0].n, 1);
});

// ---- Sending -----------------------------------------------------------------
t('TC04: personalised individual emails with unsubscribe headers; TC05 hard bounce; 5.7.1 held for review', async () => {
  campaignId = await newCampaign('November news');
  const ready = await http('admin', 'GET', `/api/campaigns/${campaignId}`);
  assert.deepEqual(ready.data.problems, []);
  assert.equal(ready.data.eligible, 6);
  const sent = await http('admin', 'POST', `/api/campaigns/${campaignId}/send`);
  assert.equal(sent.data.recipients, 6);
  await drain();

  const mails = sinkTo('alice@ok.example');
  assert.equal(mails.length, 1);
  const m = mails[0];
  assert.equal(m.envelope.rcptTo.length, 1, 'one recipient per message');
  assert.equal(m.parsed.subject, 'November news for Alice');
  assert.match(m.parsed.html, /Hello Alice/);
  assert.match(m.parsed.html, /12 Main Road, Rosebank/, 'sender postal address in footer');
  assert.match(m.raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(m.raw.replace(/\r\n[ \t]+/g, ' '), /List-Unsubscribe: <https:\/\/mail\.acme\.example\/u\//);
  assert.match(m.parsed.html, /https:\/\/mail\.acme\.example\/t\/c\//, 'click tracking');
  assert.match(m.parsed.text, /Unsubscribe: https:\/\/mail\.acme\.example\/u\//);

  assert.equal((await contact('hard-dan@ok.example')).status, 'hard_bounced', 'TC05');
  assert.equal((await contact('policy-pat@ok.example')).status, 'pending_review');
  const soft = await pool.query(`SELECT status, error FROM portal.messages WHERE email = 'soft-eve@ok.example'`);
  assert.equal(soft.rows[0].status, 'queued', 'TC06: temporary failure is retried');
  assert.match(soft.rows[0].error, /4\.2\.2/);
});

t('TC06/TC07: soft bounces are counted and suppressed after the limit', async () => {
  for (let i = 0; i < 4; i += 1) {
    await pool.query(`UPDATE portal.messages SET next_attempt_at = NOW() WHERE email = 'soft-eve@ok.example' AND status = 'queued'`);
    await drain();
  }
  const msg = await pool.query(`SELECT status FROM portal.messages WHERE email = 'soft-eve@ok.example'`);
  assert.equal(msg.rows[0].status, 'failed');
  let eve = await contact('soft-eve@ok.example');
  assert.equal(eve.status, 'soft_bounced');
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await webhook({ email: 'soft-eve@ok.example', type: 'soft', reason: '452 4.2.2 mailbox full', id: `evt-soft-${i}` })).status, 200);
  }
  assert.equal((await webhook({ email: 'soft-eve@ok.example', type: 'soft', reason: 'dup', id: 'evt-soft-1' })).status, 200, 'duplicate event ignored');
  eve = await contact('soft-eve@ok.example');
  assert.equal(eve.status, 'hard_bounced');
  assert.equal(eve.suppression_reason, 'soft_limit');
});

t('TC13: campaign report counts are correct and the campaign completes', async () => {
  const c = (await http('admin', 'GET', `/api/reports/campaigns/${campaignId}`)).data.campaign;
  assert.equal(c.status, 'sent');
  assert.equal(c.targeted, 6);
  assert.equal(c.sent, 3);
  assert.equal(c.hard_bounces, 1);
  assert.equal(c.review_bounces, 1);
  assert.equal(c.soft_bounces, 1);
});

t('tracking: open pixel and click redirect (stored URLs only)', async () => {
  const { rows } = await pool.query(`SELECT uuid FROM portal.messages WHERE email = 'alice@ok.example' AND kind = 'campaign'`);
  const token = rows[0].uuid;
  assert.equal((await fetch(`${base}/t/o/${token}.gif`)).status, 200);
  const { rows: l } = await pool.query('SELECT id FROM portal.links WHERE campaign_id = $1', [campaignId]);
  const click = await fetch(`${base}/t/c/${token}/${l[0].id}`, { redirect: 'manual' });
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('location'), 'https://example.org/offer');
  assert.equal((await fetch(`${base}/t/c/${token}/999999`, { redirect: 'manual' })).status, 404);
  await new Promise((r) => setTimeout(r, 200));
  const c = (await http('admin', 'GET', `/api/reports/campaigns/${campaignId}`)).data.campaign;
  assert.equal(c.unique_opens, 1);
  assert.equal(c.unique_clicks, 1);
});

t('TC08: one-click unsubscribe suppresses immediately and is attributed to the campaign', async () => {
  const { rows } = await pool.query(`SELECT uuid FROM portal.messages WHERE email = 'bob@ok.example' AND kind = 'campaign'`);
  const page = await fetch(`${base}/u/${rows[0].uuid}`);
  assert.match(await page.text(), /Unsubscribe\?/, 'GET shows a confirmation page and changes nothing');
  assert.equal((await contact('bob@ok.example')).status, 'active');
  const r = await fetch(`${base}/u/${rows[0].uuid}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.equal((await contact('bob@ok.example')).status, 'unsubscribed');
  assert.equal((await http('admin', 'GET', `/api/reports/campaigns/${campaignId}`)).data.campaign.unsubscribes, 1);
});

t('TC11: complaint via webhook suppresses; a bad webhook token is rejected', async () => {
  assert.equal((await fetch(`${base}/webhooks/bounce?token=wrong`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  await webhook({ email: 'carol@ok.example', type: 'complaint', id: 'evt-c1' });
  assert.equal((await contact('carol@ok.example')).status, 'complaint');
});

t('TC09/TC10/TC12: re-imports stay suppressed and the next campaign excludes them', async () => {
  const csv = 'email,consent_method\nbob@ok.example,web_form\nhard-dan@ok.example,web_form\ncarol@ok.example,web_form\nsoft-eve@ok.example,web_form';
  const { preview } = await runImport(csv, { listIds: [listId], consent: { method: '' } });
  assert.equal(preview.suppressed, 4);
  const c2 = await newCampaign('December news');
  assert.equal((await http('admin', 'GET', `/api/campaigns/${c2}`)).data.eligible, 1, 'only alice (pat is held)');
  sink.messages.length = 0;
  await http('admin', 'POST', `/api/campaigns/${c2}/send`);
  await drain();
  assert.deepEqual(sink.messages.map((m) => m.envelope.rcptTo[0].address), ['alice@ok.example']);
});

t('adding to a list never re-subscribes someone who unsubscribed from it', async () => {
  const alice = await contact('alice@ok.example');
  await http('admin', 'POST', '/api/contacts/actions', { action: 'unsubscribe_from_lists', ids: [alice.id], listIds: [listId] });
  const r = await http('admin', 'POST', '/api/contacts/actions', { action: 'add_to_lists', ids: [alice.id], listIds: [listId] });
  assert.equal(r.data.changed, 0);
  const { rows } = await pool.query('SELECT status FROM portal.list_members WHERE contact_id = $1 AND list_id = $2', [alice.id, listId]);
  assert.equal(rows[0].status, 'unsubscribed');
});

t('suppression is checked again at send time (unsubscribed mid-campaign gets nothing)', async () => {
  const id = await addContact('late@ok.example');
  const c3 = await newCampaign('Flash sale');
  await http('admin', 'POST', `/api/campaigns/${c3}/send`);
  await http('admin', 'POST', '/api/contacts/actions', { action: 'unsubscribe', ids: [id], note: 'phoned in' });
  sink.messages.length = 0;
  await drain();
  assert.equal(sinkTo('late@ok.example').length, 0);
  const { rows } = await pool.query(`SELECT status FROM portal.messages WHERE campaign_id = $1 AND email = 'late@ok.example'`, [c3]);
  assert.equal(rows[0].status, 'skipped');
});

t('review hold: releasing makes the contact eligible again', async () => {
  const pat = await contact('policy-pat@ok.example');
  assert.equal((await http('admin', 'POST', `/api/contacts/${pat.id}/review`, { resolution: 'valid', note: 'DMARC fixed' })).status, 200);
  assert.equal((await contact('policy-pat@ok.example')).status, 'active');
});

t('double opt-in: confirmation email; GET does not confirm, POST does', async () => {
  sink.messages.length = 0;
  await http('admin', 'POST', '/api/contacts', { email: 'dee@ok.example', firstName: 'Dee', listIds: [doubleListId], consent: { method: 'web_form' } });
  assert.equal((await contact('dee@ok.example')).status, 'unconfirmed');
  await drain();
  const mail = sinkTo('dee@ok.example')[0];
  assert.match(mail.parsed.subject, /confirm/i);
  const link = /https:\/\/mail\.acme\.example(\/s\/confirm\/[0-9a-f-]{36})/.exec(mail.parsed.html)[1];
  await fetch(base + link);
  assert.equal((await contact('dee@ok.example')).status, 'unconfirmed', 'link scanners (GET) cannot confirm');
  await fetch(base + link, { method: 'POST' });
  assert.equal((await contact('dee@ok.example')).status, 'active');
});

t('reactivation requires an admin, a reason and new consent', async () => {
  const sup = (await http('admin', 'GET', '/api/suppressions?q=bob%40ok.example')).data[0];
  assert.equal((await http('admin', 'POST', `/api/suppressions/${sup.id}/lift`, { reason: 'short', consent: { method: 'web_form' } })).status, 422);
  const ok = await http('admin', 'POST', `/api/suppressions/${sup.id}/lift`, {
    reason: 'Re-subscribed with signed form on 10 Nov', resubscribe: true, consent: { method: 'paper_form', evidence: 'Form ref 991' } });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal((await contact('bob@ok.example')).status, 'active');
});

t('POPIA erasure keeps only a hash; the erased person cannot be re-imported', async () => {
  const carol = await contact('carol@ok.example');
  assert.equal((await http('admin', 'POST', `/api/contacts/${carol.id}/erase`, { confirm: 'ERASE' })).status, 200);
  assert.equal(await contact('carol@ok.example'), undefined);
  const { preview } = await runImport('email,consent_method\ncarol@ok.example,web_form', { listIds: [listId], consent: { method: '' } });
  assert.equal(preview.suppressed, 1);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM portal.suppressions WHERE email = 'carol@ok.example'`);
  assert.equal(rows[0].n, 0);
});

t('TC14: SMTP unavailable pauses the campaign, raises a critical alert, and loses nothing', async () => {
  const { createTransport } = require('../../src/engine/mailer');
  const { Worker } = require('../../src/engine/worker');
  const { loadConfig } = require('../../src/config');
  const bad = createTransport(loadConfig({ DATABASE_URL: DB, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_REQUIRE_TLS: 'false' }));
  const w = new Worker({ pool, settings, transport: bad, logger: pino({ level: 'silent' }) });
  await addContact('paused@ok.example');
  const c4 = await newCampaign('Paused one');
  await http('admin', 'POST', `/api/campaigns/${c4}/send`);
  w.sender.tokens = 100;
  await w.sender.tick();
  const r = await http('admin', 'GET', `/api/campaigns/${c4}`);
  assert.equal(r.data.status, 'paused');
  assert.match(r.data.pause_reason, /Paused automatically/);
  const { rows } = await pool.query(`SELECT severity FROM portal.alerts WHERE key = 'smtp_unavailable' AND resolved_at IS NULL`);
  assert.equal(rows[0].severity, 'critical');
  const { rows: q } = await pool.query(`SELECT status FROM portal.messages WHERE campaign_id = $1`, [c4]);
  assert.ok(q.every((m) => m.status === 'queued'), 'nothing was lost');
  bad.close();
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c4}/resume`)).status, 200);
  await pool.query(`UPDATE portal.messages SET next_attempt_at = NOW() WHERE campaign_id = $1`, [c4]);
  await drain();
  assert.equal((await http('admin', 'GET', `/api/campaigns/${c4}`)).data.status, 'sent');
  const { rows: a } = await pool.query(`SELECT 1 FROM portal.alerts WHERE key = 'smtp_unavailable' AND resolved_at IS NULL`);
  assert.equal(a.length, 0, 'alert resolves after a successful send');
});

t('TC14 (scope): bounce mailbox unavailable raises a critical alert; password stored encrypted', async () => {
  const closed = require('node:net').createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r)); // nothing listens there now
  const put = await http('admin', 'PUT', '/api/settings', {
    bounce_mailbox: { enabled: true, host: '127.0.0.1', port, secure: false, user: 'bounces', password: 'secret-pw-123' },
  });
  assert.equal(put.status, 200, JSON.stringify(put));
  assert.equal(put.data.bounce_mailbox.password, undefined, 'password never returned');
  assert.equal(put.data.bounce_mailbox.password_set, true);
  const { rows: raw } = await pool.query(`SELECT value::text AS v FROM portal.settings WHERE key = 'bounce_mailbox'`);
  assert.ok(!raw[0].v.includes('secret-pw-123'), 'password encrypted at rest');
  const poll = await http('admin', 'POST', '/api/settings/mailbox-poll');
  assert.ok(poll.data.error, JSON.stringify(poll));
  const { rows } = await pool.query(`SELECT severity FROM portal.alerts WHERE key = 'bounce_mailbox_error' AND resolved_at IS NULL`);
  assert.equal(rows[0]?.severity, 'critical');
  const health = await http('admin', 'GET', '/api/system/health');
  assert.equal(health.status, 200);
  await http('admin', 'PUT', '/api/settings', { bounce_mailbox: { enabled: false } });
});

t('exports and campaign report download as CSV', async () => {
  const text = await (await http('admin', 'GET', '/api/exports/contacts.csv?status=suppressed', undefined, { raw: true })).text();
  assert.ok(text.includes('hard-dan@ok.example'));
  assert.ok(!text.includes('dee@ok.example'));
  const consent = await (await http('admin', 'GET', '/api/exports/consent.csv', undefined, { raw: true })).text();
  assert.ok(consent.includes('withdrawn'));
  const camp = await (await http('admin', 'GET', '/api/reports/campaigns.csv', undefined, { raw: true })).text();
  assert.ok(camp.includes('November news'));
});
