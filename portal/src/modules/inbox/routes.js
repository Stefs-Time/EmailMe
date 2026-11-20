'use strict';

/**
 * Inbox: replies to campaigns.
 *
 *   GET    /api/inbox                       conversations (view, q, campaign, contact, page)
 *   GET    /api/inbox/counts                numbers for the menu badge and the view tabs
 *   GET    /api/inbox/:id                   one conversation with its messages (marks it read)
 *   POST   /api/inbox/:id/reply             answer by email                    (inbox:reply)
 *   POST   /api/inbox/:id/notes             internal note, never emailed       (inbox:reply)
 *   PATCH  /api/inbox/:id                   status, assignee, unread           (inbox:reply)
 *   POST   /api/inbox/:id/unsubscribe       honour an unsubscribe request      (contacts:write)
 *   GET    /api/inbox/messages/:id/html     the original email, sandboxed; ?images=1 loads remote images
 *   GET    /api/inbox/attachments/:id       download an attachment (never displayed inline)
 */
const express = require('express');
const { z } = require('zod');
const { parse, notFound, conflict, upstream } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { withTransaction } = require('../../db/pool');
const { sendReply } = require('../../engine/inbox');
const { unsubscribeContact } = require('../contacts/service');

const id = z.coerce.number().int().positive();
const VIEWS = ['open', 'mine', 'unassigned', 'unsubscribe', 'auto', 'closed', 'all'];
const like = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

function inboxRoutes({ pool, settings, transport }) {
  const r = express.Router();
  r.use(requirePermission('inbox:read'));

  // Lazy: only the chosen view binds its parameters (unused bound parameters are a PostgreSQL error).
  const VIEW_SQL = {
    open: () => `v.status = 'open'`,
    mine: (userId, p) => `v.status = 'open' AND v.assigned_to = ${p(userId)}`,
    unassigned: () => `v.status = 'open' AND v.assigned_to IS NULL`,
    unsubscribe: () => `v.status = 'open' AND v.category = 'unsubscribe_request'`,
    auto: () => `v.category = 'auto_reply'`,
    closed: () => `v.status = 'closed' AND v.category <> 'auto_reply'`,
    all: () => 'TRUE',
  };
  const viewClause = (view, userId, p) => VIEW_SQL[view](userId, p);

  r.get('/', async (req, res) => {
    const q = parse(z.object({
      view: z.enum(VIEWS).default('open'),
      q: z.string().trim().max(200).optional(),
      campaign: z.coerce.number().int().positive().optional(),
      contact: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().min(1).default(1),
      per_page: z.coerce.number().int().min(1).max(100).default(30),
    }), req.query);
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    // A campaign or contact filter shows every conversation, whatever its state.
    const where = [q.campaign || q.contact ? 'TRUE' : viewClause(q.view, req.user.id, p)];
    if (q.campaign) where.push(`v.campaign_id = ${p(q.campaign)}`);
    if (q.contact) where.push(`v.contact_id = ${p(q.contact)}`);
    if (q.q) {
      const ph = p(like(q.q));
      where.push(`(v.email ILIKE ${ph} OR v.name ILIKE ${ph} OR v.subject ILIKE ${ph}
        OR EXISTS (SELECT 1 FROM portal.inbox_messages x WHERE x.conversation_id = v.id AND x.text_body ILIKE ${ph}))`);
    }
    const lim = p(q.per_page);
    const off = p((q.page - 1) * q.per_page);
    const { rows } = await pool.query(
      `SELECT v.id, v.email, v.name, v.subject, v.status, v.category, v.unread, v.last_direction, v.last_message_at, v.message_count,
              v.contact_id, v.campaign_id, k.name AS campaign, u.name AS assigned_name, v.assigned_to,
              (SELECT LEFT(REGEXP_REPLACE(x.text_body, '\\s+', ' ', 'g'), 160) FROM portal.inbox_messages x
                WHERE x.conversation_id = v.id AND x.direction <> 'note' ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS snippet,
              COUNT(*) OVER() AS total
         FROM portal.conversations v
         LEFT JOIN portal.campaigns k ON k.id = v.campaign_id
         LEFT JOIN portal.users u ON u.id = v.assigned_to
        WHERE ${where.join(' AND ')}
        ORDER BY v.last_message_at DESC, v.id DESC LIMIT ${lim} OFFSET ${off}`, params);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x), meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page } });
  });

  r.get('/counts', async (req, res) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
              COUNT(*) FILTER (WHERE status = 'open' AND unread)::int AS unread,
              COUNT(*) FILTER (WHERE status = 'open' AND assigned_to = $1)::int AS mine,
              COUNT(*) FILTER (WHERE status = 'open' AND assigned_to IS NULL)::int AS unassigned,
              COUNT(*) FILTER (WHERE status = 'open' AND category = 'unsubscribe_request')::int AS unsubscribe
         FROM portal.conversations`, [req.user.id]);
    const s = await settings.all();
    res.json({ success: true, data: { ...rows[0], collecting: Boolean(s.replies_mailbox.enabled), reply_to: s.reply_to || s.from_email || null } });
  });

  async function loadConversation(convId) {
    const { rows } = await pool.query(
      `SELECT v.*, k.name AS campaign, k.subject AS campaign_subject, u.name AS assigned_name,
              c.first_name, c.last_name, c.company,
              (SELECT reason FROM portal.suppressions sp WHERE sp.email_hash = c.email_hash AND sp.lifted_at IS NULL LIMIT 1) AS suppression_reason
         FROM portal.conversations v
         LEFT JOIN portal.campaigns k ON k.id = v.campaign_id
         LEFT JOIN portal.users u ON u.id = v.assigned_to
         LEFT JOIN portal.contacts c ON c.id = v.contact_id
        WHERE v.id = $1`, [convId]);
    if (!rows[0]) throw notFound('Conversation not found');
    return rows[0];
  }

  r.get('/:id', async (req, res) => {
    const convId = parse(id, req.params.id);
    const conv = await loadConversation(convId);
    const { rows: messages } = await pool.query(
      `SELECT m.id, m.direction, m.from_email, m.from_name, m.to_email, m.subject, m.text_body, (m.html_body IS NOT NULL) AS has_html,
              m.matched_by, m.send_status, m.error, m.source, m.created_at, m.sent_by, u.name AS sent_by_name,
              COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('id', a.id, 'filename', a.filename, 'content_type', a.content_type,
                                                          'size', a.size, 'stored', a.data IS NOT NULL) ORDER BY a.id)
                          FROM portal.inbox_attachments a WHERE a.inbox_message_id = m.id), '[]') AS attachments
         FROM portal.inbox_messages m LEFT JOIN portal.users u ON u.id = m.sent_by
        WHERE m.conversation_id = $1 ORDER BY m.created_at, m.id`, [convId]);
    let lists = [];
    if (conv.contact_id) {
      lists = (await pool.query(
        `SELECT l.id, l.name, m.status FROM portal.list_members m JOIN portal.lists l ON l.id = m.list_id WHERE m.contact_id = $1 ORDER BY l.name`,
        [conv.contact_id])).rows;
    }
    // Opening a conversation marks it read for everyone (one shared inbox).
    if (conv.unread) await pool.query('UPDATE portal.conversations SET unread = FALSE WHERE id = $1', [convId]);
    const { rows: users } = await pool.query(`SELECT id, name FROM portal.users WHERE status = 'active' AND role IN ('manager', 'admin') ORDER BY name`);
    res.json({ success: true, data: { ...conv, unread: false, messages, lists, users } });
  });

  r.post('/:id/reply', requirePermission('inbox:reply'), async (req, res) => {
    const convId = parse(id, req.params.id);
    const body = parse(z.object({
      body: z.string().trim().min(1, 'Write a reply').max(20000),
      close: z.boolean().default(false),
    }), req.body);
    await loadConversation(convId);
    const out = await sendReply(pool, settings, transport, { conversationId: convId, user: req.user, body: body.body });
    await audit(pool, req, 'inbox.replied', { targetType: 'conversation', targetId: convId, details: { ok: out.ok } });
    if (!out.ok) throw upstream(`Your mail server did not accept the reply: ${out.error}. It is saved in the conversation as not sent.`);
    if (body.close) await pool.query(`UPDATE portal.conversations SET status = 'closed', updated_at = NOW() WHERE id = $1`, [convId]);
    res.status(201).json({ success: true, data: { id: out.id } });
  });

  r.post('/:id/notes', requirePermission('inbox:reply'), async (req, res) => {
    const convId = parse(id, req.params.id);
    const body = parse(z.object({ body: z.string().trim().min(1, 'Write a note').max(5000) }), req.body);
    await loadConversation(convId);
    const { rows } = await pool.query(
      `INSERT INTO portal.inbox_messages (conversation_id, direction, text_body, sent_by, from_name, source)
       VALUES ($1, 'note', $2, $3, $4, 'portal') RETURNING id`, [convId, body.body, req.user.id, req.user.name || '']);
    await pool.query(`UPDATE portal.conversations SET message_count = message_count + 1, updated_at = NOW() WHERE id = $1`, [convId]);
    await audit(pool, req, 'inbox.note_added', { targetType: 'conversation', targetId: convId });
    res.status(201).json({ success: true, data: { id: rows[0].id } });
  });

  r.patch('/:id', requirePermission('inbox:reply'), async (req, res) => {
    const convId = parse(id, req.params.id);
    const body = parse(z.object({
      status: z.enum(['open', 'closed']).optional(),
      assigned_to: z.string().uuid().nullable().optional(),
      unread: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, 'Nothing to change'), req.body);
    await loadConversation(convId);
    if (body.assigned_to) {
      const u = await pool.query(`SELECT 1 FROM portal.users WHERE id = $1 AND status = 'active' AND role IN ('manager', 'admin')`, [body.assigned_to]);
      if (!u.rowCount) throw conflict('That user cannot be assigned conversations');
    }
    const sets = [];
    const params = [convId];
    for (const k of ['status', 'assigned_to', 'unread']) {
      if (body[k] !== undefined) { params.push(body[k]); sets.push(`${k} = $${params.length}`); }
    }
    await pool.query(`UPDATE portal.conversations SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    await audit(pool, req, 'inbox.updated', { targetType: 'conversation', targetId: convId, details: body });
    res.json({ success: true, data: await loadConversation(convId) });
  });

  /** "Please take me off your list": unsubscribe the contact, note it in the conversation and close it. */
  r.post('/:id/unsubscribe', requirePermission('contacts:write'), async (req, res) => {
    const convId = parse(id, req.params.id);
    const conv = await loadConversation(convId);
    if (!conv.contact_id) throw conflict('This person is not a contact, so there is nothing to unsubscribe. Suppress the address under Suppression list if needed.');
    const s = await settings.all();
    await withTransaction(pool, async (db) => {
      let listIds = null;
      if (!s.global_unsubscribe && conv.campaign_id) {
        listIds = (await db.query('SELECT list_id FROM portal.campaign_lists WHERE campaign_id = $1 AND list_id IS NOT NULL', [conv.campaign_id])).rows.map((x) => x.list_id);
      }
      await unsubscribeContact(db, {
        contactId: conv.contact_id, campaignId: conv.campaign_id, listIds, global: s.global_unsubscribe || !listIds?.length,
        note: `Asked by email reply (conversation ${convId})`, actorType: 'user', actorId: req.user.id, source: 'reply',
      });
      await db.query(
        `INSERT INTO portal.inbox_messages (conversation_id, direction, text_body, sent_by, from_name, source)
         VALUES ($1, 'note', $2, $3, $4, 'portal')`,
        [convId, `Unsubscribed ${conv.email} as requested${s.global_unsubscribe ? ' (all marketing)' : ' (the lists of this campaign)'}.`, req.user.id, req.user.name || '']);
      await db.query(`UPDATE portal.conversations SET status = 'closed', message_count = message_count + 1, updated_at = NOW() WHERE id = $1`, [convId]);
      await audit(db, req, 'inbox.unsubscribed', { targetType: 'conversation', targetId: convId, details: { contact: conv.contact_id } });
    });
    res.json({ success: true, data: await loadConversation(convId) });
  });

  r.get('/messages/:id/html', async (req, res) => {
    const msgId = parse(id, req.params.id);
    const { rows } = await pool.query(`SELECT html_body FROM portal.inbox_messages WHERE id = $1`, [msgId]);
    if (!rows[0]?.html_body) throw notFound('This email has no formatted version');
    // Remote images (often tracking pixels) are not loaded unless the reader asks for them: removed from the
    // HTML (so nothing is even attempted) and blocked by the CSP as a second line.
    const images = req.query.images === '1';
    const img = images ? 'img-src https: http: data:' : 'img-src data:';
    const body = images ? rows[0].html_body : rows[0].html_body.replace(/<img\b[^>]*>/gi,
      (tag) => tag.replace(/\s(src|srcset)=("|')(?!data:)[^"']*\2/gi, ' data-blocked-$1=""'));
    res.setHeader('Content-Security-Policy', `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; ${img}; style-src 'unsafe-inline'; font-src data:`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><base target="_blank">${body}`);
  });

  r.get('/attachments/:id', async (req, res) => {
    const attId = parse(id, req.params.id);
    const { rows } = await pool.query('SELECT filename, data, size FROM portal.inbox_attachments WHERE id = $1', [attId]);
    if (!rows[0]) throw notFound('Attachment not found');
    if (!rows[0].data) throw notFound('This attachment was too large to keep (over 10 MB). Open it in the mailbox itself.');
    await audit(pool, req, 'inbox.attachment_downloaded', { details: { attachment: attId } });
    // Always a download: never rendered by the browser on this origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].filename.replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.send(rows[0].data);
  });

  return r;
}

module.exports = { inboxRoutes };
