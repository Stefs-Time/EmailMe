'use strict';

/**
 * Ready-made campaign designs ("samples") for the drag-and-drop builder.
 * Each is a normal builder document, validated and rendered like any campaign.
 * [Square-bracket] text marks what to replace; buttons start without a link so
 * the "Ready to send" checklist reminds people to add one.
 */
const { renderDocument } = require('./blocks');

let seq = 0;
const id = () => `s${(seq += 1)}`;
const heading = (text, props = {}) => ({ id: id(), type: 'heading', props: { text, ...props } });
const text = (htmlText, props = {}) => ({ id: id(), type: 'text', props: { html: htmlText, ...props } });
const button = (label, props = {}) => ({ id: id(), type: 'button', props: { label, url: '', ...props } });
const image = (alt, props = {}) => ({ id: id(), type: 'image', props: { src: '', alt, ...props } });
const divider = () => ({ id: id(), type: 'divider', props: {} });
const spacer = (height = 16) => ({ id: id(), type: 'spacer', props: { height } });
const columns = (left, right, props = {}) => ({ id: id(), type: 'columns', props: { columns: [left, right], ...props } });

const SAMPLES = [
  {
    id: 'blank',
    name: 'Simple message',
    icon: 'file-earmark',
    description: 'A greeting, a paragraph and a button. Start from (almost) nothing.',
    subject: '',
    preheader: '',
    blocks: [
      heading('Hello {{ first_name | "there" }}'),
      text('<p>Write your message here. Add images, buttons, columns and more from the Blocks panel.</p>'),
      button('Find out more'),
    ],
  },
  {
    id: 'promotion',
    name: 'Marketing promotion',
    icon: 'megaphone',
    description: 'Banner, headline offer, two featured products and a call to action.',
    subject: '{{ first_name | "Hi" }}, this month\'s specials are here',
    preheader: 'Save on [products] until [end date]. While stocks last.',
    blocks: [
      image('Promotion banner: [describe the image]'),
      heading('This month\'s specials', { level: 1, align: 'center' }),
      text('<p>Hi {{ first_name | "there" }}, for a limited time you can save up to <strong>[20%]</strong> on [product range]. Here are two of our favourites.</p>', { align: 'center' }),
      columns(
        [image('[Product one]'), heading('[Product one]', { level: 3 }), text('<p><strong>R[price]</strong> <s>R[was]</s><br>[One line on why customers love it.]</p>', { size: 15 }), button('Shop now', { align: 'left', pad: 8 })],
        [image('[Product two]'), heading('[Product two]', { level: 3 }), text('<p><strong>R[price]</strong> <s>R[was]</s><br>[One line on why customers love it.]</p>', { size: 15 }), button('Shop now', { align: 'left', pad: 8 })],
      ),
      button('See all specials', { full: true }),
      divider(),
      text('<p>Offer valid until [end date] or while stocks last. Prices include VAT. [Terms and conditions apply.]</p>', { size: 12, color: '#5f6b7a', align: 'center' }),
    ],
  },
  {
    id: 'product-launch',
    name: 'New product release',
    icon: 'rocket-takeoff',
    description: 'Announce something new: hero image, what it is, key features and where to learn more.',
    subject: 'Introducing [product name]',
    preheader: '[One sentence on the problem it solves.]',
    blocks: [
      text('<p><strong>NEW</strong></p>', { align: 'center', color: '#0f8f82', size: 13, pad: 4 }),
      heading('Introducing [product name]', { level: 1, align: 'center' }),
      image('[Product name] photo'),
      text('<p>Hi {{ first_name | "there" }},</p><p>We\'re excited to introduce <strong>[product name]</strong>, [one or two sentences: what it is and who it\'s for].</p>'),
      columns(
        [image('[Product name] in use')],
        [heading('Why you\'ll like it', { level: 3 }), text('<ul><li>[Key benefit one]</li><li>[Key benefit two]</li><li>[Key benefit three]</li></ul>', { size: 15 })],
        { ratio: '50-50' },
      ),
      button('Find out more'),
      text('<p>Available from [date] at [where to buy]. Questions? Simply reply to this email and our team will help.</p>', { size: 14, color: '#5f6b7a' }),
    ],
  },
  {
    id: 'still-interested',
    name: 'Are you still interested?',
    icon: 'question-circle',
    description: 'Re-engage quiet contacts: one clear button to stay, and an easy way out.',
    subject: '{{ first_name | "Hi" }}, are you still interested?',
    preheader: 'One click keeps you on our list.',
    blocks: [
      heading('Are you still interested, {{ first_name | "there" }}?', { align: 'center' }),
      text('<p>We haven\'t heard from you in a while, and we only want to email people who find our updates useful.</p><p>If you\'d like to keep hearing from us about [what you send: specials, news, events], just click below.</p>', { align: 'center' }),
      button('Yes, keep me on the list', { link: 'stay' }),
      spacer(8),
      text('<p>Not interested any more? <a href="{{ unsubscribe_url }}">Unsubscribe here</a>, no hard feelings. We\'ll stop emailing you straight away.</p>', { align: 'center', size: 14, color: '#5f6b7a' }),
    ],
    tip: 'The button goes to MailHarbor\'s own "stay subscribed" page. Everyone who confirms is counted in the campaign report as "Stayed subscribed".',
  },
  {
    id: 'find-out-more',
    name: 'Want to find out more?',
    icon: 'lightbulb',
    description: 'Follow up interest in a product or service: benefits, social proof and a next step.',
    subject: 'Want to find out more about [topic]?',
    preheader: 'Here\'s how [product or service] can help [your business / you].',
    blocks: [
      heading('Want to find out more about [topic]?'),
      text('<p>Hi {{ first_name | "there" }},</p><p>[Thanks for your interest in / You recently asked about] <strong>[product or service]</strong>. Here\'s a quick overview of how it can help.</p>'),
      columns(
        [heading('[Benefit one]', { level: 3 }), text('<p>[One or two sentences.]</p>', { size: 15 })],
        [heading('[Benefit two]', { level: 3 }), text('<p>[One or two sentences.]</p>', { size: 15 })],
      ),
      text('<p><em>"[A short quote from a happy customer.]"</em><br>[Name], [Company]</p>', { bg: '#f4f6f9', pad: 16 }),
      button('Book a call'),
      text('<p>Prefer email? Simply reply with your questions and [name] from our team will get back to you within [one working day].</p>', { size: 14, color: '#5f6b7a' }),
    ],
  },
  {
    id: 'newsletter',
    name: 'Monthly newsletter',
    icon: 'newspaper',
    description: 'A short intro, two feature stories side by side and quick news items.',
    subject: '[Month] news from {{ org_name }}',
    preheader: '[Lead story in one line] and more.',
    blocks: [
      heading('[Month] newsletter', { level: 1 }),
      text('<p>Hi {{ first_name | "there" }}, here\'s what\'s been happening at {{ org_name }} this month.</p>'),
      image('[Lead story image]'),
      heading('[Lead story headline]', { level: 2 }),
      text('<p>[Two or three sentences summarising the story.]</p>'),
      button('Read more', { align: 'left' }),
      divider(),
      columns(
        [image('[Story two image]'), heading('[Story two]', { level: 3 }), text('<p>[Short summary.] <a href="https://example.co.za">Read more</a></p>', { size: 15 })],
        [image('[Story three image]'), heading('[Story three]', { level: 3 }), text('<p>[Short summary.] <a href="https://example.co.za">Read more</a></p>', { size: 15 })],
      ),
      divider(),
      heading('In brief', { level: 3 }),
      text('<ul><li>[Quick news item]</li><li>[Quick news item]</li><li>[Upcoming date or event]</li></ul>'),
    ],
    tip: 'Replace the example.co.za "Read more" links with your own pages.',
  },
  {
    id: 'event-invite',
    name: 'Event invitation',
    icon: 'calendar-event',
    description: 'Invite contacts to an event or webinar with date, time, venue and an RSVP button.',
    subject: 'You\'re invited: [event name]',
    preheader: '[Day, date] at [venue / online]. Spaces are limited.',
    blocks: [
      image('[Event banner]'),
      heading('You\'re invited, {{ first_name | "there" }}', { level: 1, align: 'center' }),
      text('<p>Join us for <strong>[event name]</strong>, [one sentence on what attendees will get out of it].</p>', { align: 'center' }),
      text('<p><strong>Date:</strong> [Day, DD Month YYYY]<br><strong>Time:</strong> [HH:MM] to [HH:MM] (SAST)<br><strong>Venue:</strong> [Venue, address / Online]</p>', { bg: '#f4f6f9', pad: 16, align: 'center' }),
      button('RSVP now'),
      text('<p>Spaces are limited, so please RSVP by [date]. Can\'t make it? Reply to this email and we\'ll share the highlights.</p>', { size: 14, color: '#5f6b7a', align: 'center' }),
    ],
  },
  {
    id: 'welcome',
    name: 'Welcome new subscribers',
    icon: 'hand-thumbs-up',
    description: 'Say hello, set expectations about what you\'ll send, and point to a first step.',
    subject: 'Welcome to {{ org_name }}, {{ first_name | "friend" }}',
    preheader: 'Here\'s what to expect from us.',
    blocks: [
      heading('Welcome, {{ first_name | "there" }}!', { level: 1 }),
      text('<p>Thank you for joining the {{ org_name }} mailing list. We\'re glad to have you.</p><p>Here\'s what you can expect from us:</p><ul><li>[What you send, e.g. monthly specials]</li><li>[How often, e.g. about twice a month]</li><li>[Something exclusive, e.g. early access to sales]</li></ul>'),
      button('Visit our website'),
      text('<p>You can unsubscribe at any time using the link at the bottom of every email.</p>', { size: 14, color: '#5f6b7a' }),
    ],
  },
];

// Fail fast at startup if a sample is not a valid document.
for (const s of SAMPLES) renderDocument({ version: 1, blocks: s.blocks });

/** Matching ready-made template (templateSamples.js) per campaign sample; none = the default template. */
const MATCHING_TEMPLATE = {
  promotion: 'promotion',
  'event-invite': 'promotion',
  'product-launch': 'new-release',
  'still-interested': 'clean',
  'find-out-more': 'clean',
  newsletter: 'clean',
  welcome: 'clean',
};
const TEMPLATE_NAMES = { promotion: 'Promotion', 'new-release': 'New release', clean: 'Clean' };

/** Public list for the gallery. */
function listSamples() {
  return SAMPLES.map(({ blocks, ...meta }) => ({
    ...meta, blockCount: blocks.length,
    template: MATCHING_TEMPLATE[meta.id] || null, templateName: TEMPLATE_NAMES[MATCHING_TEMPLATE[meta.id]] || null,
  }));
}

/** A fresh copy of a sample's document, subject, preheader and matching template key. */
function getSample(sampleId) {
  const s = SAMPLES.find((x) => x.id === sampleId);
  if (!s) return null;
  return { subject: s.subject, preheader: s.preheader, template: MATCHING_TEMPLATE[s.id] || null,
    doc: { version: 1, blocks: JSON.parse(JSON.stringify(s.blocks)) } };
}

module.exports = { listSamples, getSample, SAMPLE_IDS: SAMPLES.map((s) => s.id) };
