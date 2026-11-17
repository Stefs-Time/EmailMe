'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { streamCsv } = require('../../lib/csv');
const { getState } = require('../../engine/worker');
const repo = require('../contacts/repo');

/**
 * Campaign metrics (scope §3.8) from the per-recipient message log.
 * Unsubscribes are attributed exactly: they come from that campaign's links.
 * Opens are indicative only (image blocking, privacy proxies, scanners).
 */
const CAMPAIGN_METRICS = `
SELECT c.id, c.name, c.subject, c.status, c.created_at, c.send_at, c.started_at, c.finished_at, c.pause_reason,
       COALESCE((SELECT ARRAY_AGG(cl.list_name ORDER BY cl.list_name) FROM portal.campaign_lists cl WHERE cl.campaign_id = c.id), '{}') AS lists,
       COALESCE(m.targeted, 0) AS targeted, COALESCE(m.sent, 0) AS sent, COALESCE(m.failed, 0) AS failed,
       COALESCE(m.skipped, 0) AS skipped, COALESCE(m.pending, 0) AS pending,
       COALESCE(b.hard, 0) AS hard_bounces, COALESCE(b.soft, 0) AS soft_bounces, COALESCE(b.review, 0) AS review_bounces,
       COALESCE(b.complaint, 0) AS complaints,
       COALESCE(t.opens, 0) AS opens, COALESCE(t.unique_opens, 0) AS unique_opens,
       COALESCE(t.clicks, 0) AS clicks, COALESCE(t.unique_clicks, 0) AS unique_clicks,
       COALESCE(u.n, 0) AS unsubscribes, COALESCE(u.stayed, 0) AS stayed, COALESCE(u.prefs, 0) AS preference_changes
  FROM portal.campaigns c
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS targeted,
           COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
           COUNT(*) FILTER (WHERE status IN ('failed', 'unknown'))::int AS failed,
           COUNT(*) FILTER (WHERE status IN ('skipped', 'cancelled'))::int AS skipped,
           COUNT(*) FILTER (WHERE status IN ('queued', 'sending'))::int AS pending
      FROM portal.messages WHERE campaign_id = c.id AND kind = 'campaign') m ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT COALESCE(message_id, -id)) FILTER (WHERE classification = 'hard')::int AS hard,
           COUNT(DISTINCT COALESCE(message_id, -id)) FILTER (WHERE classification = 'soft')::int AS soft,
           COUNT(DISTINCT COALESCE(message_id, -id)) FILTER (WHERE classification = 'review')::int AS review,
           COUNT(DISTINCT COALESCE(message_id, -id)) FILTER (WHERE classification = 'complaint')::int AS complaint
      FROM portal.bounce_events WHERE campaign_id = c.id) b ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE kind = 'open')::int AS opens,
           COUNT(DISTINCT message_id) FILTER (WHERE kind = 'open')::int AS unique_opens,
           COUNT(*) FILTER (WHERE kind = 'click')::int AS clicks,
           COUNT(DISTINCT message_id) FILTER (WHERE kind = 'click')::int AS unique_clicks
      FROM portal.tracking_events WHERE campaign_id = c.id) t ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(DISTINCT COALESCE(contact_id::text, email_hash)) FILTER (WHERE event_type = 'unsubscribed')::int AS n,
           COUNT(DISTINCT COALESCE(contact_id::text, email_hash)) FILTER (WHERE event_type = 'stayed_subscribed')::int AS stayed,
           COUNT(DISTINCT COALESCE(contact_id::text, email_hash)) FILTER (WHERE event_type = 'preferences_updated')::int AS prefs
      FROM portal.recipient_events
     WHERE campaign_id = c.id AND event_type IN ('unsubscribed', 'stayed_subscribed', 'preferences_updated')) u ON TRUE`;

function shapeCampaign(c) {
  const failures = c.hard_bounces + c.soft_bounces + c.review_bounces;
  const pct = (n) => (c.sent > 0 ? Math.round((n / c.sent) * 1000) / 10 : null);
  return {
    ...c, delivery_failures: failures,
    rates: { bounce: pct(failures), open: pct(c.unique_opens), click: pct(c.unique_clicks),
      unsubscribe: pct(c.unsubscribes), complaint: pct(c.complaints) },
  };
}

function reportRoutes({ pool, settings, config }) {
  const r = express.Router();
  r.use(requirePermission('reports:read'));

  r.get('/overview', async (_req, res) => {
    const db = pool;
    const statusCounts = await db.query(`SELECT status, COUNT(*)::int AS n FROM (${repo.BASE_SQL}) c GROUP BY status`);
    const totals = await db.query(`
      SELECT (SELECT COUNT(*)::int FROM portal.contacts) AS contacts,
             (SELECT COUNT(*)::int FROM portal.campaigns) AS campaigns,
             (SELECT COUNT(*)::int FROM portal.campaigns WHERE status IN ('scheduled', 'sending', 'paused')) AS active_campaigns,
             (SELECT COUNT(*)::bigint FROM portal.messages WHERE kind = 'campaign' AND status = 'sent') AS emails_sent,
             (SELECT COUNT(*)::int FROM portal.lists) AS lists,
             (SELECT COUNT(*)::int FROM portal.suppressions WHERE lifted_at IS NULL) AS suppressed,
             (SELECT COUNT(*)::int FROM portal.review_queue WHERE resolved_at IS NULL) AS pending_review,
             (SELECT COUNT(*)::int FROM portal.bounce_events WHERE bounced_at > NOW() - INTERVAL '30 days') AS bounces_30d`);
    const growth = await db.query(`
      SELECT d::date AS day,
             (SELECT COUNT(*)::int FROM portal.contacts s WHERE s.created_at >= d AND s.created_at < d + INTERVAL '1 day') AS added,
             (SELECT COUNT(*)::int FROM portal.suppressions p WHERE p.created_at >= d AND p.created_at < d + INTERVAL '1 day') AS suppressed
        FROM generate_series(date_trunc('day', NOW()) - INTERVAL '29 days', date_trunc('day', NOW()), INTERVAL '1 day') d ORDER BY d`);
    const recentBounces = await db.query(`
      SELECT e.id, e.contact_id, s.email, e.classification, e.reason, e.action_taken, e.bounced_at, c.name AS campaign
        FROM portal.bounce_events e LEFT JOIN portal.contacts s ON s.id = e.contact_id
        LEFT JOIN portal.campaigns c ON c.id = e.campaign_id ORDER BY e.bounced_at DESC LIMIT 8`);
    const recentCampaigns = await db.query(`${CAMPAIGN_METRICS} ORDER BY COALESCE(c.started_at, c.created_at) DESC LIMIT 5`);
    const alerts = await db.query(
      `SELECT id, key, severity, message, details, occurrences, first_seen, last_seen FROM portal.alerts
        WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC`);
    const hb = await getState(pool, 'heartbeat', null);
    const data = {
      statuses: Object.fromEntries(statusCounts.rows.map((s) => [s.status, s.n])),
      totals: totals.rows[0], growth: growth.rows, recentBounces: recentBounces.rows,
      recentCampaigns: recentCampaigns.rows.map(shapeCampaign), alerts: alerts.rows, sync: hb,
    };
    if (!hb || Date.now() - new Date(hb.at).getTime() > 5 * 60000) {
      data.alerts.unshift({ id: null, key: 'worker_stale', severity: 'critical', occurrences: 1, last_seen: new Date().toISOString(),
        message: 'The background worker is not running, so emails are not being sent and bounces are not being processed.' });
    }
    res.json({ success: true, data });
  });

  r.get('/campaigns', async (req, res) => {
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
      `SELECT x.*, COUNT(*) OVER() AS total FROM (${CAMPAIGN_METRICS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) x
        ORDER BY COALESCE(x.started_at, x.send_at, x.created_at) DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ success: true, data: rows.map(({ total, ...x }) => shapeCampaign(x)), meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page } });
  });

  r.get('/campaigns.csv', requirePermission('exports:read'), async (_req, res) => {
    const { rows } = await pool.query(`${CAMPAIGN_METRICS} ORDER BY COALESCE(c.started_at, c.created_at) DESC`);
    await streamCsv(res, `campaign-report-${new Date().toISOString().slice(0, 10)}.csv`, [
      'ID', 'Campaign', 'Subject', 'Status', 'Lists', 'Started', 'Finished', 'Recipients targeted', 'Emails sent', 'Not sent (skipped/cancelled)',
      'Delivery failures', 'Hard bounces', 'Soft bounces', 'Needs review', 'Complaints', 'Unsubscribes', 'Unique opens', 'Opens',
      'Unique clicks', 'Clicks', 'Bounce %', 'Open %', 'Click %', 'Unsubscribe %',
    ], [rows.map(shapeCampaign).map((c) => [c.id, c.name, c.subject, c.status, c.lists.join('; '), c.started_at, c.finished_at,
      c.targeted, c.sent, c.skipped, c.delivery_failures, c.hard_bounces, c.soft_bounces, c.review_bounces, c.complaints,
      c.unsubscribes, c.unique_opens, c.opens, c.unique_clicks, c.clicks, c.rates.bounce, c.rates.open, c.rates.click, c.rates.unsubscribe])]);
  });

  r.get('/campaigns/:id', async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const { rows } = await pool.query(`${CAMPAIGN_METRICS} WHERE c.id = $1`, [id]);
    if (!rows[0]) throw notFound('Campaign not found');
    const links = await pool.query(`
      SELECT l.url, COUNT(t.id)::int AS clicks, COUNT(DISTINCT t.message_id)::int AS unique_clicks
        FROM portal.links l LEFT JOIN portal.tracking_events t ON t.link_id = l.id AND t.kind = 'click'
       WHERE l.campaign_id = $1 GROUP BY l.url ORDER BY clicks DESC LIMIT 25`, [id]);
    const timeline = await pool.query(`
      SELECT date_trunc('hour', t.at) AS at, t.kind, COUNT(*)::int AS n FROM (
        SELECT sent_at AS at, 'sent' AS kind FROM portal.messages WHERE campaign_id = $1 AND kind = 'campaign' AND sent_at IS NOT NULL
        UNION ALL SELECT created_at, kind FROM portal.tracking_events WHERE campaign_id = $1
        UNION ALL SELECT bounced_at, 'bounce' FROM portal.bounce_events WHERE campaign_id = $1
      ) t GROUP BY 1, 2 ORDER BY 1 LIMIT 2000`, [id]);
    const bounces = await pool.query(`
      SELECT e.contact_id, s.email, e.classification, e.enhanced_code, e.reason, e.action_taken, e.source, e.bounced_at
        FROM portal.bounce_events e LEFT JOIN portal.contacts s ON s.id = e.contact_id
       WHERE e.campaign_id = $1 ORDER BY e.bounced_at DESC LIMIT 200`, [id]);
    const failures = await pool.query(`
      SELECT m.contact_id, m.email, m.status, m.error, m.updated_at FROM portal.messages m
       WHERE m.campaign_id = $1 AND m.kind = 'campaign' AND m.status IN ('failed', 'skipped', 'unknown')
       ORDER BY m.updated_at DESC LIMIT 200`, [id]);
    res.json({ success: true, data: { campaign: shapeCampaign(rows[0]), links: links.rows, timeline: timeline.rows,
      bounces: bounces.rows, failures: failures.rows } });
  });

  r.get('/audience', async (_req, res) => {
    const [bySource, byConsent, byDomain, byMonth, byStatusSource] = await Promise.all([
      pool.query(`SELECT COALESCE(NULLIF(source, ''), '(none)') AS label, COUNT(*)::int AS n FROM portal.contacts GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
      pool.query(`SELECT COALESCE(NULLIF(consent->>'method', ''), '(not recorded)') AS label, COUNT(*)::int AS n FROM portal.contacts GROUP BY 1 ORDER BY 2 DESC`),
      pool.query(`SELECT split_part(LOWER(email), '@', 2) AS label, COUNT(*)::int AS n FROM portal.contacts GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
      pool.query(`SELECT to_char(d, 'YYYY-MM') AS month,
                         (SELECT COUNT(*)::int FROM portal.contacts s WHERE s.created_at >= d AND s.created_at < d + INTERVAL '1 month') AS added,
                         (SELECT COUNT(*)::int FROM portal.suppressions p WHERE p.created_at >= d AND p.created_at < d + INTERVAL '1 month') AS suppressed
                    FROM generate_series(date_trunc('month', NOW()) - INTERVAL '11 months', date_trunc('month', NOW()), INTERVAL '1 month') d`),
      pool.query(`SELECT COALESCE(NULLIF(c.source, ''), '(none)') AS source, c.status, COUNT(*)::int AS n FROM (${repo.BASE_SQL}) c GROUP BY 1, 2`),
    ]);
    res.json({ success: true, data: { bySource: bySource.rows, byConsent: byConsent.rows, byDomain: byDomain.rows,
      byMonth: byMonth.rows, byStatusSource: byStatusSource.rows } });
  });

  r.get('/bounces', async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const [daily, byClass, byDomain, byCode] = await Promise.all([
      pool.query(`SELECT d::date AS day,
                         COUNT(e.id) FILTER (WHERE e.classification = 'hard')::int AS hard,
                         COUNT(e.id) FILTER (WHERE e.classification = 'soft')::int AS soft,
                         COUNT(e.id) FILTER (WHERE e.classification = 'complaint')::int AS complaint,
                         COUNT(e.id) FILTER (WHERE e.classification = 'review')::int AS review
                    FROM generate_series(date_trunc('day', NOW()) - ($1 - 1) * INTERVAL '1 day', date_trunc('day', NOW()), INTERVAL '1 day') d
                    LEFT JOIN portal.bounce_events e ON e.bounced_at >= d AND e.bounced_at < d + INTERVAL '1 day'
                   GROUP BY d ORDER BY d`, [q.days]),
      pool.query(`SELECT classification AS label, COUNT(*)::int AS n FROM portal.bounce_events
                   WHERE bounced_at > NOW() - $1 * INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC`, [q.days]),
      pool.query(`SELECT split_part(LOWER(s.email), '@', 2) AS label, COUNT(*)::int AS n
                    FROM portal.bounce_events e JOIN portal.contacts s ON s.id = e.contact_id
                   WHERE e.bounced_at > NOW() - $1 * INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [q.days]),
      pool.query(`SELECT COALESCE(enhanced_code, smtp_code, '(none)') AS label, MIN(reason) AS reason, COUNT(*)::int AS n
                    FROM portal.bounce_events WHERE bounced_at > NOW() - $1 * INTERVAL '1 day' GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [q.days]),
    ]);
    res.json({ success: true, data: { daily: daily.rows, byClass: byClass.rows, byDomain: byDomain.rows, byCode: byCode.rows } });
  });

  /**
   * Mail usage through your SMTP server: volume per day and kind, failures,
   * current hour against the hourly cap, queue, and recipient actions.
   */
  r.get('/usage', async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const [daily, totals, actions, byCampaign] = await Promise.all([
      pool.query(`SELECT d::date AS day,
                         COUNT(m.id) FILTER (WHERE m.kind = 'campaign')::int AS campaign,
                         COUNT(m.id) FILTER (WHERE m.kind = 'test')::int AS test,
                         COUNT(m.id) FILTER (WHERE m.kind = 'optin')::int AS optin
                    FROM generate_series(date_trunc('day', NOW()) - ($1 - 1) * INTERVAL '1 day', date_trunc('day', NOW()), INTERVAL '1 day') d
                    LEFT JOIN portal.messages m ON m.sent_at >= d AND m.sent_at < d + INTERVAL '1 day'
                   GROUP BY d ORDER BY d`, [q.days]),
      pool.query(`SELECT COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
                         COUNT(*) FILTER (WHERE sent_at >= date_trunc('day', NOW()))::int AS today,
                         COUNT(*) FILTER (WHERE sent_at >= date_trunc('month', NOW()))::int AS this_month,
                         COUNT(*) FILTER (WHERE sent_at > NOW() - $1 * INTERVAL '1 day')::int AS period,
                         (SELECT COUNT(*)::int FROM portal.messages WHERE status IN ('failed', 'unknown') AND updated_at > NOW() - $1 * INTERVAL '1 day') AS failed,
                         (SELECT COUNT(*)::int FROM portal.messages WHERE status IN ('queued', 'sending')) AS queued
                    FROM portal.messages WHERE sent_at > LEAST(date_trunc('month', NOW()), NOW() - $1 * INTERVAL '1 day')`, [q.days]),
      pool.query(`SELECT event_type, COUNT(*)::int AS n FROM portal.recipient_events
                   WHERE actor_type = 'recipient' AND created_at > NOW() - $1 * INTERVAL '1 day'
                     AND event_type IN ('unsubscribed', 'stayed_subscribed', 'preferences_updated', 'optin_confirmed')
                   GROUP BY 1`, [q.days]),
      pool.query(`SELECT c.id, c.name, COUNT(m.id)::int AS sent, MIN(m.sent_at) AS first_sent, MAX(m.sent_at) AS last_sent
                    FROM portal.messages m JOIN portal.campaigns c ON c.id = m.campaign_id
                   WHERE m.kind = 'campaign' AND m.sent_at > NOW() - $1 * INTERVAL '1 day'
                   GROUP BY c.id, c.name ORDER BY sent DESC LIMIT 10`, [q.days]),
    ]);
    const s = await settings.all();
    res.json({ success: true, data: {
      days: q.days,
      daily: daily.rows,
      totals: totals.rows[0],
      limits: { per_second: s.send_rate_per_second, per_hour: s.send_max_per_hour || null },
      smtp: { host: config?.SMTP_HOST || null, port: config?.SMTP_PORT || null },
      actions: Object.fromEntries(actions.rows.map((a) => [a.event_type, a.n])),
      byCampaign: byCampaign.rows,
    } });
  });

  return r;
}

module.exports = { reportRoutes, shapeCampaign, CAMPAIGN_METRICS };
