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
  const { ensureDefaultTemplate, ensureTemplatePresets } = require('../../src/modules/templates/routes');
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
  await ensureTemplatePresets(pool);
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
    reply_to: '', template_id: c.data.template_id, editor: 'builder', body_text: '', track_opens: true, track_clicks: true, list_ids: [listId] };
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

t('template builder: default template is a builder design; templates are validated, rendered and wrap campaigns', async () => {
  const list = await http('admin', 'GET', '/api/templates');
  const def = list.data.find((x) => x.is_default);
  assert.equal(def.editor, 'builder', 'built-in template is a drag-and-drop design');

  const noContent = await http('admin', 'POST', '/api/templates', { name: 'Broken', editor: 'builder', body_json: { blocks: [{ id: 'f', type: 'footer' }] } });
  assert.equal(noContent.status, 422);
  const htmlNoContent = await http('admin', 'POST', '/api/templates', { name: 'Broken', html: '<p>no slot</p>' });
  assert.equal(htmlNoContent.status, 422);

  const design = { version: 1, settings: { page_bg: '#e8f1ef', width: 640 }, blocks: [
    { id: 'l', type: 'image', props: { src: 'https://cdn.acme.example/logo.png', alt: 'Acme logo', width: 40 } },
    { id: 'c', type: 'content' },
    { id: 'f', type: 'footer', props: { text: 'Proudly South African.' } },
  ] };
  const created = await http('admin', 'POST', '/api/templates', { name: 'Spring brand', editor: 'builder', body_json: design });
  assert.equal(created.status, 201, JSON.stringify(created));
  const t = (await http('admin', 'GET', `/api/templates/${created.data.id}`)).data;
  assert.equal(t.editor, 'builder');
  assert.equal(t.body_json.settings.width, 640);
  assert.match(t.html, /\{\{ content \}\}/);

  await addContact('tpl-tom@ok.example');
  const c = await http('admin', 'POST', '/api/campaigns', { name: 'Uses spring brand' });
  c.data.body_json.blocks.find((b) => b.type === 'button').props.url = 'https://acme.example/spring';
  const r = await http('admin', 'PUT', `/api/campaigns/${c.data.id}`, {
    name: 'Uses spring brand', subject: 'Spring', preheader: '', from_name: 'Acme', from_email: 'news@acme.example', reply_to: '',
    template_id: created.data.id, editor: 'builder', body_json: c.data.body_json, body_text: '', track_opens: false, track_clicks: false, list_ids: [listId],
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${c.data.id}/send`)).status, 200);
  await drain();
  const [m] = sinkTo('tpl-tom@ok.example');
  assert.ok(m, 'delivered');
  assert.match(m.parsed.html, /alt="Acme logo"/);
  assert.match(m.parsed.html, /Proudly South African\./);
  assert.match(m.parsed.html, /Hello tpl-tom/);
  assert.equal((m.parsed.html.match(/\/u\/[0-9a-f-]{36}/g) || []).length, 1, 'one unsubscribe link (from the template footer)');
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
    template_id: c.data.template_id, editor: 'builder', body_json: design, body_text: '', track_opens: false, track_clicks: true, list_ids: [l2.data.id],
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
    template_id: c.data.template_id, editor: 'builder', body_json: c.data.body_json, body_text: '', track_opens: false, track_clicks: true, list_ids: [l.data.id],
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

t('ready-made templates: Clean, Promotion and New release installed once; campaign samples use the matching template', async () => {
  const { ensureTemplatePresets } = require('../../src/modules/templates/routes');
  const list = (await http('admin', 'GET', '/api/templates')).data;
  const presets = Object.fromEntries(list.filter((x) => x.sample_key).map((x) => [x.sample_key, x]));
  assert.deepEqual(Object.keys(presets).sort(), ['clean', 'new-release', 'promotion']);
  assert.ok(Object.values(presets).every((x) => x.editor === 'builder'));

  const gallery = await http('admin', 'GET', '/api/templates/samples');
  assert.deepEqual(gallery.data.map((x) => x.id), ['standard', 'clean', 'promotion', 'new-release']);
  assert.equal((await http('admin', 'GET', '/api/templates/samples/promotion')).data.doc.settings.page_bg, '#0f2846');

  // Samples pick their matching template; the simple message keeps the default.
  const promo = await http('admin', 'POST', '/api/campaigns', { name: 'Specials', sample: 'promotion' });
  assert.equal(promo.data.template_id, presets.promotion.id);
  const launch = await http('admin', 'POST', '/api/campaigns', { name: 'Launch', sample: 'product-launch' });
  assert.equal(launch.data.template_id, presets['new-release'].id);
  const plain = await http('admin', 'POST', '/api/campaigns', { name: 'Plain', sample: 'blank' });
  assert.equal(plain.data.template_id, list.find((x) => x.is_default).id);
  const samples = (await http('admin', 'GET', '/api/campaigns/samples')).data;
  assert.equal(samples.find((x) => x.id === 'promotion').templateName, 'Promotion');

  // A delivered email is wrapped in the Promotion design.
  await addContact('promo-pia@ok.example');
  const doc = promo.data.body_json;
  for (const b of doc.blocks.flatMap((x) => (x.type === 'columns' ? x.props.columns.flat() : [x]))) if (b.type === 'button') b.props.url = 'https://shop.acme.example';
  const put = await http('admin', 'PUT', `/api/campaigns/${promo.data.id}`, {
    name: 'Specials', subject: 'Specials', preheader: '', from_name: 'Acme', from_email: 'news@acme.example', reply_to: '',
    template_id: presets.promotion.id, editor: 'builder', body_json: doc, body_text: '', track_opens: false, track_clicks: false, list_ids: [listId],
  });
  assert.equal(put.status, 200, JSON.stringify(put));
  sink.messages.length = 0;
  assert.equal((await http('admin', 'POST', `/api/campaigns/${promo.data.id}/send`)).status, 200, 'promotion sample is sendable once links are set');
  await drain();
  const [m] = sinkTo('promo-pia@ok.example');
  assert.match(m.parsed.html, /LIMITED-TIME OFFERS/);
  assert.match(m.parsed.html, /background-color:#0f2846/);
  assert.match(m.parsed.html, /This month's specials/);

  // Installed once: re-running adds nothing; a deleted preset stays deleted.
  await ensureTemplatePresets(pool);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM portal.templates WHERE sample_key IS NOT NULL')).rows[0].n, 3);
  await pool.query(`UPDATE portal.campaigns SET template_id = NULL WHERE template_id = $1`, [presets.clean.id]);
  assert.equal((await http('admin', 'DELETE', `/api/templates/${presets.clean.id}`)).status, 200);
  await ensureTemplatePresets(pool);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM portal.templates WHERE sample_key = 'clean'`)).rows[0].n, 0, 'deleted preset is not re-added');
  const welcome = await http('admin', 'POST', '/api/campaigns', { name: 'Welcome', sample: 'welcome' });
  assert.equal(welcome.data.template_id, list.find((x) => x.is_default).id, 'falls back to the default template');
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
  const durban = await http('admin', 'POST', '/api/contacts', { email: 'seg-dee@ok.example', firstName: 'Dee', listIds: [listId], consent: { method: 'web_form' }, attribs: { city: 'Umhlanga' } });
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
