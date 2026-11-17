'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound, conflict } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { NOT_SUPPRESSED } = require('../../engine/audience');

const id = z.coerce.number().int().positive();
const listBody = z.object({
  name: z.string().trim().min(1).max(200),
  optin: z.enum(['single', 'double']).default('single'),
  description: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});

function listRoutes({ pool }) {
  const r = express.Router();

  /** Lists with membership by status and how many would receive a campaign right now. */
  r.get('/', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT l.id, l.name, l.optin, l.tags, l.description, l.created_at,
             COUNT(m.contact_id)::int AS total,
             COUNT(*) FILTER (WHERE m.status = 'subscribed')::int AS confirmed,
             COUNT(*) FILTER (WHERE m.status = 'unconfirmed')::int AS unconfirmed,
             COUNT(*) FILTER (WHERE m.status = 'unsubscribed')::int AS unsubscribed,
             COUNT(*) FILTER (WHERE m.status = 'subscribed' AND ${NOT_SUPPRESSED('c')})::int AS eligible
        FROM portal.lists l
        LEFT JOIN portal.list_members m ON m.list_id = l.id
        LEFT JOIN portal.contacts c ON c.id = m.contact_id
       GROUP BY l.id ORDER BY l.name`);
    res.json({ success: true, data: rows });
  });

  const save = async (req, listId) => {
    const body = parse(listBody, req.body);
    try {
      const { rows } = listId
        ? await pool.query(
          `UPDATE portal.lists SET name = $2, optin = $3, description = $4, tags = $5, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [listId, body.name, body.optin, body.description, body.tags])
        : await pool.query(
          `INSERT INTO portal.lists (name, optin, description, tags) VALUES ($1, $2, $3, $4) RETURNING *`,
          [body.name, body.optin, body.description, body.tags]);
      if (!rows[0]) throw notFound('List not found');
      await audit(pool, req, listId ? 'list.updated' : 'list.created', { targetType: 'list', targetId: rows[0].id, details: { name: body.name } });
      return rows[0];
    } catch (err) {
      if (err.code === '23505') throw conflict('A list with that name already exists');
      throw err;
    }
  };

  r.post('/', requirePermission('lists:write'), async (req, res) => {
    res.status(201).json({ success: true, data: await save(req) });
  });

  r.put('/:id', requirePermission('lists:write'), async (req, res) => {
    res.json({ success: true, data: await save(req, parse(id, req.params.id)) });
  });

  r.delete('/:id', requirePermission('lists:delete'), async (req, res) => {
    const listId = parse(id, req.params.id);
    const busy = await pool.query(
      `SELECT 1 FROM portal.campaign_lists cl JOIN portal.campaigns c ON c.id = cl.campaign_id
        WHERE cl.list_id = $1 AND c.status IN ('scheduled', 'sending', 'paused')`, [listId]);
    if (busy.rowCount) throw conflict('This list is used by a scheduled, sending or paused campaign');
    const { rows } = await pool.query('DELETE FROM portal.lists WHERE id = $1 RETURNING name', [listId]);
    if (!rows[0]) throw notFound('List not found');
    await audit(pool, req, 'list.deleted', { targetType: 'list', targetId: listId, details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  return r;
}

module.exports = { listRoutes };
