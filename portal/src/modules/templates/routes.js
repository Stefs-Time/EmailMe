'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { parse, notFound, conflict, validation } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { withTransaction } = require('../../db/pool');
const { audit } = require('../../lib/audit');
const { sanitize, renderMessage, DEFAULT_TEMPLATE } = require('../../engine/render');
const { SAMPLE } = require('../campaigns/routes');

const id = z.coerce.number().int().positive();
const body = z.object({
  name: z.string().trim().min(1).max(120),
  html: z.string().min(1).max(300000).refine((h) => /\{\{\s*content\s*\}\}/.test(h), 'The template must contain {{ content }} where the email body goes'),
});

/** Creates the built-in template on first start. */
async function ensureDefaultTemplate(pool) {
  const { rowCount } = await pool.query('SELECT 1 FROM portal.templates LIMIT 1');
  if (!rowCount) {
    await pool.query(`INSERT INTO portal.templates (name, html, is_default) VALUES ('MailHarbor standard', $1, TRUE)`, [DEFAULT_TEMPLATE]);
  }
}

function templateRoutes({ pool, settings }) {
  const r = express.Router();

  r.get('/', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.is_default, t.created_at, t.updated_at,
              (SELECT COUNT(*)::int FROM portal.campaigns c WHERE c.template_id = t.id) AS used_by
         FROM portal.templates t ORDER BY t.is_default DESC, t.name`);
    res.json({ success: true, data: rows });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM portal.templates WHERE id = $1', [parse(id, req.params.id)]);
    if (!rows[0]) throw notFound('Template not found');
    res.json({ success: true, data: rows[0] });
  });

  r.post('/', requirePermission('templates:write'), async (req, res) => {
    const b = parse(body, req.body);
    const { rows } = await pool.query('INSERT INTO portal.templates (name, html) VALUES ($1, $2) RETURNING id', [b.name, sanitize(b.html)]);
    await audit(pool, req, 'template.created', { targetType: 'template', targetId: rows[0].id, details: { name: b.name } });
    res.status(201).json({ success: true, data: { id: rows[0].id } });
  });

  r.put('/:id', requirePermission('templates:write'), async (req, res) => {
    const tid = parse(id, req.params.id);
    const b = parse(body, req.body);
    const { rowCount } = await pool.query('UPDATE portal.templates SET name = $2, html = $3, updated_at = NOW() WHERE id = $1', [tid, b.name, sanitize(b.html)]);
    if (!rowCount) throw notFound('Template not found');
    await audit(pool, req, 'template.updated', { targetType: 'template', targetId: tid });
    res.json({ success: true, data: { id: tid } });
  });

  r.post('/:id/default', requirePermission('templates:write'), async (req, res) => {
    const tid = parse(id, req.params.id);
    await withTransaction(pool, async (db) => {
      await db.query('UPDATE portal.templates SET is_default = FALSE WHERE is_default');
      const { rowCount } = await db.query('UPDATE portal.templates SET is_default = TRUE WHERE id = $1', [tid]);
      if (!rowCount) throw notFound('Template not found');
    });
    await audit(pool, req, 'template.default_set', { targetType: 'template', targetId: tid });
    res.json({ success: true, data: {} });
  });

  r.delete('/:id', requirePermission('templates:write'), async (req, res) => {
    const tid = parse(id, req.params.id);
    const { rows } = await pool.query('SELECT is_default FROM portal.templates WHERE id = $1', [tid]);
    if (!rows[0]) throw notFound('Template not found');
    if (rows[0].is_default) throw conflict('The default template cannot be deleted. Make another template the default first.');
    const busy = await pool.query(`SELECT 1 FROM portal.campaigns WHERE template_id = $1 AND status IN ('draft', 'scheduled', 'sending', 'paused')`, [tid]);
    if (busy.rowCount) throw conflict('This template is used by a campaign that has not finished');
    await pool.query('DELETE FROM portal.templates WHERE id = $1', [tid]);
    await audit(pool, req, 'template.deleted', { targetType: 'template', targetId: tid });
    res.json({ success: true, data: {} });
  });

  /**
   * Preview of unsaved template HTML. Step 1 (POST, CSRF-protected) stores the
   * draft briefly; step 2 (GET) renders it sandboxed inside an iframe.
   */
  const drafts = new Map();
  r.post('/preview', requirePermission('contacts:read'), async (req, res) => {
    const b = parse(z.object({ html: z.string().max(300000) }), req.body);
    if (!/\{\{\s*content\s*\}\}/.test(b.html)) throw validation('The template must contain {{ content }}');
    const key = crypto.randomBytes(12).toString('hex');
    drafts.set(key, { html: sanitize(b.html), user: req.user.id, at: Date.now() });
    for (const [k, v] of drafts) if (Date.now() - v.at > 10 * 60000) drafts.delete(k);
    res.json({ success: true, data: { id: key } });
  });

  r.get('/preview/:key', requirePermission('contacts:read'), async (req, res) => {
    const d = drafts.get(String(req.params.key));
    if (!d || d.user !== req.user.id) throw notFound('Preview expired');
    const s = await settings.all();
    const msg = renderMessage({
      campaign: { subject: 'Template preview', preheader: '', body_html: '<h2>Sample heading</h2><p>Hello {{ first_name }}, this is where your campaign content appears.</p><p class="mh-align-center"><a href="https://example.com" class="mh-button">A sample button</a></p>', body_text: '', track_opens: false, track_clicks: false },
      templateHtml: d.html, contact: SAMPLE, token: '00000000-0000-0000-0000-000000000000', settings: s,
      publicUrl: (await settings.publicUrl()) || 'https://example.invalid', isTest: true,
    });
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:");
    res.type('html').send(msg.html);
  });

  return r;
}

module.exports = { templateRoutes, ensureDefaultTemplate };
