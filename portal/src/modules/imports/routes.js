'use strict';

const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { parse, badRequest, conflict } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { streamCsv } = require('../../lib/csv');
const { audit } = require('../../lib/audit');
const service = require('./service');
const { FIELDS } = require('./mapping');
const { CONSENT_METHODS } = require('../contacts/consent');

const uuid = z.string().uuid();

function importRoutes(deps) {
  const r = express.Router();
  const ctx = (req) => ({ ...deps, user: req.user, req });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.config.IMPORT_MAX_MB * 1024 * 1024, files: 1, fields: 5 },
    fileFilter: (_req, file, cb) => {
      const okName = /\.(csv|txt)$/i.test(file.originalname);
      const okType = /^(text\/|application\/(vnd\.ms-excel|csv|octet-stream))/.test(file.mimetype);
      cb(okName && okType ? null : badRequest('Please upload a .csv file'), okName && okType);
    },
  });

  r.get('/', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1) }), req.query);
    const { rows } = await deps.pool.query(
      `SELECT i.id, i.filename, i.status, i.total_rows, i.summary, i.error, i.created_at, i.completed_at, u.name AS created_by_name,
              COUNT(*) OVER() AS total
         FROM portal.imports i LEFT JOIN portal.users u ON u.id = i.created_by
        ORDER BY i.created_at DESC LIMIT 25 OFFSET $1`, [(q.page - 1) * 25]);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x), meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: 25 } });
  });

  r.get('/meta', requirePermission('contacts:read'), (_req, res) => {
    res.json({ success: true, data: { fields: FIELDS, consentMethods: CONSENT_METHODS, labels: service.CLASS_LABELS,
      blocking: service.BLOCKING, maxRows: deps.config.IMPORT_MAX_ROWS, maxMb: deps.config.IMPORT_MAX_MB } });
  });

  r.post('/', requirePermission('imports:write'), upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('Choose a CSV file to upload');
    const imp = await service.upload(ctx(req), { filename: req.file.originalname, buffer: req.file.buffer });
    res.status(201).json({ success: true, data: imp });
  });

  r.get('/:id', requirePermission('contacts:read'), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const imp = await service.loadImport(deps.pool, id);
    const { rows: sample } = await deps.pool.query(
      'SELECT raw FROM portal.import_rows WHERE import_id = $1 ORDER BY row_no LIMIT 5', [id]);
    const { rows: counts } = await deps.pool.query(
      'SELECT classification, COUNT(*)::int AS n FROM portal.import_rows WHERE import_id = $1 GROUP BY 1', [id]);
    res.json({ success: true, data: { ...imp, sample: sample.map((s) => s.raw),
      counts: Object.fromEntries(counts.filter((c) => c.classification).map((c) => [c.classification, c.n])) } });
  });

  r.post('/:id/preview', requirePermission('imports:write'), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(
      z.object({
        mapping: z.record(z.string(), z.enum(FIELDS)),
        options: z.object({
          listIds: z.array(z.coerce.number().int().positive()).max(50).default([]),
          source: z.string().trim().max(100).default('import'),
          subscriptionStatus: z.enum(['confirmed', 'unconfirmed']).default('confirmed'),
          consent: z.object({
            method: z.union([z.enum(CONSENT_METHODS), z.literal('')]).default(''),
            purpose: z.string().trim().max(200).default(''),
            obtainedAt: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).default(''),
            evidence: z.string().trim().max(1000).default(''),
          }).default({}),
        }),
      }),
      req.body,
    );
    const out = await service.preview(ctx(req), id, body);
    res.json({ success: true, data: out });
  });

  r.post('/:id/commit', requirePermission('imports:write'), async (req, res) => {
    const id = parse(uuid, req.params.id);
    res.status(202).json({ success: true, data: await service.commit(ctx(req), id) });
  });

  r.delete('/:id', requirePermission('imports:write'), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { rowCount } = await deps.pool.query(
      `UPDATE portal.imports SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status IN ('uploaded', 'previewed')`, [id]);
    if (!rowCount) throw conflict('Only an import that has not been committed can be cancelled');
    await deps.pool.query('DELETE FROM portal.import_rows WHERE import_id = $1', [id]);
    await audit(deps.pool, req, 'import.cancelled', { targetType: 'import', targetId: id });
    res.json({ success: true, data: {} });
  });

  /** Row-level report, optionally filtered by classification. */
  r.get('/:id/rows.csv', requirePermission('exports:read'), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const q = parse(z.object({ class: z.string().max(40).optional() }), req.query);
    await service.loadImport(deps.pool, id);
    await audit(deps.pool, req, 'export.import_rows', { targetType: 'import', targetId: id, details: { class: q.class } });
    async function* pages() {
      let after = 0;
      for (;;) {
        const { rows } = await deps.pool.query(
          `SELECT row_no, email, classification, message FROM portal.import_rows
            WHERE import_id = $1 AND row_no > $2 AND ($3::text IS NULL OR classification = $3)
            ORDER BY row_no LIMIT 5000`, [id, after, q.class || null]);
        if (!rows.length) return;
        after = rows[rows.length - 1].row_no;
        yield rows.map((x) => [x.row_no, x.email, service.CLASS_LABELS[x.classification] || x.classification, x.message]);
      }
    }
    await streamCsv(res, `import-${id.slice(0, 8)}-${q.class || 'all'}.csv`, ['Row', 'Email', 'Result', 'Details'], pages());
  });

  return r;
}

module.exports = { importRoutes };
