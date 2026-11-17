'use strict';

/**
 * Campaigns: authoring, preview, test sends and the send lifecycle
 *   draft → scheduled → sending ⇄ paused → sent      (or cancelled)
 */
const express = require('express');
const { z } = require('zod');
const { parse, notFound, conflict, validation, badRequest } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { withTransaction } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { renderMessage, sanitize, DEFAULT_TEMPLATE } = require('../../engine/render');
const { renderDocument, documentSchema, starterDocument } = require('../../engine/blocks');
const { listSamples, getSample, SAMPLE_IDS } = require('../../engine/samples');
const { startCampaign } = require('../../engine/sender');
const { countEligible } = require('../../engine/audience');
const { isValidEmail, normalizeEmail } = require('../../lib/email');

const id = z.coerce.number().int().positive();
const EDITABLE = ['draft', 'scheduled'];

const campaignBody = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().max(300).default(''),
  preheader: z.string().trim().max(300).default(''),
  from_name: z.string().trim().max(120).default(''),
  from_email: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  reply_to: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  template_id: z.coerce.number().int().positive().nullable().optional(),
  editor: z.enum(['builder', 'visual', 'html']).optional(), // inferred from the content sent when omitted
  body_html: z.string().max(500000).default(''),
  body_json: z.unknown().optional(), // validated by documentSchema when editor = builder
  body_text: z.string().max(200000).default(''),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  list_ids: z.array(z.coerce.number().int().positive()).max(50).default([]),
});

const SAMPLE = { first_name: 'Thandi', last_name: 'Nkosi', email: 'thandi@example.co.za', company: 'Example (Pty) Ltd', attribs: { city: 'Johannesburg' } };

/**
 * Resolves the stored content: builder documents are validated and rendered on
 * the server (the browser's HTML is never trusted); other editors are sanitised.
 */
function inferEditor(body) {
  return body.editor ?? (body.body_json === undefined && body.body_html ? 'visual' : 'builder');
}

function resolveContent(editor, bodyJson, bodyHtml) {
  if (editor === 'builder') {
    const { doc, html } = renderDocument(parse(documentSchema, bodyJson ?? {}));
    return { html: sanitize(html), json: doc };
  }
  return { html: sanitize(bodyHtml), json: null };
}

async function loadCampaign(db, campaignId) {
  const { rows } = await db.query(
    `SELECT c.*, u.name AS created_by_name,
            COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('id', cl.list_id, 'name', cl.list_name) ORDER BY cl.list_name)
                        FROM portal.campaign_lists cl WHERE cl.campaign_id = c.id), '[]') AS lists
       FROM portal.campaigns c LEFT JOIN portal.users u ON u.id = c.created_by WHERE c.id = $1`, [campaignId]);
  if (!rows[0]) throw notFound('Campaign not found');
  return rows[0];
}

async function setLists(db, campaignId, listIds) {
  await db.query('DELETE FROM portal.campaign_lists WHERE campaign_id = $1', [campaignId]);
  if (!listIds.length) return;
  const { rows } = await db.query('SELECT id, name FROM portal.lists WHERE id = ANY($1::int[])', [listIds]);
  if (rows.length !== new Set(listIds).size) throw validation('One or more selected lists do not exist');
  for (const l of rows) {
    await db.query('INSERT INTO portal.campaign_lists (campaign_id, list_id, list_name) VALUES ($1, $2, $3)', [campaignId, l.id, l.name]);
  }
}

/** Everything that must be true before a campaign may be scheduled or sent. */
async function readinessProblems(pool, settings, c) {
  const s = await settings.all();
  const problems = [];
  if (!c.subject) problems.push('Add a subject line.');
  if (!(c.from_email || s.from_email)) problems.push('Set a sender address (campaign or Settings → Sending).');
  if (!c.lists.length) problems.push('Choose at least one list.');
  const stripped = c.body_html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (!stripped && !/<img\s/i.test(c.body_html)) problems.push('Write the email content.');
  if (c.editor === 'builder' && c.body_json) {
    const all = (c.body_json.blocks || []).flatMap((b) => (b.type === 'columns' ? b.props.columns.flat() : [b]));
    if (all.some((b) => b.type === 'button' && b.props.label?.trim() && !b.props.url)) problems.push('A button has no link: select it and add a web address.');
    if (all.some((b) => b.type === 'image' && b.props.src && !b.props.alt?.trim())) problems.push('An image has no description (alt text) for people who cannot see it.');
  }
  if (!(await settings.publicUrl())) problems.push('Set the public URL (Settings → General) so unsubscribe links work.');
  if (!s.org_address) problems.push('Add your organisation\'s postal address (Settings → General); it is shown in every email footer.');
  if (c.lists.length && !(await countEligible(pool, c.lists.map((l) => l.id)))) problems.push('The selected lists have no eligible recipients.');
  return problems;
}

function campaignRoutes({ pool, settings, worker }) {
  const r = express.Router();

  r.get('/', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({
      page: z.coerce.number().int().min(1).default(1),
      per_page: z.coerce.number().int().min(1).max(100).default(20),
      q: z.string().trim().max(200).optional(),
      status: z.enum(['draft', 'scheduled', 'sending', 'paused', 'cancelled', 'sent']).optional(),
    }), req.query);
    const params = [];
    const where = [];
    if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(c.name ILIKE $${params.length} OR c.subject ILIKE $${params.length})`); }
    if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.subject, c.status, c.send_at, c.started_at, c.finished_at, c.created_at, c.updated_at, c.pause_reason,
              COALESCE((SELECT ARRAY_AGG(cl.list_name ORDER BY cl.list_name) FROM portal.campaign_lists cl WHERE cl.campaign_id = c.id), '{}') AS lists,
              (SELECT COUNT(*)::int FROM portal.messages m WHERE m.campaign_id = c.id AND m.kind = 'campaign') AS targeted,
              (SELECT COUNT(*)::int FROM portal.messages m WHERE m.campaign_id = c.id AND m.kind = 'campaign' AND m.status = 'sent') AS sent,
              COUNT(*) OVER() AS total
         FROM portal.campaigns c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(c.started_at, c.send_at, c.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x), meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page } });
  });

  /** Ready-made designs for the "new campaign" gallery (defined before /:id). */
  r.get('/samples', requirePermission('contacts:read'), (_req, res) => {
    res.json({ success: true, data: listSamples() });
  });
  r.get('/samples/:sample', requirePermission('contacts:read'), (req, res) => {
    const sample = getSample(String(req.params.sample));
    if (!sample) throw notFound('Sample not found');
    res.json({ success: true, data: sample });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    const c = await loadCampaign(pool, parse(id, req.params.id));
    const eligible = await countEligible(pool, c.lists.map((l) => l.id));
    const problems = EDITABLE.includes(c.status) ? await readinessProblems(pool, settings, c) : [];
    res.json({ success: true, data: { ...c, eligible, problems } });
  });

  r.post('/', requirePermission('campaigns:write'), async (req, res) => {
    const body = parse(campaignBody.partial({ name: true }).extend({
      name: z.string().trim().min(1).max(200).default('Untitled campaign'),
      sample: z.enum(SAMPLE_IDS).optional(), // start from a ready-made design
    }), req.body);
    if (body.sample) {
      const sample = getSample(body.sample);
      body.editor = 'builder';
      body.body_json = sample.doc;
      body.subject ||= sample.subject;
      body.preheader ||= sample.preheader;
    }
    const s = await settings.all();
    const { rows: tpl } = await pool.query('SELECT id FROM portal.templates WHERE is_default LIMIT 1');
    const editor = inferEditor(body);
    const content = resolveContent(editor, body.body_json ?? starterDocument(), body.body_html || '<p>Hello {{ first_name | "there" }},</p><p></p>');
    const created = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO portal.campaigns (name, subject, preheader, from_name, from_email, reply_to, template_id, editor, body_html, body_text,
                                       track_opens, track_clicks, created_by, body_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [body.name, body.subject || '', body.preheader || '', body.from_name || s.from_name, body.from_email || s.from_email,
          body.reply_to || s.reply_to, body.template_id ?? tpl[0]?.id ?? null, editor,
          content.html, body.body_text || '',
          body.track_opens ?? s.track_opens, body.track_clicks ?? s.track_clicks, req.user.id, content.json]);
      await setLists(db, rows[0].id, body.list_ids || []);
      await audit(db, req, 'campaign.created', { targetType: 'campaign', targetId: rows[0].id, details: { name: body.name } });
      return rows[0].id;
    });
    res.status(201).json({ success: true, data: await loadCampaign(pool, created) });
  });

  r.put('/:id', requirePermission('campaigns:write'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const body = parse(campaignBody, req.body);
    body.editor = inferEditor(body);
    const content = resolveContent(body.editor, body.body_json, body.body_html);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT status FROM portal.campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
      if (!rows[0]) throw notFound('Campaign not found');
      if (!EDITABLE.includes(rows[0].status)) throw conflict(`A ${rows[0].status} campaign can no longer be edited. Duplicate it to send a new version.`);
      await db.query(
        `UPDATE portal.campaigns SET name=$2, subject=$3, preheader=$4, from_name=$5, from_email=$6, reply_to=$7, template_id=$8,
                editor=$9, body_html=$10, body_text=$11, track_opens=$12, track_clicks=$13, body_json=$14, updated_at=NOW() WHERE id=$1`,
        [campaignId, body.name, body.subject, body.preheader, body.from_name, body.from_email, body.reply_to, body.template_id ?? null,
          body.editor, content.html, body.body_text, body.track_opens, body.track_clicks, content.json]);
      await setLists(db, campaignId, body.list_ids);
    });
    res.json({ success: true, data: await loadCampaign(pool, campaignId) });
  });

  r.post('/:id/duplicate', requirePermission('campaigns:write'), async (req, res) => {
    const src = await loadCampaign(pool, parse(id, req.params.id));
    const newId = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO portal.campaigns (name, subject, preheader, from_name, from_email, reply_to, template_id, editor, body_html, body_text,
                                       track_opens, track_clicks, created_by, body_json)
         SELECT 'Copy of ' || name, subject, preheader, from_name, from_email, reply_to, template_id, editor, body_html, body_text,
                track_opens, track_clicks, $2, body_json FROM portal.campaigns WHERE id = $1 RETURNING id`, [src.id, req.user.id]);
      await setLists(db, rows[0].id, src.lists.map((l) => l.id).filter(Boolean));
      await audit(db, req, 'campaign.duplicated', { targetType: 'campaign', targetId: rows[0].id, details: { from: src.id } });
      return rows[0].id;
    });
    res.status(201).json({ success: true, data: { id: newId } });
  });

  r.delete('/:id', requirePermission('campaigns:write'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const { rows } = await pool.query(`DELETE FROM portal.campaigns WHERE id = $1 AND status = 'draft' RETURNING name`, [campaignId]);
    if (!rows[0]) throw conflict('Only draft campaigns can be deleted (sent campaigns are kept for reporting)');
    await audit(pool, req, 'campaign.deleted', { targetType: 'campaign', targetId: campaignId, details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  /** Rendered preview with sample data. Served sandboxed: no scripts, no same-origin access. */
  r.get('/:id/preview', requirePermission('contacts:read'), async (req, res) => {
    const c = await loadCampaign(pool, parse(id, req.params.id));
    const s = await settings.all();
    const { rows } = await pool.query(
      `SELECT html FROM portal.templates WHERE ${c.template_id ? 'id = $1' : 'is_default'} LIMIT 1`, c.template_id ? [c.template_id] : []);
    const msg = renderMessage({ campaign: { ...c, track_opens: false, track_clicks: false }, templateHtml: rows[0]?.html || DEFAULT_TEMPLATE,
      contact: SAMPLE, token: '00000000-0000-0000-0000-000000000000', settings: s, publicUrl: (await settings.publicUrl()) || 'https://example.invalid', isTest: true });
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:");
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(req.query.format === 'text' ? `<pre style="white-space:pre-wrap;font:14px/1.5 monospace;padding:16px">${msg.text.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))}</pre>` : msg.html);
  });

  r.post('/:id/test', requirePermission('campaigns:write'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const body = parse(z.object({ emails: z.array(z.string().trim()).min(1).max(5) }), req.body);
    const emails = body.emails.map(normalizeEmail);
    const bad = emails.filter((e) => !isValidEmail(e));
    if (bad.length) throw validation(`Invalid address: ${bad.join(', ')}`);
    await loadCampaign(pool, campaignId);
    if (!(await settings.publicUrl())) throw badRequest('Set the public URL in Settings → General first.');
    for (const e of emails) {
      await pool.query(
        `INSERT INTO portal.messages (kind, campaign_id, email, payload) VALUES ('test', $1, $2, $3)`,
        [campaignId, e, { sample: { ...SAMPLE, email: e } }]);
    }
    await audit(pool, req, 'campaign.test_sent', { targetType: 'campaign', targetId: campaignId, details: { count: emails.length } });
    res.status(202).json({ success: true, data: { queued: emails.length } });
  });

  r.post('/:id/schedule', requirePermission('campaigns:send'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const body = parse(z.object({ send_at: z.coerce.date() }), req.body);
    if (body.send_at.getTime() < Date.now() - 60000) throw validation('Choose a time in the future');
    const c = await loadCampaign(pool, campaignId);
    if (!EDITABLE.includes(c.status)) throw conflict(`A ${c.status} campaign cannot be scheduled`);
    const problems = await readinessProblems(pool, settings, c);
    if (problems.length) throw validation('This campaign is not ready to send', problems.map((m) => ({ message: m })));
    await pool.query(`UPDATE portal.campaigns SET status = 'scheduled', send_at = $2, updated_at = NOW() WHERE id = $1`, [campaignId, body.send_at]);
    await audit(pool, req, 'campaign.scheduled', { targetType: 'campaign', targetId: campaignId, details: { send_at: body.send_at } });
    res.json({ success: true, data: await loadCampaign(pool, campaignId) });
  });

  r.post('/:id/unschedule', requirePermission('campaigns:send'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const { rowCount } = await pool.query(`UPDATE portal.campaigns SET status = 'draft', send_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'scheduled'`, [campaignId]);
    if (!rowCount) throw conflict('Only a scheduled campaign can be unscheduled');
    await audit(pool, req, 'campaign.unscheduled', { targetType: 'campaign', targetId: campaignId });
    res.json({ success: true, data: await loadCampaign(pool, campaignId) });
  });

  r.post('/:id/send', requirePermission('campaigns:send'), async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const c = await loadCampaign(pool, campaignId);
    if (!EDITABLE.includes(c.status)) throw conflict(`A ${c.status} campaign cannot be sent`);
    const problems = await readinessProblems(pool, settings, c);
    if (problems.length) throw validation('This campaign is not ready to send', problems.map((m) => ({ message: m })));
    const n = await startCampaign(pool, campaignId);
    if (n === null) throw conflict('The campaign was already started');
    await audit(pool, req, 'campaign.sent', { targetType: 'campaign', targetId: campaignId, details: { recipients: n } });
    res.json({ success: true, data: { recipients: n } });
  });

  const transition = (action, from, to, extra = '') => async (req, res) => {
    const campaignId = parse(id, req.params.id);
    const { rowCount } = await pool.query(
      `UPDATE portal.campaigns SET status = $3, ${extra} updated_at = NOW() WHERE id = $1 AND status = ANY($2::text[])`,
      [campaignId, from, to]);
    if (!rowCount) throw conflict(`This campaign cannot be ${action} in its current state`);
    if (to === 'cancelled') {
      await pool.query(`UPDATE portal.messages SET status = 'cancelled', updated_at = NOW() WHERE campaign_id = $1 AND status = 'queued'`, [campaignId]);
      await pool.query(`UPDATE portal.campaigns SET finished_at = NOW() WHERE id = $1`, [campaignId]);
    }
    await audit(pool, req, `campaign.${action}`, { targetType: 'campaign', targetId: campaignId });
    res.json({ success: true, data: await loadCampaign(pool, campaignId) });
  };
  r.post('/:id/pause', requirePermission('campaigns:send'), transition('paused', ['sending'], 'paused', `pause_reason = 'Paused by a user',`));
  r.post('/:id/resume', requirePermission('campaigns:send'), transition('resumed', ['paused'], 'sending', 'pause_reason = NULL,'));
  r.post('/:id/cancel', requirePermission('campaigns:send'), transition('cancelled', ['sending', 'paused', 'scheduled'], 'cancelled'));

  r.get('/:id/estimate', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({ list_ids: z.string().default('') }), req.query);
    const listIds = q.list_ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    res.json({ success: true, data: { eligible: await countEligible(pool, listIds) } });
  });

  void worker;
  return r;
}

module.exports = { campaignRoutes, SAMPLE };
