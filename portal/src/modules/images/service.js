'use strict';

/**
 * Image library: compress uploads for email and store them in PostgreSQL.
 *
 *   - photos (opaque)       → JPEG (mozjpeg, quality 80, progressive), max 1200px wide
 *   - transparency          → PNG (palette-quantised, max compression), max 1200px wide
 *   - animated GIF          → GIF kept animated, max 600px wide
 *   - EXIF orientation applied, all metadata removed (GPS, camera, etc.)
 *   - identical results stored once (SHA-256)
 *
 * Email clients do not reliably support WebP/AVIF, so output is JPEG/PNG/GIF only.
 */
const crypto = require('node:crypto');
const sharp = require('sharp');
const { validation } = require('../../lib/errors');

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_STORED_BYTES = 3 * 1024 * 1024;
const MAX_WIDTH = 1200;
const MAX_GIF_WIDTH = 600;
const MAX_INPUT_PIXELS = 50_000_000; // guards against decompression bombs
const ACCEPTED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

sharp.cache(false); // a server process should not hold decoded images in memory

function cleanName(name) {
  const base = String(name || 'image').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\p{L}\p{N} _.()-]+/gu, ' ').trim();
  return (base || 'image').slice(0, 120);
}

/**
 * Compresses one upload. Returns { data, mime, width, height, bytes, originalBytes }.
 * Throws a validation error for unsupported or broken files.
 */
async function compressImage(buffer) {
  if (!buffer?.length) throw validation('The file is empty');
  if (buffer.length > MAX_UPLOAD_BYTES) throw validation('Images can be up to 15 MB before compression');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw validation('This file is not an image MailHarbor can read. Use JPG, PNG, GIF or WebP.');
  }
  if (!ACCEPTED.has(meta.format)) throw validation(`Unsupported image type (${meta.format}). Use JPG, PNG, GIF or WebP.`);

  const animated = meta.format === 'gif' && (meta.pages || 1) > 1;
  let out;
  if (animated) {
    out = await sharp(buffer, { animated: true, limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: MAX_GIF_WIDTH, withoutEnlargement: true })
      .gif({ effort: 7 })
      .toBuffer({ resolveWithObject: true });
  } else {
    const base = () => sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true });
    const opaque = !meta.hasAlpha || (await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).stats()).isOpaque;
    out = opaque
      ? await base().flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true, progressive: true }).toBuffer({ resolveWithObject: true })
      : await base().png({ palette: true, quality: 90, compressionLevel: 9, effort: 8 }).toBuffer({ resolveWithObject: true });
  }
  if (out.data.length > MAX_STORED_BYTES) {
    throw validation(animated
      ? 'This animated GIF is still over 3 MB after compression. Shorten it or use a still image.'
      : 'This image is still over 3 MB after compression.');
  }
  const mime = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[out.info.format];
  return {
    data: out.data, mime, width: out.info.width,
    height: animated ? (out.info.pageHeight || out.info.height) : out.info.height,
    bytes: out.data.length, originalBytes: buffer.length,
  };
}

/** Stores an upload (or returns the identical image already stored). */
async function saveImage(db, { buffer, name, userId }) {
  const img = await compressImage(buffer);
  const sha = crypto.createHash('sha256').update(img.data).digest('hex');
  const { rows } = await db.query(
    `INSERT INTO portal.images (name, mime, width, height, bytes, original_bytes, sha256, data, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
     RETURNING id, token, name, mime, width, height, bytes, original_bytes, created_at, (xmax <> 0) AS existed`,
    [cleanName(name), img.mime, img.width, img.height, img.bytes, img.originalBytes, sha, img.data, userId || null]);
  return rows[0];
}

const imagePath = (row) => `/img/${row.token}.${EXT[row.mime]}`;

module.exports = { compressImage, saveImage, imagePath, cleanName, MAX_UPLOAD_BYTES, EXT };
