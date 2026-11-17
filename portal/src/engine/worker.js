'use strict';

/**
 * Background work, all in-process:
 *   sender     every second   deliver queued emails (rate-limited)
 *   scheduler  every 15 s     start campaigns whose send time has come
 *   mailbox    every N min    read the bounce mailbox (Settings → Bounces)
 *   upkeep     every minute   heartbeat, stale-send recovery, backup check,
 *                             hourly purge of old import staging rows
 * Mailbox and upkeep take a PostgreSQL advisory lock, so extra replicas are safe.
 */
const { Sender, startCampaign } = require('./sender');
const { pollMailbox } = require('./mailbox');
const { raiseAlert, resolveAlert } = require('../lib/audit');

const LOCK_MAILBOX = 74219041;
const LOCK_UPKEEP = 74219042;

async function getState(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM portal.sync_state WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setState(db, key, value) {
  await db.query(
    `INSERT INTO portal.sync_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]);
}

async function withLock(pool, id, fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [id])).rows[0].ok;
    if (!locked) return null;
    return await fn();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [id]).catch(() => {});
    client.release();
  }
}

class Worker {
  constructor({ pool, settings, transport, logger }) {
    this.pool = pool;
    this.settings = settings;
    this.log = logger.child({ component: 'worker' });
    this.sender = new Sender({ pool, settings, transport, logger });
    this.timers = [];
    this.running = new Set();
    this.stopped = false;
    this.lastMailbox = 0;
    this.lastHousekeeping = 0;
  }

  loop(name, everyMs, fn) {
    const run = async () => {
      if (this.stopped) return;
      const p = fn().catch((err) => this.log.error({ err, loop: name }, 'worker loop failed'));
      this.running.add(p);
      await p;
      this.running.delete(p);
      if (!this.stopped) this.timers.push(setTimeout(run, everyMs));
    };
    this.timers.push(setTimeout(run, 1000));
  }

  async start() {
    await this.sender.recoverInterrupted();
    this.loop('sender', 1000, async () => {
      // Keep sending while there is budget and work.
      for (let i = 0; i < 20 && !this.stopped; i += 1) if (!(await this.sender.tick())) break;
    });
    this.loop('scheduler', 15000, () => this.startDue());
    this.loop('mailbox', 30000, () => this.mailboxIfDue());
    this.loop('upkeep', 60000, () => withLock(this.pool, LOCK_UPKEEP, () => this.upkeep()));
  }

  async stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    await Promise.allSettled([...this.running]);
  }

  async startDue() {
    const { rows } = await this.pool.query(
      `SELECT id FROM portal.campaigns WHERE status = 'scheduled' AND send_at <= NOW() ORDER BY send_at LIMIT 10`);
    for (const r of rows) {
      const n = await startCampaign(this.pool, r.id, this.settings);
      if (n !== null) this.log.info({ campaign: r.id, recipients: n }, 'scheduled campaign started');
    }
  }

  async mailboxIfDue(force = false) {
    const m = await this.settings.mailbox();
    if (!m.enabled) return null;
    if (!force && Date.now() - this.lastMailbox < m.interval_minutes * 60000) return null;
    this.lastMailbox = Date.now();
    return withLock(this.pool, LOCK_MAILBOX, () => pollMailbox({ pool: this.pool, settings: this.settings, logger: this.log }));
  }

  async upkeep() {
    await setState(this.pool, 'heartbeat', { at: new Date().toISOString(), ok: true });
    await this.sender.recoverInterrupted();
    await this.checkBackups();
    await this.checkConfig();
    if (Date.now() - this.lastHousekeeping > 3600000) {
      this.lastHousekeeping = Date.now();
      const { rows } = await this.pool.query(
        `UPDATE portal.imports SET rows_purged_at = NOW()
          WHERE rows_purged_at IS NULL AND created_at < NOW() - INTERVAL '30 days' RETURNING id`);
      if (rows.length) await this.pool.query('DELETE FROM portal.import_rows WHERE import_id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
    }
  }

  /** Alerts for settings that block sending or compliance. */
  async checkConfig() {
    const s = await this.settings.all();
    const url = await this.settings.publicUrl();
    if (!url) {
      await raiseAlert(this.pool, 'public_url_missing', 'critical', 'The public URL is not set (Settings → General). Emails cannot include unsubscribe links, so nothing will be sent.');
    } else await resolveAlert(this.pool, 'public_url_missing');
    if (!s.bounce_mailbox.enabled) {
      await raiseAlert(this.pool, 'bounce_mailbox_off', 'warning',
        'No bounce mailbox is configured (Settings → Bounces). Rejections during sending are still recorded, but bounces that arrive later by email are not.');
    } else await resolveAlert(this.pool, 'bounce_mailbox_off');
  }

  /** Scope §8: backup execution status. */
  async checkBackups() {
    const s = await this.settings.all();
    const hours = s.backup_stale_hours;
    if (!hours) return;
    const hb = await getState(this.pool, 'backup_heartbeat', null);
    const ageH = hb ? (Date.now() - new Date(hb.at).getTime()) / 3600000 : Infinity;
    if (hb && !hb.ok) await raiseAlert(this.pool, 'backup_failed', 'critical', `The last database backup failed: ${hb.error || 'unknown error'}`);
    else await resolveAlert(this.pool, 'backup_failed');
    if (ageH > hours) {
      await raiseAlert(this.pool, 'backup_stale', 'warning', hb
        ? `No successful database backup in the last ${Math.floor(ageH)} hours.`
        : 'No database backup has been recorded yet. Check the backup job.');
    } else await resolveAlert(this.pool, 'backup_stale');
  }
}

module.exports = { Worker, getState, setState };
