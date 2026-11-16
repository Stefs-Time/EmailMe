'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { readOnly, sequential } = require('../../db/pool');
const { streamCsv } = require('../../lib/csv');
const { getState } = require('../sync/worker');

/**
 * Campaign metrics (scope §3.8). listmonk does not attribute unsubscribes to
 * a campaign, so "unsubscribes" counts list unsubscribes on the campaign's
 * lists within 7 days of the send started, excluding contacts that bounced.
 * Opens are indicative only (image blocking, privacy proxies, scanners).
 */
const CAMPAIGN_METRICS = `
SELECT c.id, c.name, c.subject, c.status, c.type, c.to_send, c.sent, c.started_at, c.created_at, c.updated_at, c.send_at,
       COALESCE((SELECT ARRAY_AGG(cl.list_name ORDER BY cl.list_name) FROM campaign_lists cl WHERE cl.campaign_id = c.id), '{}') AS lists,
       (SELECT COUNT(*)::int FROM campaign_views v WHERE v.campaign_id = c.id) AS opens,
       (SELECT COUNT(DISTINCT v.subscriber_id)::int FROM campaign_views v WHERE v.campaign_id = c.id) AS unique_opens,
       (SELECT COUNT(*)::int FROM link_clicks k WHERE k.campaign_id = c.id) AS clicks,
       (SELECT COUNT(DISTINCT k.subscriber_id)::int FROM link_clicks k WHERE k.campaign_id = c.id) AS unique_clicks,
       (SELECT COUNT(*)::int FROM bounces b WHERE b.campaign_id = c.id AND b.type = 'hard') AS hard_bounces_raw,
       (SELECT COUNT(*)::int FROM bounces b WHERE b.campaign_id = c.id AND b.type = 'soft') AS soft_bounces_raw,
       (SELECT COUNT(*)::int FROM bounces b WHERE b.campaign_id = c.id AND b.type = 'complaint') AS complaints,
       (SELECT COUNT(*)::int FROM portal.bounce_events e WHERE e.campaign_id = c.id AND e.classification = 'hard') AS hard_bounces,
       (SELECT COUNT(*)::int FROM portal.bounce_events e WHERE e.campaign_id = c.id AND e.classification = 'soft') AS soft_bounces,
       (SELECT COUNT(*)::int FROM portal.bounce_events e WHERE e.campaign_id = c.id AND e.classification = 'review') AS review_bounces,
       CASE WHEN c.started_at IS NULL THEN 0 ELSE (
         SELECT COUNT(DISTINCT x.subscriber_id)::int FROM subscriber_lists x
           JOIN campaign_lists cl ON cl.list_id = x.list_id AND cl.campaign_id = c.id
          WHERE x.status = 'unsubscribed' AND x.updated_at BETWEEN c.started_at AND c.started_at + INTERVAL '7 days'
            AND NOT EXISTS (SELECT 1 FROM bounces b WHERE b.subscriber_id = x.subscriber_id AND b.campaign_id = c.id)
       ) END AS unsubscribes
FROM campaigns c`;

function shapeCampaign(c) {
  // Before the sync has classified a campaign's bounces, fall back to listmonk's raw counts.
  const classified = c.hard_bounces + c.soft_bounces + c.review_bounces;
  const raw = c.hard_bounces_raw + c.soft_bounces_raw;
  const hard = classified >= raw ? c.hard_bounces : c.hard_bounces_raw;
  const soft = classified >= raw ? c.soft_bounces : c.soft_bounces_raw;
  const review = classified >= raw ? c.review_bounces : 0;
  const failures = hard + soft + review;
  const pct = (n) => (c.sent > 0 ? Math.round((n / c.sent) * 1000) / 10 : null);
  return {
    id: c.id, name: c.name, subject: c.subject, status: c.status, type: c.type, lists: c.lists,
    created_at: c.created_at, started_at: c.started_at, send_at: c.send_at, updated_at: c.updated_at,
    targeted: c.to_send, sent: c.sent, delivery_failures: failures, hard_bounces: hard, soft_bounces: soft,
    review_bounces: review, complaints: c.complaints, unsubscribes: c.unsubscribes, opens: c.opens,
    unique_opens: c.unique_opens, clicks: c.clicks, unique_clicks: c.unique_clicks,
    rates: { bounce: pct(failures), open: pct(c.unique_opens), click: pct(c.unique_clicks),
      unsubscribe: pct(c.unsubscribes), complaint: pct(c.complaints) },
  };
}

function reportRoutes({ pool, config }) {
  const r = express.Router();
  r.use(requirePermission('reports:read'));

  r.get('/overview', async (_req, res) => {
    const data = await readOnly(pool, async (db) => {
      const repo = require('../contacts/repo');
      const statusCounts = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM (${repo.BASE_SQL}) c GROUP BY status`);
      const totals = await db.query(`
        SELECT (SELECT COUNT(*)::int FROM subscribers) AS contacts,
               (SELECT COUNT(*)::int FROM campaigns) AS campaigns,
               (SELECT COUNT(*)::int FROM campaigns WHERE status IN ('running', 'scheduled')) AS active_campaigns,
               (SELECT COALESCE(SUM(sent), 0)::bigint FROM campaigns) AS emails_sent,
               (SELECT COUNT(*)::int FROM lists) AS lists,
               (SELECT COUNT(*)::int FROM portal.suppressions WHERE lifted_at IS NULL) AS suppressed,
               (SELECT COUNT(*)::int FROM portal.review_queue WHERE resolved_at IS NULL) AS pending_review,
               (SELECT COUNT(*)::int FROM bounces WHERE created_at > NOW() - INTERVAL '30 days') AS bounces_30d`);
      const growth = await db.query(`
        SELECT d::date AS day,
               (SELECT COUNT(*)::int FROM subscribers s WHERE s.created_at >= d AND s.created_at < d + INTERVAL '1 day') AS added,
               (SELECT COUNT(*)::int FROM portal.suppressions p WHERE p.created_at >= d AND p.created_at < d + INTERVAL '1 day') AS suppressed
          FROM generate_series(date_trunc('day', NOW()) - INTERVAL '29 days', date_trunc('day', NOW()), INTERVAL '1 day') d
         ORDER BY d`);
      const recentBounces = await db.query(`
        SELECT e.id, e.subscriber_id, s.email, e.classification, e.reason, e.action_taken, e.bounced_at, c.name AS campaign
          FROM portal.bounce_events e LEFT JOIN subscribers s ON s.id = e.subscriber_id
          LEFT JOIN campaigns c ON c.id = e.campaign_id
         ORDER BY e.bounced_at DESC LIMIT 8`);
      const recentCampaigns = await db.query(`${CAMPAIGN_METRICS} ORDER BY c.created_at DESC LIMIT 5`);
      const alerts = await db.query(
        `SELECT id, key, severity, message, details, occurrences, first_seen, last_seen FROM portal.alerts
          WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC`);
      return {
        statuses: Object.fromEntries(statusCounts.rows.map((s) => [s.status, s.n])),
        totals: totals.rows[0],
        growth: growth.rows,
        recentBounces: recentBounces.rows,
        recentCampaigns: recentCampaigns.rows.map(shapeCampaign),
        alerts: alerts.rows,
      };
    });
    const hb = await getState(pool, 'heartbeat', null);
    const stale = !hb || Date.now() - new Date(hb.at).getTime() > config.SYNC_STALE_MINUTES * 60000;
    if (stale) {
      data.alerts.unshift({ id: null, key: 'sync_stale', severity: 'critical', occurrences: 1,
        message: hb ? `Recipient sync has not run since ${new Date(hb.at).toLocaleString('en-ZA')}. Suppressions are not being updated.`
          : 'Recipient sync has not run yet.', last_seen: new Date().toISOString() });
    }
    res.json({ success: true, data: { ...data, sync: hb } });
  });

  r.get('/campaigns', async (req, res) => {
    const q = parse(z.object({
      page: z.coerce.number().int().min(1).default(1),
      per_page: z.coerce.number().int().min(1).max(100).default(20),
      q: z.string().trim().max(200).optional(),
      status: z.enum(['draft', 'scheduled', 'running', 'paused', 'cancelled', 'finished']).optional(),
    }), req.query);
    const params = [];
    const where = [];
    if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`(c.name ILIKE $${params.length} OR c.subject ILIKE $${params.length})`); }
    if (q.status) { params.push(q.status); where.push(`c.status = $${params.length}`); }
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const out = await readOnly(pool, async (db) => {
      const { rows } = await db.query(
        `SELECT m.*, COUNT(*) OVER() AS total FROM (${CAMPAIGN_METRICS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}) m
          ORDER BY m.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return rows;
    });
    res.json({ success: true, data: out.map(shapeCampaign), meta: { total: Number(out[0]?.total || 0), page: q.page, perPage: q.per_page } });
  });

  r.get('/campaigns.csv', requirePermission('exports:read'), async (_req, res) => {
    const rows = await readOnly(pool, async (db) => (await db.query(`${CAMPAIGN_METRICS} ORDER BY c.created_at DESC`)).rows);
    await streamCsv(res, `campaign-report-${new Date().toISOString().slice(0, 10)}.csv`, [
      'ID', 'Campaign', 'Subject', 'Status', 'Lists', 'Started', 'Recipients targeted', 'Emails sent', 'Delivery failures',
      'Hard bounces', 'Soft bounces', 'Needs review', 'Complaints', 'Unsubscribes (7d)', 'Unique opens', 'Opens',
      'Unique clicks', 'Clicks', 'Bounce %', 'Open %', 'Click %',
    ], [rows.map(shapeCampaign).map((c) => [c.id, c.name, c.subject, c.status, c.lists.join('; '), c.started_at,
      c.targeted, c.sent, c.delivery_failures, c.hard_bounces, c.soft_bounces, c.review_bounces, c.complaints,
      c.unsubscribes, c.unique_opens, c.opens, c.unique_clicks, c.clicks, c.rates.bounce, c.rates.open, c.rates.click])]);
  });

  r.get('/campaigns/:id', async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const data = await readOnly(pool, async (db) => {
      const { rows } = await db.query(`${CAMPAIGN_METRICS} WHERE c.id = $1`, [id]);
      if (!rows[0]) throw notFound('Campaign not found');
      const links = await db.query(`
        SELECT l.url, COUNT(*)::int AS clicks, COUNT(DISTINCT k.subscriber_id)::int AS unique_clicks
          FROM link_clicks k JOIN links l ON l.id = k.link_id WHERE k.campaign_id = $1
         GROUP BY l.url ORDER BY clicks DESC LIMIT 20`, [id]);
      const timeline = await db.query(`
        SELECT date_trunc('hour', t.created_at) AS at, t.kind, COUNT(*)::int AS n FROM (
          SELECT created_at, 'open' AS kind FROM campaign_views WHERE campaign_id = $1
          UNION ALL SELECT created_at, 'click' FROM link_clicks WHERE campaign_id = $1
          UNION ALL SELECT created_at, 'bounce' FROM bounces WHERE campaign_id = $1
        ) t WHERE t.created_at < (SELECT COALESCE(started_at, created_at) FROM campaigns WHERE id = $1) + INTERVAL '14 days'
        GROUP BY 1, 2 ORDER BY 1`, [id]);
      const bounces = await db.query(`
        SELECT e.subscriber_id, s.email, e.classification, e.enhanced_code, e.reason, e.action_taken, e.bounced_at
          FROM portal.bounce_events e LEFT JOIN subscribers s ON s.id = e.subscriber_id
         WHERE e.campaign_id = $1 ORDER BY e.bounced_at DESC LIMIT 200`, [id]);
      return { campaign: shapeCampaign(rows[0]), links: links.rows, timeline: timeline.rows, bounces: bounces.rows };
    });
    res.json({ success: true, data: { ...data, listmonkUrl: `${config.LISTMONK_PUBLIC_URL}/admin/campaigns/${id}` } });
  });

  r.get('/audience', async (_req, res) => {
    const data = await readOnly(pool, async (db) => {
      const repo = require('../contacts/repo');
      const [bySource, byConsent, byDomain, byMonth, byStatusSource] = await sequential([
        () => db.query(`SELECT COALESCE(NULLIF(attribs->>'source', ''), '(none)') AS label, COUNT(*)::int AS n
                    FROM subscribers GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
        () => db.query(`SELECT COALESCE(NULLIF(attribs->'consent'->>'method', ''), '(not recorded)') AS label, COUNT(*)::int AS n
                    FROM subscribers GROUP BY 1 ORDER BY 2 DESC`),
        () => db.query(`SELECT split_part(LOWER(email), '@', 2) AS label, COUNT(*)::int AS n
                    FROM subscribers GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
        () => db.query(`SELECT to_char(d, 'YYYY-MM') AS month,
                         (SELECT COUNT(*)::int FROM subscribers s WHERE s.created_at >= d AND s.created_at < d + INTERVAL '1 month') AS added,
                         (SELECT COUNT(*)::int FROM portal.suppressions p WHERE p.created_at >= d AND p.created_at < d + INTERVAL '1 month') AS suppressed
                    FROM generate_series(date_trunc('month', NOW()) - INTERVAL '11 months', date_trunc('month', NOW()), INTERVAL '1 month') d`),
        () => db.query(`SELECT COALESCE(NULLIF(c.attribs->>'source', ''), '(none)') AS source, c.status, COUNT(*)::int AS n
                    FROM (${repo.BASE_SQL}) c GROUP BY 1, 2`),
      ]);
      return { bySource: bySource.rows, byConsent: byConsent.rows, byDomain: byDomain.rows, byMonth: byMonth.rows,
        byStatusSource: byStatusSource.rows };
    });
    res.json({ success: true, data });
  });

  r.get('/bounces', async (req, res) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const data = await readOnly(pool, async (db) => {
      const [daily, byClass, byDomain, byCode] = await sequential([
        () => db.query(`SELECT d::date AS day,
                         COUNT(e.id) FILTER (WHERE e.classification = 'hard')::int AS hard,
                         COUNT(e.id) FILTER (WHERE e.classification = 'soft')::int AS soft,
                         COUNT(e.id) FILTER (WHERE e.classification = 'complaint')::int AS complaint,
                         COUNT(e.id) FILTER (WHERE e.classification = 'review')::int AS review
                    FROM generate_series(date_trunc('day', NOW()) - ($1 - 1) * INTERVAL '1 day', date_trunc('day', NOW()), INTERVAL '1 day') d
                    LEFT JOIN portal.bounce_events e ON e.bounced_at >= d AND e.bounced_at < d + INTERVAL '1 day'
                   GROUP BY d ORDER BY d`, [q.days]),
        () => db.query(`SELECT classification AS label, COUNT(*)::int AS n FROM portal.bounce_events
                   WHERE bounced_at > NOW() - $1 * INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC`, [q.days]),
        () => db.query(`SELECT split_part(LOWER(s.email), '@', 2) AS label, COUNT(*)::int AS n
                    FROM portal.bounce_events e JOIN subscribers s ON s.id = e.subscriber_id
                   WHERE e.bounced_at > NOW() - $1 * INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [q.days]),
        () => db.query(`SELECT COALESCE(enhanced_code, '(none)') AS label, MIN(reason) AS reason, COUNT(*)::int AS n
                    FROM portal.bounce_events WHERE bounced_at > NOW() - $1 * INTERVAL '1 day'
                   GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [q.days]),
      ]);
      return { daily: daily.rows, byClass: byClass.rows, byDomain: byDomain.rows, byCode: byCode.rows };
    });
    res.json({ success: true, data });
  });

  return r;
}

module.exports = { reportRoutes, shapeCampaign };
