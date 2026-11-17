'use strict';

/**
 * UTM tagging for Google Analytics (and any analytics that reads utm_*).
 * Adds utm_source / utm_medium / utm_campaign to web links in campaign HTML.
 *
 * Skipped: links that already carry any utm_* parameter, personalised links
 * ({{ tags }}), mailto:/tel:, MailHarbor's own pages, and, when a domain list
 * is configured, links to other sites.
 */

const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'campaign';

const cleanValue = (s, fallback) => (String(s || '').trim().replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').slice(0, 80) || fallback);

/** Parses "acme.co.za, shop.acme.co.za" into a list of lower-case domains. */
function parseDomains(text) {
  return String(text || '').split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
}

/**
 * The UTM parameters for a campaign, or null when tagging is off.
 * @param {object} campaign  needs name, utm_enabled, utm_campaign
 * @param {object} s         settings (utm_enabled, utm_source, utm_medium, utm_domains)
 */
function utmParamsFor(campaign, s) {
  if (!s?.utm_enabled || campaign?.utm_enabled === false) return null;
  return {
    source: cleanValue(s.utm_source, 'mailharbor'),
    medium: cleanValue(s.utm_medium, 'email'),
    campaign: campaign.utm_campaign?.trim() ? cleanValue(campaign.utm_campaign, 'campaign') : slugify(campaign.name),
    domains: parseDomains(s.utm_domains),
  };
}

function domainMatches(host, domains) {
  if (!domains.length) return true;
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Adds the parameters to qualifying links in HTML (href="https://…"). */
function addUtm(html, params, publicUrl = '') {
  if (!params) return html;
  const own = publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  return String(html || '').replace(/(<a\s[^>]*?href=")(https?:\/\/[^"]+)(")/gi, (m, pre, href, post) => {
    if (href.includes('{{') || (own && href.startsWith(own))) return m;
    let u;
    try { u = new URL(href.replace(/&amp;/g, '&')); } catch { return m; }
    if ([...u.searchParams.keys()].some((k) => k.toLowerCase().startsWith('utm_'))) return m;
    if (!domainMatches(u.hostname, params.domains)) return m;
    u.searchParams.set('utm_source', params.source);
    u.searchParams.set('utm_medium', params.medium);
    u.searchParams.set('utm_campaign', params.campaign);
    return `${pre}${u.toString().replace(/&/g, '&amp;')}${post}`;
  });
}

module.exports = { addUtm, utmParamsFor, slugify, parseDomains };
