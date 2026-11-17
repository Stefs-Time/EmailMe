'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyBounce } = require('../../src/engine/bounceRules');
const { isValidEmail, normalizeEmail, emailHash } = require('../../src/lib/email');
const { cell } = require('../../src/lib/csv');
const { parseCsv, suggestMapping, mapRow, parseDate, normalizeConsentMethod, detectDelimiter } = require('../../src/modules/imports/mapping');
const { loadConfig } = require('../../src/config');

test('bounce rules follow scope §3.6.2', () => {
  const c = (type, meta) => classifyBounce(type, meta).classification;
  assert.equal(c('hard', { classify_reason: 'smtp_status=5.1.1' }), 'hard');
  assert.equal(c('soft', '550 5.1.1 <x@y.com>: Recipient address rejected: User unknown'), 'hard');
  assert.equal(c('soft', '451 4.7.1 Try again later'), 'soft');
  assert.equal(c('soft', '452 4.2.2 Mailbox full'), 'soft');
  assert.equal(c('hard', { classify_reason: 'smtp_status=5.7.1' }), 'review');
  assert.equal(c('hard', '550 5.7.26 Unauthenticated email is not accepted (DMARC)'), 'review');
  assert.equal(c('hard', '550 Message rejected as spam'), 'review');
  assert.equal(c('hard', '550 Mailbox unavailable'), 'hard');
  assert.equal(c('complaint', {}), 'complaint');
  assert.equal(c('hard', { classify_reason: 'body_match=user unknown' }), 'hard');
  assert.equal(c('soft', { classify_reason: 'default' }), 'soft');
});

test('bounce rules ignore IP addresses in received headers', () => {
  const r = classifyBounce('soft', { received: ['from mx (10.5.1.1)'], classify_reason: 'smtp_status=4.4.1' });
  assert.equal(r.classification, 'soft');
  assert.equal(r.enhancedCode, '4.4.1');
  const r2 = classifyBounce('soft', 'connection from 192.10.5.1.1 refused 421 try later');
  assert.equal(r2.classification, 'soft');
});

test('email validation and normalisation', () => {
  assert.ok(isValidEmail('Thandi.Nkosi+news@Example.co.za'));
  assert.ok(isValidEmail('a@xn--bcher-kva.example'));
  for (const bad of ['', 'plain', 'a@b', 'a@@b.com', 'a@b..com', '.a@b.com', 'a.@b.com', 'a b@c.com', 'a@-b.com', 'a@b.c']) {
    assert.ok(!isValidEmail(bad), bad);
  }
  assert.equal(normalizeEmail('  A@B.COM '), 'a@b.com');
  assert.equal(emailHash('A@B.com'), emailHash('a@b.com '));
});

test('CSV cells are protected against formula injection', () => {
  assert.equal(cell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(cell('+27 82 000'), "'+27 82 000");
  assert.equal(cell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell(null), '');
  assert.equal(cell(5), '5');
});

test('CSV parsing handles BOM, semicolons and duplicate headers', () => {
  const { headers, rows, delimiter } = parseCsv('﻿Email;Name;Name\nx@y.com;A;B\n', 100);
  assert.equal(delimiter, ';');
  assert.deepEqual(headers, ['Email', 'Name', 'Name (2)']);
  assert.equal(rows[0]['Name (2)'], 'B');
  assert.throws(() => parseCsv('email\na@b.com\nc@d.com\n', 1), /maximum/);
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
});

test('column mapping suggestions and row mapping', () => {
  const m = suggestMapping(['E-mail Address', 'First Name', 'Surname', 'Organisation', 'Opt-in date', 'Favourite Colour']);
  assert.equal(m['E-mail Address'], 'email');
  assert.equal(m['First Name'], 'first_name');
  assert.equal(m.Surname, 'last_name');
  assert.equal(m.Organisation, 'company');
  assert.equal(m['Opt-in date'], 'consent_date');
  assert.equal(m['Favourite Colour'], 'attribute');
  const r = mapRow({ 'E-mail Address': ' X@Y.COM ', 'First Name': 'X', Surname: '', Organisation: 'Co', 'Opt-in date': '14/03/2026', 'Favourite Colour': 'blue' },
    m, { source: 'file', consent: { method: 'web_form' } });
  assert.equal(r.email, 'x@y.com');
  assert.ok(r.emailValid);
  assert.equal(r.data.consent_date, '2026-03-14');
  assert.equal(r.data.consent_method, 'web_form');
  assert.equal(r.data.attribs.favourite_colour, 'blue');
  assert.equal(r.data.source, 'file');
  const full = mapRow({ n: 'Thandi Nkosi Mokoena', e: 'a@b.com' }, { n: 'full_name', e: 'email' }, {});
  assert.equal(full.data.first_name, 'Thandi');
  assert.equal(full.data.last_name, 'Nkosi Mokoena');
});

test('dates and consent methods are normalised', () => {
  assert.equal(parseDate('2026-02-30'), undefined);
  assert.equal(parseDate('31/12/2025').toISOString().slice(0, 10), '2025-12-31');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('yesterday'), undefined);
  assert.equal(normalizeConsentMethod('Double Opt-In'), 'double_opt_in');
  assert.equal(normalizeConsentMethod('Website'), 'web_form');
  assert.equal(normalizeConsentMethod('carrier pigeon'), 'other');
});

test('configuration: only the database and SMTP are required', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL[\s\S]*SMTP_HOST/);
  const c = loadConfig({ DATABASE_URL: 'postgres://x', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASSWORD: 'p', ADMIN_EMAIL: '' });
  assert.equal(c.SMTP_PORT, 587);
  assert.equal(c.SMTP_SECURE, false);
  assert.equal(c.SMTP_REQUIRE_TLS, true);
  assert.equal(c.ADMIN_EMAIL, undefined);
  assert.equal(c.PORT, 3000);
  assert.equal(loadConfig({ DATABASE_URL: 'x', SMTP_HOST: 'h', SMTP_PORT: '465' }).SMTP_SECURE, true);
  const rw = loadConfig({ DATABASE_URL: 'x', SMTP_HOST: 'h', RAILWAY_PUBLIC_DOMAIN: 'mh.up.railway.app' });
  assert.equal(rw.platformPublicUrl, 'https://mh.up.railway.app');
  assert.equal(rw.envPublicUrl, undefined); // fallback only: a custom domain can still be set in Settings
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', SMTP_HOST: 'h', SMTP_USER: 'u' }), /SMTP_PASSWORD/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', SMTP_HOST: 'h', ADMIN_EMAIL: 'a@b.co' }), /both ADMIN_EMAIL and ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'x', SMTP_HOST: 'h', ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'onlyletterslong' }), /letters and at least one number/);
});

test('secrets: encrypted values round-trip and fail closed with another key', () => {
  const { encrypt, decrypt } = require('../../src/lib/secrets');
  const v = encrypt('k'.repeat(32), 'mailbox-pass');
  assert.ok(!v.includes('mailbox-pass'));
  assert.equal(decrypt('k'.repeat(32), v), 'mailbox-pass');
  assert.equal(decrypt('z'.repeat(32), v), null);
});

test('render: personalisation, escaping, footer, tracking and headers', () => {
  const { renderMessage, sanitize, DEFAULT_TEMPLATE } = require('../../src/engine/render');
  const campaign = { uuid: 'c-1', subject: 'Hi {{ first_name | "there" }}', preheader: 'Sale', body_html: '<p>Hello {{ first_name }} from {{ attribs.city }}</p><p class="mh-align-center"><a href="https://x.example/a" class="mh-button">Go</a></p><a href="{{ view_url }}">v</a>',
    body_text: '', track_opens: true, track_clicks: true };
  const settings = { org_name: 'Acme', org_address: '1 Road' };
  const contact = { first_name: '<b>Ann</b>', email: 'a@b.co', attribs: { city: 'Durban' } };
  const m = renderMessage({ campaign, templateHtml: DEFAULT_TEMPLATE, contact, token: 'tok', settings, publicUrl: 'https://mh.example', links: () => 7 });
  assert.equal(m.subject, 'Hi <b>Ann</b>');
  assert.match(m.html, /Hello &lt;b&gt;Ann&lt;\/b&gt; from Durban/, 'values are HTML-escaped');
  assert.match(m.html, /https:\/\/mh\.example\/t\/c\/tok\/7/, 'click tracking');
  assert.match(m.html, /\/t\/o\/tok\.gif/, 'open pixel');
  assert.match(m.html, /text-align:center/, 'editor classes inlined');
  assert.match(m.html, /background:#1f4e8c/);
  assert.match(m.html, /1 Road/);
  assert.equal(m.headers['List-Unsubscribe'], '<https://mh.example/u/tok>');
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(m.text, /Unsubscribe: https:\/\/mh\.example\/u\/tok/);
  const empty = renderMessage({ campaign: { ...campaign, subject: 'Hi {{ first_name | "there" }}' }, templateHtml: '<p>{{ content }}</p>', contact: {}, token: 't', settings, publicUrl: 'https://m' });
  assert.equal(empty.subject, 'Hi there');
  assert.match(empty.html, /https:\/\/m\/u\/t/, 'footer with unsubscribe added when the template lacks one');
  const clean = sanitize('<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">b</a><iframe src="x"></iframe><a href="{{ unsubscribe_url }}">u</a>');
  assert.ok(!/script|onclick|javascript|iframe/i.test(clean));
  assert.match(clean, /href="\{\{ unsubscribe_url \}\}"/);
});

test('bounce parsing: DSN, ARF complaint, auto-reply and heuristic bounces', async () => {
  const { parseBounceEmail } = require('../../src/engine/bounces');
  const dsn = Buffer.from([
    'From: MAILER-DAEMON@mx.example', 'To: bounces@acme.example', 'Subject: Undelivered Mail Returned to Sender', 'Message-ID: <dsn1@mx.example>',
    'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=delivery-status; boundary="B"', '',
    '--B', 'Content-Type: text/plain', '', 'Your message could not be delivered.', '',
    '--B', 'Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mx.example', '',
    'Final-Recipient: rfc822; gone@ok.example', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 <gone@ok.example>:', '  Recipient address rejected: User unknown', '',
    '--B', 'Content-Type: text/rfc822-headers', '', 'X-MailHarbor-ID: 8e86728b-d88b-4f2b-8bfb-cb6ac768606a', 'To: gone@ok.example', '', '--B--', ''].join('\r\n'));
  const [d] = await parseBounceEmail(dsn);
  assert.equal(d.kind, 'dsn');
  assert.equal(d.email, 'gone@ok.example');
  assert.equal(d.token, '8e86728b-d88b-4f2b-8bfb-cb6ac768606a');
  assert.equal(d.hint, 'hard');
  assert.match(d.text, /5\.1\.1.*User unknown/);

  const delayed = Buffer.from(dsn.toString().replace('Action: failed', 'Action: delayed').replace('Status: 5.1.1', 'Status: 4.4.1'));
  assert.equal((await parseBounceEmail(delayed))[0].hint, 'soft');
  const delivered = Buffer.from(dsn.toString().replace('Action: failed', 'Action: delivered'));
  assert.equal((await parseBounceEmail(delivered)).length, 0);

  const arf = Buffer.from(['From: fbl@isp.example', 'Subject: Abuse report', 'MIME-Version: 1.0', 'Content-Type: multipart/report; report-type=feedback-report; boundary="F"', '',
    '--F', 'Content-Type: message/feedback-report', '', 'Feedback-Type: abuse', 'Original-Rcpt-To: <angry@ok.example>', '', '--F--', ''].join('\r\n'));
  const [a] = await parseBounceEmail(arf);
  assert.equal(a.hint, 'complaint');
  assert.equal(a.email, 'angry@ok.example');

  const ooo = Buffer.from(['From: someone@ok.example', 'Subject: Out of Office: back Monday', 'Auto-Submitted: auto-replied', '', 'I am away.'].join('\r\n'));
  assert.equal((await parseBounceEmail(ooo)).length, 0);

  const heur = Buffer.from(['From: postmaster@old.example', 'Subject: Delivery failure', '', 'This message could not be delivered.', '', '<nobody@old.example>: host mx.old.example said: 550 5.1.1 no such user'].join('\r\n'));
  const [h] = await parseBounceEmail(heur);
  assert.equal(h.email, 'nobody@old.example');
  assert.match(h.text, /5\.1\.1/);
});

test('SMTP error classification', () => {
  const { classifySendError } = require('../../src/engine/mailer');
  assert.equal(classifySendError({ code: 'EAUTH', responseCode: 535 }), 'connection');
  assert.equal(classifySendError({ code: 'ECONNECTION' }), 'connection');
  assert.equal(classifySendError({ code: 'EENVELOPE', responseCode: 550 }), 'permanent');
  assert.equal(classifySendError({ code: 'EENVELOPE', responseCode: 452 }), 'temporary');
  assert.equal(classifySendError({ responseCode: 421 }), 'connection');
});
