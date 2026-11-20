'use strict';

/**
 * Inbox: replies to campaigns, read and answered inside MailHarbor.
 *
 * Incoming (from the replies mailbox, and any human message that reaches the
 * bounce mailbox):
 *   1. classify: auto-reply (out of office) | unsubscribe request | reply
 *   2. thread:   In-Reply-To / References name the campaign email we sent
 *                (Message-ID <uuid@domain>, or the stored smtp_message_id for
 *                older sends) or an earlier message in a conversation.
 *                Otherwise the sender's address links it to the contact and to
 *                their most recent campaign (last 30 days).
 *   3. store:    text, sanitised HTML (served sandboxed, remote images blocked
 *                by default) and attachments (≤ 10 MB each, download only).
 *
 * Outgoing: answers are sent through the same SMTP server with In-Reply-To and
 * References, so they thread in the recipient's mail client, and their own
 * Message-ID, so a further reply joins the same conversation.
 */
const crypto = require('node:crypto');
const { simpleParser } = require('mailparser');
const { sanitize, htmlToText, escapeHtml } = require('./render');
const { normalizeEmail, isValidEmail } = require('../lib/email');
const { withTransaction } = require('../db/pool');

const MAX_TEXT = 200000;
const MAX_HTML = 1000000;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const THREAD_DAYS = 30;
const UUID_IN_ID = /^<?(?:reply\.)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;

/** Message-IDs from In-Reply-To and References, newest first, with angle brackets. */
function referencedIds(mail) {
  const refs = Array.isArray(mail.references) ? mail.references : String(mail.references || '').split(/\s+/);
  const all = [mail.inReplyTo, ...refs.reverse()].filter(Boolean).flatMap((x) => String(x).match(/<[^<>\s]+>/g) || []);
  return [...new Set(all)].slice(0, 30);
}

const header = (mail, name) => {
  const v = mail.headers?.get(name);
  return v === undefined || v === null ? '' : (typeof v === 'object' ? (v.value || v.text || JSON.stringify(v)) : String(v));
};

/** Out-of-office and other automatic answers (RFC 3834 and common vendor headers). */
function isAutoReply(mail) {
  const auto = header(mail, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (header(mail, 'x-autoreply') || header(mail, 'x-autorespond') || header(mail, 'x-autoresponse')) return true;
  if (/^(auto_reply|autoreply)$/i.test(header(mail, 'precedence').trim())) return true;
  return /^\s*(auto(matic)?[\s-]*(reply|response|antwort)|out of (the )?office|abwesenheit|automatisch(e)? antwort|i am (currently )?out of the office)/i.test(mail.subject || '');
}

/** The new part of a reply: everything above the quoted original. */
function newText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From:\s.+/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** "Please remove me", "unsubscribe", "stop emailing me"… (only in the new text, never in the quoted email). */
function isUnsubscribeRequest(text) {
  const t = newText(text).slice(0, 1500);
  return /\b(unsubscribe|un-subscribe|opt[\s-]?out|remove me|take me off|stop (sending|emailing|contacting)|do not (email|contact) me|don'?t (email|contact) me|no more emails)\b/i.test(t);
}

function classify(mail, text) {
  if (isAutoReply(mail)) return 'auto_reply';
  if (isUnsubscribeRequest(text)) return 'unsubscribe_request';
  return 'reply';
}

/**
 * Stores one incoming email in the Inbox.
 * @returns {Promise<{status: 'stored'|'duplicate'|'ignored', conversationId?: number, category?: string}>}
 */
async function ingestReply(pool, settings, raw, { source = 'replies mailbox' } = {}) {
  const mail = await simpleParser(raw, { skipImageLinks: true });
  const from = mail.from?.value?.[0] || {};
  const fromEmail = normalizeEmail(from.address || '');
  if (!fromEmail || !isValidEmail(fromEmail)) return { status: 'ignored', reason: 'no sender' };
  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail)) return { status: 'ignored', reason: 'system sender' };
  const s = await settings.all();
  // Never ingest our own emails (e.g. a copy kept in the mailbox).
  if ([s.from_email, s.reply_to].filter(Boolean).map(normalizeEmail).includes(fromEmail) && !mail.inReplyTo) {
    return { status: 'ignored', reason: 'own address' };
  }
  const rfcId = mail.messageId ? `<${String(mail.messageId).replace(/^<|>$/g, '')}>` : null;
  const html = mail.html ? sanitize(String(mail.html)).slice(0, MAX_HTML) : null;
  const text = (mail.text || (mail.html ? htmlToText(String(mail.html)) : '')).slice(0, MAX_TEXT);
  const category = classify(mail, text);
  const refs = referencedIds(mail);
  // Ordered by arrival, not the sender's Date header (whole seconds, and senders' clocks can be wrong).
  const receivedAt = new Date();

  try {
    return await withTransaction(pool, async (db) => {
      if (rfcId) {
        const dup = await db.query(`SELECT 1 FROM portal.inbox_messages WHERE direction = 'in' AND rfc_message_id = $1`, [rfcId]);
        if (dup.rowCount) return { status: 'duplicate' };
      }
      // 1. Thread: an earlier message in a conversation, or the campaign email we sent.
      let conversationId = null;
      let message = null;
      let matchedBy = 'none';
      if (refs.length) {
        const conv = await db.query(
          `SELECT conversation_id FROM portal.inbox_messages WHERE rfc_message_id = ANY($1::text[]) ORDER BY id DESC LIMIT 1`, [refs]);
        conversationId = conv.rows[0]?.conversation_id || null;
        const uuids = refs.map((r) => (UUID_IN_ID.exec(r) || [])[1]).filter(Boolean);
        const m = await db.query(
          `SELECT id, campaign_id, contact_id FROM portal.messages
            WHERE ${uuids.length ? 'uuid = ANY($2::uuid[]) OR ' : ''}smtp_message_id = ANY($1::text[]) ORDER BY id DESC LIMIT 1`,
          uuids.length ? [refs, uuids] : [refs]);
        message = m.rows[0] || null;
        if (message || conversationId) matchedBy = 'header';
      }
      const contact = message?.contact_id
        ? { id: message.contact_id }
        : (await db.query('SELECT id FROM portal.contacts WHERE LOWER(email) = $1', [fromEmail])).rows[0] || null;
      if (!message && !conversationId && contact) {
        // 2. No headers: the most recent campaign email sent to this person.
        const m = await db.query(
          `SELECT id, campaign_id, contact_id FROM portal.messages
            WHERE contact_id = $1 AND kind = 'campaign' AND sent_at > NOW() - ${THREAD_DAYS} * INTERVAL '1 day'
            ORDER BY sent_at DESC LIMIT 1`, [contact.id]);
        message = m.rows[0] || null;
        if (message) matchedBy = 'sender';
      }
      if (!conversationId) {
        const existing = await db.query(
          `SELECT id FROM portal.conversations WHERE LOWER(email) = $1
              AND (($2::int IS NOT NULL AND campaign_id = $2) OR ($2::int IS NULL AND last_message_at > NOW() - ${THREAD_DAYS} * INTERVAL '1 day'))
            ORDER BY last_message_at DESC LIMIT 1`, [fromEmail, message?.campaign_id ?? null]);
        conversationId = existing.rows[0]?.id || null;
      }
      if (!conversationId) {
        const created = await db.query(
          `INSERT INTO portal.conversations (contact_id, campaign_id, email, name, subject, category, status, last_message_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [contact?.id || null, message?.campaign_id || null, fromEmail, String(from.name || '').slice(0, 200),
            String(mail.subject || '(no subject)').slice(0, 500), category, category === 'auto_reply' ? 'closed' : 'open', receivedAt]);
        conversationId = created.rows[0].id;
      }
      const ins = await db.query(
        `INSERT INTO portal.inbox_messages (conversation_id, direction, rfc_message_id, in_reply_to, references_hdr, from_email, from_name,
                                            to_email, subject, text_body, html_body, message_id, matched_by, source, created_at)
         VALUES ($1, 'in', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [conversationId, rfcId, mail.inReplyTo || null, refs.join(' ') || null, fromEmail, String(from.name || '').slice(0, 200),
          mail.to?.value?.[0]?.address || null, String(mail.subject || '').slice(0, 500), text, html, message?.id || null, matchedBy, source, receivedAt]);
      for (const a of (mail.attachments || []).slice(0, MAX_ATTACHMENTS)) {
        const size = a.size || a.content?.length || 0;
        await db.query(
          `INSERT INTO portal.inbox_attachments (inbox_message_id, filename, content_type, size, data) VALUES ($1, $2, $3, $4, $5)`,
          [ins.rows[0].id, String(a.filename || 'attachment').replace(/[\r\n"\\/]/g, '_').slice(0, 200),
            String(a.contentType || 'application/octet-stream').slice(0, 100), size, size <= MAX_ATTACHMENT ? a.content : null]);
      }
      // A real reply reopens the conversation; an auto-reply never does. Unsubscribe requests stand out.
      await db.query(
        `UPDATE portal.conversations SET
            unread = CASE WHEN $2 = 'auto_reply' THEN unread ELSE TRUE END,
            status = CASE WHEN $2 = 'auto_reply' THEN status ELSE 'open' END,
            category = CASE WHEN $2 = 'unsubscribe_request' THEN 'unsubscribe_request'
                            WHEN $2 = 'reply' AND category = 'auto_reply' THEN 'reply' ELSE category END,
            contact_id = COALESCE(contact_id, $3), campaign_id = COALESCE(campaign_id, $4),
            last_direction = 'in', last_message_at = GREATEST(last_message_at, $5), message_count = message_count + 1, updated_at = NOW()
          WHERE id = $1`, [conversationId, category, contact?.id || null, message?.campaign_id || null, receivedAt]);
      return { status: 'stored', conversationId, category };
    });
  } catch (err) {
    if (err.code === '23505') return { status: 'duplicate' }; // the same email arrived twice at once
    throw err;
  }
}

/** "On 19 Nov 2026, Thandi wrote:" + the message, quoted. */
function quoteOf(m) {
  if (!m) return { text: '', html: '' };
  const when = new Date(m.created_at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  const who = m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email;
  const body = String(m.text_body || '').slice(0, 6000);
  return {
    text: `On ${when}, ${who} wrote:\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`,
    html: `<div style="color:#5f6b7a;margin-top:16px">On ${escapeHtml(when)}, ${escapeHtml(who)} wrote:</div>`
      + `<blockquote style="margin:4px 0 0 .8ex;border-left:2px solid #ccd3dc;padding-left:1ex;color:#475467">${escapeHtml(body).replace(/\n/g, '<br>')}</blockquote>`,
  };
}

/**
 * Sends an answer in a conversation and records it.
 * @returns {Promise<{ok: boolean, error?: string, id: number}>}
 */
async function sendReply(pool, settings, transport, { conversationId, user, body }) {
  const { rows: cv } = await pool.query(
    `SELECT v.*, c.from_name AS c_from_name, c.from_email AS c_from_email, c.reply_to AS c_reply_to
       FROM portal.conversations v LEFT JOIN portal.campaigns c ON c.id = v.campaign_id WHERE v.id = $1`, [conversationId]);
  const conv = cv[0];
  if (!conv) return null;
  const s = await settings.all();
  const { rows: lastIn } = await pool.query(
    `SELECT * FROM portal.inbox_messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
  const { rows: chain } = await pool.query(
    `SELECT rfc_message_id FROM portal.inbox_messages WHERE conversation_id = $1 AND rfc_message_id IS NOT NULL ORDER BY created_at, id`, [conversationId]);
  const fromEmail = conv.c_from_email || s.from_email;
  if (!fromEmail) throw Object.assign(new Error('No sender address configured (Settings → Sending).'), { status: 400, code: 'BAD_REQUEST' });
  const fromName = conv.c_from_name || s.from_name || s.org_name;
  const domain = fromEmail.split('@')[1] || 'mailharbor.invalid';
  const rfcId = `<reply.${crypto.randomUUID()}@${domain}>`;
  const subject = /^\s*re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`;
  const inReplyTo = lastIn[0]?.rfc_message_id || null;
  const references = [...new Set(chain.map((r) => r.rfc_message_id))].slice(-10).join(' ') || undefined;
  const q = quoteOf(lastIn[0]);
  const text = `${body}\n\n${q.text}`.trim();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b2430">${escapeHtml(body).replace(/\n/g, '<br>')}${q.html}</div>`;

  let error = null;
  try {
    await transport.sendMail({
      from: { name: fromName, address: fromEmail },
      to: conv.email,
      replyTo: conv.c_reply_to || s.reply_to || undefined,
      subject, text, html,
      messageId: rfcId,
      inReplyTo: inReplyTo || undefined,
      references,
      headers: { 'Auto-Submitted': 'no' },
      envelope: { from: s.bounce_address || fromEmail, to: conv.email },
    });
  } catch (err) {
    error = String(err.response || err.message).slice(0, 500);
  }
  const { rows } = await pool.query(
    `INSERT INTO portal.inbox_messages (conversation_id, direction, rfc_message_id, in_reply_to, references_hdr, from_email, from_name, to_email,
                                        subject, text_body, html_body, sent_by, send_status, error, source)
     VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, 'portal') RETURNING id`,
    [conversationId, rfcId, inReplyTo, references || null, fromEmail, user.name || '', conv.email, subject, body, user.id,
      error ? 'failed' : 'sent', error]);
  if (!error) {
    await pool.query(
      `UPDATE portal.conversations SET last_direction = 'out', last_message_at = NOW(), message_count = message_count + 1,
              unread = FALSE, updated_at = NOW() WHERE id = $1`, [conversationId]);
  }
  return { ok: !error, error, id: rows[0].id };
}

module.exports = { ingestReply, sendReply, classify, newText, isAutoReply, isUnsubscribeRequest, referencedIds };
