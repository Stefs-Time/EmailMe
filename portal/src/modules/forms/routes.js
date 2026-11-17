'use strict';

/**
 * Sign-up forms.
 * Admin API (login):  GET/POST /api/forms, GET/PUT/DELETE /api/forms/:id, GET /api/forms/:id/submissions
 * Public (no login):  GET /f/:token  hosted page (?embed=1 for an iframe), POST /f/:token  sign up
 *
 * Bot protection: hidden honeypot field, signed render time (submissions faster
 * than 2.5 s or without our token are discarded silently), and per-IP rate limits.
 */
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { parse, notFound, validation } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { escapeHtml } = require('../../engine/render');
const { isValidEmail, normalizeEmail } = require('../../lib/email');
const { formBody, settingsSchema, renderToken, checkToken, signUp } = require('./service');

const id = z.coerce.number().int().positive();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formRoutes({ pool, settings }) {
  const r = express.Router();
  const shape = async (f) => {
    const base = (await settings.publicUrl()) || '';
    return { ...f, settings: settingsSchema.parse(f.settings || {}), url: `${base}/f/${f.token}` };
  };
  const checkLists = async (ids) => {
    const { rows } = await pool.query('SELECT id FROM portal.lists WHERE id = ANY($1::int[])', [ids]);
    if (rows.length !== new Set(ids).size) throw validation('One or more selected lists do not exist');
  };

  r.get('/', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT f.*, (SELECT COALESCE(ARRAY_AGG(l.name ORDER BY l.name), '{}') FROM portal.lists l WHERE l.id = ANY(f.list_ids)) AS list_names,
              COUNT(s.id) FILTER (WHERE s.outcome IN ('subscribed', 'confirmation_sent'))::int AS signups,
              COUNT(s.id) FILTER (WHERE s.outcome IN ('subscribed', 'confirmation_sent') AND s.created_at > NOW() - INTERVAL '30 days')::int AS signups_30d,
              MAX(s.created_at) FILTER (WHERE s.outcome IN ('subscribed', 'confirmation_sent')) AS last_signup
         FROM portal.forms f LEFT JOIN portal.form_submissions s ON s.form_id = f.id
        GROUP BY f.id ORDER BY f.created_at DESC`);
    res.json({ success: true, data: await Promise.all(rows.map(shape)) });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM portal.forms WHERE id = $1', [parse(id, req.params.id)]);
    if (!rows[0]) throw notFound('Form not found');
    res.json({ success: true, data: await shape(rows[0]) });
  });

  r.get('/:id/submissions', requirePermission('contacts:read'), async (req, res) => {
    const formId = parse(id, req.params.id);
    const { rows } = await pool.query(
      `SELECT s.id, s.outcome, s.created_at, c.id AS contact_id, c.email
         FROM portal.form_submissions s LEFT JOIN portal.contacts c ON c.id = s.contact_id
        WHERE s.form_id = $1 ORDER BY s.created_at DESC LIMIT 100`, [formId]);
    const { rows: totals } = await pool.query(
      'SELECT outcome, COUNT(*)::int AS n FROM portal.form_submissions WHERE form_id = $1 GROUP BY 1', [formId]);
    res.json({ success: true, data: rows, meta: { totals: Object.fromEntries(totals.map((t) => [t.outcome, t.n])) } });
  });

  r.post('/', requirePermission('lists:write'), async (req, res) => {
    const b = parse(formBody, req.body);
    await checkLists(b.list_ids);
    const { rows } = await pool.query(
      'INSERT INTO portal.forms (name, status, list_ids, settings, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [b.name, b.status, b.list_ids, b.settings, req.user.id]);
    await audit(pool, req, 'form.created', { details: { id: rows[0].id, name: b.name } });
    res.status(201).json({ success: true, data: await shape(rows[0]) });
  });

  r.put('/:id', requirePermission('lists:write'), async (req, res) => {
    const formId = parse(id, req.params.id);
    const b = parse(formBody, req.body);
    await checkLists(b.list_ids);
    const { rows } = await pool.query(
      'UPDATE portal.forms SET name = $2, status = $3, list_ids = $4, settings = $5, updated_at = NOW() WHERE id = $1 RETURNING *',
      [formId, b.name, b.status, b.list_ids, b.settings]);
    if (!rows[0]) throw notFound('Form not found');
    await audit(pool, req, 'form.updated', { details: { id: formId } });
    res.json({ success: true, data: await shape(rows[0]) });
  });

  r.delete('/:id', requirePermission('lists:write'), async (req, res) => {
    const formId = parse(id, req.params.id);
    const { rows } = await pool.query('DELETE FROM portal.forms WHERE id = $1 RETURNING name', [formId]);
    if (!rows[0]) throw notFound('Form not found');
    await audit(pool, req, 'form.deleted', { details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  return r;
}

// ---- Public form pages ------------------------------------------------------------
const field = (name, label, mode, value, type = 'text', autocomplete = '') => (mode === 'off' ? '' : `
  <div class="f-row"><label for="f-${name}">${escapeHtml(label)}${mode === 'required' ? ' <span aria-hidden="true">*</span>' : ''}</label>
  <input id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value || '')}" maxlength="120" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} ${mode === 'required' ? 'required aria-required="true"' : ''}></div>`);

function renderForm(res, { form, org, token, embed, values = {}, error = '', status = 200 }) {
  const s = form.settings;
  const nonce = crypto.randomBytes(12).toString('base64');
  res.status(status).type('html').set({
    'Cache-Control': 'no-store',
    // Forms are meant to be embedded on your website: allow framing, nothing else.
    'Content-Security-Policy': `default-src 'none'; style-src 'self' 'nonce-${nonce}'; img-src 'self' https: data:; form-action 'self' https:; frame-ancestors *; base-uri 'none'`,
  });
  res.removeHeader('X-Frame-Options');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(s.heading)} · ${escapeHtml(org)}</title><link rel="stylesheet" href="/css/public.css">
<style nonce="${nonce}">:root{--accent:${s.accent}}</style></head>
<body class="${embed ? 'embed' : ''}"><main class="box form-box">
${embed ? '' : `<div class="org">${escapeHtml(org)}</div>`}
<h1>${escapeHtml(s.heading)}</h1>${s.intro ? `<p>${escapeHtml(s.intro)}</p>` : ''}
${error ? `<p class="f-error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/f/${form.token}${embed ? '?embed=1' : ''}" novalidate>
  <div class="f-row"><label for="f-email">Email address <span aria-hidden="true">*</span></label>
  <input id="f-email" name="email" type="email" value="${escapeHtml(values.email || '')}" maxlength="254" autocomplete="email" required aria-required="true"></div>
  ${field('first_name', 'First name', s.fields.first_name, values.first_name, 'text', 'given-name')}
  ${field('last_name', 'Last name', s.fields.last_name, values.last_name, 'text', 'family-name')}
  ${field('company', 'Company', s.fields.company, values.company, 'text', 'organization')}
  <div class="f-hp" aria-hidden="true"><label for="f-website">Leave this empty</label><input id="f-website" name="website" type="text" tabindex="-1" autocomplete="off"></div>
  <input type="hidden" name="_t" value="${token}">
  <div class="f-row f-consent"><label><input type="checkbox" name="consent" value="yes" required aria-required="true"> ${escapeHtml(s.consent_text)}</label></div>
  <button type="submit" class="btn btn-accent">${escapeHtml(s.button_label)}</button>
  <p class="muted f-small">We'll only use your details as described. Every email has an unsubscribe link.</p>
</form></main></body></html>`);
}

function publicFormRoutes({ pool, settings, sessionSecret, logger }) {
  const r = express.Router();
  const secret = `form:${sessionSecret || 'mailharbor'}`;
  const postLimiter = rateLimit({ windowMs: 10 * 60000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (_req, res) => res.status(429).type('text').send('Too many sign-ups from this network. Please try again later.') });

  async function load(req, res) {
    const s = await settings.all();
    if (!UUID.test(req.params.token)) { res.status(404).type('text').send('Form not found'); return null; }
    const { rows } = await pool.query('SELECT * FROM portal.forms WHERE token = $1', [req.params.token]);
    const form = rows[0];
    if (!form || form.status !== 'active') {
      res.status(404).type('html').set('Cache-Control', 'no-store')
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Form closed</title><link rel="stylesheet" href="/css/public.css"></head><body><main class="box"><div class="org">${escapeHtml(s.org_name)}</div><h1>This sign-up form is closed</h1><p>Please contact ${escapeHtml(s.org_name)} directly.</p></main></body></html>`);
      return null;
    }
    form.settings = settingsSchema.parse(form.settings || {});
    return { form, org: s.org_name };
  }

  r.get('/f/:token', async (req, res) => {
    const x = await load(req, res);
    if (!x) return;
    renderForm(res, { ...x, token: renderToken(secret, x.form.id), embed: req.query.embed === '1' });
  });

  r.post('/f/:token', postLimiter, express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    const x = await load(req, res);
    if (!x) return;
    const { form, org } = x;
    const embed = req.query.embed === '1';
    const b = req.body || {};
    const values = { email: String(b.email || '').slice(0, 254), first_name: String(b.first_name || '').trim().slice(0, 120),
      last_name: String(b.last_name || '').trim().slice(0, 120), company: String(b.company || '').trim().slice(0, 120) };
    const success = () => {
      if (form.settings.redirect_url) return res.redirect(303, form.settings.redirect_url);
      return res.status(200).type('html').set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-ancestors *")
        .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Thank you · ${escapeHtml(org)}</title><link rel="stylesheet" href="/css/public.css"></head>
<body class="${embed ? 'embed' : ''}"><main class="box">${embed ? '' : `<div class="org">${escapeHtml(org)}</div>`}<h1>Thank you!</h1><p>${escapeHtml(form.settings.success_message)}</p></main></body></html>`);
    };

    // Bots: honeypot filled, missing/forged token or too fast → pretend success, store nothing personal.
    const tok = checkToken(secret, form.id, b._t);
    if (b.website || tok !== 'ok') {
      await pool.query(`INSERT INTO portal.form_submissions (form_id, outcome) VALUES ($1, 'rejected')`, [form.id]);
      return success();
    }
    const again = (error) => renderForm(res, { form, org, token: renderToken(secret, form.id), embed, values, error, status: 400 });
    const email = normalizeEmail(values.email);
    if (!isValidEmail(email)) return again('Please enter a valid email address.');
    for (const [k, label] of [['first_name', 'First name'], ['last_name', 'Last name'], ['company', 'Company']]) {
      if (form.settings.fields[k] === 'required' && !values[k]) return again(`${label} is required.`);
    }
    if (b.consent !== 'yes') return again('Please tick the box to confirm you want to receive our emails.');
    try {
      const base = (await settings.publicUrl()) || `${req.protocol}://${req.get('host')}`;
      await signUp(pool, { form, email, firstName: values.first_name, lastName: values.last_name, company: values.company,
        ip: req.ip, formUrl: `${base}/f/${form.token}` });
    } catch (err) {
      logger?.error({ err }, 'form sign-up failed');
      return again('Something went wrong. Please try again in a moment.');
    }
    // Same response whatever the outcome: never reveal whether an address is already known or suppressed.
    return success();
  });

  return r;
}

module.exports = { formRoutes, publicFormRoutes };
