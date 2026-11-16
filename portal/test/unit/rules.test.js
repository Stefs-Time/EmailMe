'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyBounce } = require('../../src/modules/sync/bounceRules');
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

test('configuration fails fast with clear messages', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL[\s\S]*SESSION_SECRET/);
  const c = loadConfig({ DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32), LISTMONK_URL: 'http://lm:9000/',
    LISTMONK_API_USER: 'mailharbor', LISTMONK_API_TOKEN: 't', GLOBAL_UNSUBSCRIBE: 'false' });
  assert.equal(c.LISTMONK_URL, 'http://lm:9000');
  assert.equal(c.LISTMONK_PUBLIC_URL, 'http://lm:9000');
  assert.equal(c.GLOBAL_UNSUBSCRIBE, false);
  assert.equal(c.PORT, 3000);
});

test('configuration: Railway-style variables (empty strings, self-bootstrap, env admin)', () => {
  const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32), LISTMONK_URL: 'http://lm:9000' };
  assert.throws(() => loadConfig(base), /LISTMONK_API_TOKEN/);
  const c = loadConfig({ ...base, LISTMONK_API_TOKEN: '', LISTMONK_ADMIN_USER: 'admin', LISTMONK_ADMIN_PASSWORD: 'p', ADMIN_EMAIL: '' });
  assert.equal(c.LISTMONK_API_TOKEN, undefined);
  assert.equal(c.LISTMONK_API_USER, 'mailharbor');
  assert.equal(c.ADMIN_EMAIL, undefined);
  assert.throws(() => loadConfig({ ...base, LISTMONK_API_TOKEN: 't', ADMIN_EMAIL: 'a@b.co' }), /both ADMIN_EMAIL and ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...base, LISTMONK_API_TOKEN: 't', ADMIN_EMAIL: 'a@b.co', ADMIN_PASSWORD: 'onlyletterslong' }), /letters and at least one number/);
  assert.equal(loadConfig({ ...base, LISTMONK_API_TOKEN: 't', ADMIN_EMAIL: 'A@B.co', ADMIN_PASSWORD: 'Strong-pass-123' }).ADMIN_EMAIL, 'a@b.co');
});

test('secrets: encrypted values round-trip and fail closed with another key', () => {
  const { encrypt, decrypt } = require('../../src/lib/secrets');
  const v = encrypt('k'.repeat(32), 'token-123');
  assert.ok(!v.includes('token-123'));
  assert.equal(decrypt('k'.repeat(32), v), 'token-123');
  assert.equal(decrypt('z'.repeat(32), v), null);
});
