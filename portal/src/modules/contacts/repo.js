'use strict';

/**
 * Read model for contacts. Reads listmonk's tables (inside READ ONLY
 * transactions) joined with the portal's suppression / review tables, and
 * derives one clear "recipient status" per contact (scope §3.3).
 *
 * All values are bound parameters; sort columns come from a whitelist.
 */

const STATUSES = [
  'active',
  'unconfirmed',
  'soft_bounced',
  'hard_bounced',
  'complaint',
  'unsubscribed',
  'blocklisted',
  'pending_review',
  'inactive',
  'no_lists',
];

/** Statuses that listmonk will actually send campaigns to. */
const ELIGIBLE = ['active', 'soft_bounced'];

const SORTS = {
  email: 'c.email',
  name: 'c.name',
  created_at: 'c.created_at',
  updated_at: 'c.updated_at',
  status: 'c.status',
  bounces: '(c.hard_bounces + c.soft_bounces)',
  last_bounce: 'c.last_bounce_at',
  source: "c.attribs->>'source'",
  company: "c.attribs->>'company'",
};

/**
 * Base SELECT producing one row per subscriber with derived fields.
 * Order of the CASE matters: suppression reasons first, then review holds.
 */
const BASE = `
SELECT s.id, s.uuid, s.email, s.name, s.attribs, s.status AS listmonk_status,
       s.created_at, s.updated_at,
       COALESCE(sl.total, 0) AS total_lists,
       COALESCE(sl.unsubscribed, 0) AS unsubscribed_lists,
       COALESCE(sl.list_ids, '{}') AS list_ids,
       sl.last_unsubscribed_at,
       COALESCE(b.hard, 0) AS hard_bounces,
       COALESCE(b.soft, 0) AS soft_bounces,
       COALESCE(b.complaint, 0) AS complaints,
       b.last_bounce_at,
       sup.reason AS suppression_reason,
       sup.created_at AS suppressed_at,
       (rq.id IS NOT NULL) AS pending_review,
       CASE
         WHEN sup.reason = 'complaint' OR (s.status = 'blocklisted' AND COALESCE(b.complaint, 0) > 0 AND rq.id IS NULL) THEN 'complaint'
         WHEN sup.reason = 'hard_bounce' THEN 'hard_bounced'
         WHEN sup.reason = 'unsubscribe' THEN 'unsubscribed'
         WHEN sup.reason IS NOT NULL THEN 'blocklisted'
         WHEN rq.id IS NOT NULL THEN 'pending_review'
         WHEN s.status = 'blocklisted' AND COALESCE(b.hard, 0) > 0 THEN 'hard_bounced'
         WHEN s.status = 'blocklisted' THEN 'blocklisted'
         WHEN s.status = 'disabled' THEN 'inactive'
         WHEN COALESCE(sl.total, 0) = 0 THEN 'no_lists'
         WHEN sl.unsubscribed = sl.total THEN 'unsubscribed'
         WHEN COALESCE(b.soft, 0) > 0 THEN 'soft_bounced'
         WHEN sl.sendable = 0 THEN 'unconfirmed'
         ELSE 'active'
       END AS status
FROM subscribers s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE x.status = 'unsubscribed')::int AS unsubscribed,
         COUNT(*) FILTER (WHERE x.status = 'confirmed'
                           OR (x.status = 'unconfirmed' AND l.optin <> 'double'))::int AS sendable,
         ARRAY_AGG(x.list_id ORDER BY x.list_id) FILTER (WHERE x.status <> 'unsubscribed') AS list_ids,
         MAX(x.updated_at) FILTER (WHERE x.status = 'unsubscribed') AS last_unsubscribed_at
  FROM subscriber_lists x JOIN lists l ON l.id = x.list_id
  WHERE x.subscriber_id = s.id
) sl ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) FILTER (WHERE type = 'hard')::int AS hard,
         COUNT(*) FILTER (WHERE type = 'soft')::int AS soft,
         COUNT(*) FILTER (WHERE type = 'complaint')::int AS complaint,
         MAX(created_at) AS last_bounce_at
  FROM bounces WHERE subscriber_id = s.id
) b ON TRUE
LEFT JOIN portal.suppressions sup
  ON sup.email_hash = encode(sha256(convert_to(LOWER(s.email), 'UTF8')), 'hex') AND sup.lifted_at IS NULL
LEFT JOIN portal.review_queue rq ON rq.subscriber_id = s.id AND rq.resolved_at IS NULL
`;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Builds WHERE clauses for the contact filters. Returns {where, params}.
 * Inner filters (on `s`) keep the lateral joins cheap; status filters apply
 * on the derived row.
 */
function buildFilters(f) {
  const inner = [];
  const outer = [];
  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };

  if (f.q) {
    const like = `%${escapeLike(f.q.trim())}%`;
    const ph = p(like);
    inner.push(`(s.email ILIKE ${ph} OR s.name ILIKE ${ph} OR s.attribs->>'company' ILIKE ${ph})`);
  }
  if (f.listId) {
    inner.push(`EXISTS (SELECT 1 FROM subscriber_lists z WHERE z.subscriber_id = s.id AND z.list_id = ${p(f.listId)})`);
  }
  if (f.source) inner.push(`s.attribs->>'source' = ${p(f.source)}`);
  if (f.consentMethod === 'none') inner.push(`COALESCE(s.attribs->'consent'->>'method', '') = ''`);
  else if (f.consentMethod) inner.push(`s.attribs->'consent'->>'method' = ${p(f.consentMethod)}`);
  if (f.createdFrom) inner.push(`s.created_at >= ${p(f.createdFrom)}`);
  if (f.createdTo) inner.push(`s.created_at < ${p(f.createdTo)}`);
  if (f.ids && f.ids.length) inner.push(`s.id = ANY(${p(f.ids)}::int[])`);

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
  const sql = `
    SELECT c.*, COUNT(*) OVER() AS total_count FROM (${BASE} ${innerWhere}) c
    ${outerWhere}
    ORDER BY ${orderCol} ${orderDir} NULLS LAST, c.id ${orderDir}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await client.query(sql, params);
  const total = rows.length ? Number(rows[0].total_count) : 0;
  return { rows: rows.map(strip), total };
}

/** Keyset-paginated iterator for exports (stable, memory-safe). */
async function* iterateContacts(client, filters, batchSize = 1000) {
  let lastId = 0;
  for (;;) {
    const { innerWhere, outerWhere, params } = buildFilters(filters);
    params.push(lastId, batchSize);
    const keyset = `c.id > $${params.length - 1}`;
    const where = outerWhere ? `${outerWhere} AND ${keyset}` : `WHERE ${keyset}`;
    const { rows } = await client.query(
      `SELECT c.* FROM (${BASE} ${innerWhere}) c ${where} ORDER BY c.id LIMIT $${params.length}`,
      params,
    );
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

async function findByEmails(client, emails) {
  if (!emails.length) return [];
  const { rows } = await client.query(
    `SELECT s.id, LOWER(s.email) AS email, s.status FROM subscribers s WHERE LOWER(s.email) = ANY($1::text[])`,
    [emails],
  );
  return rows;
}

async function getSubscriptions(client, subscriberId) {
  const { rows } = await client.query(
    `SELECT l.id, l.name, l.optin, l.type, x.status, x.created_at, x.updated_at
       FROM subscriber_lists x JOIN lists l ON l.id = x.list_id
      WHERE x.subscriber_id = $1 ORDER BY l.name`,
    [subscriberId],
  );
  return rows;
}

async function getBounces(client, subscriberId) {
  const { rows } = await client.query(
    `SELECT b.id, b.type, b.source, b.meta, b.created_at, c.name AS campaign_name, c.id AS campaign_id,
            pb.classification, pb.enhanced_code, pb.reason, pb.action_taken
       FROM bounces b
       LEFT JOIN campaigns c ON c.id = b.campaign_id
       LEFT JOIN portal.bounce_events pb ON pb.listmonk_bounce_id = b.id
      WHERE b.subscriber_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
    [subscriberId],
  );
  return rows;
}

async function getEngagement(client, subscriberId) {
  const { rows } = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM campaign_views WHERE subscriber_id = $1) AS views,
            (SELECT MAX(created_at) FROM campaign_views WHERE subscriber_id = $1) AS last_view_at,
            (SELECT COUNT(*)::int FROM link_clicks WHERE subscriber_id = $1) AS clicks,
            (SELECT MAX(created_at) FROM link_clicks WHERE subscriber_id = $1) AS last_click_at,
            -- listmonk does not log individual sends. This estimates the most recent
            -- campaign that targeted one of the contact's lists after they joined it.
            (SELECT MAX(c.started_at) FROM campaigns c
               JOIN campaign_lists cl ON cl.campaign_id = c.id
               JOIN subscriber_lists x ON x.list_id = cl.list_id AND x.subscriber_id = $1
              WHERE c.status IN ('running', 'finished', 'paused') AND c.started_at >= x.created_at
                AND c.type = 'regular') AS last_campaign_at_estimate`,
    [subscriberId],
  );
  return rows[0];
}

function strip(r) {
  // eslint-disable-next-line no-unused-vars
  const { total_count, ...rest } = r;
  return rest;
}

module.exports = {
  STATUSES,
  BASE_SQL: BASE,
  ELIGIBLE,
  SORTS,
  queryContacts,
  iterateContacts,
  getContact,
  findByEmails,
  getSubscriptions,
  getBounces,
  getEngagement,
  buildFilters,
};
