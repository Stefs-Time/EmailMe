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

let sink; let server; let base; let pool; let worker; let settings; let transport;
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
    body_html: body, track_opens: true, track_clicks: true, list_ids: lists,
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
  const { MailTransport } = require('../../src/engine/mailer');
  const { Worker } = require('../../src/engine/worker');
  const { upgradeToEmailDesign } = require('../../src/lib/emailDesign');
  const { announceSetupCode } = require('../../src/modules/settings/routes');
  const { createApp } = require('../../src/app');
  const config = loadConfig({ DATABASE_URL: DB, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_USER: sink.user, SMTP_PASSWORD: sink.pass,
    SMTP_REQUIRE_TLS: 'false', NODE_ENV: 'test', WORKERS: 'false', LOG_LEVEL: 'silent' });
  const logger = pino({ level: 'silent' });
  pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS portal CASCADE');
  await migrate(pool, logger);
  settings = new Settings(pool, await getOrCreate(pool, 'enc_key'), config);
  await upgradeToEmailDesign(pool, settings, logger);
  await announceSetupCode(pool, logger);
  transport = new MailTransport(config, settings);
  worker = new Worker({ pool, settings, transport, logger, config });
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
  // UTM tags are on by default (Settings → Sending): Google Analytics sees the campaign.
  assert.equal(click.headers.get('location'), 'https://example.org/offer?utm_source=mailharbor&utm_medium=email&utm_campaign=november-news');
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

t('drag-and-drop builder: new campaigns start in the builder; the server validates, renders and sends the design', async () => {
  await addContact('builder-bea@ok.example');
  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Builder campaign' });
  assert.equal(c.status, 201);
  assert.equal(c.data.editor, 'builder');
  assert.equal(c.data.body_json.blocks.length, 3, 'starter design');

  const base = { name: 'Builder campaign', subject: 'Designed for {{ first_name }}', preheader: '', from_name: 'Acme', from_email: 'news@acme.example',
    reply_to: '', editor: 'builder', body_text: '', track_opens: true, track_clicks: true, list_ids: [listId] };
  const bad = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { ...base, body_json: { blocks: [{ id: 'x', type: 'button', props: { url: 'javascript:alert(1)' } }] } });
  assert.equal(bad.status, 422, 'invalid design rejected');
  assert.ok(bad.error.details.some((d) => d.field.includes('url')));

  const design = { version: 1, blocks: [
    { id: 'h', type: 'heading', props: { text: 'Hi {{ first_name | "friend" }}', align: 'center' } },
    { id: 'c', type: 'columns', props: { columns: [
      [{ id: 'i', type: 'image', props: { src: 'https://cdn.acme.example/p.png', alt: 'Product' } }],
      [{ id: 't', type: 'text', props: { html: '<p onclick="x()">Only <strong>R99</strong></p>' } }]] } },
    { id: 'b', type: 'button', props: { label: 'Buy now', url: '' } },
  ] };
  let r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { ...base, body_json: design });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok((await http('admin', 'GET', `/api/campaigns/${c.data.id}`)).data.problems.some((p) => /button has no link/.test(p)), 'readiness flags a button without a link');
  assert.doesNotMatch(JSON.stringify(r.data.body_json), /onclick/, 'stored design is cleaned');

  design.blocks[2].props.url = 'https://shop.acme.example/buy';
  r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { ...base, body_json: design });
  assert.deepEqual((await http('admin', 'GET', `/api/campaigns/${c.data.id}`)).data.problems, []);
  assert.match(r.data.body_html, /class="mh-col"/);

  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).status, 200);
  await drain();
  const [m] = sinkTo('builder-bea@ok.example');
  assert.ok(m, 'builder email delivered');
  assert.match(m.parsed.html, />Hi builder-bea<\/h2>/);
  assert.match(m.parsed.html, /<strong>R99<\/strong>/);
  assert.match(m.parsed.html, /https:\/\/mail\.acme\.example\/t\/c\/[^"]+/, 'button link is click-tracked');
  assert.doesNotMatch(m.parsed.html, /shop\.acme\.example\/buy"/, 'raw button URL replaced by the tracked redirect');

  const dup = await http('admin', 'POST', `/api/campaigns/${c.data.id}/duplicate`);
  const copy = await http('admin', 'GET', `/api/campaigns/${dup.data.id}`);
  assert.equal(copy.data.editor, 'builder');
  assert.equal(copy.data.body_json.blocks.length, 3, 'duplicate keeps the design');
});

t('email design: one layout from Settings wraps every email; sent campaigns keep the design they were sent with', async () => {
  // Validated like any setting.
  assert.equal((await http('admin', 'PUT', '/api/settings', { email_brand_color: 'red' })).status, 422);
  assert.equal((await http('admin', 'PUT', '/api/settings', { email_logo_url: 'javascript:alert(1)' })).status, 422);
  assert.equal((await http('viewer', 'GET', '/api/settings/email-preview')).status, 403, 'design is an administrator setting');
  const saved = await http('admin', 'PUT', '/api/settings', {
    email_logo_url: 'https://cdn.acme.example/logo.png', email_brand_color: '#aa0011', email_heading_color: '#003322',
    email_background: '#eef3f1', email_font: 'georgia', email_footer_text: 'Proudly South African.', email_show_preferences: false,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved));

  // Preview: unsaved values in the query string, nothing stored.
  const pv = await http('admin', 'GET', '/api/settings/email-preview?email_brand_color=%23123456&email_logo_url=', undefined, { raw: true });
  const pvHtml = await pv.text();
  assert.match(pv.headers.get('content-security-policy'), /sandbox/);
  assert.match(pvHtml, /background-color:#123456/, 'preview uses the unsaved brand colour');
  assert.doesNotMatch(pvHtml, /logo\.png/, 'and the unsaved (empty) logo');
  assert.equal((await settings.all()).email_brand_color, '#aa0011', 'preview does not save');

  await addContact('design-dee@ok.example');
  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Uses the design' });
  assert.equal(c.data.from_email, '', 'sender left empty means Settings → Sending');
  assert.equal((await http('admin', 'GET', `/api/campaigns/${c.data.id}`)).data.defaults.design.brand, '#aa0011', 'editor gets the brand colours');
  c.data.body_json.blocks.find((b) => b.type === 'button').props.url = 'https://acme.example/spring';
  const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, {
    name: 'Uses the design', subject: 'Spring', preheader: '', from_name: '', from_email: '', reply_to: '',
    body_json: c.data.body_json, track_opens: false, track_clicks: false, list_ids: [listId],
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).status, 200);
  await drain();
  const [m] = sinkTo('design-dee@ok.example');
  assert.ok(m, 'delivered');
  assert.match(m.parsed.html, /src="https:\/\/cdn\.acme\.example\/logo\.png"/, 'logo header');
  assert.match(m.parsed.html, /background-color:#eef3f1/, 'page background');
  assert.match(m.parsed.html, /Georgia/, 'font');
  assert.match(m.parsed.html, /bgcolor="#aa0011"/, 'button follows the brand colour');
  assert.match(m.parsed.html, /color:#003322/, 'heading follows the heading colour');
  assert.match(m.parsed.html, /Proudly South African\./);
  assert.doesNotMatch(m.parsed.html, /Manage preferences/, 'preferences link switched off');
  assert.equal((m.parsed.html.match(/\/u\/[0-9a-f-]{36}/g) || []).length, 1, 'exactly one unsubscribe link (from the footer)');
  assert.equal(m.parsed.from.value[0].address, 'news@acme.example', 'sender from Settings');

  // Frozen: changing the design later never changes what was sent.
  const frozen = (await pool.query('SELECT layout_html FROM portal.campaigns WHERE id = $1', [c.data.id])).rows[0].layout_html;
  assert.match(frozen, /#eef3f1/);
  await http('admin', 'PUT', '/api/settings', { email_brand_color: '#0055ff', email_background: '#ffffff' });
  const { rows: msg } = await pool.query(`SELECT uuid FROM portal.messages WHERE campaign_id = $1 AND kind = 'campaign'`, [c.data.id]);
  const view = await (await fetch(`${base}/v/${msg[0].uuid}`)).text();
  assert.match(view, /bgcolor="#aa0011"/, 'view in browser shows the colours it was sent with');
  assert.doesNotMatch(view, /#0055ff/);
  const draft = await http('admin', 'POST', '/api/campaigns', { name: 'New look' });
  const pv2 = await (await http('admin', 'GET', `/api/campaigns/${draft.data.id}/preview`, undefined, { raw: true })).text();
  assert.match(pv2, /bgcolor="#0055ff"/, 'drafts use the current design');
  await http('admin', 'PUT', '/api/settings', { email_logo_url: '', email_background: '#f4f6f9', email_brand_color: '#1f4e8c', email_show_preferences: true });

  // Raw HTML from API clients becomes one HTML block in the builder.
  const api = await http('admin', 'PUT', `/api/campaigns/${draft.data.id}`, { name: 'New look', subject: 'x', body_html: '<p>From the API <script>x()</script></p>', list_ids: [listId] });
  assert.equal(api.status, 200, JSON.stringify(api));
  assert.equal(api.data.editor, 'builder');
  assert.equal(api.data.body_json.blocks[0].type, 'html');
  assert.doesNotMatch(api.data.body_html, /<script/);
  assert.equal((await http('admin', 'GET', '/api/templates')).status, 404, 'templates are gone');
});

t('samples and personalisation chips: ready-made designs; imported columns offered as fields', async () => {
  const samples = await http('admin', 'GET', '/api/campaigns/samples');
  assert.ok(samples.data.length >= 8);
  for (const id of ['promotion', 'product-launch', 'still-interested', 'find-out-more']) assert.ok(samples.data.some((s) => s.id === id), id);

  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Win-back', sample: 'still-interested' });
  assert.equal(c.status, 201);
  assert.equal(c.data.editor, 'builder');
  assert.match(c.data.subject, /are you still interested/);
  assert.match(c.data.body_html, /href="\{\{ unsubscribe_url \}\}"/, 'easy way out links to unsubscribe');
  const promo = await http('admin', 'POST', '/api/campaigns', { name: 'Promo', sample: 'promotion' });
  const ready = await http('admin', 'GET', `/api/campaigns/${promo.data.id}`);
  assert.ok(ready.data.problems.some((p) => /button has no link/.test(p)), 'web-address buttons in samples must be given a link before sending');
  assert.equal((await http('admin', 'POST', '/api/campaigns', { name: 'x', sample: 'nope' })).status, 422);
  assert.equal((await http('admin', 'GET', '/api/campaigns/samples/nope')).status, 404);

  await http('admin', 'POST', '/api/contacts', { email: 'attr-ann@ok.example', firstName: 'Ann', listIds: [listId], consent: { method: 'web_form' }, attribs: { city: 'Durban' } });
  const facets = await http('admin', 'GET', '/api/contacts/facets');
  assert.ok(facets.data.attributes.includes('city'), 'imported columns are offered as personalisation chips');
});

t('platform-managed links: buttons go to MailHarbor pages (stay subscribed, preferences, unsubscribe) with no URL to type', async () => {
  const l2 = await http('admin', 'POST', '/api/lists', { name: 'Events', optin: 'single' });
  assert.equal(l2.status, 201, JSON.stringify(l2));
  const add = await http('admin', 'POST', '/api/contacts', { email: 'pref-pat@ok.example', firstName: 'Pat', listIds: [listId, l2.data.id], consent: { method: 'web_form' } });
  assert.equal(add.status, 201, JSON.stringify(add));
  const add2 = await http('admin', 'POST', '/api/contacts', { email: 'all-al@ok.example', firstName: 'Al', listIds: [l2.data.id], consent: { method: 'web_form' } });
  assert.equal(add2.status, 201);

  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Still interested?', sample: 'still-interested' });
  assert.equal(c.data.body_json.blocks.find((b) => b.type === 'button').props.link, 'stay', 'sample button uses the built-in page');
  const design = c.data.body_json;
  design.blocks.push({ id: 'pb', type: 'button', props: { label: 'Manage preferences', link: 'preferences' } });
  const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, {
    name: 'Still interested?', subject: 'Still interested?', preheader: '', from_name: 'Acme', from_email: 'news@acme.example', reply_to: '',
    editor: 'builder', body_json: design, body_text: '', track_opens: false, track_clicks: true, list_ids: [l2.data.id],
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual((await http('admin', 'GET', `/api/campaigns/${c.data.id}`)).data.problems, [], 'no URL needed for platform links');

  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).status, 200);
  await drain();
  const [m] = sinkTo('pref-pat@ok.example');
  const link = (re) => { const x = m.parsed.html.match(re); assert.ok(x, `missing ${re}`); return x[0].replace('https://mail.acme.example', ''); };
  const stay = link(/https:\/\/mail\.acme\.example\/s\/stay\/[0-9a-f-]{36}/);
  const prefs = link(/https:\/\/mail\.acme\.example\/p\/[0-9a-f-]{36}/);
  link(/https:\/\/mail\.acme\.example\/u\/[0-9a-f-]{36}/);

  // Stay subscribed: GET only shows a page (scanner-safe); POST records it.
  let res = await fetch(base + stay);
  assert.match(await res.text(), /Yes, keep me subscribed/);
  assert.equal((await pool.query(`SELECT 1 FROM portal.recipient_events WHERE event_type = 'stayed_subscribed'`)).rowCount, 0);
  res = await fetch(base + stay, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.match(await res.text(), /Thank you/);

  // Preferences: keep one list, drop the other (no global suppression).
  res = await fetch(base + prefs);
  const page1 = await res.text();
  assert.match(page1, /Events/);
  res = await fetch(base + prefs, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `action=save&keep=${listId}` });
  assert.match(await res.text(), /preferences have been saved/);
  const pat = await contact('pref-pat@ok.example');
  const subs = (await http('admin', 'GET', `/api/contacts/${pat.id}`)).data.subscriptions;
  assert.equal(subs.find((s) => s.list_id === l2.data.id || s.id === l2.data.id)?.status, 'unsubscribed');
  assert.equal(subs.find((s) => s.list_id === listId || s.id === listId)?.status, 'subscribed');
  assert.notEqual(pat.status, 'unsubscribed', 'still subscribed to the other list');
  // A forged form cannot re-subscribe anyone.
  await fetch(base + prefs, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `action=save&keep=${listId}&keep=${l2.data.id}` });
  const subs2 = (await http('admin', 'GET', `/api/contacts/${pat.id}`)).data.subscriptions;
  assert.equal(subs2.find((s) => s.list_id === l2.data.id || s.id === l2.data.id)?.status, 'unsubscribed');

  // "Unsubscribe from everything" suppresses.
  const [m2] = sinkTo('all-al@ok.example');
  const prefs2 = m2.parsed.html.match(/https:\/\/mail\.acme\.example(\/p\/[0-9a-f-]{36})/)[1];
  await fetch(base + prefs2, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=all' });
  assert.equal((await contact('all-al@ok.example')).status, 'unsubscribed');

  const report = await http('admin', 'GET', `/api/reports/campaigns/${c.data.id}`);
  const rc = report.data.campaign || report.data;
  assert.equal(rc.stayed, 1);
  assert.equal(rc.preference_changes, 2);
  assert.ok(rc.unsubscribes >= 2);

  const usage = await http('admin', 'GET', '/api/reports/usage?days=7');
  assert.equal(usage.status, 200);
  assert.ok(usage.data.totals.today >= 2);
  assert.ok(usage.data.daily.length === 7);
  assert.equal(usage.data.actions.stayed_subscribed, 1);
  assert.ok(usage.data.byCampaign.some((x) => x.id === c.data.id));
});

t('permission request: introduction sample asks for consent; "Yes" records evidence once; suppressed never re-consented', async () => {
  const l = await http('admin', 'POST', '/api/lists', { name: 'Prospects', optin: 'single' });
  for (const [email, name] of [['pr-yes@ok.example', 'Yasmin'], ['pr-quiet@ok.example', 'Quinn'], ['pr-out@ok.example', 'Otto']]) {
    const a = await http('admin', 'POST', '/api/contacts', { email, firstName: name, listIds: [l.data.id], consent: { method: 'other', evidence: 'Business card, Expo 2026' } });
    assert.equal(a.status, 201, JSON.stringify(a));
  }
  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Intro to prospects', sample: 'permission-request' });
  assert.equal(c.status, 201, JSON.stringify(c));
  const btn = c.data.body_json.blocks.find((b) => b.type === 'button');
  assert.equal(btn.props.link, 'consent', 'sample button goes to the permission page');
  assert.match(c.data.body_html, /href="\{\{ consent_url \}\}"/);
  const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, {
    name: 'Intro to prospects', subject: 'May we keep in touch?', preheader: '', from_name: 'Acme', from_email: 'news@acme.example', reply_to: '',
    editor: 'builder', body_json: c.data.body_json, body_text: '', track_opens: false, track_clicks: true, list_ids: [l.data.id],
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual((await http('admin', 'GET', `/api/campaigns/${c.data.id}`)).data.problems, []);

  // A test email's link opens an explanation page and records nothing.
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/test`, { emails: ['tester@ok.example'] })).status, 202);
  await drain();
  const testLink = sinkTo('tester@ok.example')[0].parsed.html.match(/https:\/\/mail\.acme\.example(\/s\/consent\/[0-9a-f-]{36})/)[1];
  let res = await fetch(base + testLink, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.match(await res.text(), /This is a test email/);

  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).status, 200);
  await drain();
  const linkFor = (email) => sinkTo(email)[0].parsed.html.match(/https:\/\/mail\.acme\.example(\/s\/consent\/[0-9a-f-]{36})/)[1];
  const yes = linkFor('pr-yes@ok.example');
  assert.match(sinkTo('pr-yes@ok.example')[0].parsed.html, /\/u\/[0-9a-f-]{36}/, '"No thanks" goes to the unsubscribe page');

  // GET only asks (link scanners); nothing recorded yet.
  res = await fetch(base + yes);
  const ask = await res.text();
  assert.match(ask, /Yes, you may contact me/);
  assert.match(ask, /No thanks, don't contact me again|No thanks, don&#39;t contact me again/);
  const yesC = await contact('pr-yes@ok.example');
  const countGranted = async (id) => (await pool.query(
    `SELECT 1 FROM portal.consent_records WHERE contact_id = $1 AND method = 'permission_email' AND action = 'granted'`, [id])).rowCount;
  assert.equal(await countGranted(yesC.id), 0);

  // POST records consent with evidence, once.
  res = await fetch(base + yes, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.match(await res.text(), /may now email you/);
  await fetch(base + yes, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(await countGranted(yesC.id), 1, 'clicking twice records one consent');
  const rec = (await pool.query(`SELECT purpose, source, evidence, campaign_id, obtained_at FROM portal.consent_records
                                  WHERE contact_id = $1 AND method = 'permission_email'`, [yesC.id])).rows[0];
  assert.equal(rec.campaign_id, c.data.id);
  assert.equal(rec.source, 'permission-email');
  assert.match(rec.purpose, /Marketing emails from/);
  assert.match(rec.evidence, /Intro to prospects/);
  assert.ok(rec.obtained_at);
  const detail = (await http('admin', 'GET', `/api/contacts/${yesC.id}`)).data;
  assert.equal((detail.contact || detail).consent?.method ?? (await contact('pr-yes@ok.example')).consent?.method, 'permission_email');

  // An unsubscribed (suppressed) address is never turned back into consent by a link.
  const out = await contact('pr-out@ok.example');
  const unsub = linkFor('pr-out@ok.example').replace('/s/consent/', '/u/');
  await fetch(base + unsub, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  res = await fetch(base + linkFor('pr-out@ok.example'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.match(await res.text(), /currently unsubscribed/);
  assert.equal(await countGranted(out.id), 0);

  // Report and usage count it; a segment finds exactly the people who said yes.
  const rc = (await http('admin', 'GET', `/api/reports/campaigns/${c.data.id}`)).data;
  assert.equal((rc.campaign || rc).consented, 1);
  assert.equal((await http('admin', 'GET', '/api/reports/usage?days=7')).data.actions.consent_given, 1);
  const pv = await http('admin', 'POST', '/api/segments/preview', { rules: { match: 'all', conditions: [
    { field: 'consent', op: 'is', value: 'permission_email' }, { field: 'status', op: 'is', value: 'eligible' }] } });
  assert.equal(pv.status, 200, JSON.stringify(pv));
  assert.deepEqual(pv.data.sample.map((x) => x.email), ['pr-yes@ok.example']);
});

t('upgrade from templates: started campaigns keep their template; the default template becomes the email design; old drafts become builder documents', async () => {
  const { upgradeToEmailDesign } = require('../../src/lib/emailDesign');
  const tpl = (await pool.query(`INSERT INTO portal.templates (name, html, editor, body_json, is_default) VALUES ('Old brand',
    '<html><body style="background:#123123">OLD {{ content }} <a href="{{ unsubscribe_url }}">Unsubscribe</a></body></html>', 'builder',
    $1, FALSE) RETURNING id`, [{ version: 1, settings: { page_bg: '#123123', font: 'verdana' }, blocks: [
    { id: 'l', type: 'image', props: { src: 'https://cdn.acme.example/old-logo.png', align: 'center' } }, { id: 'c', type: 'content' },
    { id: 'f', type: 'footer', props: { text: 'Old footer', prefs: false } }] }])).rows[0].id;
  await pool.query('UPDATE portal.templates SET is_default = FALSE');
  await pool.query('UPDATE portal.templates SET is_default = TRUE WHERE id = $1', [tpl]);
  const sent = (await pool.query(`INSERT INTO portal.campaigns (name, subject, status, started_at, template_id, editor, body_html)
    VALUES ('Sent long ago', 'Old', 'sent', NOW() - INTERVAL '30 days', $1, 'visual', '<p>Old content</p>') RETURNING id`, [tpl])).rows[0].id;
  const legacy = (await pool.query(`INSERT INTO portal.campaigns (name, subject, status, editor, body_html)
    VALUES ('Old HTML draft', 'Draft', 'draft', 'html', '<p>Hand-written <b>HTML</b></p>') RETURNING id`)).rows[0].id;
  await pool.query(`DELETE FROM portal.settings WHERE key IN ('email_font', 'email_logo_url', 'email_header_align', 'email_footer_text', 'email_show_preferences')`);
  await pool.query(`DELETE FROM portal.sync_state WHERE key = 'email_design_upgrade'`);
  await pool.query(`UPDATE portal.campaigns SET layout_html = NULL WHERE id = $1`, [sent]);
  settings.invalidate();

  await upgradeToEmailDesign(pool, settings, null);
  const c = (await pool.query('SELECT layout_html FROM portal.campaigns WHERE id = $1', [sent])).rows[0];
  assert.match(c.layout_html, /OLD \{\{ content \}\}/, 'sent campaign keeps its template');
  const view = await http('admin', 'GET', `/api/campaigns/${sent}/preview`, undefined, { raw: true });
  assert.match(await view.text(), /OLD <p>Old content<\/p>/);
  const s = await settings.all();
  assert.equal(s.email_font, 'verdana');
  assert.equal(s.email_logo_url, 'https://cdn.acme.example/old-logo.png');
  assert.equal(s.email_header_align, 'center');
  assert.equal(s.email_footer_text, 'Old footer');
  assert.equal(s.email_show_preferences, false);
  assert.equal(s.email_background, '#f4f6f9', 'a value already set is not overwritten');
  const d = (await http('admin', 'GET', `/api/campaigns/${legacy}`)).data;
  assert.equal(d.editor, 'builder');
  assert.equal(d.body_json.blocks[0].type, 'html');
  assert.match(d.body_json.blocks[0].props.html, /Hand-written <b>HTML<\/b>/);

  // Runs once.
  await pool.query(`UPDATE portal.campaigns SET layout_html = 'changed' WHERE id = $1`, [sent]);
  await upgradeToEmailDesign(pool, settings, null);
  assert.equal((await pool.query('SELECT layout_html FROM portal.campaigns WHERE id = $1', [sent])).rows[0].layout_html, 'changed');
  await http('admin', 'PUT', '/api/settings', { email_logo_url: '', email_header_align: 'left', email_show_preferences: true, email_font: 'arial' });
});

t('report details: every number opens exactly the recipients or events behind it', async () => {
  const l = await http('admin', 'POST', '/api/lists', { name: 'Drill-down', optin: 'single' });
  const people = ['dd-ann@ok.example', 'dd-ben@ok.example', 'dd-cat@ok.example', 'dd-dan@ok.example'];
  for (const email of people) await http('admin', 'POST', '/api/contacts', { email, firstName: email.slice(3, 6), listIds: [l.data.id], consent: { method: 'web_form' } });
  const id = await newCampaign('Drill-down campaign', [l.data.id]);
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${id}/send`)).status, 200);
  await drain();
  const tok = async (email) => (await pool.query(`SELECT id, uuid FROM portal.messages WHERE campaign_id = $1 AND email = $2`, [id, email])).rows[0];
  const ann = await tok('dd-ann@ok.example');
  const ben = await tok('dd-ben@ok.example');
  const cat = await tok('dd-cat@ok.example');
  const { rows: links } = await pool.query('SELECT id FROM portal.links WHERE campaign_id = $1', [id]);
  await fetch(`${base}/t/o/${ann.uuid}.gif`);
  await fetch(`${base}/t/o/${ben.uuid}.gif`);
  await fetch(`${base}/t/c/${ben.uuid}/${links[0].id}`, { redirect: 'manual' });
  await webhook({ email: 'dd-cat@ok.example', type: 'hard', reason: '550 5.1.1 user unknown', message_id: cat.uuid, id: 'dd-1' });
  await fetch(`${base}/u/${ann.uuid}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  await new Promise((r) => setTimeout(r, 200));

  const report = (await http('admin', 'GET', `/api/reports/campaigns/${id}`)).data.campaign;
  const detail = async (q) => {
    const r = await http('viewer', 'GET', `/api/reports/details?kind=recipients&campaign=${id}&${q}`);
    assert.equal(r.status, 200, JSON.stringify(r));
    return r;
  };
  const emails = (r) => r.data.map((x) => x.email).sort();
  // Each tile's number equals the rows it opens.
  for (const [outcome, n] of [['all', report.targeted], ['sent', report.sent], ['opened', report.unique_opens], ['clicked', report.unique_clicks],
    ['hard', report.hard_bounces], ['bounced', report.delivery_failures], ['unsubscribed', report.unsubscribes]]) {
    assert.equal((await detail(`outcome=${outcome}`)).meta.total, n, outcome);
  }
  assert.deepEqual(emails(await detail('outcome=opened')), ['dd-ann@ok.example', 'dd-ben@ok.example']);
  assert.deepEqual(emails(await detail(`outcome=clicked&link=${links[0].id}`)), ['dd-ben@ok.example']);
  assert.deepEqual(emails(await detail('outcome=hard')), ['dd-cat@ok.example']);
  assert.deepEqual(emails(await detail('outcome=unsubscribed')), ['dd-ann@ok.example']);
  assert.deepEqual(emails(await detail('outcome=not_opened')), ['dd-cat@ok.example', 'dd-dan@ok.example']);
  const row = (await detail('outcome=clicked')).data[0];
  assert.equal(row.clicks, 1);
  assert.equal(row.opens, 1);
  assert.ok(row.contact_id, 'rows link to the contact');
  const page = await detail('outcome=all&per_page=2&page=2');
  assert.equal(page.data.length, 2);
  assert.equal(page.meta.total, 4);
  assert.deepEqual(emails(await detail('outcome=all&q=dd-dan')), ['dd-dan@ok.example']);

  // Bounces, recipient actions and messages
  const b = await http('viewer', 'GET', `/api/reports/details?kind=bounces&campaign=${id}&classification=hard&domain=ok.example`);
  assert.deepEqual(b.data.map((x) => x.email), ['dd-cat@ok.example']);
  assert.equal(b.data[0].code, '5.1.1');
  const ev = await http('viewer', 'GET', `/api/reports/details?kind=events&type=unsubscribed&campaign=${id}`);
  assert.deepEqual(ev.data.map((x) => x.email), ['dd-ann@ok.example']);
  const ms = await http('viewer', 'GET', `/api/reports/details?kind=messages&campaign=${id}&state=sent&days=1`);
  assert.equal(ms.meta.total, 4);
  assert.equal((await http('viewer', 'GET', `/api/reports/details?kind=messages&campaign=${id}&state=sent&since=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`)).meta.total, 0);

  // Validation, permissions and CSV
  assert.equal((await http('viewer', 'GET', '/api/reports/details?kind=recipients')).status, 422, 'campaign required');
  assert.equal((await http('viewer', 'GET', '/api/reports/details?kind=nope')).status, 422);
  assert.equal((await http('viewer', 'GET', `/api/reports/details?kind=recipients&campaign=${id}&outcome=drop%20table`)).status, 422);
  assert.equal((await http('viewer', 'GET', '/api/reports/details?kind=bounces&domain=x%27%3B--')).status, 422);
  assert.equal((await http('viewer', 'GET', `/api/reports/details?kind=recipients&campaign=${id}&format=csv`, undefined, { raw: true })).status, 403, 'viewers cannot export');
  const csv = await http('admin', 'GET', `/api/reports/details?kind=recipients&campaign=${id}&outcome=opened&format=csv`, undefined, { raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /Email,Name,Delivery/);
  assert.equal(text.trim().split(/\r\n/).length, 3, 'header + 2 opened');
});

t('image library: uploads are compressed and stored in PostgreSQL, served publicly, protected while in use', async () => {
  const sharp = require('sharp');
  const big = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#3a7bd5' } }).png().toBuffer();
  const form = new FormData();
  form.append('files', new Blob([big], { type: 'image/png' }), 'Summer banner.png');
  form.append('files', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'broken.png');
  const up = await http('admin', 'POST', '/api/images', form);
  assert.equal(up.status, 201, JSON.stringify(up));
  const [ok, bad] = up.data;
  assert.equal(ok.ok, true);
  assert.equal(ok.image.mime, 'image/jpeg', 'opaque PNG photo stored as JPEG');
  assert.equal(ok.image.width, 1200);
  assert.ok(ok.image.bytes < ok.image.original_bytes);
  assert.equal(ok.image.name, 'Summer banner');
  assert.equal(bad.ok, false);

  const res = await fetch(base + ok.image.path);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(res.headers.get('cache-control'), /immutable/);
  const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.exif, undefined, 'metadata stripped');

  const again = new FormData();
  again.append('files', new Blob([big], { type: 'image/png' }), 'copy.png');
  assert.equal((await http('admin', 'POST', '/api/images', again)).data[0].existed, true, 'identical image stored once');
  assert.equal((await fetch(`${base}/img/00000000-0000-0000-0000-000000000000.jpg`)).status, 404);

  // In use by a campaign → cannot be deleted.
  const c = await http('admin', 'POST', '/api/campaigns', { name: 'With image' });
  const doc = c.data.body_json;
  doc.blocks.unshift({ id: 'img1', type: 'image', props: { src: `https://mail.acme.example${ok.image.path}`, alt: 'Banner' } });
  await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { name: 'With image', subject: 's', from_email: 'news@acme.example', editor: 'builder', body_json: doc, list_ids: [] });
  const delUsed = await http('admin', 'DELETE', `/api/images/${ok.image.id}`);
  assert.equal(delUsed.status, 409);
  const list = await http('admin', 'GET', '/api/images');
  assert.ok(list.meta.storage.count >= 1);
});

t('UTM tagging: Google Analytics tags added to web links (frozen at send), per-campaign off switch', async () => {
  await http('admin', 'PUT', '/api/settings', { utm_enabled: true, utm_source: 'mailharbor', utm_medium: 'email', utm_domains: '' });
  await addContact('utm-uma@ok.example');
  const mk = async (name, utm) => {
    const c = await http('admin', 'POST', '/api/campaigns', { name });
    const doc = c.data.body_json;
    doc.blocks.find((b) => b.type === 'button').props.url = 'https://shop.acme.example/sale?x=1';
    const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { name, subject: name, from_email: 'news@acme.example', editor: 'builder',
      body_json: doc, list_ids: [listId], track_clicks: true, track_opens: false, ...utm });
    assert.equal(r.status, 200, JSON.stringify(r));
    return c.data.id;
  };
  const tagged = await mk('Spring Sale 2026', { utm_enabled: true, utm_campaign: '' });
  const plain = await mk('No tags please', { utm_enabled: false });
  for (const id of [tagged, plain]) {
    sink.messages.length = 0;
    assert.equal((await http('admin', 'POST', `/api/campaigns/${id}/send`)).status, 200);
    await drain();
    const [m] = sinkTo('utm-uma@ok.example');
    const click = m.parsed.html.match(/https:\/\/mail\.acme\.example(\/t\/c\/[^"]+)/)[1];
    const res = await fetch(base + click, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (id === tagged) {
      assert.equal(loc, 'https://shop.acme.example/sale?x=1&utm_source=mailharbor&utm_medium=email&utm_campaign=spring-sale-2026');
      assert.deepEqual((await pool.query('SELECT utm_params FROM portal.campaigns WHERE id = $1', [id])).rows[0].utm_params.campaign, 'spring-sale-2026');
    } else {
      assert.equal(loc, 'https://shop.acme.example/sale?x=1', 'campaign switched UTM off');
    }
    assert.doesNotMatch(m.parsed.html, /\/u\/[0-9a-f-]{36}\?utm_/, 'MailHarbor pages never tagged');
  }
});

t('saved segments: rules with bound parameters, contact filter, campaign narrowing, delete protection', async () => {
  await http('admin', 'POST', '/api/contacts', { email: 'seg-dee@ok.example', firstName: 'Dee', listIds: [listId], consent: { method: 'web_form' }, attribs: { city: 'Umhlanga' } });
  await http('admin', 'POST', '/api/contacts', { email: 'seg-cal@ok.example', firstName: 'Cal', listIds: [listId], consent: { method: 'web_form' }, attribs: { city: 'Cape Town' } });
  const rules = { match: 'all', conditions: [{ field: 'attribute', key: 'city', op: 'is', value: 'umhlanga' }, { field: 'status', op: 'is', value: 'eligible' },
    { field: 'created_at', op: 'within_days', value: 30 }, { field: 'last_open_at', op: 'not_within_days', value: 90 }] };
  const pv = await http('admin', 'POST', '/api/segments/preview', { rules });
  assert.equal(pv.status, 200, JSON.stringify(pv));
  assert.equal(pv.data.counts.total, 1);
  assert.equal(pv.data.sample[0].email, 'seg-dee@ok.example');

  // Validation and injection safety
  assert.equal((await http('admin', 'POST', '/api/segments/preview', { rules: { conditions: [{ field: 'status', op: 'drop table', value: 'x' }] } })).status, 422);
  assert.equal((await http('admin', 'POST', '/api/segments/preview', { rules: { conditions: [{ field: 'email', op: 'is', value: 'x' }] } })).status, 422);
  const inj = await http('admin', 'POST', '/api/segments/preview', { rules: { conditions: [{ field: 'source', op: 'is', value: "x'); DROP TABLE portal.contacts; --" }] } });
  assert.equal(inj.data.counts.total, 0);
  assert.ok((await pool.query('SELECT COUNT(*)::int AS n FROM portal.contacts')).rows[0].n > 0, 'tables intact');

  const seg = await http('admin', 'POST', '/api/segments', { name: 'Durban', rules });
  assert.equal(seg.status, 201);
  assert.equal((await http('admin', 'POST', '/api/segments', { name: 'durban', rules })).status, 409, 'names are unique');
  const filtered = await http('admin', 'GET', `/api/contacts?segment_id=${seg.data.id}`);
  assert.deepEqual(filtered.data.map((x) => x.email), ['seg-dee@ok.example']);

  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Durban only' });
  const doc = c.data.body_json;
  doc.blocks.find((b) => b.type === 'button').props.url = 'https://acme.example';
  const put = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, { name: 'Durban only', subject: 'Hi Durban', from_email: 'news@acme.example',
    editor: 'builder', body_json: doc, list_ids: [listId], segment_id: seg.data.id });
  assert.equal(put.status, 200, JSON.stringify(put));
  const g = await http('admin', 'GET', `/api/campaigns/${c.data.id}`);
  assert.equal(g.data.eligible, 1, 'segment narrows the list audience');
  assert.equal((await http('admin', 'DELETE', `/api/segments/${seg.data.id}`)).status, 409, 'in use by a draft');
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).data.recipients, 1);
  await drain();
  assert.deepEqual(sink.messages.map((m) => m.envelope.rcptTo[0].address), ['seg-dee@ok.example']);
  assert.equal((await pool.query('SELECT segment_name FROM portal.campaigns WHERE id = $1', [c.data.id])).rows[0].segment_name, 'Durban');
});

t('sign-up forms: consent evidence, double opt-in, bot protection, suppression never bypassed', async () => {
  const crypto = require('node:crypto');
  const dbl = await http('admin', 'POST', '/api/lists', { name: 'Form double', optin: 'double' });
  const f = await http('admin', 'POST', '/api/forms', { name: 'Website footer', list_ids: [listId, dbl.data.id],
    settings: { fields: { first_name: 'required' }, consent_text: 'Yes, email me news and specials. I can unsubscribe any time.' } });
  assert.equal(f.status, 201, JSON.stringify(f));
  const url = `/f/${f.data.token}`;
  const page = await fetch(base + url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(page.headers.get('x-frame-options'), null, 'embeddable');
  const html = await page.text();
  assert.match(html, /name="_t" value="[^"]+"/);
  // A token rendered 5 seconds ago (signed with the app secret), as a person would submit.
  const t = (Date.now() - 5000).toString(36);
  const token = `${t}.${crypto.createHmac('sha256', `form:${'x'.repeat(40)}`).update(`${f.data.id}.${t}`).digest('base64url')}`;
  const submit = (fields) => fetch(base + url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _t: token, consent: 'yes', ...fields }).toString() });

  // Bots: no token / too fast / honeypot → "thank you" but nothing stored.
  let r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=bot1@ok.example&first_name=B&consent=yes' });
  assert.match(await r.text(), /Thank you/);
  r = await submit({ email: 'bot2@ok.example', first_name: 'B', website: 'http://spam.example' });
  assert.match(await r.text(), /Thank you/);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM portal.contacts WHERE email LIKE 'bot%'`)).rows[0].n, 0);

  // Validation
  r = await submit({ email: 'form-fay@ok.example' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /First name is required/);
  r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _t: token, email: 'form-fay@ok.example', first_name: 'Fay' }).toString() });
  assert.match(await r.text(), /tick the box/);

  // A real sign-up
  r = await submit({ email: 'Form-Fay@OK.example', first_name: 'Fay' });
  assert.match(await r.text(), /Thank you/);
  const fay = await contact('form-fay@ok.example');
  assert.ok(fay, 'contact created');
  const detail = (await http('admin', 'GET', `/api/contacts/${fay.id}`)).data;
  assert.equal(detail.contact?.first_name ?? detail.first_name, 'Fay');
  const subs = Object.fromEntries(detail.subscriptions.map((s) => [s.id, s.status]));
  assert.equal(subs[listId], 'subscribed');
  assert.equal(subs[dbl.data.id], 'unconfirmed', 'double opt-in list waits for confirmation');
  const consent = await pool.query(`SELECT method, evidence FROM portal.consent_records WHERE contact_id = $1 AND source LIKE 'Form:%'`, [fay.id]);
  assert.equal(consent.rows[0].method, 'web_form');
  assert.match(consent.rows[0].evidence, /Website footer.*IP.*Statement accepted: "Yes, email me news/);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM portal.messages WHERE kind = 'optin' AND contact_id = $1`, [fay.id])).rows[0].n, 1);

  // Suppressed address: same reply, never re-subscribed.
  await addContact('form-sam@ok.example');
  const sam = await contact('form-sam@ok.example');
  assert.equal((await http('admin', 'POST', '/api/contacts/actions', { action: 'unsubscribe', ids: [sam.id], note: 'asked' })).status, 200);
  r = await submit({ email: 'form-sam@ok.example', first_name: 'Sam' });
  assert.match(await r.text(), /Thank you/);
  assert.equal((await contact('form-sam@ok.example')).status, 'unsubscribed');

  const subsApi = await http('admin', 'GET', `/api/forms/${f.data.id}/submissions`);
  assert.equal(subsApi.meta.totals.rejected, 2);
  assert.equal(subsApi.meta.totals.confirmation_sent, 1);
  assert.equal(subsApi.meta.totals.suppressed, 1);

  // Closed forms
  await http('admin', 'PUT', `/api/forms/${f.data.id}`, { name: 'Website footer', status: 'disabled', list_ids: [listId], settings: {} });
  assert.equal((await fetch(base + url)).status, 404);
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

t('inbox: replies are classified, threaded to the campaign and contact, read safely, answered and acted on', async () => {
  const MailComposer = require('nodemailer/lib/mail-composer');
  const { handleMessage } = require('../../src/engine/mailbox');
  const raw = (opts) => new MailComposer({ date: new Date(), ...opts }).compile().build();
  const handle = (buf) => handleMessage({ pool, settings, logger: { warn() {}, error() {} } }, buf, { kind: 'replies', ref: 'test' });

  const l = await http('admin', 'POST', '/api/lists', { name: 'Inbox list', optin: 'single' });
  for (const [email, name] of [['ib-amy@ok.example', 'Amy'], ['ib-bob@ok.example', 'Bob']]) {
    await http('admin', 'POST', '/api/contacts', { email, firstName: name, listIds: [l.data.id], consent: { method: 'web_form' } });
  }
  const campId = await newCampaign('Inbox campaign', [l.data.id]);
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${campId}/send`)).status, 200);
  await drain();
  const sentToAmy = sinkTo('ib-amy@ok.example')[0];
  const amyMsg = (await pool.query(`SELECT uuid FROM portal.messages WHERE campaign_id = $1 AND email = 'ib-amy@ok.example'`, [campId])).rows[0];
  assert.equal(sentToAmy.parsed.messageId, `<${amyMsg.uuid}@acme.example>`, 'campaign emails carry our own Message-ID');

  // 1. A reply, threaded by In-Reply-To; the HTML is sanitised; the attachment is kept.
  const amyReply = await raw({
    from: 'Amy Adams <ib-amy@ok.example>', to: 'news@acme.example', subject: 'Re: Inbox campaign', inReplyTo: sentToAmy.parsed.messageId,
    references: sentToAmy.parsed.messageId,
    text: 'Thanks! What are your prices for 50 units?\n\nOn Tue, Acme wrote:\n> Hello Amy, unsubscribe here',
    html: '<p>Thanks! What are your prices?</p><script>alert(1)</script><img src="https://tracker.example/p.gif">',
    attachments: [{ filename: 'order.pdf', content: Buffer.from('%PDF-1.4 test') }],
  });
  assert.equal(await handle(amyReply), 'reply');
  assert.equal(await handle(amyReply), 'reply', 'the same email again is recognised');
  const { rows: amyConvs } = await pool.query(`SELECT * FROM portal.conversations WHERE email = 'ib-amy@ok.example'`);
  assert.equal(amyConvs.length, 1);
  const amyConv = amyConvs[0];
  assert.equal(amyConv.campaign_id, campId);
  assert.ok(amyConv.contact_id);
  assert.equal(amyConv.category, 'reply', 'quoted "unsubscribe" text does not count');
  assert.equal(amyConv.status, 'open');
  assert.equal(amyConv.message_count, 1, 'stored once');
  const stored = (await pool.query(`SELECT * FROM portal.inbox_messages WHERE conversation_id = $1`, [amyConv.id])).rows[0];
  assert.equal(stored.matched_by, 'header');
  assert.doesNotMatch(stored.html_body, /<script/);

  // 2. Out-of-office: kept, closed, never counted as needing a reply.
  await handle(await raw({ from: 'ib-bob@ok.example', to: 'news@acme.example', subject: 'Out of office: Inbox campaign',
    headers: { 'Auto-Submitted': 'auto-replied' }, text: 'I am away until Monday.' }));
  let bob = (await pool.query(`SELECT * FROM portal.conversations WHERE email = 'ib-bob@ok.example'`)).rows[0];
  assert.equal(bob.category, 'auto_reply');
  assert.equal(bob.status, 'closed');
  // 3. Then a real "remove me" without any headers: matched by sender, joins Bob's conversation and stands out.
  await handle(await raw({ from: 'ib-bob@ok.example', to: 'news@acme.example', subject: 'Re: Inbox campaign', text: 'Please remove me from your list.' }));
  bob = (await pool.query(`SELECT * FROM portal.conversations WHERE email = 'ib-bob@ok.example'`)).rows[0];
  assert.equal(bob.category, 'unsubscribe_request');
  assert.equal(bob.status, 'open');
  assert.equal(bob.campaign_id, campId, 'linked to the campaign Bob was sent');
  // 4. A stranger; 5. a delivery report (still a bounce, not a conversation).
  await handle(await raw({ from: 'stranger@else.example', to: 'news@acme.example', subject: 'Partnership', text: 'Hi, can we talk?' }));
  assert.equal((await pool.query(`SELECT contact_id FROM portal.conversations WHERE email = 'stranger@else.example'`)).rows[0].contact_id, null);
  const dsn = Buffer.from(`From: MAILER-DAEMON@mx.example\r\nTo: bounces@acme.example\r\nSubject: Undelivered\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nFailed\r\n--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; nobody-ib@ok.example\r\nAction: failed\r\nStatus: 5.1.1\r\n--b--\r\n`);
  assert.equal(await handle(dsn), 'bounce');

  // Reading: list, counts, the thread, the sandboxed original, the attachment.
  const list = await http('viewer', 'GET', '/api/inbox?view=open');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map((c) => c.email).filter((e) => e.startsWith('ib-') || e.startsWith('stranger')).sort(),
    ['ib-amy@ok.example', 'ib-bob@ok.example', 'stranger@else.example']);
  assert.match(list.data.find((c) => c.email === 'ib-amy@ok.example').snippet, /What are your prices/);
  const counts = (await http('viewer', 'GET', '/api/inbox/counts')).data;
  assert.ok(counts.unsubscribe >= 1 && counts.open >= 3);
  assert.equal((await http('viewer', 'GET', '/api/inbox?view=auto')).data.some((c) => c.email === 'ib-bob@ok.example'), false, 'Bob is no longer just an auto-reply');
  const thread = await http('viewer', 'GET', `/api/inbox/${amyConv.id}`);
  assert.equal(thread.data.campaign, 'Inbox campaign');
  assert.equal(thread.data.messages[0].attachments[0].filename, 'order.pdf');
  assert.equal((await pool.query('SELECT unread FROM portal.conversations WHERE id = $1', [amyConv.id])).rows[0].unread, false, 'opened = read');
  const h = await http('viewer', 'GET', `/api/inbox/messages/${thread.data.messages[0].id}/html`, undefined, { raw: true });
  assert.match(h.headers.get('content-security-policy'), /sandbox.*img-src data:/, 'remote images blocked by default');
  assert.doesNotMatch(await h.text(), /<script/);
  const att = await http('viewer', 'GET', `/api/inbox/attachments/${thread.data.messages[0].attachments[0].id}`, undefined, { raw: true });
  assert.match(att.headers.get('content-disposition'), /^attachment; filename="order.pdf"/);
  assert.equal(att.headers.get('content-type'), 'application/octet-stream');

  // Answering: viewers cannot; a manager/admin reply is threaded, and the next answer joins the conversation.
  assert.equal((await http('viewer', 'POST', `/api/inbox/${amyConv.id}/reply`, { body: 'x' })).status, 403);
  assert.equal((await http('admin', 'POST', `/api/inbox/${amyConv.id}/reply`, { body: '' })).status, 422);
  sink.messages.length = 0;
  const rep = await http('admin', 'POST', `/api/inbox/${amyConv.id}/reply`, { body: 'Hi Amy, 50 units are R4 500.\n\nKind regards\nThandi' });
  assert.equal(rep.status, 201, JSON.stringify(rep));
  const out = sinkTo('ib-amy@ok.example')[0];
  assert.ok(out, 'reply delivered');
  assert.equal(out.parsed.subject, 'Re: Inbox campaign');
  assert.equal(out.parsed.inReplyTo, stored.rfc_message_id);
  assert.match(out.parsed.text, /R4 500[\s\S]*> Thanks! What are your prices/);
  assert.match(out.parsed.messageId, /^<reply\.[0-9a-f-]{36}@acme\.example>$/);
  await handle(await raw({ from: 'ib-amy@ok.example', to: 'news@acme.example', subject: 'Re: Inbox campaign', inReplyTo: out.parsed.messageId, text: 'Great, please send an invoice.' }));
  const amyAfter = (await http('admin', 'GET', `/api/inbox/${amyConv.id}`)).data;
  assert.deepEqual(amyAfter.messages.map((m) => m.direction), ['in', 'out', 'in'], 'one conversation');

  // Notes, assignment, closing
  assert.equal((await http('admin', 'POST', `/api/inbox/${amyConv.id}/notes`, { body: 'Quote sent; follow up Friday.' })).status, 201);
  const me = (await http('admin', 'GET', '/api/auth/session')).data.user;
  const asg = await http('admin', 'PATCH', `/api/inbox/${amyConv.id}`, { assigned_to: me.id });
  assert.equal(asg.status, 200, JSON.stringify(asg));
  assert.ok((await http('admin', 'GET', '/api/inbox?view=mine')).data.some((c) => c.id === amyConv.id));
  const cls = await http('admin', 'PATCH', `/api/inbox/${amyConv.id}`, { status: 'closed' });
  assert.equal(cls.status, 200, JSON.stringify(cls));
  assert.equal((await http('admin', 'GET', '/api/inbox?view=open')).data.some((c) => c.id === amyConv.id), false);
  assert.equal((await http('admin', 'PATCH', `/api/inbox/${amyConv.id}`, { assigned_to: '00000000-0000-0000-0000-000000000000' })).status, 409);

  // "Remove me" → one click unsubscribes the contact, notes it and closes the conversation.
  const unsub = await http('admin', 'POST', `/api/inbox/${bob.id}/unsubscribe`);
  assert.equal(unsub.status, 200, JSON.stringify(unsub));
  assert.equal(unsub.data.status, 'closed');
  assert.equal((await contact('ib-bob@ok.example')).status, 'unsubscribed');
  assert.ok((await http('admin', 'GET', `/api/inbox/${bob.id}`)).data.messages.some((m) => m.direction === 'note' && /Unsubscribed/.test(m.text_body)));

  // Reports and POPIA
  assert.equal((await http('admin', 'GET', `/api/reports/campaigns/${campId}`)).data.campaign.replies, 2);
  const amyId = amyConv.contact_id;
  const exported = await http('admin', 'GET', `/api/contacts/${amyId}/export`, undefined, { raw: true });
  assert.match(await exported.text(), /please send an invoice/);
  const er = await http('admin', 'POST', `/api/contacts/${amyId}/erase`, { confirm: 'ERASE' });
  assert.equal(er.status, 200, JSON.stringify(er));
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM portal.conversations WHERE email = 'ib-amy@ok.example'`)).rows[0].n, 0, 'erasure removes the conversation');
});

t('mail server in Settings: the customer manages it; password encrypted and never returned; sending switches over', async () => {
  const own = await startSink({ user: 'cust', pass: 'cust-pass-2026' });
  try {
    let st = (await http('admin', 'GET', '/api/settings')).data;
    assert.equal(st.mail_server.source, 'hosting', 'starts on the operator default (SMTP_* variables)');
    assert.equal((await http('viewer', 'PUT', '/api/settings', { smtp: { host: 'x' } })).status, 403);

    // Check before saving: wrong password, then right one.
    let v = await http('admin', 'POST', '/api/settings/smtp-verify', { host: '127.0.0.1', port: own.port, security: 'none', user: 'cust', password: 'wrong' });
    assert.equal(v.data.ok, false);
    assert.match(v.data.error, /username or password/);
    v = await http('admin', 'POST', '/api/settings/smtp-verify', { host: '127.0.0.1', port: own.port, security: 'none', user: 'cust', password: 'cust-pass-2026' });
    assert.equal(v.data.ok, true, JSON.stringify(v));
    assert.equal((await http('admin', 'PUT', '/api/settings', { smtp: { host: 'bad host!' } })).status, 422);

    const saved = await http('admin', 'PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: own.port, security: 'none', user: 'cust', password: 'cust-pass-2026' } });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.data.mail_server.source, 'settings');
    assert.equal(saved.data.smtp.password_set, true);
    assert.doesNotMatch(JSON.stringify(saved), /cust-pass-2026/, 'the password is never returned');
    const raw = (await pool.query(`SELECT value::text AS v FROM portal.settings WHERE key = 'smtp'`)).rows[0].v;
    assert.doesNotMatch(raw, /cust-pass-2026/, 'encrypted at rest');

    // Test email and campaigns now go through the customer's server.
    own.messages.length = 0;
    sink.messages.length = 0;
    const tst = await http('admin', 'POST', '/api/settings/smtp-test', { to: 'smtp-check@ok.example' });
    assert.equal(tst.data.ok, true, JSON.stringify(tst));
    assert.equal(own.messages.length, 1, 'delivered by the customer server');
    assert.equal(sink.messages.length, 0);
    await addContact('own-smtp@ok.example');
    const camp = await newCampaign('Own server');
    assert.equal((await http('admin', 'POST', `/api/campaigns/${camp}/send`)).status, 200);
    await drain();
    assert.ok(own.messages.some((m) => m.envelope.rcptTo.some((r) => r.address === 'own-smtp@ok.example')), 'campaign sent through the customer server');
    const health = (await http('admin', 'GET', '/api/system/health')).data;
    assert.equal(health.smtp.source, 'settings');
    assert.equal(health.smtp.ok, true);

    // A different server without a new password: the old password is not sent there.
    st = (await http('admin', 'PUT', '/api/settings', { smtp: { host: '127.0.0.2', port: own.port, security: 'none', user: 'cust' } })).data;
    assert.equal(st.smtp.password_set, false);
    // Clearing the server returns to the operator default.
    st = (await http('admin', 'PUT', '/api/settings', { smtp: { host: '' } })).data;
    assert.equal(st.mail_server.source, 'hosting');
  } finally {
    await http('admin', 'PUT', '/api/settings', { smtp: { host: '' } });
    await own.close();
  }
});
