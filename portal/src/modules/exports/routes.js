'use strict';

const express = require('express');
const { z } = require('zod');
const { parse } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { streamCsv } = require('../../lib/csv');
const { audit } = require('../../lib/audit');
const repo = require('../contacts/repo');
const { filterSchema, toFilters } = require('../contacts/routes');

const range = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const stamp = () => new Date().toISOString().slice(0, 10);

/** Keyset paging over a portal table ordered by bigserial id. */
function pager(pool, sql, params, map, size = 5000) {
  return (async function* gen() {
    let after = 0;
    for (;;) {
      const { rows } = await pool.query(sql, [...params, after, size]);
      if (!rows.length) return;
      after = rows[rows.length - 1].id;
      yield rows.map(map);
      if (rows.length < size) return;
    }
  })();
}

function exportRoutes({ pool }) {
  const r = express.Router();
  r.use(requirePermission('exports:read'));

  r.get('/contacts.csv', async (req, res) => {
    const q = parse(filterSchema, req.query);
    const filters = toFilters(q);
    await audit(pool, req, 'export.contacts', { details: { filters: q } });
    const { rows: lists } = await pool.query('SELECT id, name FROM lists');
    const listName = new Map(lists.map((l) => [l.id, l.name]));
    // Dedicated client: the export runs as one long read-only transaction so
    // the snapshot is consistent across pages.
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const pages = (async function* gen() {
        for await (const page of repo.iterateContacts(client, filters)) {
          yield page.map((c) => [
            c.id, c.email, c.attribs?.first_name || '', c.attribs?.last_name || '', c.name, c.attribs?.company || '',
            c.status, (c.list_ids || []).map((id) => listName.get(id) || id).join('; '),
            c.attribs?.source || '', c.attribs?.consent?.method || '', c.attribs?.consent?.date || '',
            c.attribs?.consent?.purpose || '', c.hard_bounces, c.soft_bounces, c.complaints, c.last_bounce_at,
            c.suppression_reason || '', c.suppressed_at, c.last_unsubscribed_at, c.created_at, c.updated_at,
          ]);
        }
      })();
      await streamCsv(res, `contacts-${stamp()}.csv`, [
        'ID', 'Email', 'First name', 'Last name', 'Display name', 'Company', 'Status', 'Lists', 'Source',
        'Consent method', 'Consent date', 'Consent purpose', 'Hard bounces', 'Soft bounces', 'Complaints',
        'Last bounce', 'Suppression reason', 'Suppressed at', 'Last unsubscribe', 'Date added', 'Last updated',
      ], pages);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!res.headersSent) throw err;
      res.destroy(err);
    } finally {
      client.release();
    }
  });

  r.get('/suppressions.csv', async (req, res) => {
    const q = parse(z.object({ include_lifted: z.enum(['true', 'false']).default('false') }), req.query);
    await audit(pool, req, 'export.suppressions');
    const lifted = q.include_lifted === 'true';
    await streamCsv(res, `suppression-list-${stamp()}.csv`,
      ['Email', 'Email hash (SHA-256)', 'Reason', 'Source', 'Suppressed at', 'Lifted at', 'Lift reason'],
      pager(pool,
        `SELECT id, email, email_hash, reason, source, created_at, lifted_at, lift_reason FROM portal.suppressions
          WHERE ($1::boolean OR lifted_at IS NULL) AND id > $2 ORDER BY id LIMIT $3`, [lifted],
        (s) => [s.email || '[erased]', s.email_hash, s.reason, s.source, s.created_at, s.lifted_at, s.lift_reason]));
  });

  /** POPIA: consent and unsubscribe history. */
  r.get('/consent.csv', async (req, res) => {
    const q = parse(range, req.query);
    await audit(pool, req, 'export.consent', { details: q });
    await streamCsv(res, `consent-history-${stamp()}.csv`,
      ['Email', 'Contact ID', 'Action', 'Method', 'Purpose', 'Source', 'Consent obtained', 'Evidence', 'Recorded at', 'Recorded by'],
      pager(pool,
        `SELECT c.id, c.email, c.subscriber_id, c.action, c.method, c.purpose, c.source, c.obtained_at, c.evidence,
                c.created_at, u.name AS recorded_by
           FROM portal.consent_records c LEFT JOIN portal.users u ON u.id = c.recorded_by
          WHERE ($1::timestamptz IS NULL OR c.created_at >= $1) AND ($2::timestamptz IS NULL OR c.created_at < $2)
            AND c.id > $3 ORDER BY c.id LIMIT $4`, [q.from || null, q.to || null],
        (c) => [c.email || '[erased]', c.subscriber_id, c.action, c.method, c.purpose, c.source, c.obtained_at,
          c.evidence, c.created_at, c.recorded_by || 'system']));
  });

  r.get('/events.csv', async (req, res) => {
    const q = parse(range, req.query);
    await audit(pool, req, 'export.events', { details: q });
    await streamCsv(res, `recipient-history-${stamp()}.csv`,
      ['Event ID', 'Contact ID', 'Event', 'From', 'To', 'Details', 'Actor', 'At'],
      pager(pool,
        `SELECT e.id, e.subscriber_id, e.event_type, e.from_status, e.to_status, e.details, e.actor_type, e.created_at,
                u.name AS actor_name
           FROM portal.recipient_events e LEFT JOIN portal.users u ON u.id = e.actor_id
          WHERE ($1::timestamptz IS NULL OR e.created_at >= $1) AND ($2::timestamptz IS NULL OR e.created_at < $2)
            AND e.id > $3 ORDER BY e.id LIMIT $4`, [q.from || null, q.to || null],
        (e) => [e.id, e.subscriber_id, e.event_type, e.from_status, e.to_status, e.details,
          e.actor_name || e.actor_type, e.created_at]));
  });

  r.get('/bounces.csv', async (req, res) => {
    const q = parse(range, req.query);
    await audit(pool, req, 'export.bounces', { details: q });
    await streamCsv(res, `bounces-${stamp()}.csv`,
      ['Bounce ID', 'Email', 'Campaign', 'listmonk type', 'Classification', 'Enhanced code', 'Reason', 'Action', 'Source', 'Bounced at'],
      pager(pool,
        `SELECT b.id, s.email, c.name AS campaign, b.listmonk_type, b.classification, b.enhanced_code, b.reason,
                b.action_taken, b.source, b.bounced_at
           FROM portal.bounce_events b
           LEFT JOIN subscribers s ON s.id = b.subscriber_id
           LEFT JOIN campaigns c ON c.id = b.campaign_id
          WHERE ($1::timestamptz IS NULL OR b.bounced_at >= $1) AND ($2::timestamptz IS NULL OR b.bounced_at < $2)
            AND b.id > $3 ORDER BY b.id LIMIT $4`, [q.from || null, q.to || null],
        (b) => [b.id, b.email || '[deleted]', b.campaign, b.listmonk_type, b.classification, b.enhanced_code,
          b.reason, b.action_taken, b.source, b.bounced_at]));
  });

  r.get('/audit.csv', requirePermission('audit:read'), async (req, res) => {
    const q = parse(range, req.query);
    await audit(pool, req, 'export.audit', { details: q });
    await streamCsv(res, `audit-log-${stamp()}.csv`,
      ['ID', 'At', 'User', 'Action', 'Target type', 'Target', 'Details', 'IP'],
      pager(pool,
        `SELECT id, created_at, actor_email, action, target_type, target_id, details, ip FROM portal.audit_log
          WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)
            AND id > $3 ORDER BY id LIMIT $4`, [q.from || null, q.to || null],
        (a) => [a.id, a.created_at, a.actor_email || 'system', a.action, a.target_type, a.target_id, a.details, a.ip]));
  });

  return r;
}

module.exports = { exportRoutes };
