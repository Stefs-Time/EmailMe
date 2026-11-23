'use strict';

/**
 * Read model for contacts: one derived recipient status per contact
 * (scope §3.3), filtering, sorting and keyset iteration for exports.
 * All values are bound parameters; sort columns come from a whitelist.
 */

const STATUSES = [
  'active', 'unconfirmed', 'soft_bounced', 'hard_bounced', 'complaint',
  'unsubscribed', 'blocklisted', 'pending_review', 'no_lists',
];

/** Statuses that receive campaigns. */
const ELIGIBLE = ['active', 'soft_bounced'];

const SORTS = {
  email: 'c.email',
  name: "LOWER(c.first_name || ' ' || c.last_name)",
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  status: 'c.status',
  bounces: '(c.hard_bounces + c.soft_bounce_events)',
  last_bounce: 'c.last_bounce_at',
  last_sent: 'c.last_sent_at',
  source: 'c.source',
  company: 'LOWER(c.company)',
};

/** Order matters: suppression reasons first, then review holds, then list state. */
const BASE = `
SELECT s.id, s.uuid, s.email, s.first_name, s.last_name, s.company, s.source, s.attribs, s.consent,
       TRIM(s.first_name || ' ' || s.last_name) AS name,
       s.soft_bounces, s.last_sent_at, s.last_open_at, s.last_click_at, s.last_bounce_at,
       s.created_at, s.updated_at,
       COALESCE(ml.total, 0) AS total_lists,
       COALESCE(ml.unsubscribed, 0) AS unsubscribed_lists,
       COALESCE(ml.list_ids, '{}') AS list_ids,
       ml.last_unsubscribed_at,
       COALESCE(b.hard, 0) AS hard_bounces,
       COALESCE(b.soft, 0) AS soft_bounce_events,
       COALESCE(b.complaint, 0) AS complaints,
       sup.reason AS suppression_reason,
       sup.created_at AS suppressed_at,
       (rq.id IS NOT NULL) AS pending_review,
       CASE
         WHEN sup.reason = 'complaint' THEN 'complaint'
         WHEN sup.reason IN ('hard_bounce', 'soft_limit') THEN 'hard_bounced'
         WHEN sup.reason = 'unsubscribe' THEN 'unsubscribed'
         WHEN sup.reason IS NOT NULL THEN 'blocklisted'
         WHEN rq.id IS NOT NULL THEN 'pending_review'
         WHEN COALESCE(ml.total, 0) = 0 THEN 'no_lists'
         WHEN ml.unsubscribed = ml.total THEN 'unsubscribed'
         WHEN ml.subscribed = 0 THEN 'unconfirmed'
         WHEN s.soft_bounces > 0 THEN 'soft_bounced'
         ELSE 'active'
       END AS status
FROM portal.contacts s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE m.status = 'unsubscribed')::int AS unsubscribed,
         COUNT(*) FILTER (WHERE m.status = 'subscribed')::int AS subscribed,
         ARRAY_AGG(m.list_id ORDER BY m.list_id) FILTER (WHERE m.status <> 'unsubscribed') AS list_ids,
         MAX(m.unsubscribed_at) AS last_unsubscribed_at
  FROM portal.list_members m WHERE m.contact_id = s.id
) ml ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE classification = 'hard')::int AS hard,
         COUNT(*) FILTER (WHERE classification = 'soft')::int AS soft,
         COUNT(*) FILTER (WHERE classification = 'complaint')::int AS complaint
  FROM portal.bounce_events WHERE contact_id = s.id
) b ON TRUE
LEFT JOIN portal.suppressions sup ON sup.email_hash = s.email_hash AND sup.lifted_at IS NULL
LEFT JOIN portal.review_queue rq ON rq.contact_id = s.id AND rq.resolved_at IS NULL
`;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function buildFilters(f) {
  const inner = [];
  const outer = [];
  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.q) {
    const ph = p(`%${escapeLike(f.q.trim())}%`);
    inner.push(`(s.email ILIKE ${ph} OR (s.first_name || ' ' || s.last_name) ILIKE ${ph} OR s.company ILIKE ${ph})`);
  }
  if (f.listId) inner.push(`EXISTS (SELECT 1 FROM portal.list_members z WHERE z.contact_id = s.id AND z.list_id = ${p(f.listId)})`);
  if (f.source) inner.push(`s.source = ${p(f.source)}`);
  if (f.consentMethod === 'none') inner.push(`COALESCE(s.consent->>'method', '') = ''`);
  else if (f.consentMethod) inner.push(`s.consent->>'method' = ${p(f.consentMethod)}`);
  if (f.createdFrom) inner.push(`s.created_at >= ${p(f.createdFrom)}`);
  if (f.createdTo) inner.push(`s.created_at < ${p(f.createdTo)}`);
  if (f.ids && f.ids.length) inner.push(`s.id = ANY(${p(f.ids)}::int[])`);
  // Saved segment: rules compiled to SQL with bound parameters (segments/rules.js).
  if (f.segmentRules) outer.push(require('../segments/rules').compileRules(f.segmentRules, p, 'c'));
  if (f.status) {
    if (f.status === 'eligible') outer.push(`c.status = ANY(${p(ELIGIBLE)}::text[])`);
    else if (f.status === 'suppressed') outer.push(`c.suppression_reason IS NOT NULL`);
    else outer.push(`c.status = ${p(f.status)}`);
  }
  return {
    innerWhere: inner.length ? `WHERE ${inner.join(' AND ')}` : '',
    outerWhere: outer.length ? `WHERE ${outer.join(' AND ')}` : '',
    params,
  };
}

async function queryContacts(client, filters, { page = 1, perPage = 25, sort = 'created_at', dir = 'desc' } = {}) {
  const { innerWhere, outerWhere, params } = buildFilters(filters);
  const orderCol = SORTS[sort] || SORTS.created_at;
  const orderDir = dir === 'asc' ? 'ASC' : 'DESC';
  params.push(perPage, (page - 1) * perPage);
  const { rows } = await client.query(
    `SELECT c.*, COUNT(*) OVER() AS total_count FROM (${BASE} ${innerWhere}) c ${outerWhere}
      ORDER BY ${orderCol} ${orderDir} NULLS LAST, c.id ${orderDir}
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { rows: rows.map(strip), total: rows.length ? Number(rows[0].total_count) : 0 };
}

async function matchingIds(client, filters, limit) {
  const { innerWhere, outerWhere, params } = buildFilters(filters);
  params.push(limit + 1);
  const { rows } = await client.query(
    `SELECT c.id FROM (${BASE} ${innerWhere}) c ${outerWhere} ORDER BY c.id LIMIT $${params.length}`, params);
  return { ids: rows.slice(0, limit).map((r) => r.id), truncated: rows.length > limit };
}

async function* iterateContacts(client, filters, batchSize = 1000) {
  let lastId = 0;
  for (;;) {
    const { innerWhere, outerWhere, params } = buildFilters(filters);
    params.push(lastId, batchSize);
    const keyset = `c.id > $${params.length - 1}`;
    const where = outerWhere ? `${outerWhere} AND ${keyset}` : `WHERE ${keyset}`;
    const { rows } = await client.query(
      `SELECT c.* FROM (${BASE} ${innerWhere}) c ${where} ORDER BY c.id LIMIT $${params.length}`, params);
    if (!rows.length) return;
    yield rows.map(strip);
    lastId = rows[rows.length - 1].id;
    if (rows.length < batchSize) return;
  }
}

async function getContact(client, id) {
  const { rows } = await client.query(`SELECT c.* FROM (${BASE} WHERE s.id = $1) c`, [id]);
  return rows[0] ? strip(rows[0]) : null;
}

async function getSubscriptions(client, contactId) {
  const { rows } = await client.query(
    `SELECT l.id, l.name, l.optin, m.status, m.created_at, m.updated_at, m.confirmed_at, m.unsubscribed_at
       FROM portal.list_members m JOIN portal.lists l ON l.id = m.list_id
      WHERE m.contact_id = $1 ORDER BY l.name`, [contactId]);
  return rows;
}

async function getBounces(client, contactId) {
  const { rows } = await client.query(
    `SELECT b.id, b.source, b.classification, b.enhanced_code, b.smtp_code, b.reason, b.action_taken, b.bounced_at,
            c.name AS campaign_name, c.id AS campaign_id
       FROM portal.bounce_events b LEFT JOIN portal.campaigns c ON c.id = b.campaign_id
      WHERE b.contact_id = $1 ORDER BY b.bounced_at DESC LIMIT 100`, [contactId]);
  return rows;
}

async function getMessages(client, contactId) {
  const { rows } = await client.query(
    `SELECT m.id, m.kind, m.status, m.sent_at, m.error, m.created_at, c.name AS campaign_name, c.id AS campaign_id,
            EXISTS (SELECT 1 FROM portal.tracking_events t WHERE t.message_id = m.id AND t.kind = 'open') AS opened,
            EXISTS (SELECT 1 FROM portal.tracking_events t WHERE t.message_id = m.id AND t.kind = 'click') AS clicked
       FROM portal.messages m LEFT JOIN portal.campaigns c ON c.id = m.campaign_id
      WHERE m.contact_id = $1 AND m.kind <> 'test' ORDER BY m.created_at DESC LIMIT 50`, [contactId]);
  return rows;
}

function strip(r) {
   
  const { total_count, ...rest } = r;
  return rest;
}

module.exports = {
  STATUSES, ELIGIBLE, SORTS, BASE_SQL: BASE,
  queryContacts, matchingIds, iterateContacts, getContact, getSubscriptions, getBounces, getMessages, buildFilters,
};
