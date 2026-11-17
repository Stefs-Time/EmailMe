'use strict';

/**
 * Audit helpers. `db` may be the pool or a transaction client.
 */

async function audit(db, req, action, { targetType, targetId, details } = {}) {
  await db.query(
    `INSERT INTO portal.audit_log (actor_id, actor_email, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      req?.user?.id ?? null,
      req?.user?.email ?? null,
      action,
      targetType ?? null,
      targetId !== undefined && targetId !== null ? String(targetId) : null,
      details ?? {},
      req?.ip ?? null,
    ],
  );
}

async function recipientEvent(db, { contactId, emailHash, campaignId, type, from, to, details, actorType = 'system', actorId }) {
  await db.query(
    `INSERT INTO portal.recipient_events
       (contact_id, email_hash, campaign_id, event_type, from_status, to_status, details, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [contactId ?? null, emailHash ?? null, campaignId ?? null, type, from ?? null, to ?? null, details ?? {}, actorType, actorId ?? null],
  );
}

/** Opens (or bumps) an alert identified by `key`. */
async function raiseAlert(db, key, severity, message, details = {}) {
  await db.query(
    `INSERT INTO portal.alerts (key, severity, message, details)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) WHERE resolved_at IS NULL
     DO UPDATE SET occurrences = portal.alerts.occurrences + 1, last_seen = NOW(),
                   message = EXCLUDED.message, details = EXCLUDED.details, severity = EXCLUDED.severity`,
    [key, severity, message, details],
  );
}

async function resolveAlert(db, key) {
  await db.query(`UPDATE portal.alerts SET resolved_at = NOW() WHERE key = $1 AND resolved_at IS NULL`, [key]);
}

module.exports = { audit, recipientEvent, raiseAlert, resolveAlert };
