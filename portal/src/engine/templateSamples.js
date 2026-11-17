'use strict';

/**
 * Ready-made template designs (the frame around campaigns), built with the
 * template builder. They are added to Templates once on first start
 * (ensureTemplatePresets) and campaign samples pick the matching one.
 * The image block at the top is a logo placeholder: empty images are not
 * rendered in emails, and the builder shows "add the image address" until set.
 */
const { renderTemplate } = require('./blocks');

const block = (id, type, props = {}) => ({ id, type, props });

const TEMPLATE_SAMPLES = [
  {
    id: 'standard',
    name: 'MailHarbor standard',
    icon: 'layout-text-window',
    description: 'Light grey page, your name on top, white content card, standard footer.',
    doc: {
      version: 1,
      settings: {},
      blocks: [
        block('t1', 'heading', { text: '{{ org_name }}', level: 3, pad: 16 }),
        block('t2', 'content'),
        block('t3', 'footer'),
      ],
    },
  },
  {
    id: 'clean',
    name: 'Clean',
    icon: 'file-earmark-text',
    description: 'Minimal and white, with thin dividers. Lets your words do the work: ideal for updates, newsletters and personal notes.',
    doc: {
      version: 1,
      settings: { page_bg: '#ffffff', body_bg: '#ffffff', width: 600, font: 'helvetica', radius: 0, body_pad: 8 },
      blocks: [
        block('c1', 'image', { alt: 'Your logo', width: 30, align: 'left', pad: 8 }),
        block('c2', 'heading', { text: '{{ org_name }}', level: 3, align: 'left', color: '#1b2430', pad: 8 }),
        block('c3', 'divider', { color: '#e5e7eb', pad: 8 }),
        block('c4', 'content'),
        block('c5', 'divider', { color: '#e5e7eb', pad: 8 }),
        block('c6', 'footer', { align: 'left', color: '#5f6b7a' }),
      ],
    },
  },
  {
    id: 'promotion',
    name: 'Promotion',
    icon: 'megaphone',
    description: 'Bold navy frame with a "limited-time offers" banner and a bright content card. Made for specials, sales and events.',
    doc: {
      version: 1,
      settings: { page_bg: '#0f2846', body_bg: '#ffffff', width: 620, font: 'arial', radius: 12, body_pad: 28 },
      blocks: [
        block('p1', 'image', { alt: 'Your logo', width: 35, align: 'center', pad: 12 }),
        block('p2', 'heading', { text: '{{ org_name }}', level: 2, align: 'center', color: '#ffffff', pad: 4 }),
        block('p3', 'text', { html: '<p><strong>LIMITED-TIME OFFERS</strong> · DON\'T MISS OUT</p>', align: 'center', color: '#2bb3a3', size: 13, pad: 4 }),
        block('p4', 'spacer', { height: 12 }),
        block('p5', 'content'),
        block('p6', 'spacer', { height: 12 }),
        block('p7', 'text', { html: '<p>Shop online at [your website] · Prices include VAT · While stocks last</p>', align: 'center', color: '#c9d6e6', size: 13, pad: 4 }),
        block('p8', 'footer', { align: 'center', color: '#c9d6e6' }),
      ],
    },
  },
  {
    id: 'new-release',
    name: 'New release',
    icon: 'rocket-takeoff',
    description: 'Fresh, modern frame with a "new release" label above a rounded card. Built for product launches and announcements.',
    doc: {
      version: 1,
      settings: { page_bg: '#eef3f8', body_bg: '#ffffff', width: 600, font: 'helvetica', radius: 16, body_pad: 32 },
      blocks: [
        block('n1', 'image', { alt: 'Your logo', width: 30, align: 'center', pad: 12 }),
        block('n2', 'heading', { text: '{{ org_name }}', level: 3, align: 'center', color: '#16365f', pad: 4 }),
        block('n3', 'text', { html: '<p><strong>✦ NEW RELEASE ✦</strong></p>', align: 'center', color: '#0b6b62', size: 13, pad: 4 }),
        block('n4', 'spacer', { height: 8 }),
        block('n5', 'content'),
        block('n6', 'text', { html: '<p>Questions about what\'s new? Simply reply to this email. We\'re happy to help.</p>', align: 'center', color: '#44505f', size: 14, pad: 16 }),
        block('n7', 'footer', { align: 'center', color: '#5f6b7a' }),
      ],
    },
  },
];

// Fail fast at startup if a design is invalid.
for (const t of TEMPLATE_SAMPLES) renderTemplate(t.doc);

/** Presets added to Templates automatically (the standard one is the default template). */
const PRESET_IDS = ['clean', 'promotion', 'new-release'];

function listTemplateSamples() {
  return TEMPLATE_SAMPLES.map(({ doc, ...meta }) => meta);
}

function getTemplateSample(id) {
  const t = TEMPLATE_SAMPLES.find((x) => x.id === id);
  return t ? { id: t.id, name: t.name, doc: JSON.parse(JSON.stringify(t.doc)) } : null;
}

module.exports = { listTemplateSamples, getTemplateSample, PRESET_IDS, TEMPLATE_SAMPLE_IDS: TEMPLATE_SAMPLES.map((t) => t.id) };
