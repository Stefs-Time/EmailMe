'use strict';

/**
 * Background sync worker. Every SYNC_INTERVAL_SECONDS it:
 *   1. classifies new listmonk bounces and applies the suppression / review rules
 *   2. captures unsubscribes (and makes them global when GLOBAL_UNSUBSCRIBE=true)
 *   3. records any contact blocklisted directly in listmonk as suppressed
 *   4. enforces suppressions: anything suppressed or held is blocklisted in
 *      listmonk, so a suppressed address can never quietly become active again
 *   5. checks listmonk health and its logs for bounce-mailbox / SMTP errors
 *   6. purges staged import rows older than the retention period
 *
 * A PostgreSQL advisory lock makes this safe with several portal replicas.
 */

const { classifyBounce } = require('./bounceRules');
const { addSuppression } = require('../suppression/service');
const { recipientEvent, raiseAlert, resolveAlert } = require('../../lib/audit');
const { emailHash } = require('../../lib/email');

const LOCK_ID = 74219032;
const BATCH = 500;
const IMPORT_ROW_RETENTION_DAYS = 30;

async function getState(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM portal.sync_state WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setState(db, key, value) {
  await db.query(
    `INSERT INTO portal.sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

class SyncWorker {
  constructor({ pool, listmonk, config, logger }) {
    this.pool = pool;
    this.lm = listmonk;
    this.config = config;
    this.log = logger.child({ component: 'sync' });
    this.timer = null;
    this.running = null;
    this.cycle = 0;
  }

  start() {
    const tick = async () => {
      this.running = this.runOnce().catch((err) => this.log.error({ err }, 'sync cycle failed'));
      await this.running;
      this.running = null;
      if (this.timer !== false) this.timer = setTimeout(tick, this.config.SYNC_INTERVAL_SECONDS * 1000);
    };
    this.timer = setTimeout(tick, 2000);
  }

  async stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = false;
    if (this.running) await this.running;
  }

  /** Runs one full cycle. Returns stats, or null if another instance holds the lock. */
  async runOnce() {
    const client = await this.pool.connect();
    let locked = false;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
      locked = rows[0].ok;
      if (!locked) return null;
      this.cycle += 1;
      const stats = { bounces: 0, unsubscribes: 0, blocklistedImported: 0, enforced: 0 };
      let error = null;
      try {
        stats.bounces = await this.processBounces();
        stats.unsubscribes = await this.processUnsubscribes();
        stats.blocklistedImported = await this.reconcileBlocklisted();
        stats.enforced = await this.enforceSuppressions();
        await resolveAlert(this.pool, 'sync_failed');
      } catch (err) {
        error = err.message;
        this.log.error({ err }, 'sync step failed');
        await raiseAlert(this.pool, 'sync_failed', 'critical',
          'Recipient sync is failing. Suppression records may be out of date.', { error: err.message }).catch(() => {});
      }
      await this.healthChecks().catch((err) => this.log.warn({ err }, 'health check failed'));
      if (this.cycle % 60 === 1) await this.housekeeping().catch((err) => this.log.warn({ err }, 'housekeeping failed'));
      await setState(this.pool, 'heartbeat', { at: new Date().toISOString(), ok: !error, error, stats });
      if (Object.values(stats).some((n) => n > 0)) this.log.info({ stats }, 'sync cycle');
      return { ...stats, error };
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
      client.release();
    }
  }

  // 1. Bounces ---------------------------------------------------------------
  async processBounces() {
    const cursor = await getState(this.pool, 'bounce_cursor', { id: 0 });
    const { rows } = await this.pool.query(
      `SELECT b.id, b.subscriber_id, b.campaign_id, b.type, b.source, b.meta, b.created_at,
              s.email, s.status AS sub_status
         FROM bounces b JOIN subscribers s ON s.id = b.subscriber_id
        WHERE b.id > $1 ORDER BY b.id LIMIT $2`,
      [cursor.id, BATCH],
    );
    if (!rows.length) return 0;

    const toHold = [];
    for (const b of rows) {
      let c = classifyBounce(b.type, b.meta);
      // listmonk said "hard" (and has probably blocklisted the contact) but our
      // rules say the failure is temporary: let a person decide.
      if (c.classification === 'soft' && b.type === 'hard') {
        c = { ...c, classification: 'review', reason: `${c.reason} (listmonk recorded a hard bounce)` };
      }
      const hash = emailHash(b.email);
      let action = 'recorded';

      if (c.classification === 'hard' || c.classification === 'complaint') {
        const created = await addSuppression(this.pool, {
          email: b.email,
          subscriberId: b.subscriber_id,
          reason: c.classification === 'hard' ? 'hard_bounce' : 'complaint',
          source: `bounce:${b.source || 'unknown'}`,
          details: { bounce_id: b.id, campaign_id: b.campaign_id, code: c.enhancedCode, reason: c.reason },
        });
        action = created ? 'suppressed' : 'already_suppressed';
      } else if (c.classification === 'review') {
        const sup = await this.pool.query(
          'SELECT 1 FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL',
          [hash],
        );
        if (sup.rowCount) {
          action = 'already_suppressed';
        } else {
          const ins = await this.pool.query(
            `INSERT INTO portal.review_queue (subscriber_id, email_hash, reason, details)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (subscriber_id) WHERE resolved_at IS NULL DO NOTHING`,
            [b.subscriber_id, hash, c.reason, {
              bounce_id: b.id, campaign_id: b.campaign_id, code: c.enhancedCode, held_at: new Date().toISOString(),
              bounce_at: new Date(b.created_at).toISOString(),
              listmonk_status_before: b.sub_status,
            }],
          );
          if (ins.rowCount) {
            await recipientEvent(this.pool, {
              subscriberId: b.subscriber_id, emailHash: hash, type: 'review_hold', to: 'pending_review',
              details: { bounce_id: b.id, reason: c.reason },
            });
            toHold.push(b.subscriber_id);
          }
          action = 'held_for_review';
        }
      } else {
        await recipientEvent(this.pool, {
          subscriberId: b.subscriber_id, emailHash: hash, type: 'soft_bounce',
          details: { bounce_id: b.id, campaign_id: b.campaign_id, reason: c.reason },
        });
      }

      await this.pool.query(
        `INSERT INTO portal.bounce_events
           (listmonk_bounce_id, subscriber_id, email_hash, campaign_id, listmonk_type, classification,
            smtp_code, enhanced_code, reason, source, action_taken, bounced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (listmonk_bounce_id) DO NOTHING`,
        [b.id, b.subscriber_id, hash, b.campaign_id, b.type, c.classification, c.smtpCode,
          c.enhancedCode, c.reason, b.source, action, b.created_at],
      );
      await setState(this.pool, 'bounce_cursor', { id: b.id });
    }
    return rows.length;
  }

  // 2. Unsubscribes ----------------------------------------------------------
  async processUnsubscribes() {
    const cursor = await getState(this.pool, 'unsub_cursor', { at: '1970-01-01T00:00:00Z' });
    const { rows } = await this.pool.query(
      `SELECT x.subscriber_id, s.email, MAX(x.updated_at) AS at,
              ARRAY_AGG(x.list_id ORDER BY x.list_id) AS list_ids
         FROM subscriber_lists x JOIN subscribers s ON s.id = x.subscriber_id
        WHERE x.status = 'unsubscribed' AND x.updated_at > $1
        GROUP BY x.subscriber_id, s.email
        ORDER BY MAX(x.updated_at) LIMIT $2`,
      [cursor.at, BATCH],
    );
    if (!rows.length) return 0;
    let n = 0;
    for (const r of rows) {
      const hash = emailHash(r.email);
      const skip = await this.pool.query(
        `SELECT (SELECT 1 FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL) AS sup,
                (SELECT 1 FROM portal.review_queue WHERE subscriber_id = $2 AND resolved_at IS NULL) AS rev,
                (SELECT 1 FROM portal.recipient_events WHERE subscriber_id = $2 AND event_type = 'unsubscribed'
                    AND created_at >= $3::timestamptz - INTERVAL '2 minutes' LIMIT 1) AS seen`,
        [hash, r.subscriber_id, r.at],
      );
      const { sup, rev, seen } = skip.rows[0];
      if (!sup && !rev && !seen) {
        n += 1;
        await recipientEvent(this.pool, {
          subscriberId: r.subscriber_id, emailHash: hash, type: 'unsubscribed', to: 'unsubscribed',
          details: { list_ids: r.list_ids, global: this.config.GLOBAL_UNSUBSCRIBE }, actorType: 'listmonk',
        });
        await this.pool.query(
          `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, source)
           VALUES ($1, $2, $3, 'withdrawn', 'unsubscribe', 'listmonk')`,
          [r.subscriber_id, r.email.toLowerCase(), hash],
        );
        if (this.config.GLOBAL_UNSUBSCRIBE) {
          await addSuppression(this.pool, {
            email: r.email, subscriberId: r.subscriber_id, reason: 'unsubscribe', source: 'listmonk',
            details: { list_ids: r.list_ids },
          });
        }
      }
      await setState(this.pool, 'unsub_cursor', { at: new Date(r.at).toISOString() });
    }
    return n;
  }

  // 3. Contacts blocklisted directly in listmonk -----------------------------
  async reconcileBlocklisted() {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.email,
              EXISTS (SELECT 1 FROM bounces b WHERE b.subscriber_id = s.id AND b.type = 'complaint') AS complaint,
              EXISTS (SELECT 1 FROM bounces b WHERE b.subscriber_id = s.id AND b.type = 'hard') AS hard
         FROM subscribers s
        WHERE s.status = 'blocklisted'
          AND NOT EXISTS (SELECT 1 FROM portal.suppressions p
                           WHERE p.email_hash = encode(sha256(convert_to(LOWER(s.email), 'UTF8')), 'hex')
                             AND p.lifted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM portal.review_queue r WHERE r.subscriber_id = s.id AND r.resolved_at IS NULL)
        ORDER BY s.id LIMIT $1`,
      [BATCH],
    );
    for (const r of rows) {
      await addSuppression(this.pool, {
        email: r.email,
        subscriberId: r.id,
        reason: r.complaint ? 'complaint' : r.hard ? 'hard_bounce' : 'blocklisted',
        source: 'listmonk',
        actorType: 'listmonk',
      });
    }
    return rows.length;
  }

  // 4. Enforcement -----------------------------------------------------------
  async enforceSuppressions() {
    // Record suppressions now confirmed as applied (contact blocklisted in listmonk).
    await this.pool.query(
      `UPDATE portal.suppressions p SET enforced_at = NOW()
        WHERE p.enforced_at IS NULL AND p.lifted_at IS NULL
          AND EXISTS (SELECT 1 FROM subscribers s WHERE s.status = 'blocklisted'
                       AND encode(sha256(convert_to(LOWER(s.email), 'UTF8')), 'hex') = p.email_hash)`);
    const { rows } = await this.pool.query(
      `SELECT s.id, s.email, p.reason, (r.id IS NOT NULL) AS review,
              -- Already confirmed blocked once (or re-created since), as opposed to a
              -- suppression recorded moments ago that simply has not been applied yet.
              (p.id IS NOT NULL AND (p.enforced_at IS NOT NULL OR s.created_at > p.created_at)) AS reactivated
         FROM subscribers s
         LEFT JOIN portal.suppressions p
           ON p.email_hash = encode(sha256(convert_to(LOWER(s.email), 'UTF8')), 'hex') AND p.lifted_at IS NULL
         LEFT JOIN portal.review_queue r ON r.subscriber_id = s.id AND r.resolved_at IS NULL
        WHERE s.status <> 'blocklisted' AND (p.id IS NOT NULL OR r.id IS NOT NULL)
        ORDER BY s.id LIMIT $1`,
      [BATCH],
    );
    if (!rows.length) return 0;
    await this.lm.blocklistSubscribers(rows.map((r) => r.id));
    await this.pool.query(
      `UPDATE portal.suppressions SET enforced_at = COALESCE(enforced_at, NOW())
        WHERE lifted_at IS NULL AND email_hash = ANY($1::text[])`, [rows.map((r) => emailHash(r.email))]);
    const reactivated = [];
    for (const r of rows) {
      await recipientEvent(this.pool, {
        subscriberId: r.id, emailHash: emailHash(r.email), type: 'suppression_enforced', to: 'blocklisted',
        details: { reason: r.review ? 'pending_review' : r.reason },
      });
      // A suppressed address enabled again outside the portal: tell the administrators.
      if (r.reactivated) reactivated.push(r.id);
    }
    if (reactivated.length) {
      await raiseAlert(this.pool, 'suppression_reenforced', 'warning',
        `${reactivated.length} suppressed contact(s) were re-enabled in listmonk and have been blocked again. ` +
        'Reactivation must go through MailHarbor with a documented permission basis.',
        { subscriber_ids: reactivated.slice(0, 50) });
    }
    return rows.length;
  }

  // 5. Health ---------------------------------------------------------------
  async healthChecks() {
    try {
      await this.lm.health();
      await resolveAlert(this.pool, 'listmonk_unreachable');
    } catch (err) {
      await raiseAlert(this.pool, 'listmonk_unreachable', 'critical',
        'listmonk is not responding. Campaigns and bounce processing may be stopped.', { error: err.message });
      return;
    }

    // Scan listmonk's recent log lines for bounce mailbox and SMTP errors.
    try {
      const lines = (await this.lm.logs()) || [];
      const since = await getState(this.pool, 'log_cursor', { at: null });
      let newest = since.at;
      const bounceErrors = [];
      const smtpErrors = [];
      for (const line of lines) {
        const m = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(line);
        const at = m ? new Date(m[1].replace(/\//g, '-').replace(' ', 'T') + 'Z').toISOString() : null;
        if (!at || (since.at && at <= since.at)) continue;
        if (!newest || at > newest) newest = at;
        if (/bounce|pop3?|mailbox/i.test(line) && /(error|fail|unable|could not|refused|timeout)/i.test(line)) {
          bounceErrors.push(line.slice(0, 300));
        } else if (/(smtp|messenger|sending)/i.test(line) && /(error|fail)/i.test(line)) {
          smtpErrors.push(line.slice(0, 300));
        }
      }
      if (bounceErrors.length) {
        await raiseAlert(this.pool, 'bounce_mailbox_error', 'critical',
          'listmonk reported errors while processing the bounce mailbox. Bounces may not be recorded.',
          { lines: bounceErrors.slice(-5) });
        await setState(this.pool, 'bounce_error_at', { at: new Date().toISOString() });
      } else {
        const last = await getState(this.pool, 'bounce_error_at', { at: null });
        if (last.at && Date.now() - new Date(last.at).getTime() > 60 * 60 * 1000) {
          await resolveAlert(this.pool, 'bounce_mailbox_error');
        }
      }
      if (smtpErrors.length) {
        await raiseAlert(this.pool, 'smtp_errors', 'warning', 'listmonk reported SMTP sending errors.',
          { lines: smtpErrors.slice(-5) });
      }
      if (newest) await setState(this.pool, 'log_cursor', { at: newest });
    } catch (err) {
      this.log.debug({ err }, 'log scan skipped');
    }

    // Configuration checks every ~10 cycles.
    if (this.cycle % 10 === 1) {
      try {
        const s = await this.lm.settings();
        const mailboxes = (s['bounce.mailboxes'] || []).filter((m) => m.enabled);
        const anyWebhook = s['bounce.webhooks_enabled'] || s['bounce.ses_enabled'] || s['bounce.sendgrid_enabled'] ||
          s['bounce.postmark']?.enabled || s['bounce.azure']?.enabled || s['bounce.forwardemail']?.enabled;
        if (!s['bounce.enabled'] || (!mailboxes.length && !anyWebhook)) {
          await raiseAlert(this.pool, 'bounce_processing_disabled', 'warning',
            'Bounce processing is not enabled in listmonk (Settings → Bounces). Invalid addresses will not be suppressed automatically.');
        } else {
          await resolveAlert(this.pool, 'bounce_processing_disabled');
        }
      } catch (err) {
        this.log.debug({ err }, 'settings check skipped');
      }
    }
  }

  // 6. Housekeeping ---------------------------------------------------------
  async housekeeping() {
    const { rows } = await this.pool.query(
      `UPDATE portal.imports SET rows_purged_at = NOW()
        WHERE rows_purged_at IS NULL AND created_at < NOW() - ($1 || ' days')::interval
        RETURNING id`,
      [String(IMPORT_ROW_RETENTION_DAYS)],
    );
    if (rows.length) {
      await this.pool.query('DELETE FROM portal.import_rows WHERE import_id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    }
  }
}

module.exports = { SyncWorker, getState, setState };

/**
 * Runs fn while holding the sync lock, so a reactivation (lifting a
 * suppression, releasing a review hold) cannot interleave with an enforcement
 * pass that would immediately re-block the contact.
 */
async function withSyncLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('SET lock_timeout = 0');
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports.withSyncLock = withSyncLock;
