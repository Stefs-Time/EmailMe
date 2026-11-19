'use strict';

/**
 * The email layout: one fixed, compliant frame around every email, built from
 * Settings → Email design (logo, colours, font, footer line). There are no
 * per-campaign templates: campaigns only provide their content.
 *
 *   ┌ header: logo, or the organisation name ┐
 *   │ content card: {{ content }}            │
 *   └ footer: organisation · postal address, footer line,
 *             Unsubscribe · Manage preferences · View in browser
 *
 * The result still contains {{ tags }} (content, org_name, links), which
 * render.js fills per recipient. Every value here comes from validated settings
 * and is escaped.
 */

const FONTS = {
  arial: 'Arial, Helvetica, sans-serif',
  helvetica: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
};
const WIDTH = 600;
const CONTENT_PAD = 28;
/** Width available to content blocks inside the card. */
const CONTENT_WIDTH = WIDTH - 2 * CONTENT_PAD;

const HEX = /^#[0-9a-fA-F]{6}$/;
const colour = (v, fallback) => (HEX.test(v || '') ? v : fallback);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Text nodes keep quotes literal so {{ tag | "fallback" }} still works.
const escText = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Colours and font that content blocks follow unless a block sets its own. */
function themeFrom(s = {}) {
  return {
    brand: colour(s.email_brand_color, '#1f4e8c'),
    heading: colour(s.email_heading_color, '#16365f'),
    font: FONTS[s.email_font] || FONTS.arial,
  };
}

/** The complete email document with {{ content }} where the campaign goes. */
function renderLayout(s = {}) {
  const t = themeFrom(s);
  const bg = colour(s.email_background, '#f4f6f9');
  const align = s.email_header_align === 'center' ? 'center' : 'left';
  const logoW = Math.min(300, Math.max(40, Number(s.email_logo_width) || 160));
  const header = s.email_logo_url && /^https?:\/\//i.test(s.email_logo_url)
    ? `<img src="${esc(s.email_logo_url)}" alt="{{ org_name }}" width="${logoW}" style="display:${align === 'center' ? 'block;margin:0 auto' : 'block'};width:${logoW}px;max-width:100%;height:auto;border:0">`
    : `<span style="font-size:20px;font-weight:bold;color:${t.heading}">{{ org_name }}</span>`;
  const link = 'color:#5f6b7a;text-decoration:underline';
  const footerText = (s.email_footer_text || '').trim();
  const footer = `{{ org_name }}{{ org_address_line }}${footerText ? `<br>${escText(footerText)}` : ''}<br>`
    + `<a href="{{ unsubscribe_url }}" style="${link}">Unsubscribe</a>`
    + `${s.email_show_preferences === false ? '' : ` &nbsp;&middot;&nbsp; <a href="{{ preferences_url }}" style="${link}">Manage preferences</a>`}`
    + ` &nbsp;&middot;&nbsp; <a href="{{ view_url }}" style="${link}">View in browser</a>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{ subject }}</title>
<style>body{margin:0;padding:0;-webkit-text-size-adjust:100%}img{max-width:100%;height:auto;border:0}
@media only screen and (max-width:480px){td.mh-col{display:block!important;width:100%!important;padding-left:0!important;padding-right:0!important}td.mh-content{padding:20px 16px!important}}</style></head>
<body style="margin:0;padding:0;background-color:${bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color:${bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${WIDTH}px">
<tr><td align="${align}" style="padding:0 8px 16px;font-family:${t.font}">${header}</td></tr>
<tr><td class="mh-content" style="background-color:#ffffff;border-radius:8px;padding:${CONTENT_PAD}px;font-family:${t.font};font-size:16px;line-height:1.6;color:#1b2430">{{ content }}</td></tr>
<tr><td align="center" style="padding:20px 12px;font-family:${t.font};font-size:12px;line-height:1.5;color:#5f6b7a">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { renderLayout, themeFrom, FONTS, CONTENT_WIDTH };
