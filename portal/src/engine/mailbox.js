'use strict';

/**
 * Bounce mailbox reader (IMAP). Configured in Settings → Bounces. Reads every
 * message in the folder, records delivery failures and spam complaints, then
 * moves processed messages to "MailHarbor-Processed" (or deletes them).
 *
 * Use a mailbox dedicated to bounces: every message in it is processed.
 */
const { ImapFlow } = require('imapflow');
const { parseBounceEmail, processBounce } = require('./bounces');
const { raiseAlert, resolveAlert } = require('../lib/audit');

const PROCESSED_FOLDER = 'MailHarbor-Processed';
const MAX_PER_RUN = 200;

async function testMailbox(m) {
  const client = new ImapFlow({
    host: m.host, port: m.port, secure: m.secure, auth: { user: m.user, pass: m.password },
    logger: false, socketTimeout: 30000, connectionTimeout: 15000,
  });
  await client.connect();
  try {
    const status = await client.status(m.folder, { messages: true });
    return { ok: true, messages: status.messages };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function pollMailbox({ pool, settings, logger }) {
  const m = await settings.mailbox();
  if (!m.enabled) return { skipped: true };
  if (!m.host || !m.user || !m.password) {
    await raiseAlert(pool, 'bounce_mailbox_error', 'critical', 'The bounce mailbox is enabled but not fully configured (Settings → Bounces).');
    return { error: 'incomplete' };
  }
  const client = new ImapFlow({
    host: m.host, port: m.port, secure: m.secure, auth: { user: m.user, pass: m.password },
    logger: false, socketTimeout: 60000, connectionTimeout: 20000,
  });
  const stats = { checked: 0, bounces: 0, ignored: 0 };
  try {
    await client.connect();
    const lock = await client.getMailboxLock(m.folder);
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const done = [];
      for await (const msg of client.fetch('1:*', { uid: true, source: true }, { uid: false })) {
        if (stats.checked >= MAX_PER_RUN) break;
        stats.checked += 1;
        let reports = [];
        try {
          reports = await parseBounceEmail(msg.source);
        } catch (err) {
          logger.warn({ err: err.message, uid: msg.uid }, 'unparseable message in bounce mailbox');
        }
        if (!reports.length) stats.ignored += 1;
        for (const r of reports) {
          const res = await processBounce(pool, settings, {
            source: 'mailbox', sourceRef: r.ref || `uid:${uidValidity}:${msg.uid}:${r.email || ''}`,
            token: r.token, email: r.email, hint: r.hint, text: r.text,
          });
          if (res.status === 'processed') stats.bounces += 1;
        }
        done.push(msg.uid);
      }
      if (done.length) {
        if (m.after === 'delete') {
          await client.messageDelete(done, { uid: true });
        } else {
          await client.mailboxCreate(PROCESSED_FOLDER).catch(() => {}); // exists already
          await client.messageMove(done, PROCESSED_FOLDER, { uid: true });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    await resolveAlert(pool, 'bounce_mailbox_error');
    await pool.query(
      `INSERT INTO portal.sync_state (key, value) VALUES ('mailbox', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ at: new Date().toISOString(), ok: true, ...stats })]);
    return stats;
  } catch (err) {
    client.close();
    const reason = err.authenticationFailed ? 'login failed' : err.responseText || err.message;
    await raiseAlert(pool, 'bounce_mailbox_error', 'critical',
      `Cannot read the bounce mailbox (${reason}). Bounces are not being recorded.`, { host: m.host });
    await pool.query(
      `INSERT INTO portal.sync_state (key, value) VALUES ('mailbox', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(reason).slice(0, 300) })]);
    logger.warn({ reason }, 'bounce mailbox poll failed');
    return { error: reason };
  }
}

module.exports = { pollMailbox, testMailbox, PROCESSED_FOLDER };
