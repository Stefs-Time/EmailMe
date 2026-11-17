'use strict';

/**
 * Who may receive a campaign. Used when a campaign starts (snapshot) and
 * again immediately before each email is sent.
 *
 * A contact is eligible when ALL of these hold:
 *   - subscribed (confirmed) to at least one of the campaign's lists
 *   - not on the active suppression register (bounced, complained,
 *     unsubscribed, manually suppressed, erased)
 *   - not held in the review queue
 */
const NOT_SUPPRESSED = (alias = 'c') => `
  NOT EXISTS (SELECT 1 FROM portal.suppressions s WHERE s.email_hash = ${alias}.email_hash AND s.lifted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM portal.review_queue r WHERE r.contact_id = ${alias}.id AND r.resolved_at IS NULL)`;

/**
 * Optional segment narrowing: "AND <alias>.id IN (contacts matching the segment)".
 * Segments only narrow an audience; list membership still carries the consent.
 */
function segmentClause(rules, params, alias = 'c') {
  if (!rules) return '';
  const { BASE_SQL } = require('../modules/contacts/repo');
  const { compileRules } = require('../modules/segments/rules');
  const p = (v) => { params.push(v); return `$${params.length}`; };
  return ` AND ${alias}.id IN (SELECT seg.id FROM (${BASE_SQL}) seg WHERE ${compileRules(rules, p, 'seg')})`;
}

async function countEligible(db, listIds, segmentRules = null) {
  if (!listIds.length) return 0;
  const params = [listIds];
  const seg = segmentClause(segmentRules, params);
  const { rows } = await db.query(
    `SELECT COUNT(DISTINCT c.id)::int AS n FROM portal.contacts c
       JOIN portal.list_members m ON m.contact_id = c.id AND m.status = 'subscribed' AND m.list_id = ANY($1::int[])
      WHERE ${NOT_SUPPRESSED('c')}${seg}`, params);
  return rows[0].n;
}

/** Re-check for one queued campaign message just before sending. */
async function stillEligible(db, contactId, campaignId) {
  const { rows } = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM portal.suppressions s JOIN portal.contacts c ON c.email_hash = s.email_hash
                WHERE c.id = $1 AND s.lifted_at IS NULL) AS suppressed,
       EXISTS (SELECT 1 FROM portal.review_queue r WHERE r.contact_id = $1 AND r.resolved_at IS NULL) AS held,
       EXISTS (SELECT 1 FROM portal.list_members m JOIN portal.campaign_lists cl ON cl.list_id = m.list_id AND cl.campaign_id = $2
                WHERE m.contact_id = $1 AND m.status = 'subscribed') AS subscribed`, [contactId, campaignId]);
  const r = rows[0];
  if (r.suppressed) return { ok: false, reason: 'Suppressed after the campaign started' };
  if (r.held) return { ok: false, reason: 'Held for review after the campaign started' };
  if (!r.subscribed) return { ok: false, reason: 'No longer subscribed to the campaign lists' };
  return { ok: true };
}

module.exports = { NOT_SUPPRESSED, countEligible, stillEligible, segmentClause };
