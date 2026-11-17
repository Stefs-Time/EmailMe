'use strict';

/**
 * Bounce processing for all sources:
 *   smtp    - the receiving server refused the recipient while we were sending
 *   mailbox - a delivery report (DSN) or spam complaint (ARF) arrived in the
 *             bounce mailbox (IMAP)
 *   webhook - an email provider posted a bounce/complaint event
 *
 * Every bounce is classified (bounceRules.js), recorded once and acted on:
 *   hard      -> permanent suppression
 *   complaint -> permanent suppression
 *   review    -> held from sending until a person decides (5.7.x etc.)
 *   soft      -> counted; suppressed after the configured soft-bounce limit
 */
const { simpleParser } = require('mailparser');
const { classifyBounce } = require('./bounceRules');
const { addSuppression } = require('../modules/suppression/service');
const { recipientEvent } = require('../lib/audit');
const { emailHash, normalizeEmail, isValidEmail } = require('../lib/email');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * @param {object} p
 * @param {'smtp'|'mailbox'|'webhook'|'manual'} p.source
 * @param {string} [p.sourceRef]  de-duplication key within the source
 * @param {string} [p.token]      recipient token (X-MailHarbor-ID)
 * @param {string} [p.email]
 * @param {'hard'|'soft'|'complaint'} [p.hint] verdict from the source, if any
 * @param {string} [p.text]       status / diagnostic text to classify
 */
async function processBounce(pool, settings, p) {
  let message = null;
  if (p.token && UUID_RE.test(p.token)) {
    const { rows } = await pool.query(
      `SELECT id, campaign_id, contact_id, email FROM portal.messages WHERE uuid = $1`, [p.token]);
    message = rows[0] || null;
  }
  let email = normalizeEmail(p.email || message?.email || '');
  let contactId = message?.contact_id ?? null;
  if (!contactId && email) {
    const { rows } = await pool.query('SELECT id FROM portal.contacts WHERE LOWER(email) = $1', [email]);
    contactId = rows[0]?.id ?? null;
  }
  if (!email && contactId) {
    const { rows } = await pool.query('SELECT email FROM portal.contacts WHERE id = $1', [contactId]);
    email = normalizeEmail(rows[0]?.email || '');
  }
  if (!email || !isValidEmail(email)) return { status: 'unmatched' };

  const c = classifyBounce(p.hint, p.text || '');
  const hash = emailHash(email);
  const campaignId = message?.campaign_id ?? null;

  const ins = await pool.query(
    `INSERT INTO portal.bounce_events
       (source, source_ref, message_id, contact_id, email_hash, campaign_id, classification, smtp_code, enhanced_code, reason, diagnostic, bounced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, NOW()))
     ON CONFLICT (source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
    [p.source, p.sourceRef || null, message?.id ?? null, contactId, hash, campaignId, c.classification,
      c.smtpCode, c.enhancedCode, c.reason, (p.text || '').slice(0, 1000), p.bouncedAt || null]);
  if (!ins.rowCount) return { status: 'duplicate' };
  const bounceId = ins.rows[0].id;

  if (contactId) await pool.query('UPDATE portal.contacts SET last_bounce_at = NOW() WHERE id = $1', [contactId]);

  let action = 'recorded';
  const details = { bounce_id: bounceId, campaign_id: campaignId, code: c.enhancedCode || c.smtpCode, reason: c.reason, source: p.source };
  if (c.classification === 'hard' || c.classification === 'complaint') {
    const created = await addSuppression(pool, {
      email, contactId, campaignId, reason: c.classification === 'hard' ? 'hard_bounce' : 'complaint',
      source: `bounce:${p.source}`, details,
    });
    action = created ? 'suppressed' : 'already_suppressed';
  } else if (c.classification === 'review' && contactId) {
    const r = await pool.query(
      `INSERT INTO portal.review_queue (contact_id, email_hash, reason, details) VALUES ($1, $2, $3, $4)
       ON CONFLICT (contact_id) WHERE resolved_at IS NULL DO NOTHING`, [contactId, hash, c.reason, details]);
    if (r.rowCount) {
      await recipientEvent(pool, { contactId, emailHash: hash, campaignId, type: 'review_hold', to: 'pending_review', details });
    }
    action = 'held_for_review';
  } else if (c.classification === 'soft' && contactId) {
    const { rows } = await pool.query(
      'UPDATE portal.contacts SET soft_bounces = soft_bounces + 1 WHERE id = $1 RETURNING soft_bounces', [contactId]);
    const s = await settings.all();
    await recipientEvent(pool, { contactId, emailHash: hash, campaignId, type: 'soft_bounce', details: { ...details, count: rows[0].soft_bounces } });
    if (rows[0].soft_bounces >= s.soft_bounce_limit) {
      await addSuppression(pool, { email, contactId, campaignId, reason: 'soft_limit', source: `bounce:${p.source}`,
        details: { ...details, soft_bounces: rows[0].soft_bounces, limit: s.soft_bounce_limit } });
      action = 'suppressed_soft_limit';
    } else {
      action = 'counted';
    }
  }
  await pool.query('UPDATE portal.bounce_events SET action_taken = $2 WHERE id = $1', [bounceId, action]);
  return { status: 'processed', classification: c.classification, action, contactId, campaignId };
}

/** Unfolds header continuation lines. */
function unfold(text) {
  return String(text || '').replace(/\r?\n[ \t]+/g, ' ');
}

/**
 * Extracts bounce reports from a raw email (DSN, ARF or heuristic).
 * Returns [] for messages that are not bounces (e.g. auto-replies).
 */
async function parseBounceEmail(raw) {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const parts = [unfold(raw.toString('utf8'))];
  for (const a of mail.attachments || []) {
    if (/^(message|text)\//i.test(a.contentType || '')) parts.push(unfold(a.content.toString('utf8')));
  }
  if (mail.text) parts.push(unfold(mail.text));
  const all = parts.join('\n');
  const token = (/X-MailHarbor-ID:\s*([0-9a-f-]{36})/i.exec(all) || [])[1];
  const ref = mail.messageId || null;

  // Spam complaint (Abuse Reporting Format, RFC 5965).
  if (/message\/feedback-report/i.test(all) || /^Feedback-Type:\s*abuse/im.test(all)) {
    const orig = (/^Original-Rcpt-To:\s*<?([^\s>]+@[^\s>]+)>?/im.exec(all) || /^To:\s*.*?<?([^\s<>"]+@[^\s<>"]+)>?\s*$/im.exec(all) || [])[1];
    return [{ kind: 'arf', hint: 'complaint', token, email: orig, text: 'Spam complaint (feedback report)', ref }];
  }

  // Delivery Status Notification (RFC 3464): one block per recipient.
  const reports = [];
  const dsnRe = /Final-Recipient:\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)>?([\s\S]*?)(?=Final-Recipient:|$)/gi;
  let m;
  while ((m = dsnRe.exec(all))) {
    const block = m[2];
    const action = (/^\s*Action:\s*(\w+)/im.exec(block) || [])[1]?.toLowerCase();
    if (action && !['failed', 'delayed'].includes(action)) continue;
    const status = (/^\s*Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(block) || [])[1] || '';
    const diag = (/^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.+)$/im.exec(block) || [])[1] || '';
    reports.push({
      kind: 'dsn', hint: action === 'delayed' || status.startsWith('4') ? 'soft' : 'hard',
      token, email: m[1], text: `${status} ${diag}`.trim(), ref: ref && `${ref}#${m[1]}`,
    });
  }
  if (reports.length) {
    // Several identical blocks for one address appear in some reports.
    const seen = new Set();
    return reports.filter((r) => !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
  }

  // Not a standard report. Treat it as a bounce only if it clearly is one.
  const subject = mail.subject || '';
  const autoReply = /^auto-(replied|generated)/im.test(String(mail.headers.get('auto-submitted') || '')) &&
    !/undeliver|failure|returned/i.test(subject);
  if (autoReply || /out of (the )?office|automatic reply|auto.?reply/i.test(subject)) return [];
  if (!/undeliver|delivery (status|failure|has failed)|returned mail|failure notice|mail delivery failed|could not be delivered/i.test(subject + all.slice(0, 2000))) return [];
  const rcpt = (/(?:^|\s)<?([^\s<>@"']+@[^\s<>"']+\.[a-z]{2,})>?:?\s*(?:\r?\n)?\s*(?:host|SMTP error|said|550|5\.\d\.\d)/im.exec(mail.text || '') || [])[1];
  const code = (/\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(mail.text || '') || [])[1] || '';
  const basic = (/\b([45]\d\d)[ -]/.exec(mail.text || '') || [])[1] || '';
  return [{ kind: 'heuristic', hint: undefined, token, email: rcpt, text: `${code} ${basic} ${(mail.text || '').slice(0, 600)}`, ref }];
}

module.exports = { processBounce, parseBounceEmail };
