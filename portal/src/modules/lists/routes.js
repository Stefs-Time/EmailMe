'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { readOnly } = require('../../db/pool');
const { audit } = require('../../lib/audit');

const id = z.coerce.number().int().positive();
const listBody = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['private', 'public']).default('private'),
  optin: z.enum(['single', 'double']).default('single'),
  description: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});

function listRoutes({ pool, lm }) {
  const r = express.Router();

  /** Lists with membership broken down by status, and how many would actually receive a campaign. */
  r.get('/', requirePermission('contacts:read'), async (_req, res) => {
    const rows = await readOnly(pool, async (db) => (await db.query(`
      SELECT l.id, l.name, l.type, l.optin, l.tags, l.description, l.created_at,
             COUNT(x.subscriber_id)::int AS total,
             COUNT(*) FILTER (WHERE x.status = 'confirmed')::int AS confirmed,
             COUNT(*) FILTER (WHERE x.status = 'unconfirmed')::int AS unconfirmed,
             COUNT(*) FILTER (WHERE x.status = 'unsubscribed')::int AS unsubscribed,
             COUNT(*) FILTER (WHERE x.status <> 'unsubscribed' AND s.status <> 'blocklisted'
                               AND (x.status = 'confirmed' OR l.optin <> 'double'))::int AS eligible
        FROM lists l
        LEFT JOIN subscriber_lists x ON x.list_id = l.id
        LEFT JOIN subscribers s ON s.id = x.subscriber_id
       GROUP BY l.id ORDER BY l.name`)).rows);
    res.json({ success: true, data: rows });
  });

  r.post('/', requirePermission('lists:write'), async (req, res) => {
    const body = parse(listBody, req.body);
    const list = await lm.createList(body);
    await audit(pool, req, 'list.created', { targetType: 'list', targetId: list.id, details: { name: body.name } });
    res.status(201).json({ success: true, data: list });
  });

  r.put('/:id', requirePermission('lists:write'), async (req, res) => {
    const listId = parse(id, req.params.id);
    const body = parse(listBody, req.body);
    const list = await lm.updateList(listId, body);
    await audit(pool, req, 'list.updated', { targetType: 'list', targetId: listId, details: { name: body.name } });
    res.json({ success: true, data: list });
  });

  r.delete('/:id', requirePermission('lists:delete'), async (req, res) => {
    const listId = parse(id, req.params.id);
    const { rows } = await pool.query('SELECT name FROM lists WHERE id = $1', [listId]);
    if (!rows[0]) throw notFound('List not found');
    await lm.deleteList(listId);
    await audit(pool, req, 'list.deleted', { targetType: 'list', targetId: listId, details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  return r;
}

module.exports = { listRoutes };
