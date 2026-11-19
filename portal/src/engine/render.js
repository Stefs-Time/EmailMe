'use strict';

/**
 * Email rendering: layout (Settings → Email design) + campaign content +
 * per-recipient personalisation, link tracking, open pixel, compliant footer,
 * text part.
 *
 * Drafts are rendered live from their builder document and the current email
 * design. When a campaign starts, its content and layout are frozen on the
 * campaign (body_html, layout_html), so what was sent never changes afterwards.
 *
 * Personalisation tags (no logic, so no template injection):
 *   {{ first_name }}  {{ last_name }}  {{ full_name }}  {{ email }}  {{ company }}
 *   {{ attribs.city }}                       any custom attribute
 *   {{ first_name | "there" }}               fallback when empty
 *   {{ unsubscribe_url }}  {{ view_url }}  {{ preferences_url }}  {{ stay_url }}  {{ consent_url }}
 *   {{ org_name }}  {{ org_address }}
 * Values are HTML-escaped in the HTML part.
 */
const sanitizeHtml = require('sanitize-html');
const { addUtm, utmParamsFor } = require('./utm');
const { renderLayout } = require('./layout');

const TAG_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*"([^"]*)"\s*)?\}\}/g;

const SANITIZE = {
  allowedTags: [
    'html', 'head', 'body', 'meta', 'title', 'style', 'center', 'div', 'span', 'p', 'br', 'hr', 'a', 'img',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sup', 'sub', 'blockquote',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'pre', 'code', 'font',
  ],
  allowedAttributes: {
    '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'role', 'title', 'id'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'alt', 'width', 'height', 'border'],
    table: ['border', 'cellpadding', 'cellspacing'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan', 'scope'],
    meta: ['charset', 'name', 'content', 'http-equiv'],
    font: ['face', 'size', 'color'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowVulnerableTags: true, // <style> is required for email layouts; scripts are still removed
  // Keep personalisation tags inside attributes (e.g. href="{{ unsubscribe_url }}").
  allowProtocolRelative: false,
};

/** Removes scripts, event handlers, iframes, forms and javascript: URLs. */
function sanitize(html) {
  // Protect {{ tags }} in href/src, which the URL scheme filter would drop.
  const keep = [];
  const protectedHtml = String(html || '').replace(/(href|src)="(\{\{[^"]*\}\})"/g, (m, attr, tag) => {
    keep.push(tag);
    return `${attr}="https://mh-tag.invalid/${keep.length - 1}"`;
  });
  const clean = sanitizeHtml(protectedHtml, SANITIZE).replace(/https:\/\/mh-tag\.invalid\/(\d+)/g, (m, i) => keep[Number(i)]);
  // sanitize-html drops the doctype; without it some email clients render in quirks mode.
  return /^\s*<!doctype html>/i.test(String(html || '')) ? `<!doctype html>\n${clean.replace(/^\s+/, '')}` : clean;
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function lookup(vars, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), vars);
}

function substitute(text, vars, { escape }) {
  return String(text || '').replace(TAG_RE, (m, path, fallback) => {
    let v = lookup(vars, path);
    if (v === undefined || v === null || v === '') v = fallback ?? '';
    if (typeof v === 'object') v = '';
    return escape ? escapeHtml(v) : String(v);
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const t = label.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Visual-editor alignment classes → inline styles (email clients ignore classes). */
function inlineEditorClasses(html) {
  return String(html || '')
    .replace(/class="mh-align-(left|center|right)"/g, 'style="text-align:$1"')
    .replace(/class="mh-button"/g, 'style="background:#1f4e8c;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold"');
}

/** The built-in frame used before Email design existed (kept to freeze old campaigns faithfully). */
const LEGACY_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{ subject }}</title>
<style>
  body { margin:0; padding:0; background:#f4f6f9; font-family:Arial, Helvetica, sans-serif; color:#1b2430; }
  .wrap { max-width:600px; margin:0 auto; padding:24px 12px; }
  .card { background:#ffffff; border-radius:8px; padding:32px 28px; line-height:1.6; font-size:16px; }
  .brand { font-size:20px; font-weight:bold; color:#16365f; padding:0 4px 16px; }
  h1, h2, h3 { color:#16365f; line-height:1.3; margin:0 0 12px; }
  a { color:#1f4e8c; }
  img { max-width:100%; height:auto; }
  .footer { font-size:12px; color:#5f6b7a; text-align:center; padding:20px 12px; line-height:1.5; }
  .footer a { color:#5f6b7a; }
</style></head>
<body><div class="wrap">
  <div class="brand">{{ org_name }}</div>
  <div class="card">{{ content }}</div>
  <div class="footer">
    {{ org_name }}{{ org_address_line }}<br>
    You are receiving this because you subscribed or are a customer of {{ org_name }}.<br>
    <a href="{{ unsubscribe_url }}">Unsubscribe</a> &nbsp;·&nbsp; <a href="{{ view_url }}">View in browser</a>
  </div>
</div></body></html>`;

/**
 * Rewrites http(s) links in campaign content for click tracking.
 * `linkId(url)` returns the tracked link id. Personalised URLs are not tracked.
 */
function trackLinks(html, linkId, clickUrl) {
  return html.replace(/(<a\s[^>]*?href=")(https?:\/\/[^"]+)(")/gi, (m, pre, url, post) => {
    if (url.includes('{{')) return m;
    const id = linkId(url.replace(/&amp;/g, '&'));
    return id ? `${pre}${clickUrl(id)}${post}` : m;
  });
}

const isStarted = (c) => Boolean(c.started_at) || ['sending', 'paused', 'sent', 'cancelled'].includes(c.status);

/**
 * The content and layout of a campaign: frozen once started, otherwise rendered
 * from the builder document with the current email design.
 */
function emailParts(campaign, settings) {
  if (isStarted(campaign) && campaign.layout_html) return { content: campaign.body_html || '', layout: campaign.layout_html };
  const { renderDocument } = require('./blocks'); // lazy: blocks.js uses this module's sanitiser
  const content = campaign.editor === 'builder' && campaign.body_json
    ? sanitize(renderDocument(campaign.body_json, settings).html)
    : (campaign.body_html || '');
  return { content, layout: renderLayout(settings) };
}

/**
 * Builds a complete message for one recipient.
 * @returns {{subject, html, text, headers}}
 */
function renderMessage({ campaign, contact, token, settings, publicUrl, links, isTest = false }) {
  const parts = emailParts(campaign, settings);
  const base = publicUrl;
  const unsubscribeUrl = `${base}/u/${token}`;
  const viewUrl = `${base}/v/${token}`;
  const vars = {
    first_name: contact.first_name || '', last_name: contact.last_name || '',
    full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
    email: contact.email || '', company: contact.company || '', attribs: contact.attribs || {},
    unsubscribe_url: unsubscribeUrl, view_url: viewUrl,
    preferences_url: `${base}/p/${token}`, stay_url: `${base}/s/stay/${token}`,
    consent_url: `${base}/s/consent/${token}`,
    org_name: settings.org_name, org_address: settings.org_address,
    org_address_line: settings.org_address ? ` · ${settings.org_address}` : '',
    subject: campaign.subject, preheader: campaign.preheader || '',
  };

  let content = inlineEditorClasses(parts.content);
  // UTM tags: frozen on the campaign when it starts (utm_params), live for previews and tests.
  const started = isStarted(campaign);
  const utm = started ? (campaign.utm_params || null) : utmParamsFor(campaign, settings);
  content = addUtm(content, utm, base);
  if (campaign.track_clicks && !isTest && links) {
    content = trackLinks(content, links, (id) => `${base}/t/c/${token}/${id}`);
  }
  const doc = /\{\{\s*content\s*\}\}/.test(parts.layout)
    ? parts.layout.replace(/\{\{\s*content\s*\}\}/, () => content)
    : `${parts.layout}${content}`;
  let html = substitute(doc, vars, { escape: true });

  // Preheader: hidden preview text shown by inbox lists.
  if (campaign.preheader) {
    const pre = `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(substitute(campaign.preheader, vars, { escape: false }))}</div>`;
    html = /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${pre}`) : pre + html;
  }
  // Every marketing email must carry a working unsubscribe link (scope §3.7).
  if (!html.includes(unsubscribeUrl)) {
    const footer = `<div style="font-size:12px;color:#5f6b7a;text-align:center;padding:16px">${escapeHtml(settings.org_name)}${settings.org_address ? ` · ${escapeHtml(settings.org_address)}` : ''}<br><a href="${unsubscribeUrl}" style="color:#5f6b7a">Unsubscribe</a></div>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}</body>`) : html + footer;
  }
  if (campaign.track_opens && !isTest) {
    const pixel = `<img src="${base}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
  }

  // A hand-written text part is only honoured for campaigns sent with one; otherwise it is generated.
  const textBody = started && campaign.body_text?.trim()
    ? substitute(campaign.body_text, vars, { escape: false })
    : htmlToText(substitute(parts.content, vars, { escape: false }));
  const text = `${textBody}\n\n--\n${settings.org_name}${settings.org_address ? `, ${settings.org_address}` : ''}\nUnsubscribe: ${unsubscribeUrl}\n`;

  return {
    subject: `${isTest ? '[TEST] ' : ''}${substitute(campaign.subject, vars, { escape: false })}`,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-MailHarbor-ID': token,
      ...(campaign.uuid ? { 'X-MailHarbor-Campaign': campaign.uuid } : {}),
    },
  };
}

module.exports = { renderMessage, emailParts, isStarted, sanitize, substitute, htmlToText, escapeHtml, trackLinks, LEGACY_TEMPLATE, TAG_RE };
