'use strict';

/**
 * One-time upgrade from templates to Settings → Email design (runs at startup,
 * recorded in sync_state so it never runs twice):
 *
 *  1. Campaigns that already started keep exactly the frame they were sent
 *     with: their template's HTML is frozen into campaigns.layout_html.
 *  2. The default template's look (background, font, logo, heading colour,
 *     footer line) becomes the email design, for keys not set yet.
 *  3. Drafts written in the old visual/HTML editors become builder documents
 *     with one HTML block, so the builder is the only editor.
 *
 * Templates are not deleted (see migration 007).
 */
const { LEGACY_TEMPLATE } = require('../engine/render');
const { documentFromHtml } = require('../engine/blocks');
const { SETTINGS_SCHEMA } = require('./settings');

const KEY = 'email_design_upgrade';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Email design values derived from a builder template document. */
function designFromTemplate(doc) {
  const out = {};
  if (!doc || !Array.isArray(doc.blocks)) return out;
  const st = doc.settings || {};
  if (HEX.test(st.page_bg || '')) out.email_background = st.page_bg;
  if (st.font) out.email_font = st.font;
  const top = doc.blocks.slice(0, Math.max(0, doc.blocks.findIndex((b) => b.type === 'content')));
  const flat = (bs) => bs.flatMap((b) => (b.type === 'columns' ? (b.props?.columns || []).flat() : [b]));
  const logo = flat(top).find((b) => b.type === 'image' && b.props?.src);
  if (logo) {
    out.email_logo_url = logo.props.src;
    if (logo.props.align === 'center') out.email_header_align = 'center';
  }
  const heading = flat(top).find((b) => b.type === 'heading');
  if (heading && HEX.test(heading.props?.color || '')) out.email_heading_color = heading.props.color;
  if (heading?.props?.align === 'center' && !logo) out.email_header_align = 'center';
  const footer = doc.blocks.find((b) => b.type === 'footer');
  if (footer) {
    if (typeof footer.props?.text === 'string') out.email_footer_text = footer.props.text;
    if (footer.props?.prefs === false) out.email_show_preferences = false;
  }
  return out;
}

async function upgradeToEmailDesign(pool, settings, logger) {
  const done = await pool.query('SELECT 1 FROM portal.sync_state WHERE key = $1', [KEY]);
  if (done.rowCount) return;

  // 1. Freeze the frame of every campaign that already started.
  const frozen = await pool.query(
    `UPDATE portal.campaigns c
        SET layout_html = COALESCE((SELECT t.html FROM portal.templates t WHERE t.id = c.template_id),
                                   (SELECT t.html FROM portal.templates t WHERE t.is_default LIMIT 1), $1)
      WHERE c.status NOT IN ('draft', 'scheduled') AND c.layout_html IS NULL`, [LEGACY_TEMPLATE]);

  // 2. Carry the default template's look over, without overwriting anything already set.
  const { rows: tpl } = await pool.query(`SELECT body_json FROM portal.templates WHERE is_default AND editor = 'builder' LIMIT 1`);
  const wanted = designFromTemplate(tpl[0]?.body_json);
  const { rows: existing } = await pool.query(`SELECT key FROM portal.settings WHERE key LIKE 'email\\_%'`);
  const have = new Set(existing.map((r) => r.key));
  const applied = [];
  for (const [key, value] of Object.entries(wanted)) {
    if (have.has(key)) continue;
    if (!SETTINGS_SCHEMA.shape[key].safeParse(value).success) continue; // e.g. a relative logo address
    await settings.update({ [key]: value }, null);
    applied.push(key);
  }

  // 3. One editor: convert old visual/HTML drafts (sent campaigns are frozen and untouched).
  const { rows: legacy } = await pool.query(
    `SELECT id, body_html FROM portal.campaigns WHERE status IN ('draft', 'scheduled') AND (editor <> 'builder' OR body_json IS NULL)`);
  for (const c of legacy) {
    await pool.query(`UPDATE portal.campaigns SET editor = 'builder', body_json = $2, body_text = '' WHERE id = $1`,
      [c.id, documentFromHtml(c.body_html)]);
  }

  await pool.query(
    `INSERT INTO portal.sync_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    [KEY, JSON.stringify({ frozen: frozen.rowCount, applied, converted: legacy.length, at: new Date().toISOString() })]);
  logger?.info({ frozenCampaigns: frozen.rowCount, designKeys: applied, convertedDrafts: legacy.length }, 'upgraded templates to Settings → Email design');
}

module.exports = { upgradeToEmailDesign, designFromTemplate };
