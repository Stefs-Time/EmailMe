'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderDocument, starterDocument, documentFromHtml } = require('../../src/engine/blocks');
const { renderMessage } = require('../../src/engine/render');

test('builder: starter document renders with personalisation intact', () => {
  const { html, doc } = renderDocument(starterDocument());
  assert.equal(doc.blocks.length, 3);
  assert.match(html, /<h2 [^>]*>Hello \{\{ first_name \| "there" \}\}<\/h2>/);
  assert.match(html, /role="presentation"/);
});

test('builder: defaults are applied to missing props', () => {
  const { doc } = renderDocument({ blocks: [{ id: 'a', type: 'button' }, { id: 'b', type: 'columns' }] });
  assert.equal(doc.blocks[0].props.bg, '', 'empty = follow the brand colour');
  assert.equal(doc.blocks[0].props.align, 'center');
  assert.deepEqual(doc.blocks[1].props.columns, [[], []]);
});

test('builder: unsafe values are rejected or stripped', () => {
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'button', props: { url: 'javascript:alert(1)' } }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'heading', props: { color: 'red;background:url(x)' } }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'image', props: { src: 'data:image/png;base64,xx' } }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'script' }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'a"><x', type: 'text' }] }));
  // columns may not contain columns
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'columns', props: { columns: [[{ id: 'b', type: 'columns' }], []] } }] }));

  const { doc, html } = renderDocument({ blocks: [
    { id: 't', type: 'text', props: { html: '<p onclick="x()">Hi <img src=x onerror=alert(1)><a href="javascript:x">a</a><script>bad()</script></p>' } },
    { id: 'h', type: 'heading', props: { text: '<img src=x onerror=alert(1)> & co' } },
    { id: 'b', type: 'button', props: { label: '</a><script>x</script>', url: 'https://ok.example/?a=1&b=2' } },
  ] });
  assert.equal(doc.blocks[0].props.html, '<p>Hi <a>a</a></p>', 'stored document is cleaned too');
  assert.doesNotMatch(html, /<img[^>]*onerror|onclick=|<script|javascript:/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; co/);
  assert.match(html, /href="https:\/\/ok\.example\/\?a=1&amp;b=2"/);
  assert.match(html, /&lt;\/a&gt;&lt;script&gt;x&lt;\/script&gt;/);
  assert.throws(() => renderDocument({ blocks: [{ id: 'q', type: 'button', props: { url: 'https://x.example/"onmouseover="x' } }] }));
});

test('builder: links to personalisation tags survive sanitising', () => {
  const { html } = renderDocument({ blocks: [{ id: 't', type: 'text', props: { html: '<p><a href="{{ view_url }}">View</a></p>' } }] });
  assert.match(html, /href="\{\{ view_url \}\}"/);
});

test('builder: columns stack on phones; images get pixel widths', () => {
  const { html } = renderDocument({ blocks: [{ id: 'c', type: 'columns', props: { ratio: '33-67', columns: [
    [{ id: 'i', type: 'image', props: { src: 'https://cdn.example/a.png', alt: 'A', width: 100 } }],
    [{ id: 't', type: 'text', props: { html: '<p>Right</p>' } }],
  ] } }] });
  assert.match(html, /@media only screen and \(max-width:480px\)/);
  assert.match(html, /class="mh-col" width="33%"/);
  assert.match(html, /<img src="https:\/\/cdn\.example\/a\.png" alt="A" width="174"/); // (544-16)*33%
});

test('builder: rendered email is personalised and button links are click-tracked', () => {
  const { html: body } = renderDocument({ blocks: [
    { id: 'h', type: 'heading', props: { text: 'Hi {{ first_name | "friend" }}' } },
    { id: 'b', type: 'button', props: { label: 'Shop', url: 'https://shop.example/sale' } },
  ] });
  const m = renderMessage({
    campaign: { subject: 's', body_html: body, track_clicks: true, track_opens: false },
    contact: { first_name: 'Thandi', email: 't@example.com' }, token: 'tok',
    settings: { org_name: 'Acme', org_address: '1 Road' }, publicUrl: 'https://mh.example',
    links: (u) => (u === 'https://shop.example/sale' ? 7 : null),
  });
  assert.match(m.html, />Hi Thandi<\/h2>/);
  assert.match(m.html, /href="https:\/\/mh\.example\/t\/c\/tok\/7"/);
  assert.match(m.text, /Hi Thandi/);
});

test('builder: existing HTML becomes one HTML block', () => {
  const d = documentFromHtml('<p>Old content</p>');
  const { html } = renderDocument(d);
  assert.match(html, /<p>Old content<\/p>/);
});

test('email design: one layout around every email, built from settings', () => {
  const { renderLayout } = require('../../src/engine/layout');
  const { sanitize } = require('../../src/engine/render');
  const layout = renderLayout({ email_background: '#e8f1ef', email_font: 'georgia', email_logo_url: 'https://cdn.example/logo.png',
    email_logo_width: 120, email_header_align: 'center', email_footer_text: 'Proudly <local>', email_show_preferences: false });
  assert.equal((layout.match(/\{\{ content \}\}/g) || []).length, 1);
  assert.match(layout, /background-color:#e8f1ef/);
  assert.match(layout, /Georgia/);
  assert.match(layout, /src="https:\/\/cdn\.example\/logo\.png"[^>]*width="120"/);
  assert.match(layout, /Proudly &lt;local&gt;/, 'footer text is escaped');
  assert.doesNotMatch(layout, /preferences_url/);
  assert.match(layout, /href="\{\{ unsubscribe_url \}\}"/);
  assert.match(sanitize(layout), /^<!doctype html>/, 'doctype kept after sanitising');
  // Invalid values never reach the HTML.
  const bad = renderLayout({ email_background: 'red;x:expression(1)', email_logo_url: 'javascript:alert(1)', email_logo_width: 9999 });
  assert.doesNotMatch(bad, /expression|javascript/);
  assert.match(bad, /<span[^>]*>\{\{ org_name \}\}<\/span>/, 'organisation name when there is no logo');

  const m = renderMessage({
    campaign: { subject: 's', body_html: renderDocument(starterDocument()).html, track_clicks: false, track_opens: false },
    contact: { first_name: 'Thandi' }, token: 'tok',
    settings: { org_name: 'Acme', org_address: '1 Road' }, publicUrl: 'https://mh.example',
  });
  assert.match(m.html, /Hello Thandi/);
  assert.equal((m.html.match(/https:\/\/mh\.example\/u\/tok/g) || []).length, 1, 'footer link used; no second footer added');
  assert.match(m.html, /Acme · 1 Road/);
  assert.match(m.html, /href="https:\/\/mh\.example\/p\/tok"/, 'preferences link shown by default');
});

test('email design: headings, buttons and links follow the brand colours unless set per block', () => {
  const brand = { email_brand_color: '#aa0011', email_heading_color: '#003322' };
  const { html } = renderDocument({ blocks: [
    { id: 'h', type: 'heading', props: { text: 'Hi' } },
    { id: 'o', type: 'heading', props: { text: 'Old default', color: '#16365f' } },
    { id: 'x', type: 'heading', props: { text: 'Own colour', color: '#123456' } },
    { id: 'b', type: 'button', props: { label: 'Go', url: 'https://a.example' } },
    { id: 't', type: 'text', props: { html: '<p><a href="https://a.example">link</a></p>' } },
  ] }, brand);
  assert.equal((html.match(/color:#003322/g) || []).length, 2, 'unset and old-default headings follow the brand');
  assert.match(html, /color:#123456/, 'a chosen colour is kept');
  assert.match(html, /bgcolor="#aa0011"/);
  assert.match(html, /<a style="color:#aa0011/);
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'content' }] }), 'template-only blocks no longer exist');
  assert.throws(() => renderDocument({ blocks: [{ id: 'f', type: 'footer' }] }));
});

test('builder: platform-managed link destinations', () => {
  const { html } = renderDocument({ blocks: [
    { id: 'a', type: 'button', props: { label: 'Unsubscribe', link: 'unsubscribe' } },
    { id: 'b', type: 'button', props: { label: 'Preferences', link: 'preferences' } },
    { id: 'c', type: 'button', props: { label: 'Stay', link: 'stay' } },
    { id: 'd', type: 'button', props: { label: 'Web', link: 'view' } },
    { id: 'e', type: 'button', props: { label: 'Site', link: 'url', url: 'https://acme.example' } },
  ] });
  for (const tag of ['unsubscribe_url', 'preferences_url', 'stay_url', 'view_url']) assert.match(html, new RegExp(`href="\\{\\{ ${tag} \\}\\}"`));
  assert.match(html, /href="https:\/\/acme\.example"/);
  assert.throws(() => renderDocument({ blocks: [{ id: 'x', type: 'button', props: { link: 'javascript' } }] }));

  const m = renderMessage({
    campaign: { subject: 's', body_html: html, track_clicks: true, track_opens: false }, contact: { email: 'x@y.z' }, token: 'tok',
    settings: { org_name: 'A', org_address: 'B' }, publicUrl: 'https://mh.example', links: () => 9,
  });
  assert.match(m.html, /href="https:\/\/mh\.example\/p\/tok"/);
  assert.match(m.html, /href="https:\/\/mh\.example\/s\/stay\/tok"/);
  assert.match(m.html, /href="https:\/\/mh\.example\/t\/c\/tok\/9"/, 'web addresses are still click-tracked');
});
