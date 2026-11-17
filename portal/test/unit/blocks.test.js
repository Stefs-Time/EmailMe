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
  assert.equal(doc.blocks[0].props.bg, '#1f4e8c');
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

test('template builder: renders a complete document around {{ content }}', () => {
  const { renderTemplate, starterTemplate } = require('../../src/engine/blocks');
  const { sanitize } = require('../../src/engine/render');
  const t = renderTemplate({ ...starterTemplate(), settings: { width: 640, font: 'georgia', page_bg: '#e8f1ef' } });
  assert.equal((t.html.match(/\{\{ content \}\}/g) || []).length, 1);
  assert.match(t.html, /max-width:640px/);
  assert.match(t.html, /background-color:#e8f1ef/);
  assert.match(t.html, /Georgia/);
  const clean = sanitize(t.html);
  assert.match(clean, /^<!doctype html>/, 'doctype kept after sanitising');
  assert.match(clean, /href="\{\{ unsubscribe_url \}\}"/);

  const { renderDocument, starterDocument } = require('../../src/engine/blocks');
  const m = renderMessage({
    campaign: { subject: 's', body_html: renderDocument(starterDocument()).html, track_clicks: false, track_opens: false },
    templateHtml: clean, contact: { first_name: 'Thandi' }, token: 'tok',
    settings: { org_name: 'Acme', org_address: '1 Road' }, publicUrl: 'https://mh.example',
  });
  assert.match(m.html, /Hello Thandi/);
  assert.equal((m.html.match(/https:\/\/mh\.example\/u\/tok/g) || []).length, 1, 'footer link used; no second footer added');
  assert.match(m.html, /Acme · 1 Road/);
});

test('template builder: needs exactly one top-level content block; campaigns cannot use template blocks', () => {
  const { renderTemplate, renderDocument } = require('../../src/engine/blocks');
  assert.throws(() => renderTemplate({ blocks: [{ id: 'f', type: 'footer' }] }));
  assert.throws(() => renderTemplate({ blocks: [{ id: 'a', type: 'content' }, { id: 'b', type: 'content' }] }));
  assert.throws(() => renderTemplate({ blocks: [{ id: 'c', type: 'columns', props: { columns: [[{ id: 'x', type: 'content' }], []] } }] }));
  assert.throws(() => renderTemplate({ settings: { width: 2000 }, blocks: [{ id: 'a', type: 'content' }] }));
  assert.throws(() => renderTemplate({ settings: { font: 'Comic Sans' }, blocks: [{ id: 'a', type: 'content' }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'a', type: 'content' }] }));
  assert.throws(() => renderDocument({ blocks: [{ id: 'f', type: 'footer' }] }));
});
