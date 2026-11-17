'use strict';

/**
 * Saved segments API.
 *   GET    /api/segments          list with live counts
 *   GET    /api/segments/meta     rule catalogue + lists, consent methods, imported columns
 *   POST   /api/segments/preview  count + sample contacts for unsaved rules
 *   GET    /api/segments/:id
 *   POST   /api/segments          create
 *   PUT    /api/segments/:id      update
 *   DELETE /api/segments/:id      delete (refused while an unsent campaign uses it)
 */
const express = require('express');
const { z } = require('zod');
const { parse, notFound, conflict } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const repo = require('../contacts/repo');
const { CONSENT_METHODS } = require('../contacts/consent');
const { rulesSchema, compileRules, catalogue } = require('./rules');

const id = z.coerce.number().int().positive();
const body = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  rules: rulesSchema,
});

async function countFor(db, rules) {
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.status IN ('active', 'soft_bounced'))::int AS eligible
       FROM (${repo.BASE_SQL}) c WHERE ${compileRules(rules, p, 'c')}`, params);
  return rows[0];
}

function segmentRoutes({ pool }) {
  const r = express.Router();

  r.get('/', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.description, s.rules, s.created_at, s.updated_at, u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM portal.campaigns c WHERE c.segment_id = s.id) AS used_by
         FROM portal.segments s LEFT JOIN portal.users u ON u.id = s.created_by ORDER BY LOWER(s.name)`);
    const data = [];
    for (const s of rows) data.push({ ...s, counts: await countFor(pool, s.rules) });
    res.json({ success: true, data });
  });

  r.get('/meta', requirePermission('contacts:read'), async (_req, res) => {
    const [lists, sources, attributes] = await Promise.all([
      pool.query('SELECT id, name FROM portal.lists ORDER BY name'),
      pool.query(`SELECT source AS v FROM portal.contacts WHERE source <> '' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 50`),
      pool.query(`SELECT k FROM (SELECT attribs FROM portal.contacts WHERE jsonb_typeof(attribs) = 'object' ORDER BY id DESC LIMIT 5000) c,
                         jsonb_object_keys(c.attribs) k GROUP BY k ORDER BY COUNT(*) DESC, k LIMIT 50`),
    ]);
    res.json({ success: true, data: { fields: catalogue(), statuses: repo.STATUSES, lists: lists.rows, sources: sources.rows.map((x) => x.v),
      consentMethods: CONSENT_METHODS, attributes: attributes.rows.map((x) => x.k) } });
  });

  r.post('/preview', requirePermission('contacts:read'), async (req, res) => {
    const rules = parse(rulesSchema, req.body?.rules);
    const params = [];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const where = compileRules(rules, p, 'c');
    const [counts, sample] = await Promise.all([
      countFor(pool, rules),
      pool.query(`SELECT c.id, c.email, c.name, c.status, c.source FROM (${repo.BASE_SQL}) c WHERE ${where} ORDER BY c.created_at DESC LIMIT 8`, params),
    ]);
    res.json({ success: true, data: { counts, sample: sample.rows } });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM portal.segments WHERE id = $1', [parse(id, req.params.id)]);
    if (!rows[0]) throw notFound('Segment not found');
    res.json({ success: true, data: { ...rows[0], counts: await countFor(pool, rows[0].rules) } });
  });

  const nameTaken = (err) => {
    if (err.code === '23505') throw conflict('A segment with this name already exists');
    throw err;
  };

  r.post('/', requirePermission('contacts:write'), async (req, res) => {
    const b = parse(body, req.body);
    const { rows } = await pool.query(
      'INSERT INTO portal.segments (name, description, rules, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [b.name, b.description, b.rules, req.user.id]).catch(nameTaken);
    await audit(pool, req, 'segment.created', { details: { id: rows[0].id, name: b.name } });
    res.status(201).json({ success: true, data: { id: rows[0].id } });
  });

  r.put('/:id', requirePermission('contacts:write'), async (req, res) => {
    const segId = parse(id, req.params.id);
    const b = parse(body, req.body);
    const { rowCount } = await pool.query(
      'UPDATE portal.segments SET name = $2, description = $3, rules = $4, updated_at = NOW() WHERE id = $1',
      [segId, b.name, b.description, b.rules]).catch(nameTaken);
    if (!rowCount) throw notFound('Segment not found');
    await audit(pool, req, 'segment.updated', { details: { id: segId } });
    res.json({ success: true, data: { id: segId } });
  });

  r.delete('/:id', requirePermission('contacts:write'), async (req, res) => {
    const segId = parse(id, req.params.id);
    const { rows: busy } = await pool.query(
      `SELECT name FROM portal.campaigns WHERE segment_id = $1 AND status IN ('draft', 'scheduled', 'sending', 'paused') LIMIT 3`, [segId]);
    if (busy.length) throw conflict(`This segment is used by campaign(s) not yet finished: ${busy.map((b) => `"${b.name}"`).join(', ')}. Remove it from those campaigns first.`);
    // Finished campaigns keep the segment's name in their report (segment_name).
    await pool.query('UPDATE portal.campaigns SET segment_id = NULL WHERE segment_id = $1', [segId]);
    const { rows } = await pool.query('DELETE FROM portal.segments WHERE id = $1 RETURNING name', [segId]);
    if (!rows[0]) throw notFound('Segment not found');
    await audit(pool, req, 'segment.deleted', { details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  return r;
}

module.exports = { segmentRoutes, countFor };
