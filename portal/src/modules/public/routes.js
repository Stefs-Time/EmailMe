'use strict';

/**
 * Public endpoints used by recipients and providers (no login):
 *   GET/POST /u/:token          unsubscribe (confirmation page + RFC 8058 one-click)
 *   GET      /v/:token          view the email in a browser
 *   GET      /t/o/:token.gif    open pixel
 *   GET      /t/c/:token/:link  click redirect (only to URLs stored for that campaign)
 *   GET/POST /s/confirm/:token  double opt-in confirmation
 *   POST     /webhooks/bounce   provider bounce/complaint events (token required)
 *
 * GET never changes state (link scanners follow GET links); actions need POST.
 */
const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { withTransaction } = require('../../db/pool');
const { escapeHtml, renderMessage, DEFAULT_TEMPLATE } = require('../../engine/render');
const { unsubscribeContact } = require('../contacts/service');
const { processBounce } = require('../../engine/bounces');
const { recipientEvent } = require('../../lib/audit');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function page(res, { title, org, body, status = 200 }) {
  res.status(status).type('html').setHeader('Cache-Control', 'no-store');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · ${escapeHtml(org)}</title><link rel="stylesheet" href="/css/public.css"></head>
<body><main class="box"><div class="org">${escapeHtml(org)}</div>${body}</main></body></html>`);
}

const maskEmail = (e) => String(e || '').replace(/^(.)(.*)(@.*)$/, (m, a, b, c) => `${a}${'•'.repeat(Math.min(b.length, 6))}${c}`);

function publicRoutes({ pool, settings, logger }) {
  const r = express.Router();
  r.use(rateLimit({ windowMs: 60000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
  r.use(express.urlencoded({ extended: false, limit: '10kb' }));

  async function messageByToken(token) {
    if (!UUID.test(token)) return null;
    const { rows } = await pool.query(
      `SELECT m.id, m.uuid, m.kind, m.campaign_id, m.contact_id, m.email, c.email AS contact_email
         FROM portal.messages m LEFT JOIN portal.contacts c ON c.id = m.contact_id WHERE m.uuid = $1`, [token]);
    return rows[0] || null;
  }

  // ---- Unsubscribe -------------------------------------------------------
  r.get('/u/:token', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    if (!m || !m.contact_id) {
      return page(res, { title: 'Link not valid', org: s.org_name, status: 404,
        body: '<h1>This link is no longer valid</h1><p>If you want to stop receiving emails, reply to any email and ask to be removed.</p>' });
    }
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM portal.suppressions s JOIN portal.contacts c ON c.email_hash = s.email_hash
                       WHERE c.id = $1 AND s.lifted_at IS NULL AND s.reason = 'unsubscribe') AS done`, [m.contact_id]);
    if (rows[0].done) {
      return page(res, { title: 'Unsubscribed', org: s.org_name, body: `<h1>You are unsubscribed</h1><p><strong>${escapeHtml(maskEmail(m.contact_email))}</strong> will not receive marketing emails from ${escapeHtml(s.org_name)}.</p>` });
    }
    return page(res, { title: 'Unsubscribe', org: s.org_name, body: `
      <h1>Unsubscribe?</h1>
      <p>Stop all marketing emails from <strong>${escapeHtml(s.org_name)}</strong> to <strong>${escapeHtml(maskEmail(m.contact_email))}</strong>.</p>
      <form method="post"><button type="submit" class="btn">Unsubscribe me</button></form>
      <p class="muted">You will not need to log in. This takes effect immediately.</p>` });
  });

  r.post('/u/:token', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
    if (!m || !m.contact_id) {
      if (oneClick) return res.status(404).end();
      return page(res, { title: 'Link not valid', org: s.org_name, status: 404, body: '<h1>This link is no longer valid</h1>' });
    }
    let listIds = null;
    if (!s.global_unsubscribe && m.campaign_id) {
      const { rows } = await pool.query('SELECT list_id FROM portal.campaign_lists WHERE campaign_id = $1 AND list_id IS NOT NULL', [m.campaign_id]);
      listIds = rows.map((x) => x.list_id);
    }
    await withTransaction(pool, (db) => unsubscribeContact(db, {
      contactId: m.contact_id, campaignId: m.campaign_id, listIds, global: s.global_unsubscribe,
      actorType: 'recipient', source: oneClick ? 'one-click' : 'unsubscribe-link',
    }));
    if (oneClick) return res.status(200).type('text').send('Unsubscribed');
    return page(res, { title: 'Unsubscribed', org: s.org_name, body: `<h1>You have been unsubscribed</h1>
      <p>${escapeHtml(maskEmail(m.contact_email))} will no longer receive ${s.global_unsubscribe ? 'marketing emails' : 'emails from these lists'} from ${escapeHtml(s.org_name)}.</p>
      <p class="muted">Unsubscribed by mistake? Contact ${escapeHtml(s.org_name)}${s.reply_to ? ` at ${escapeHtml(s.reply_to)}` : ''}.</p>` });
  });

  // ---- View in browser ---------------------------------------------------
  r.get('/v/:token', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    if (!m || !m.campaign_id) return page(res, { title: 'Not found', org: s.org_name, status: 404, body: '<h1>This email is no longer available</h1>' });
    const { rows } = await pool.query(
      `SELECT c.*, t.html AS template_html FROM portal.campaigns c LEFT JOIN portal.templates t ON t.id = c.template_id WHERE c.id = $1`, [m.campaign_id]);
    const { rows: contact } = await pool.query('SELECT * FROM portal.contacts WHERE id = $1', [m.contact_id]);
    if (!rows[0]) return page(res, { title: 'Not found', org: s.org_name, status: 404, body: '<h1>This email is no longer available</h1>' });
    const msg = renderMessage({ campaign: { ...rows[0], track_opens: false, track_clicks: false }, templateHtml: rows[0].template_html || DEFAULT_TEMPLATE,
      contact: contact[0] || { email: m.email }, token: m.uuid, settings: s, publicUrl: await settings.publicUrl() });
    res.setHeader('Content-Security-Policy', "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:");
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(msg.html);
  });

  // ---- Tracking ----------------------------------------------------------
  r.get('/t/o/:file', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.type('gif').send(GIF);
    const token = req.params.file.replace(/\.gif$/, '');
    try {
      const m = await messageByToken(token);
      if (m?.campaign_id && m.kind === 'campaign') {
        await pool.query(`INSERT INTO portal.tracking_events (kind, message_id, campaign_id, contact_id) VALUES ('open', $1, $2, $3)`,
          [m.id, m.campaign_id, m.contact_id]);
        if (m.contact_id) await pool.query('UPDATE portal.contacts SET last_open_at = NOW() WHERE id = $1', [m.contact_id]);
      }
    } catch (err) {
      logger.warn({ err: err.message }, 'open tracking failed');
    }
  });

  r.get('/t/c/:token/:linkId', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    const linkId = Number(req.params.linkId);
    if (!m || !Number.isInteger(linkId)) return page(res, { title: 'Link not found', org: s.org_name, status: 404, body: '<h1>This link is not valid</h1>' });
    const { rows } = await pool.query('SELECT url FROM portal.links WHERE id = $1 AND campaign_id = $2', [linkId, m.campaign_id]);
    if (!rows[0]) return page(res, { title: 'Link not found', org: s.org_name, status: 404, body: '<h1>This link is not valid</h1>' });
    res.redirect(302, rows[0].url);
    try {
      await pool.query(`INSERT INTO portal.tracking_events (kind, message_id, campaign_id, contact_id, link_id) VALUES ('click', $1, $2, $3, $4)`,
        [m.id, m.campaign_id, m.contact_id, linkId]);
      // A click proves the mailbox works: clear earlier temporary failures.
      if (m.contact_id) await pool.query('UPDATE portal.contacts SET last_click_at = NOW(), soft_bounces = 0 WHERE id = $1', [m.contact_id]);
    } catch (err) {
      logger.warn({ err: err.message }, 'click tracking failed');
    }
  });

  // ---- Double opt-in -----------------------------------------------------
  r.get('/s/confirm/:token', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    if (!m || m.kind !== 'optin' || !m.contact_id) return page(res, { title: 'Link not valid', org: s.org_name, status: 404, body: '<h1>This confirmation link is not valid</h1>' });
    return page(res, { title: 'Confirm subscription', org: s.org_name, body: `<h1>Confirm your subscription</h1>
      <p>Confirm that <strong>${escapeHtml(maskEmail(m.contact_email))}</strong> wants to receive emails from ${escapeHtml(s.org_name)}.</p>
      <form method="post"><button type="submit" class="btn">Yes, confirm</button></form>` });
  });

  r.post('/s/confirm/:token', async (req, res) => {
    const s = await settings.all();
    const m = await messageByToken(req.params.token);
    if (!m || m.kind !== 'optin' || !m.contact_id) return page(res, { title: 'Link not valid', org: s.org_name, status: 404, body: '<h1>This confirmation link is not valid</h1>' });
    const n = await withTransaction(pool, async (db) => {
      const { rows } = await db.query('SELECT email, email_hash FROM portal.contacts WHERE id = $1', [m.contact_id]);
      const sup = await db.query('SELECT 1 FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL', [rows[0].email_hash]);
      if (sup.rowCount) return -1;
      const u = await db.query(
        `UPDATE portal.list_members m SET status = 'subscribed', confirmed_at = NOW(), updated_at = NOW()
           FROM portal.lists l WHERE l.id = m.list_id AND l.optin = 'double' AND m.contact_id = $1 AND m.status = 'unconfirmed'`, [m.contact_id]);
      if (u.rowCount) {
        await db.query(
          `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, source, evidence)
           VALUES ($1, $2, $3, 'reconfirmed', 'double_opt_in', 'confirmation-link', $4)`,
          [m.contact_id, rows[0].email, rows[0].email_hash, `Confirmed via link at ${new Date().toISOString()} from ${req.ip}`]);
        await db.query(`UPDATE portal.contacts SET consent = consent || '{"method":"double_opt_in","status":"granted"}'::jsonb WHERE id = $1`, [m.contact_id]);
        await recipientEvent(db, { contactId: m.contact_id, emailHash: rows[0].email_hash, type: 'optin_confirmed', to: 'active', actorType: 'recipient' });
      }
      return u.rowCount;
    });
    if (n === -1) return page(res, { title: 'Not available', org: s.org_name, body: `<h1>We can't subscribe this address</h1><p>Please contact ${escapeHtml(s.org_name)} directly.</p>` });
    return page(res, { title: 'Confirmed', org: s.org_name, body: `<h1>Thank you!</h1><p>Your subscription to ${escapeHtml(s.org_name)} is confirmed.</p>` });
  });

  // ---- Provider webhook --------------------------------------------------
  /**
   * POST /webhooks/bounce?token=… with JSON (one event or an array):
   *   { "email": "x@y.com", "type": "hard|soft|complaint", "reason": "550 5.1.1 …", "message_id": "<X-MailHarbor-ID>", "id": "provider event id" }
   */
  r.post('/webhooks/bounce', express.json({ limit: '1mb' }), async (req, res) => {
    const s = await settings.all();
    const given = Buffer.from(String(req.query.token || req.get('x-webhook-token') || ''));
    const want = Buffer.from(s.webhook_token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return res.status(401).json({ success: false });
    const events = (Array.isArray(req.body) ? req.body : [req.body]).slice(0, 500);
    const out = [];
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      const type = ['hard', 'soft', 'complaint'].includes(e.type) ? e.type : undefined;
      out.push((await processBounce(pool, settings, {
        source: 'webhook', sourceRef: e.id ? String(e.id).slice(0, 200) : null, token: e.message_id, email: e.email,
        hint: type, text: [e.code, e.reason].filter(Boolean).join(' ').slice(0, 1000) || (type === 'complaint' ? 'complaint' : ''),
      })).status);
    }
    res.json({ success: true, data: { received: events.length, results: out } });
  });

  return r;
}

module.exports = { publicRoutes };
