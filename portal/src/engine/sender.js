'use strict';

/**
 * Sending engine.
 *
 * Every email is a row in portal.messages. Workers claim queued rows with
 * FOR UPDATE SKIP LOCKED (safe with several replicas), re-check eligibility,
 * render, send through SMTP and record the outcome:
 *   success            -> sent
 *   5xx for recipient  -> failed + bounce processed immediately (source smtp)
 *   4xx / transient    -> retried after 5, 30, 120 minutes, then soft bounce
 *   SMTP unusable      -> message re-queued, campaigns paused, critical alert
 */
const { renderMessage, DEFAULT_TEMPLATE, escapeHtml } = require('./render');
const { addUtm, utmParamsFor } = require('./utm');
const { classifySendError } = require('./mailer');
const { processBounce } = require('./bounces');
const { NOT_SUPPRESSED, stillEligible, segmentClause } = require('./audience');
const { raiseAlert, resolveAlert, recipientEvent } = require('../lib/audit');

const RETRY_MINUTES = [5, 30, 120];

/** Extracts trackable links from campaign HTML. */
function extractLinks(html) {
  const out = new Set();
  const re = /<a\s[^>]*?href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html || ''))) if (!m[1].includes('{{')) out.add(m[1].replace(/&amp;/g, '&'));
  return [...out];
}

/**
 * Starts a draft or scheduled campaign: freezes the recipient list (one
 * message per eligible contact) and switches it to "sending".
 * Returns the number of recipients, or null if it was not startable.
 */
async function startCampaign(pool, campaignId, settings = null) {
  // Freeze the UTM parameters so link tracking matches what is sent, even if Settings change mid-send.
  const s = settings ? await settings.all() : null;
  const publicUrl = settings ? await settings.publicUrl() : '';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.id, c.name, c.body_html, c.status, c.utm_enabled, c.utm_campaign, c.segment_id, sg.name AS seg_name, sg.rules AS seg_rules
         FROM portal.campaigns c LEFT JOIN portal.segments sg ON sg.id = c.segment_id WHERE c.id = $1 FOR UPDATE OF c`, [campaignId]);
    const c = rows[0];
    if (!c || !['draft', 'scheduled'].includes(c.status)) {
      await client.query('ROLLBACK');
      return null;
    }
    // Recipients are frozen now: list members (consent), minus suppressions, narrowed by the segment if any.
    const params = [campaignId];
    const seg = segmentClause(c.seg_rules, params);
    const ins = await client.query(
      `INSERT INTO portal.messages (kind, campaign_id, contact_id, email)
       SELECT DISTINCT ON (c.id) 'campaign', $1, c.id, c.email
         FROM portal.contacts c
         JOIN portal.list_members m ON m.contact_id = c.id AND m.status = 'subscribed'
         JOIN portal.campaign_lists cl ON cl.list_id = m.list_id AND cl.campaign_id = $1
        WHERE ${NOT_SUPPRESSED('c')}${seg}
        ORDER BY c.id
       ON CONFLICT DO NOTHING`, params);
    if (c.segment_id) await client.query('UPDATE portal.campaigns SET segment_name = $2 WHERE id = $1', [campaignId, c.seg_name]);
    const utm = s ? utmParamsFor(c, s) : null;
    for (const url of extractLinks(addUtm(c.body_html, utm, publicUrl))) {
      await client.query(
        `INSERT INTO portal.links (campaign_id, url) VALUES ($1, $2) ON CONFLICT (campaign_id, url) DO NOTHING`, [campaignId, url]);
    }
    await client.query(
      `UPDATE portal.campaigns SET status = 'sending', started_at = NOW(), pause_reason = NULL, utm_params = $2, updated_at = NOW() WHERE id = $1`,
      [campaignId, utm]);
    await client.query('COMMIT');
    return ins.rowCount;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const OPTIN_TEMPLATE = (orgName, confirmUrl, lists) => `
<h2>Please confirm your subscription</h2>
<p>Hello {{ first_name | "there" }},</p>
<p>You asked to receive emails from <strong>${escapeHtml(orgName)}</strong>${lists ? ` (${escapeHtml(lists)})` : ''}.
Please confirm by clicking the button below. If you did not ask for this, simply ignore this email.</p>
<p style="text-align:center;margin:28px 0"><a href="${confirmUrl}" style="background:#1f4e8c;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;display:inline-block">Confirm my subscription</a></p>`;

class Sender {
  constructor({ pool, settings, transport, logger }) {
    this.pool = pool;
    this.settings = settings;
    this.transport = transport;
    this.log = logger.child({ component: 'sender' });
    this.tokens = 0;
    this.lastRefill = Date.now();
    this.campaignCache = new Map();
    this.templateCache = new Map();
  }

  /** Requeues messages left "sending" by a crash; delivery state is unknown, so they are not resent. */
  async recoverInterrupted() {
    await this.pool.query(
      `UPDATE portal.messages SET status = 'unknown', error = 'Interrupted during sending; delivery not confirmed', updated_at = NOW()
        WHERE status = 'sending' AND updated_at < NOW() - INTERVAL '5 minutes'`);
  }

  async refill() {
    const s = await this.settings.all();
    const now = Date.now();
    this.tokens = Math.min(Math.max(s.send_rate_per_second, 1) * 2, this.tokens + ((now - this.lastRefill) / 1000) * s.send_rate_per_second);
    this.lastRefill = now;
    let budget = Math.floor(this.tokens);
    if (s.send_max_per_hour > 0 && budget > 0) {
      const { rows } = await this.pool.query(
        `SELECT COUNT(*)::int AS n FROM portal.messages WHERE sent_at > NOW() - INTERVAL '1 hour'`);
      budget = Math.min(budget, Math.max(0, s.send_max_per_hour - rows[0].n));
    }
    return budget;
  }

  /** One sending pass. Returns the number of messages processed. */
  async tick() {
    const budget = await this.refill();
    if (budget < 1) return 0;
    const { rows: batch } = await this.pool.query(
      `UPDATE portal.messages m SET status = 'sending', attempts = m.attempts + 1, updated_at = NOW()
        WHERE m.id IN (
          SELECT q.id FROM portal.messages q LEFT JOIN portal.campaigns c ON c.id = q.campaign_id
           WHERE q.status = 'queued' AND q.next_attempt_at <= NOW()
             AND (q.kind <> 'campaign' OR c.status = 'sending')
           ORDER BY (q.kind = 'campaign'), q.id
           LIMIT $1 FOR UPDATE OF q SKIP LOCKED)
        RETURNING m.*`, [budget]);
    if (!batch.length) {
      await this.completeFinished();
      return 0;
    }
    this.tokens -= batch.length;
    this.campaignCache.clear();
    this.templateCache.clear();
    const s = await this.settings.all();
    const publicUrl = await this.settings.publicUrl();
    let stop = false;
    // Send in parallel up to the SMTP pool size.
    const parallel = Math.max(1, this.transport.options?.maxConnections || 3);
    for (let i = 0; i < batch.length; i += parallel) {
      if (stop) {
        await this.pool.query(`UPDATE portal.messages SET status = 'queued', attempts = attempts - 1 WHERE id = ANY($1::bigint[])`,
          [batch.slice(i).map((m) => m.id)]);
        break;
      }
      const results = await Promise.all(batch.slice(i, i + parallel).map((m) => this.sendOne(m, s, publicUrl)));
      if (results.includes('connection')) stop = true;
    }
    await this.completeFinished();
    return batch.length;
  }

  async campaign(id) {
    if (!this.campaignCache.has(id)) {
      const { rows } = await this.pool.query('SELECT * FROM portal.campaigns WHERE id = $1', [id]);
      const c = rows[0];
      if (c) {
        const { rows: links } = await this.pool.query('SELECT id, url FROM portal.links WHERE campaign_id = $1', [id]);
        c.linkMap = new Map(links.map((l) => [l.url, l.id]));
      }
      this.campaignCache.set(id, c);
    }
    return this.campaignCache.get(id);
  }

  async template(id) {
    const key = id || 'default';
    if (!this.templateCache.has(key)) {
      const { rows } = await this.pool.query(
        `SELECT html FROM portal.templates WHERE ${id ? 'id = $1' : 'is_default'} LIMIT 1`, id ? [id] : []);
      this.templateCache.set(key, rows[0]?.html || DEFAULT_TEMPLATE);
    }
    return this.templateCache.get(key);
  }

  async sendOne(msg, s, publicUrl) {
    try {
      let contact = null;
      if (msg.contact_id) {
        const { rows } = await this.pool.query('SELECT * FROM portal.contacts WHERE id = $1', [msg.contact_id]);
        contact = rows[0];
      }
      if (!contact && msg.kind !== 'test') return this.finish(msg, 'skipped', 'Contact no longer exists');
      if (msg.kind === 'campaign') {
        const e = await stillEligible(this.pool, msg.contact_id, msg.campaign_id);
        if (!e.ok) return this.finish(msg, 'skipped', e.reason);
      }
      if (!publicUrl) throw Object.assign(new Error('The public URL is not configured (Settings → General).'), { mhConfig: true });
      if (!s.from_email) throw Object.assign(new Error('No sender address configured (Settings → Sending or SMTP_FROM).'), { mhConfig: true });

      let campaign;
      let templateHtml;
      if (msg.kind === 'optin') {
        const lists = msg.payload?.list_names || '';
        campaign = { subject: `Please confirm your subscription to ${s.org_name}`, preheader: '', body_html: OPTIN_TEMPLATE(s.org_name, `${publicUrl}/s/confirm/${msg.uuid}`, lists),
          body_text: '', track_opens: false, track_clicks: false, from_name: s.from_name, from_email: s.from_email, reply_to: s.reply_to };
        templateHtml = await this.template(null);
      } else {
        campaign = await this.campaign(msg.campaign_id);
        if (!campaign) return this.finish(msg, 'skipped', 'Campaign deleted');
        templateHtml = await this.template(campaign.template_id);
      }
      const recipient = contact || { email: msg.email, ...(msg.payload?.sample || {}) };
      const rendered = renderMessage({
        campaign, templateHtml, contact: recipient, token: msg.uuid, settings: s, publicUrl,
        links: (url) => campaign.linkMap?.get(url), isTest: msg.kind === 'test',
      });
      const fromEmail = campaign.from_email || s.from_email;
      const info = await this.transport.sendMail({
        from: { name: campaign.from_name || s.from_name || s.org_name, address: fromEmail },
        to: msg.email,
        replyTo: campaign.reply_to || s.reply_to || undefined,
        subject: rendered.subject,
        html: rendered.html, // content and templates are sanitised when saved
        text: rendered.text,
        headers: rendered.headers,
        envelope: { from: s.bounce_address || fromEmail, to: msg.email },
      });
      await this.pool.query(
        `UPDATE portal.messages SET status = 'sent', sent_at = NOW(), smtp_message_id = $2, error = NULL, updated_at = NOW() WHERE id = $1`,
        [msg.id, info.messageId || null]);
      if (msg.contact_id && msg.kind === 'campaign') {
        await this.pool.query('UPDATE portal.contacts SET last_sent_at = NOW() WHERE id = $1', [msg.contact_id]);
      }
      await resolveAlert(this.pool, 'smtp_unavailable');
      return 'sent';
    } catch (err) {
      return this.handleError(msg, err);
    }
  }

  async finish(msg, status, error) {
    await this.pool.query(`UPDATE portal.messages SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`, [msg.id, status, error]);
    return status;
  }

  async handleError(msg, err) {
    const kind = err.mhConfig ? 'connection' : classifySendError(err);
    const detail = String(err.response || err.message || 'Unknown error').slice(0, 500);
    if (kind === 'connection') {
      // Nothing can be delivered: put the message back and pause sending.
      await this.pool.query(
        `UPDATE portal.messages SET status = 'queued', attempts = GREATEST(attempts - 1, 0), next_attempt_at = NOW() + INTERVAL '1 minute', error = $2 WHERE id = $1`,
        [msg.id, detail]);
      if (msg.kind === 'campaign') {
        await this.pool.query(
          `UPDATE portal.campaigns SET status = 'paused', pause_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'sending'`,
          [msg.campaign_id, `Paused automatically: ${detail}`]);
      }
      await raiseAlert(this.pool, 'smtp_unavailable', 'critical',
        `Emails cannot be sent: ${detail}. Sending campaigns were paused; resume them once the problem is fixed.`, { code: err.code });
      this.log.error({ code: err.code, detail }, 'SMTP unavailable');
      return 'connection';
    }
    if (kind === 'permanent') {
      await this.finish(msg, 'failed', detail);
      await processBounce(this.pool, this.settings, {
        source: 'smtp', sourceRef: `msg:${msg.id}`, token: msg.uuid, email: msg.email, hint: 'hard', text: detail,
      }).catch((e) => this.log.error({ err: e }, 'recording SMTP bounce failed'));
      return 'failed';
    }
    // Temporary: retry with backoff, then count a soft bounce.
    if (msg.attempts <= RETRY_MINUTES.length) {
      await this.pool.query(
        `UPDATE portal.messages SET status = 'queued', error = $2, next_attempt_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW() WHERE id = $1`,
        [msg.id, detail, String(RETRY_MINUTES[msg.attempts - 1])]);
      return 'retry';
    }
    await this.finish(msg, 'failed', detail);
    await processBounce(this.pool, this.settings, {
      source: 'smtp', sourceRef: `msg:${msg.id}`, token: msg.uuid, email: msg.email, hint: 'soft', text: detail,
    }).catch((e) => this.log.error({ err: e }, 'recording SMTP soft bounce failed'));
    return 'failed';
  }

  /** Marks campaigns finished once nothing is left to send. */
  async completeFinished() {
    const { rows } = await this.pool.query(
      `UPDATE portal.campaigns c SET status = 'sent', finished_at = NOW(), updated_at = NOW()
        WHERE c.status = 'sending'
          AND NOT EXISTS (SELECT 1 FROM portal.messages m WHERE m.campaign_id = c.id AND m.kind = 'campaign' AND m.status IN ('queued', 'sending'))
        RETURNING c.id`);
    return rows.map((r) => r.id);
  }
}

/** Queues double opt-in confirmation emails for a contact (one email for all pending lists). */
async function queueOptin(db, contactId) {
  const { rows } = await db.query(
    `SELECT c.email, ARRAY_AGG(l.name ORDER BY l.name) AS names
       FROM portal.contacts c JOIN portal.list_members m ON m.contact_id = c.id AND m.status = 'unconfirmed'
       JOIN portal.lists l ON l.id = m.list_id AND l.optin = 'double'
      WHERE c.id = $1 GROUP BY c.email`, [contactId]);
  if (!rows[0]) return false;
  // Never more than one pending confirmation email per contact per day.
  const recent = await db.query(
    `SELECT 1 FROM portal.messages WHERE kind = 'optin' AND contact_id = $1 AND created_at > NOW() - INTERVAL '1 day'`, [contactId]);
  if (recent.rowCount) return false;
  await db.query(
    `INSERT INTO portal.messages (kind, contact_id, email, payload) VALUES ('optin', $1, $2, $3)`,
    [contactId, rows[0].email, { list_names: rows[0].names.join(', ') }]);
  return true;
}

module.exports = { Sender, startCampaign, extractLinks, queueOptin, recipientEvent };
