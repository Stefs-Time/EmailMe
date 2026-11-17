'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { readOnly } = require('../../db/pool');
const repo = require('./repo');
const service = require('./service');
const { consentSchema, CONSENT_METHODS } = require('./consent');

const idParam = z.coerce.number().int().positive();
const idList = z.array(z.coerce.number().int().positive()).min(1).max(5000);
const listIds = z.array(z.coerce.number().int().positive()).max(100);
const note = z.string().trim().max(1000).default('');
const attribValue = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
const attribsSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/, 'Attribute names: letters, numbers, underscore'), attribValue)
  .refine((o) => Object.keys(o).length <= 50, 'Too many attributes');

const filterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum([...repo.STATUSES, 'eligible', 'suppressed']).optional(),
  list_id: z.coerce.number().int().positive().optional(),
  source: z.string().trim().max(100).optional(),
  consent_method: z.string().trim().max(50).optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
  segment_id: z.coerce.number().int().positive().optional(),
});

/** Query → repository filters. A saved segment's rules are loaded from the database. */
async function toFilters(q, db) {
  let segmentRules;
  if (q.segment_id) {
    const { rows } = await db.query('SELECT rules FROM portal.segments WHERE id = $1', [q.segment_id]);
    if (!rows[0]) throw notFound('Segment not found');
    segmentRules = rows[0].rules;
  }
  return {
    q: q.q || undefined,
    status: q.status,
    listId: q.list_id,
    source: q.source || undefined,
    consentMethod: q.consent_method || undefined,
    createdFrom: q.created_from,
    createdTo: q.created_to,
    segmentRules,
  };
}

function contactRoutes(deps) {
  const r = express.Router();
  const ctx = (req) => ({ ...deps, user: req.user, req });

  r.get('/', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(
      filterSchema.extend({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        per_page: z.coerce.number().int().min(1).max(200).default(25),
        sort: z.enum(Object.keys(repo.SORTS)).default('created_at'),
        dir: z.enum(['asc', 'desc']).default('desc'),
      }),
      req.query,
    );
    const { rows, total } = await readOnly(deps.pool, (db) =>
      toFilters(q, db).then((f) => repo.queryContacts(db, f, { page: q.page, perPage: q.per_page, sort: q.sort, dir: q.dir })),
    );
    res.json({ success: true, data: rows, meta: { total, page: q.page, perPage: q.per_page } });
  });

  /** Every id matching the filters (max 5000, the bulk-action limit). */
  r.get('/ids', requirePermission('contacts:write'), async (req, res) => {
    const q = parse(filterSchema, req.query);
    const data = await readOnly(deps.pool, async (db) => repo.matchingIds(db, await toFilters(q, db), 5000));
    res.json({ success: true, data });
  });

  /** Values for filter dropdowns. */
  r.get('/facets', requirePermission('contacts:read'), async (_req, res) => {
    const data = await readOnly(deps.pool, async (db) => {
      const sources = await db.query(
        `SELECT source AS v, COUNT(*)::int AS n FROM portal.contacts
          WHERE source <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 100`);
      const lists = await db.query(`SELECT id, name, optin FROM portal.lists ORDER BY name`);
      // Imported custom columns, for personalisation chips. Bounded: recent contacts only.
      const attributes = await db.query(
        `SELECT k, COUNT(*)::int AS n
           FROM (SELECT attribs FROM portal.contacts WHERE jsonb_typeof(attribs) = 'object' ORDER BY id DESC LIMIT 5000) c,
                jsonb_object_keys(c.attribs) AS k
          GROUP BY k ORDER BY n DESC, k LIMIT 20`);
      return { sources: sources.rows, lists: lists.rows, attributes: attributes.rows.map((r) => r.k) };
    });
    res.json({ success: true, data: { ...data, statuses: repo.STATUSES, consentMethods: CONSENT_METHODS } });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    res.json({ success: true, data: await service.getDetail(ctx(req), parse(idParam, req.params.id)) });
  });

  r.get('/:id/export', requirePermission('exports:read'), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const data = await service.exportData(ctx(req), id);
    res.setHeader('Content-Disposition', `attachment; filename="contact-${id}-data.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  });

  r.post('/', requirePermission('contacts:write'), async (req, res) => {
    const body = parse(
      z.object({
        email: z.string().trim().min(3).max(254),
        firstName: z.string().trim().max(100).default(''),
        lastName: z.string().trim().max(100).default(''),
        company: z.string().trim().max(200).default(''),
        source: z.string().trim().max(100).default('manual'),
        listIds: listIds.default([]),
        preconfirm: z.boolean().default(false),
        consent: consentSchema,
        attribs: attribsSchema.optional(),
      }),
      req.body,
    );
    const sub = await service.createContact(ctx(req), body);
    res.status(201).json({ success: true, data: { id: sub.id } });
  });

  r.patch('/:id', requirePermission('contacts:write'), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(
      z.object({
        email: z.string().trim().min(3).max(254).optional(),
        firstName: z.string().trim().max(100).optional(),
        lastName: z.string().trim().max(100).optional(),
        company: z.string().trim().max(200).optional(),
        source: z.string().trim().max(100).optional(),
        attribs: attribsSchema.optional(),
      }),
      req.body,
    );
    await service.updateContact(ctx(req), id, body);
    res.json({ success: true, data: { id } });
  });

  r.post('/:id/consent', requirePermission('contacts:write'), async (req, res) => {
    const id = parse(idParam, req.params.id);
    await service.recordConsent(ctx(req), id, parse(consentSchema, req.body));
    res.json({ success: true, data: { id } });
  });

  r.post('/:id/review', requirePermission('review:resolve'), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(z.object({ resolution: z.enum(['valid', 'invalid']), note }), req.body);
    await service.resolveReview(ctx(req), id, body.resolution, body.note);
    res.json({ success: true, data: { id } });
  });

  r.post('/:id/erase', requirePermission('contacts:erase'), async (req, res) => {
    const id = parse(idParam, req.params.id);
    const body = parse(z.object({ confirm: z.literal('ERASE'), note }), req.body);
    await service.erase(ctx(req), id);
    res.json({ success: true, data: {} });
  });

  /** Bulk and single actions share one endpoint. */
  r.post('/actions', requirePermission('contacts:write'), async (req, res) => {
    const body = parse(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('add_to_lists'), ids: idList, listIds: listIds.min(1),
          subscriptionStatus: z.enum(['confirmed', 'unconfirmed']).default('confirmed') }),
        z.object({ action: z.literal('remove_from_lists'), ids: idList, listIds: listIds.min(1) }),
        z.object({ action: z.literal('unsubscribe_from_lists'), ids: idList, listIds: listIds.min(1) }),
        z.object({ action: z.literal('unsubscribe'), ids: idList, note }),
        z.object({ action: z.literal('suppress'), ids: idList, note }),
      ]),
      req.body,
    );
    const c = ctx(req);
    let data;
    switch (body.action) {
      case 'add_to_lists':
        data = await service.changeLists(c, body.ids, 'add', body.listIds, { confirmed: body.subscriptionStatus === 'confirmed' });
        break;
      case 'remove_from_lists':
        data = await service.changeLists(c, body.ids, 'remove', body.listIds);
        break;
      case 'unsubscribe_from_lists':
        data = await service.changeLists(c, body.ids, 'unsubscribe', body.listIds);
        break;
      case 'unsubscribe':
        data = await service.unsubscribe(c, body.ids, body.note);
        break;
      case 'suppress':
        data = await service.suppress(c, body.ids, body.note);
        break;
    }
    res.json({ success: true, data });
  });

  return r;
}

module.exports = { contactRoutes, filterSchema, toFilters };
