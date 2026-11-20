'use strict';

/**
 * Mailbox readers (IMAP):
 *   bounce mailbox  (Settings → Bounces)  the Return-Path address
 *   replies mailbox (Settings → Replies)  the Reply-To address of campaigns
 *
 * Both are read the same way. Delivery reports (DSN) and spam complaints (ARF)
 * become bounces; any other email from a person becomes a conversation in the
 * Inbox (engine/inbox.js). Processed messages are moved to
 * "MailHarbor-Processed" (or deleted). A message that could not be stored stays
 * in the folder and is tried again on the next run.
 *
 * Use dedicated mailboxes: every message in the folder is processed.
 */
const { ImapFlow } = require('imapflow');
const { parseBounceEmail, processBounce } = require('./bounces');
const { ingestReply } = require('./inbox');
const { raiseAlert, resolveAlert } = require('../lib/audit');

const PROCESSED_FOLDER = 'MailHarbor-Processed';
const MAX_PER_RUN = 200;
const KINDS = {
  bounce: { state: 'mailbox', alert: 'bounce_mailbox_error', label: 'bounce mailbox', where: 'Settings → Bounces',
    impact: 'Bounces are not being recorded.' },
  replies: { state: 'replies_mailbox', alert: 'replies_mailbox_error', label: 'replies mailbox', where: 'Settings → Replies',
    impact: 'Replies to campaigns are not reaching the Inbox.' },
};

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

/** Handles one raw email from either mailbox. Returns 'bounce' | 'reply' | 'ignored'. Throws when it must be retried. */
async function handleMessage({ pool, settings, logger }, raw, { kind, ref }) {
  let reports = [];
  try {
    reports = await parseBounceEmail(raw);
  } catch (err) {
    logger.warn({ err: err.message, ref }, `unparseable message in the ${KINDS[kind].label}`);
    return 'ignored';
  }
  if (reports.length) {
    for (const r of reports) {
      await processBounce(pool, settings, {
        source: 'mailbox', sourceRef: r.ref || `${ref}:${r.email || ''}`, token: r.token, email: r.email, hint: r.hint, text: r.text,
      });
    }
    return 'bounce';
  }
  const res = await ingestReply(pool, settings, raw, { source: KINDS[kind].label });
  return res.status === 'stored' || res.status === 'duplicate' ? 'reply' : 'ignored';
}

async function pollMailbox({ pool, settings, logger, kind = 'bounce' }) {
  const k = KINDS[kind];
  const m = await settings.mailbox(kind);
  if (!m.enabled) return { skipped: true };
  if (!m.host || !m.user || !m.password) {
    await raiseAlert(pool, k.alert, 'critical', `The ${k.label} is enabled but not fully configured (${k.where}).`);
    return { error: 'incomplete' };
  }
  const client = new ImapFlow({
    host: m.host, port: m.port, secure: m.secure, auth: { user: m.user, pass: m.password },
    logger: false, socketTimeout: 60000, connectionTimeout: 20000,
  });
  const stats = { checked: 0, bounces: 0, replies: 0, ignored: 0, retry: 0 };
  try {
    await client.connect();
    const lock = await client.getMailboxLock(m.folder);
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const done = [];
      for await (const msg of client.fetch('1:*', { uid: true, source: true }, { uid: false })) {
        if (stats.checked >= MAX_PER_RUN) break;
        stats.checked += 1;
        try {
          const outcome = await handleMessage({ pool, settings, logger }, msg.source, { kind, ref: `uid:${kind}:${uidValidity}:${msg.uid}` });
          stats[{ bounce: 'bounces', reply: 'replies', ignored: 'ignored' }[outcome]] += 1;
          done.push(msg.uid);
        } catch (err) {
          stats.retry += 1; // left in the folder: tried again next time
          logger.error({ err, uid: msg.uid }, `could not store a message from the ${k.label}`);
        }
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
    await resolveAlert(pool, k.alert);
    await pool.query(
      `INSERT INTO portal.sync_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [k.state, JSON.stringify({ at: new Date().toISOString(), ok: true, ...stats })]);
    return stats;
  } catch (err) {
    client.close();
    const reason = err.authenticationFailed ? 'login failed' : err.responseText || err.message;
    await raiseAlert(pool, k.alert, 'critical', `Cannot read the ${k.label} (${reason}). ${k.impact}`, { host: m.host });
    await pool.query(
      `INSERT INTO portal.sync_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [k.state, JSON.stringify({ at: new Date().toISOString(), ok: false, error: String(reason).slice(0, 300) })]);
    logger.warn({ reason }, `${k.label} poll failed`);
    return { error: reason };
  }
}

module.exports = { pollMailbox, testMailbox, handleMessage, PROCESSED_FOLDER };
