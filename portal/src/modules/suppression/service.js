'use strict';

const { emailHash, normalizeEmail } = require('../../lib/email');
const { recipientEvent } = require('../../lib/audit');

const REASONS = ['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'blocklisted', 'erased'];

/** Returns Map(emailHash -> active suppression row) for the given hashes. */
async function activeByHashes(db, hashes) {
  if (!hashes.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, email_hash, reason, created_at FROM portal.suppressions
      WHERE lifted_at IS NULL AND email_hash = ANY($1::text[])`,
    [hashes],
  );
  return new Map(rows.map((r) => [r.email_hash, r]));
}

async function activeForEmail(db, email) {
  const m = await activeByHashes(db, [emailHash(email)]);
  return m.get(emailHash(email)) || null;
}

/**
 * Records a suppression (idempotent: one active row per address).
 * Returns true if a new suppression was created.
 */
async function addSuppression(db, { email, subscriberId, reason, source = '', details = {}, userId = null, actorType = 'system' }) {
  const hash = emailHash(email);
  const { rowCount } = await db.query(
    `INSERT INTO portal.suppressions (email, email_hash, reason, source, details, subscriber_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email_hash) WHERE lifted_at IS NULL DO NOTHING`,
    [normalizeEmail(email), hash, reason, source, details, subscriberId ?? null, userId],
  );
  if (rowCount) {
    await recipientEvent(db, {
      subscriberId,
      emailHash: hash,
      type: 'suppressed',
      to: reason,
      details: { source, ...details },
      actorType,
      actorId: userId,
    });
  }
  return rowCount > 0;
}

module.exports = { REASONS, activeByHashes, activeForEmail, addSuppression };
