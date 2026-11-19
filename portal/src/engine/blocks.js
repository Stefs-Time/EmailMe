'use strict';

/**
 * Drag-and-drop email builder: block document → email-safe HTML.
 *
 * The browser only edits a JSON document. This module validates it and renders
 * the HTML that is stored in campaigns.body_html and sent. Every value is
 * validated (colours, sizes, URLs) and escaped here, so the document is never
 * trusted. Rich text is limited to inline formatting, links and lists.
 *
 * Output uses tables and inline styles (what email clients support) and
 * stacks columns on phones. Headings, buttons and links follow the brand
 * colours from Settings → Email design unless a block sets its own colour.
 */
const { z } = require('zod');
const sanitizeHtml = require('sanitize-html');

const { CONTENT_WIDTH, themeFrom } = require('./layout');

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f4e8c');
/** '' = follow the brand colour from Settings → Email design. */
const themed = z.union([hex, z.literal('')]).default('');
const align = z.enum(['left', 'center', 'right']);
const tagUrl = /^\{\{\s*[a-zA-Z_][\w.]*\s*\}\}$/;
const url = z.string().trim().max(2000).refine(
  (u) => u === '' || /^https?:\/\/[^\s"<>]+$/i.test(u) || /^mailto:[^\s"<>]+$/i.test(u) || /^tel:[+\d\s()-]+$/i.test(u) || tagUrl.test(u),
  'Use a full web address (https://…), mailto: or tel:',
);
const imageUrl = z.string().trim().max(2000).refine((u) => u === '' || /^https?:\/\/[^\s"<>]+$/i.test(u), 'Use an image address starting with https://');
const plain = (max) => z.string().max(max);
/** Platform-managed destinations: MailHarbor creates each recipient's own link at send time. */
const LINK_TAGS = {
  unsubscribe: '{{ unsubscribe_url }}',
  preferences: '{{ preferences_url }}',
  stay: '{{ stay_url }}',
  consent: '{{ consent_url }}',
  view: '{{ view_url }}',
};
const linkKind = z.enum(['url', ...Object.keys(LINK_TAGS)]);
const spacing = z.coerce.number().int().min(0).max(64);
const common = { pad: spacing.default(12), bg: z.union([hex, z.literal('')]).default('') };

const leafSchemas = {
  heading: z.object({ text: plain(300).default('Heading'), level: z.coerce.number().int().min(1).max(3).default(2), align: align.default('left'), color: themed, ...common }),
  text: z.object({ html: plain(50000).default('<p></p>'), align: align.default('left'), color: hex.default('#1b2430'), size: z.coerce.number().int().min(12).max(22).default(16), ...common }),
  button: z.object({
    label: plain(120).default('Find out more'), link: linkKind.default('url'), url: url.default(''), align: align.default('center'),
    bg: themed, color: hex.default('#ffffff'), radius: z.coerce.number().int().min(0).max(30).default(6),
    full: z.boolean().default(false), pad: spacing.default(16), bg_row: z.union([hex, z.literal('')]).default(''),
  }),
  image: z.object({
    src: imageUrl.default(''), alt: plain(300).default(''), href: url.default(''),
    width: z.coerce.number().int().min(10).max(100).default(100), align: align.default('center'), ...common,
  }),
  divider: z.object({ color: hex.default('#dde3ea'), thickness: z.coerce.number().int().min(1).max(8).default(1), ...common }),
  spacer: z.object({ height: z.coerce.number().int().min(4).max(120).default(24) }),
  html: z.object({ html: plain(500000).default(''), ...common }),
};

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const leaf = z.discriminatedUnion('type', Object.entries(leafSchemas).map(([type, props]) => z.object({ id, type: z.literal(type), props: props.prefault({}) })));
const columns = z.object({
  id,
  type: z.literal('columns'),
  props: z.object({
    ratio: z.enum(['50-50', '33-67', '67-33']).default('50-50'),
    gap: z.coerce.number().int().min(0).max(40).default(16),
    columns: z.array(z.array(leaf).max(20)).length(2).default([[], []]),
    ...common,
  }).prefault({}),
});
const block = z.union([leaf, columns]);

const allLeaves = (blocks) => blocks.flatMap((x) => (x.type === 'columns' ? x.props.columns.flat() : [x]));

/** Campaign content. */
const documentSchema = z.object({
  version: z.literal(1).default(1),
  blocks: z.array(block).max(200).default([]),
});

// ---- Rich text ----------------------------------------------------------------
const TEXT_SANITIZE = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'span'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  transformTags: { b: 'strong', i: 'em', div: 'p' },
};

/** Sanitises builder rich text, keeping {{ tags }} usable as link targets. */
function cleanText(htmlIn) {
  const keep = [];
  const prot = String(htmlIn || '').replace(/href="(\{\{[^"]*\}\})"/g, (m, tag) => { keep.push(tag); return `href="https://mh-tag.invalid/${keep.length - 1}"`; });
  return sanitizeHtml(prot, TEXT_SANITIZE).replace(/https:\/\/mh-tag\.invalid\/(\d+)/g, (m, i) => keep[Number(i)] || '#');
}

// Text nodes: quotes stay literal so {{ tag | "fallback" }} keeps working.
const escText = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Adds email-safe inline styles to the limited rich-text tags. */
function styleText(h, p, t) {
  const base = `margin:0 0 12px;font-size:${p.size}px;line-height:1.6;color:${p.color};text-align:${p.align}`;
  return h
    .replace(/<p>/g, `<p style="${base}">`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 12px;padding-left:24px;font-size:${p.size}px;line-height:1.6;color:${p.color}">`)
    .replace(/<li>/g, '<li style="margin:0 0 4px">')
    .replace(/<a href=/g, `<a style="color:${t.brand};text-decoration:underline" href=`)
    // the last paragraph should not add space below the block
    .replace(/(<p style="[^"]*)margin:0 0 12px;([^"]*">(?:(?!<p ).)*<\/p>\s*)$/s, '$1margin:0;$2');
}

// ---- Rendering ----------------------------------------------------------------
// Documents saved before Email design stored these defaults explicitly: treat them as "brand".
const OLD_HEADING = '#16365f';
const OLD_BUTTON = '#1f4e8c';
const pick = (v, old, themeValue) => (!v || v.toLowerCase() === old ? themeValue : v);

function row(inner, p, alignAttr = 'left') {
  const bg = p.bg ? `background-color:${p.bg};` : '';
  const padX = p.bg ? 16 : 0;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${alignAttr}" style="${bg}padding:${p.pad}px ${padX}px">${inner}</td></tr></table>`;
}

function renderLeaf(b, widthPx, t) {
  const p = b.props;
  switch (b.type) {
    case 'heading': {
      const size = { 1: 28, 2: 22, 3: 18 }[p.level];
      return row(`<h${p.level} style="margin:0;font-size:${size}px;line-height:1.3;font-weight:bold;color:${pick(p.color, OLD_HEADING, t.heading)};text-align:${p.align}">${escText(p.text)}</h${p.level}>`, p, p.align);
    }
    case 'text': {
      const h = p.html.trim() || '<p></p>';
      const wrapped = /^<(p|ul|ol)\b/.test(h) ? h : `<p>${h}</p>`;
      return row(styleText(wrapped, p, t), p, p.align);
    }
    case 'button': {
      if (!p.label.trim()) return '';
      const bg = pick(p.bg, OLD_BUTTON, t.brand);
      const width = p.full ? 'width:100%;' : '';
      const href = p.link !== 'url' ? LINK_TAGS[p.link] : (p.url || '#');
      const a = `<a href="${esc(href)}" style="display:${p.full ? 'block' : 'inline-block'};padding:12px 24px;font-size:16px;font-weight:bold;line-height:1.2;color:${p.color};text-decoration:none;border-radius:${p.radius}px">${escText(p.label)}</a>`;
      const btn = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${p.align}" style="${width}border-collapse:separate"><tr><td align="center" bgcolor="${bg}" style="background-color:${bg};border-radius:${p.radius}px">${a}</td></tr></table>`;
      return row(btn, { pad: p.pad, bg: p.bg_row }, p.align);
    }
    case 'image': {
      if (!p.src) return '';
      const w = Math.round((widthPx * p.width) / 100);
      let img = `<img src="${esc(p.src)}" alt="${esc(p.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none${p.align === 'center' ? ';margin:0 auto' : p.align === 'right' ? ';margin-left:auto' : ''}">`;
      if (p.href) img = `<a href="${esc(p.href)}">${img}</a>`;
      return row(img, p, p.align);
    }
    case 'divider':
      return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:${p.thickness}px solid ${p.color};font-size:0;line-height:0">&nbsp;</td></tr></table>`, p);
    case 'spacer':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="${p.height}" style="height:${p.height}px;font-size:0;line-height:0">&nbsp;</td></tr></table>`;
    case 'html':
      return row(p.html, p); // sanitised with the campaign sanitiser afterwards
    default:
      return '';
  }
}

function renderColumns(b, widthPx, t) {
  const p = b.props;
  const [l, r] = { '50-50': [50, 50], '33-67': [33, 67], '67-33': [67, 33] }[p.ratio];
  const inner = widthPx - p.gap;
  const cell = (blocks, pctW, padSide) => {
    const w = Math.round((inner * pctW) / 100);
    const content = blocks.map((x) => renderLeaf(x, w, t)).join('');
    return `<td class="mh-col" width="${pctW}%" valign="top" style="width:${pctW}%;${padSide}">${content || '&nbsp;'}</td>`;
  };
  const half = Math.floor(p.gap / 2);
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cell(p.columns[0], l, `padding-right:${half}px`)}${cell(p.columns[1], r, `padding-left:${p.gap - half}px`)}</tr></table>`;
  return row(table, p);
}

const MOBILE_CSS = '<style>@media only screen and (max-width:480px){td.mh-col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}}</style>';

/**
 * Validates a builder document and renders it.
 * @returns {{ doc: object, html: string }} the normalised document and its HTML
 * @throws zod error (caught by the route's parse helper) when the document is invalid
 */
function renderDocument(input, settings = {}) {
  const doc = documentSchema.parse(input);
  cleanDocument(doc); // store cleaned content too: editors load it back into the page
  const t = themeFrom(settings);
  const parts = doc.blocks.map((b) => (b.type === 'columns' ? renderColumns(b, CONTENT_WIDTH, t) : renderLeaf(b, CONTENT_WIDTH, t)));
  const body = parts.join('\n');
  const needsCss = doc.blocks.some((b) => b.type === 'columns');
  return { doc, html: `${needsCss ? MOBILE_CSS : ''}<div class="mh-builder">${body}</div>` };
}

function cleanDocument(doc) {
  const { sanitize } = require('./render');
  for (const b of allLeaves(doc.blocks)) {
    if (b.type === 'text') b.props.html = cleanText(b.props.html);
    if (b.type === 'html') b.props.html = sanitize(b.props.html);
  }
}

/** Starting point for a new campaign. */
function starterDocument() {
  return {
    version: 1,
    blocks: [
      { id: 'b1', type: 'heading', props: { text: 'Hello {{ first_name | "there" }}', level: 2 } },
      { id: 'b2', type: 'text', props: { html: '<p>Write your message here. Add images, buttons, columns and more from the Blocks panel.</p>' } },
      { id: 'b3', type: 'button', props: { label: 'Find out more', url: '' } },
    ],
  };
}

/** Wraps existing HTML content as a single builder block (switching from the HTML/visual editor). */
function documentFromHtml(h) {
  return { version: 1, blocks: [{ id: 'b1', type: 'html', props: { html: String(h || ''), pad: 0 } }] };
}

module.exports = {
  LINK_TAGS,
  renderDocument, documentSchema, starterDocument, documentFromHtml, cleanText, CONTENT_WIDTH,
};
