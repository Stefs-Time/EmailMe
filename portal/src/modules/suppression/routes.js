'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound, validation, conflict } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { withTransaction } = require('../../db/pool');
const { audit, recipientEvent } = require('../../lib/audit');
const { normalizeEmail, isValidEmail, emailHash } = require('../../lib/email');
const { addSuppression, REASONS } = require('./service');
const { consentSchema } = require('../contacts/consent');

function suppressionRoutes({ pool }) {
  const r = express.Router();

  r.get('/', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({
      q: z.string().trim().max(200).optional(),
      reason: z.enum(REASONS).optional(),
      include_lifted: z.enum(['true', 'false']).default('false'),
      created_from: z.coerce.date().optional(),
      created_to: z.coerce.date().optional(),
      page: z.coerce.number().int().min(1).default(1),
      per_page: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    const params = [];
    const where = [];
    if (q.include_lifted !== 'true') where.push('p.lifted_at IS NULL');
    if (q.reason) { params.push(q.reason); where.push(`p.reason = $${params.length}`); }
    if (q.created_from) { params.push(q.created_from); where.push(`p.created_at >= $${params.length}`); }
    if (q.created_to) { params.push(q.created_to); where.push(`p.created_at < $${params.length}`); }
    if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where.push(`p.email ILIKE $${params.length}`); }
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await pool.query(
      `SELECT p.id, p.email, p.reason, p.source, p.details, p.contact_id, p.created_at, p.lifted_at, p.lift_reason,
              u.name AS created_by_name, COUNT(*) OVER() AS total
         FROM portal.suppressions p LEFT JOIN portal.users u ON u.id = p.created_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x),
      meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page } });
  });

  /** Manually suppress addresses (they need not exist as contacts yet). */
  r.post('/', requirePermission('suppression:add'), async (req, res) => {
    const body = parse(z.object({
      emails: z.array(z.string().trim().max(254)).min(1).max(1000),
      note: z.string().trim().max(1000).default(''),
    }), req.body);
    const invalid = body.emails.filter((e) => !isValidEmail(e));
    if (invalid.length) throw validation(`Invalid email address(es): ${invalid.slice(0, 5).join(', ')}`);
    const emails = [...new Set(body.emails.map(normalizeEmail))];
    const { rows: subs } = await pool.query(
      `SELECT id, LOWER(email) AS email FROM portal.contacts WHERE LOWER(email) = ANY($1::text[])`, [emails]);
    const subMap = new Map(subs.map((s) => [s.email, s.id]));
    let added = 0;
    await withTransaction(pool, async (db) => {
      for (const e of emails) {
        if (await addSuppression(db, { email: e, contactId: subMap.get(e), reason: 'manual', source: 'portal',
          details: { note: body.note }, userId: req.user.id, actorType: 'user' })) added += 1;
      }
      await audit(db, req, 'suppression.added', { details: { count: added, note: body.note } });
    });
    res.status(201).json({ success: true, data: { added, alreadySuppressed: emails.length - added } });
  });

  /**
   * Lifts a suppression: the only sanctioned reactivation path. Requires an
   * administrator, a reason, and a new permission basis (consent evidence).
   * Erased (anonymised) records cannot be lifted.
   */
  r.post('/:id/lift', requirePermission('suppression:lift'), async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const body = parse(z.object({
      reason: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(1000),
      consent: consentSchema.extend({ evidence: z.string().trim().min(5, 'Describe the evidence of the new permission').max(1000) }),
      resubscribe: z.boolean().default(false),
    }), req.body);

    const { rows } = await pool.query('SELECT * FROM portal.suppressions WHERE id = $1', [id]);
    const sup = rows[0];
    if (!sup) throw notFound('Suppression not found');
    if (sup.lifted_at) throw conflict('This suppression has already been lifted');
    if (sup.reason === 'erased' || !sup.email) throw conflict('Erased records cannot be reactivated. Add the person again as a new contact once they opt in.');
    if (sup.reason === 'hard_bounce' && !body.reason.toLowerCase().includes('address')) {
      // Soft guard: make the operator acknowledge they verified the address.
      throw validation('This address hard-bounced. Confirm in the reason that the address has been verified as working (mention "address").');
    }

    const contact = await withTransaction(pool, async (db) => {
      const { rows: cRows } = await db.query('SELECT id, soft_bounces FROM portal.contacts WHERE email_hash = $1', [sup.email_hash]);
      const c = cRows[0] || null;
      await db.query(
        `UPDATE portal.suppressions SET lifted_at = NOW(), lifted_by = $2, lift_reason = $3, lift_basis = $4 WHERE id = $1`,
        [id, req.user.id, body.reason, body.consent]);
      await db.query(
        `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, recorded_by)
         VALUES ($1, $2, $3, 'granted', $4, $5, 'reactivation', $6, $7, $8)`,
        [c?.id ?? null, sup.email, sup.email_hash, body.consent.method, body.consent.purpose,
          body.consent.obtainedAt || null, body.consent.evidence, req.user.id]);
      let restored = 0;
      if (c) {
        await db.query(`UPDATE portal.contacts SET soft_bounces = 0, consent = $2, updated_at = NOW() WHERE id = $1`,
          [c.id, { status: 'granted', method: body.consent.method, purpose: body.consent.purpose || '',
            date: body.consent.obtainedAt ? new Date(body.consent.obtainedAt).toISOString().slice(0, 10) : null, source: 'reactivation' }]);
        if (body.resubscribe) {
          // Restore the lists they had left, now with a new, documented permission basis.
          const r = await db.query(
            `UPDATE portal.list_members SET status = 'subscribed', confirmed_at = NOW(), unsubscribed_at = NULL, updated_at = NOW()
              WHERE contact_id = $1 AND status = 'unsubscribed'`, [c.id]);
          restored = r.rowCount;
        }
      }
      await recipientEvent(db, { contactId: c?.id, emailHash: sup.email_hash, type: 'suppression_lifted',
        from: sup.reason, to: 'active', details: { reason: body.reason, restored_lists: restored }, actorType: 'user', actorId: req.user.id });
      await audit(db, req, 'suppression.lifted', { targetType: 'suppression', targetId: id,
        details: { previous_reason: sup.reason, consent_method: body.consent.method, restored_lists: restored } });
      return c;
    });
    res.json({ success: true, data: { id, contactId: contact?.id ?? null } });
  });

  r.get('/check', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({ email: z.string().trim().max(254) }), req.query);
    const { rows } = await pool.query(
      `SELECT reason, created_at FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL`, [emailHash(q.email)]);
    res.json({ success: true, data: { suppressed: Boolean(rows[0]), ...rows[0] } });
  });

  return r;
}

module.exports = { suppressionRoutes };
