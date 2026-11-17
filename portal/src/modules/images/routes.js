'use strict';

/**
 * Image library API.
 *   GET    /api/images            list (newest first, search by name)
 *   POST   /api/images            upload up to 10 files (multipart "files"); compressed and stored
 *   PATCH  /api/images/:id        rename
 *   DELETE /api/images/:id        delete (refused while a campaign or template uses it)
 * Public:  GET /img/:token.:ext  (see publicImageRoute)
 */
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { parse, notFound, conflict, badRequest } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { saveImage, imagePath, cleanName, MAX_UPLOAD_BYTES } = require('./service');

const id = z.coerce.number().int().positive();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function imageRoutes({ pool, settings, logger }) {
  const r = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 2 },
    fileFilter: (_req, file, cb) => {
      const ok = /^image\/(jpeg|png|gif|webp|avif|tiff)$/.test(file.mimetype);
      cb(ok ? null : badRequest(`"${file.originalname}" is not a supported image (JPG, PNG, GIF or WebP)`), ok);
    },
  });

  const shape = async (row) => {
    const base = (await settings.publicUrl()) || '';
    return { id: row.id, name: row.name, mime: row.mime, width: row.width, height: row.height, bytes: row.bytes,
      original_bytes: row.original_bytes, created_at: row.created_at, path: imagePath(row), url: `${base}${imagePath(row)}` };
  };

  r.get('/', requirePermission('contacts:read'), async (req, res) => {
    const q = parse(z.object({
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      per_page: z.coerce.number().int().min(1).max(100).default(48),
    }), req.query);
    const params = [];
    let where = '';
    if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`); where = `WHERE name ILIKE $1`; }
    params.push(q.per_page, (q.page - 1) * q.per_page);
    const { rows } = await pool.query(
      `SELECT id, token, name, mime, width, height, bytes, original_bytes, created_at, COUNT(*) OVER() AS total
         FROM portal.images ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const { rows: usage } = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(bytes), 0)::bigint AS bytes, COALESCE(SUM(original_bytes), 0)::bigint AS original FROM portal.images');
    res.json({ success: true, data: await Promise.all(rows.map(shape)),
      meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: q.per_page,
        storage: { count: usage[0].n, bytes: Number(usage[0].bytes), original_bytes: Number(usage[0].original) } } });
  });

  r.post('/', requirePermission('templates:write'), (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return next(badRequest('Images can be up to 15 MB before compression'));
      if (err?.code === 'LIMIT_FILE_COUNT') return next(badRequest('Upload up to 10 images at a time'));
      return next(err);
    });
  }, async (req, res) => {
    const files = req.files || [];
    if (!files.length) throw badRequest('Choose at least one image');
    const results = [];
    for (const f of files) {
      try {
        const row = await saveImage(pool, { buffer: f.buffer, name: f.originalname, userId: req.user.id });
        results.push({ ok: true, existed: row.existed, image: await shape(row) });
      } catch (err) {
        if (err.status !== 422 && err.status !== 400) logger?.warn({ err: err.message }, 'image upload failed');
        results.push({ ok: false, name: f.originalname, error: err.status ? err.message : 'This image could not be processed' });
      }
    }
    const saved = results.filter((x) => x.ok && !x.existed).length;
    if (saved) await audit(pool, req, 'image.uploaded', { details: { count: saved } });
    if (!results.some((x) => x.ok)) {
      return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: results[0].error,
        details: results.map((x) => ({ field: x.name, message: x.error })) } });
    }
    return res.status(201).json({ success: true, data: results });
  });

  r.patch('/:id', requirePermission('templates:write'), async (req, res) => {
    const imageId = parse(id, req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120) }), req.body);
    const { rows } = await pool.query(
      `UPDATE portal.images SET name = $2 WHERE id = $1
       RETURNING id, token, name, mime, width, height, bytes, original_bytes, created_at`, [imageId, cleanName(b.name)]);
    if (!rows[0]) throw notFound('Image not found');
    res.json({ success: true, data: await shape(rows[0]) });
  });

  r.delete('/:id', requirePermission('templates:write'), async (req, res) => {
    const imageId = parse(id, req.params.id);
    const { rows } = await pool.query('SELECT token, name FROM portal.images WHERE id = $1', [imageId]);
    if (!rows[0]) throw notFound('Image not found');
    // Sent emails keep pointing at the image, so refuse while anything uses it.
    const needle = `%/img/${rows[0].token}%`;
    const { rows: used } = await pool.query(
      `SELECT 'campaign' AS kind, name FROM portal.campaigns WHERE body_html LIKE $1
       UNION ALL SELECT 'template', name FROM portal.templates WHERE html LIKE $1 LIMIT 5`, [needle]);
    if (used.length) {
      throw conflict(`This image is used by ${used.map((u) => `${u.kind} "${u.name}"`).join(', ')}. Emails that were already sent would lose it, so it can't be deleted.`);
    }
    await pool.query('DELETE FROM portal.images WHERE id = $1', [imageId]);
    await audit(pool, req, 'image.deleted', { details: { name: rows[0].name } });
    res.json({ success: true, data: {} });
  });

  return r;
}

/** Public image delivery for emails and web pages: cacheable, loadable cross-origin. */
function publicImageRoute({ pool }) {
  const r = express.Router();
  r.get('/img/:file', async (req, res, next) => {
    const m = /^([0-9a-f-]{36})\.(jpg|png|gif)$/i.exec(req.params.file);
    if (!m || !UUID.test(m[1])) return next(); // not a library image (e.g. the app's own /img/logo.svg)
    const { rows } = await pool.query('SELECT mime, data FROM portal.images WHERE token = $1', [m[1]]);
    if (!rows[0]) return res.status(404).end();
    res.set({
      'Content-Type': rows[0].mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin', // webmail loads images from other origins
      'X-Content-Type-Options': 'nosniff',
    });
    return res.send(rows[0].data);
  });
  return r;
}

module.exports = { imageRoutes, publicImageRoute };
