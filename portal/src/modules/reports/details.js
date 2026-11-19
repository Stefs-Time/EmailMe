'use strict';

/**
 * Report details: the people and events behind every number in the reports.
 *
 *   GET /api/reports/details?kind=recipients&campaign=12&outcome=clicked[&link=3]
 *   GET /api/reports/details?kind=bounces&days=30[&classification=hard&domain=gmail.com&code=5.1.1&campaign=12]
 *   GET /api/reports/details?kind=events&type=unsubscribed&days=30[&campaign=12]
 *   GET /api/reports/details?kind=messages&days=30[&day=2026-11-18 | since=<ISO time>&message_kind=campaign&state=failed]
 *
 * Every kind supports q (email search), page and per_page (max 100), and
 * format=csv (managers and administrators only; at most 100 000 rows).
 * Filters are whitelisted and bound as parameters.
 */
const { z } = require('zod');
const { parse, notFound, forbidden, validation } = require('../../lib/errors');
const { can } = require('../../middleware/auth');
const { streamCsv } = require('../../lib/csv');

const OUTCOMES = ['all', 'sent', 'failed', 'skipped', 'pending', 'bounced', 'hard', 'soft', 'review', 'complaint',
  'opened', 'not_opened', 'clicked', 'unsubscribed', 'consented', 'stayed', 'preferences'];
const EVENT_OF = { unsubscribed: 'unsubscribed', consented: 'consent_given', stayed: 'stayed_subscribed', preferences: 'preferences_updated' };
const EVENT_TYPES = ['unsubscribed', 'stayed_subscribed', 'preferences_updated', 'optin_confirmed', 'consent_given'];
const CSV_MAX = 100000;

const base = z.object({
  kind: z.enum(['recipients', 'bounces', 'events', 'messages']),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(['json', 'csv']).default('json'),
  campaign: z.coerce.number().int().positive().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  outcome: z.enum(OUTCOMES).default('all'),
  link: z.coerce.number().int().positive().optional(),
  classification: z.enum(['hard', 'soft', 'review', 'complaint']).optional(),
  domain: z.string().trim().toLowerCase().max(255).regex(/^[a-z0-9.-]+$/, 'Invalid domain').optional(),
  code: z.string().trim().max(20).optional(),
  type: z.enum(EVENT_TYPES).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  since: z.coerce.date().optional(),
  message_kind: z.enum(['campaign', 'test', 'optin']).optional(),
  state: z.enum(['sent', 'failed', 'pending']).optional(),
});

const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Builds { title, columns, from, where, order, select } for one kind. `p` binds a parameter. */
function querySpec(q, p) {
  const where = [];
  if (q.kind === 'recipients') {
    if (!q.campaign) throw validation('Choose a campaign');
    where.push(`m.campaign_id = ${p(q.campaign)}`, `m.kind = 'campaign'`);
    const bounce = (cls) => `EXISTS (SELECT 1 FROM portal.bounce_events b WHERE b.campaign_id = m.campaign_id
      AND (b.message_id = m.id OR (b.message_id IS NULL AND b.contact_id = m.contact_id)) AND b.classification = ANY(${p(cls)}::text[]))`;
    const tracked = (kind) => `EXISTS (SELECT 1 FROM portal.tracking_events t WHERE t.message_id = m.id AND t.kind = '${kind}'${kind === 'click' && q.link ? ` AND t.link_id = ${p(q.link)}` : ''})`;
    switch (q.outcome) {
      case 'sent': where.push(`m.status = 'sent'`); break;
      case 'failed': where.push(`m.status IN ('failed', 'unknown')`); break;
      case 'skipped': where.push(`m.status IN ('skipped', 'cancelled')`); break;
      case 'pending': where.push(`m.status IN ('queued', 'sending')`); break;
      case 'bounced': where.push(bounce(['hard', 'soft', 'review'])); break;
      case 'hard': case 'soft': case 'review': case 'complaint': where.push(bounce([q.outcome])); break;
      case 'opened': where.push(tracked('open')); break;
      case 'not_opened': where.push(`m.status = 'sent'`, `NOT ${tracked('open')}`); break;
      case 'clicked': where.push(tracked('click')); break;
      case 'unsubscribed': case 'consented': case 'stayed': case 'preferences':
        where.push(`EXISTS (SELECT 1 FROM portal.recipient_events e WHERE e.campaign_id = m.campaign_id AND e.contact_id = m.contact_id
          AND e.event_type = ${p(EVENT_OF[q.outcome])})`);
        break;
      default: break;
    }
    if (q.q) where.push(`COALESCE(c.email, m.email) ILIKE ${p(like(q.q))}`);
    return {
      from: `portal.messages m LEFT JOIN portal.contacts c ON c.id = m.contact_id`,
      select: `m.id, m.contact_id, COALESCE(c.email, m.email) AS email, TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
        m.status, m.sent_at, m.error,
        (SELECT COUNT(*)::int FROM portal.tracking_events t WHERE t.message_id = m.id AND t.kind = 'open') AS opens,
        (SELECT COUNT(*)::int FROM portal.tracking_events t WHERE t.message_id = m.id AND t.kind = 'click') AS clicks,
        (SELECT b.classification || ': ' || COALESCE(b.enhanced_code || ' ', '') || COALESCE(b.reason, '') FROM portal.bounce_events b
          WHERE b.campaign_id = m.campaign_id AND (b.message_id = m.id OR (b.message_id IS NULL AND b.contact_id = m.contact_id))
          ORDER BY b.bounced_at DESC LIMIT 1) AS bounce,
        (SELECT STRING_AGG(e.event_type, ', ' ORDER BY e.created_at) FROM portal.recipient_events e
          WHERE e.campaign_id = m.campaign_id AND e.contact_id = m.contact_id AND e.actor_type = 'recipient') AS actions`,
      where, order: 'm.id',
      columns: [['email', 'Email'], ['name', 'Name'], ['status', 'Delivery'], ['sent_at', 'Sent'], ['opens', 'Opens'], ['clicks', 'Clicks'],
        ['bounce', 'Bounce'], ['actions', 'Actions'], ['error', 'Error']],
    };
  }
  if (q.kind === 'bounces') {
    if (q.days) where.push(`b.bounced_at > NOW() - ${p(q.days)} * INTERVAL '1 day'`);
    if (q.campaign) where.push(`b.campaign_id = ${p(q.campaign)}`);
    if (q.classification) where.push(`b.classification = ${p(q.classification)}`);
    if (q.domain) where.push(`split_part(LOWER(c.email), '@', 2) = ${p(q.domain)}`);
    if (q.code) where.push(q.code === '(none)' ? `COALESCE(b.enhanced_code, b.smtp_code) IS NULL` : `COALESCE(b.enhanced_code, b.smtp_code) = ${p(q.code)}`);
    if (q.q) where.push(`c.email ILIKE ${p(like(q.q))}`);
    return {
      from: `portal.bounce_events b LEFT JOIN portal.contacts c ON c.id = b.contact_id LEFT JOIN portal.campaigns k ON k.id = b.campaign_id`,
      select: `b.id, b.contact_id, c.email, b.bounced_at, b.classification, COALESCE(b.enhanced_code, b.smtp_code) AS code, b.reason,
        b.action_taken, b.source, b.campaign_id, k.name AS campaign`,
      where, order: 'b.bounced_at DESC, b.id DESC',
      columns: [['bounced_at', 'When'], ['email', 'Email'], ['classification', 'Type'], ['code', 'Code'], ['reason', 'Reason'],
        ['action_taken', 'Action'], ['source', 'Source'], ['campaign', 'Campaign']],
    };
  }
  if (q.kind === 'events') {
    where.push(`e.actor_type = 'recipient'`);
    where.push(q.type ? `e.event_type = ${p(q.type)}` : `e.event_type = ANY(${p(EVENT_TYPES)}::text[])`);
    if (q.days) where.push(`e.created_at > NOW() - ${p(q.days)} * INTERVAL '1 day'`);
    if (q.campaign) where.push(`e.campaign_id = ${p(q.campaign)}`);
    if (q.q) where.push(`c.email ILIKE ${p(like(q.q))}`);
    return {
      from: `portal.recipient_events e LEFT JOIN portal.contacts c ON c.id = e.contact_id LEFT JOIN portal.campaigns k ON k.id = e.campaign_id`,
      select: `e.id, e.contact_id, COALESCE(c.email, '(erased)') AS email, e.created_at, e.event_type, e.campaign_id, k.name AS campaign`,
      where, order: 'e.created_at DESC, e.id DESC',
      columns: [['created_at', 'When'], ['email', 'Email'], ['event_type', 'Action'], ['campaign', 'Campaign']],
    };
  }
  // messages: everything that went (or should go) through the mail server
  if (q.message_kind) where.push(`m.kind = ${p(q.message_kind)}`);
  if (q.state === 'sent') where.push(`m.status = 'sent'`);
  if (q.state === 'failed') where.push(`m.status IN ('failed', 'unknown')`);
  if (q.state === 'pending') where.push(`m.status IN ('queued', 'sending')`);
  if (q.campaign) where.push(`m.campaign_id = ${p(q.campaign)}`);
  if (q.day) where.push(`m.sent_at >= ${p(q.day)}::date AND m.sent_at < ${p(q.day)}::date + 1`);
  else if (q.since) where.push(`m.sent_at >= ${p(q.since)}`);
  else if (q.days) where.push(`COALESCE(m.sent_at, m.updated_at) > NOW() - ${p(q.days)} * INTERVAL '1 day'`);
  if (q.q) where.push(`m.email ILIKE ${p(like(q.q))}`);
  return {
    from: `portal.messages m LEFT JOIN portal.campaigns k ON k.id = m.campaign_id`,
    select: `m.id, m.contact_id, m.email, m.kind, m.status, COALESCE(m.sent_at, m.updated_at) AS at, m.error, m.campaign_id, k.name AS campaign`,
    where, order: 'COALESCE(m.sent_at, m.updated_at) DESC, m.id DESC',
    columns: [['at', 'When'], ['email', 'Email'], ['kind', 'Type'], ['status', 'Status'], ['campaign', 'Campaign'], ['error', 'Error']],
  };
}

function detailRoutes(r, { pool }) {
  r.get('/details', async (req, res) => {
    const q = parse(base, req.query);
    if (q.format === 'csv' && !can(req.user.role, 'exports:read')) throw forbidden('Exporting needs the manager or administrator role');
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const spec = querySpec(q, p);
    let campaign = null;
    if (q.campaign) {
      const { rows } = await pool.query('SELECT id, name FROM portal.campaigns WHERE id = $1', [q.campaign]);
      if (!rows[0]) throw notFound('Campaign not found');
      campaign = rows[0];
    }
    const whereSql = spec.where.length ? `WHERE ${spec.where.join(' AND ')}` : '';
    if (q.format === 'csv') {
      const { rows } = await pool.query(`SELECT ${spec.select} FROM ${spec.from} ${whereSql} ORDER BY ${spec.order} LIMIT ${CSV_MAX}`, params);
      const name = `${q.kind}${q.outcome !== 'all' ? `-${q.outcome}` : ''}${campaign ? `-campaign-${campaign.id}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`;
      await streamCsv(res, name, spec.columns.map(([, l]) => l), [rows.map((x) => spec.columns.map(([k]) => x[k]))]);
      return;
    }
    const lim = p(q.per_page);
    const off = p((q.page - 1) * q.per_page);
    const { rows } = await pool.query(
      `SELECT ${spec.select}, COUNT(*) OVER() AS total FROM ${spec.from} ${whereSql} ORDER BY ${spec.order} LIMIT ${lim} OFFSET ${off}`, params);
    let link = null;
    if (q.link) link = (await pool.query('SELECT id, url FROM portal.links WHERE id = $1 AND campaign_id = $2', [q.link, q.campaign || 0])).rows[0] || null;
    res.json({
      success: true,
      data: rows.map(({ total, ...x }) => x),
      meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page, columns: spec.columns.map(([key, label]) => ({ key, label })), campaign, link },
    });
  });
}

module.exports = { detailRoutes, OUTCOMES };
