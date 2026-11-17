'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

test('UTM: tags web links, keeps existing tags, skips personalised, own and mailto links; domain filter', () => {
  const { addUtm, utmParamsFor, parseDomains } = require('../../src/engine/utm');
  const p = utmParamsFor({ name: 'Spring Sale 2026!' }, { utm_enabled: true, utm_source: 'mailharbor', utm_medium: 'email', utm_domains: '' });
  assert.deepEqual(p, { source: 'mailharbor', medium: 'email', campaign: 'spring-sale-2026', domains: [] });
  const out = addUtm('<a href="https://shop.example/a?x=1&amp;y=2#top">a</a><a href="https://x.example/?utm_source=keep">b</a>'
    + '<a href="{{ unsubscribe_url }}">u</a><a href="https://mh.example/p/abc">own</a><a href="mailto:a@b.c">m</a>', p, 'https://mh.example');
  assert.match(out, /https:\/\/shop\.example\/a\?x=1&amp;y=2&amp;utm_source=mailharbor&amp;utm_medium=email&amp;utm_campaign=spring-sale-2026#top/);
  assert.match(out, /href="https:\/\/x\.example\/\?utm_source=keep"/);
  assert.match(out, /href="\{\{ unsubscribe_url \}\}"/);
  assert.match(out, /href="https:\/\/mh\.example\/p\/abc"/);
  assert.equal(utmParamsFor({ name: 'x', utm_enabled: false }, { utm_enabled: true }), null);
  assert.equal(utmParamsFor({ name: 'x' }, { utm_enabled: false }), null);
  assert.deepEqual(parseDomains('https://acme.co.za/, shop.acme.co.za; nonsense'), ['acme.co.za', 'shop.acme.co.za']);
  const onlyOwn = addUtm('<a href="https://other.example/">o</a><a href="https://www.acme.co.za/">a</a>', { ...p, domains: ['acme.co.za'] });
  assert.match(onlyOwn, /other\.example\/"/);
  assert.match(onlyOwn, /www\.acme\.co\.za\/\?utm_source/);
});

test('segments: rules validate against the catalogue and compile with bound parameters only', () => {
  const { rulesSchema, compileRules } = require('../../src/modules/segments/rules');
  const rules = rulesSchema.parse({ match: 'any', conditions: [
    { field: 'attribute', key: 'city', op: 'is', value: "Durban'; DROP TABLE x; --" },
    { field: 'last_open_at', op: 'within_days', value: 90 },
    { field: 'list', op: 'not_in', value: 3 },
    { field: 'status', op: 'is', value: 'eligible' },
  ] });
  const params = [];
  const sql = compileRules(rules, (v) => { params.push(v); return `$${params.length}`; }, 'c');
  assert.doesNotMatch(sql, /DROP|Durban/, 'values never appear in SQL');
  assert.match(sql, / OR /);
  assert.deepEqual(params, ['city', "Durban'; DROP TABLE x; --", 90, 3]);
  for (const bad of [
    { conditions: [] },
    { conditions: [{ field: 'password', op: 'is', value: 'x' }] },
    { conditions: [{ field: 'status', op: 'is', value: 'superuser' }] },
    { conditions: [{ field: 'attribute', key: 'bad key; --', op: 'set' }] },
    { conditions: [{ field: 'created_at', op: 'after', value: 'yesterday' }] },
  ]) assert.equal(rulesSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('images: compressed for email, rotated, metadata stripped, broken files rejected', async () => {
  const sharp = require('sharp');
  const { compressImage } = require('../../src/modules/images/service');
  const photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#3a7bd5' } }).png().toBuffer();
  let r = await compressImage(photo);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.width, 1200);
  assert.ok(r.bytes < r.originalBytes);
  const logo = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="300" height="100"><rect width="150" height="100" fill="#16365f"/></svg>') }]).png().toBuffer();
  r = await compressImage(logo);
  assert.equal(r.mime, 'image/png', 'transparency kept');
  const sideways = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  r = await compressImage(sideways);
  assert.deepEqual([r.width, r.height], [600, 800], 'EXIF orientation applied');
  assert.equal((await sharp(r.data).metadata()).exif, undefined);
  await assert.rejects(compressImage(Buffer.from('nope')), /not an image/);
  await assert.rejects(compressImage(Buffer.alloc(0)), /empty/);
});
