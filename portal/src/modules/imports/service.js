'use strict';

/**
 * CSV import pipeline (scope §3.4):
 *   upload  -> parse and stage raw rows
 *   preview -> map columns, validate, detect duplicates, check suppression,
 *              match existing contacts, require a consent basis
 *   commit  -> new contacts are inserted and existing contacts are only
 *              added to lists they have never been on (never overwritten);
 *              consent evidence is recorded per contact. Batched transactions.
 *
 * Importing can never reactivate an unsubscribed, bounced or blocklisted
 * contact: suppressed rows are excluded before anything is written.
 */

const { withTransaction } = require('../../db/pool');
const { emailHash } = require('../../lib/email');
const { audit, recipientEvent } = require('../../lib/audit');
const { conflict, notFound, badRequest, validation } = require('../../lib/errors');
const { addMemberships } = require('../contacts/service');
const { queueOptin } = require('../../engine/sender');
const { parseCsv, suggestMapping, mapRow } = require('./mapping');

const CHUNK = 2000;

const CLASS_LABELS = {
  new: 'New contact',
  existing_add: 'Existing contact – will be added to list(s)',
  existing_unchanged: 'Existing contact – no change',
  suppressed: 'Suppressed – excluded',
  invalid_email: 'Invalid email – excluded',
  duplicate: 'Duplicate in file – excluded',
  missing_consent: 'No consent basis – excluded',
  invalid_data: 'Invalid data – excluded',
  imported: 'Imported',
  added_to_lists: 'Added to list(s)',
  failed: 'Failed',
};
const BLOCKING = ['suppressed', 'invalid_email', 'duplicate', 'missing_consent', 'invalid_data'];

async function loadImport(db, id) {
  const { rows } = await db.query('SELECT * FROM portal.imports WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Import not found');
  return rows[0];
}

async function upload(ctx, { filename, buffer }) {
  const text = buffer.toString('utf8');
  if (text.includes('\u0000')) throw badRequest('This does not look like a CSV text file');
  let parsed;
  try {
    parsed = parseCsv(text, ctx.config.IMPORT_MAX_ROWS);
  } catch (err) {
    if (err.code === 'TOO_MANY_ROWS') throw badRequest(err.message);
    throw badRequest(`Could not read the CSV file: ${err.message.slice(0, 200)}`);
  }
  if (!parsed.headers.length || !parsed.rows.length) throw badRequest('The file has no data rows');

  const imp = await withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO portal.imports (filename, status, headers, mapping, total_rows, created_by)
       VALUES ($1, 'uploaded', $2, $3, $4, $5) RETURNING *`,
      [filename.slice(0, 200), JSON.stringify(parsed.headers), suggestMapping(parsed.headers), parsed.rows.length, ctx.user.id],
    );
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const slice = parsed.rows.slice(i, i + CHUNK);
      await db.query(
        `INSERT INTO portal.import_rows (import_id, row_no, raw)
         SELECT $1, n, r FROM UNNEST($2::int[], $3::jsonb[]) AS t(n, r)`,
        [rows[0].id, slice.map((_, j) => i + j + 2), slice.map((r) => JSON.stringify(r))],
      );
    }
    await audit(db, ctx.req, 'import.uploaded', { targetType: 'import', targetId: rows[0].id,
      details: { filename, rows: parsed.rows.length } });
    return rows[0];
  });
  return { ...imp, sample: parsed.rows.slice(0, 5) };
}

/** Validates mapping/options and classifies every staged row. */
async function preview(ctx, id, { mapping, options }) {
  const imp = await loadImport(ctx.pool, id);
  if (!['uploaded', 'previewed'].includes(imp.status)) throw conflict(`This import is already ${imp.status}`);
  const headers = imp.headers;
  for (const h of Object.keys(mapping)) if (!headers.includes(h)) throw validation(`Unknown column "${h}"`);
  const emailCols = Object.values(mapping).filter((f) => f === 'email').length;
  if (emailCols !== 1) throw validation('Map exactly one column to Email');
  // A contact on no list never receives anything: require a list up front.
  if (!options.listIds.length) {
    throw validation('Choose at least one list to add these contacts to', [{ field: 'lists', message: 'Choose at least one list' }]);
  }
  {
    const { rows } = await ctx.pool.query('SELECT id FROM portal.lists WHERE id = ANY($1::int[])', [options.listIds]);
    if (rows.length !== options.listIds.length) throw validation('One or more selected lists do not exist');
  }

  const counts = {};
  const seen = new Set();
  const { rows: allRows } = await ctx.pool.query(
    'SELECT row_no, raw FROM portal.import_rows WHERE import_id = $1 ORDER BY row_no', [id]);

  for (let i = 0; i < allRows.length; i += CHUNK) {
    const slice = allRows.slice(i, i + CHUNK).map((r) => ({ row_no: r.row_no, ...mapRow(r.raw, mapping, options) }));
    const valid = slice.filter((r) => r.emailValid);
    const emails = [...new Set(valid.map((r) => r.email))];
    const hashes = emails.map(emailHash);

    const [{ rows: sup }, { rows: existing }] = await Promise.all([
      ctx.pool.query(
        `SELECT email_hash, reason FROM portal.suppressions WHERE lifted_at IS NULL AND email_hash = ANY($1::text[])`, [hashes]),
      ctx.pool.query(
        `SELECT s.id, LOWER(s.email) AS email,
                COALESCE(ARRAY_AGG(x.list_id) FILTER (WHERE x.list_id IS NOT NULL), '{}') AS lists
           FROM portal.contacts s LEFT JOIN portal.list_members x ON x.contact_id = s.id AND x.list_id = ANY($2::int[])
          WHERE LOWER(s.email) = ANY($1::text[]) GROUP BY s.id`, [emails, options.listIds]),
    ]);
    const supMap = new Map(sup.map((s) => [s.email_hash, s.reason]));
    const exMap = new Map(existing.map((e) => [e.email, e]));

    const out = { nos: [], emails: [], data: [], cls: [], msg: [], sub: [] };
    for (const r of slice) {
      let cls;
      let msg = '';
      let subId = null;
      const ex = exMap.get(r.email);
      if (!r.email) {
        cls = 'invalid_email';
        msg = 'Email is empty';
      } else if (!r.emailValid) {
        cls = 'invalid_email';
        msg = 'Email address is not valid';
      } else if (seen.has(r.email)) {
        cls = 'duplicate';
        msg = 'Same email appears earlier in the file';
      } else if (supMap.has(emailHash(r.email))) {
        cls = 'suppressed';
        msg = `Suppressed (${supMap.get(emailHash(r.email)).replace('_', ' ')}); will not be re-activated`;
      } else if (r.problems.length) {
        cls = 'invalid_data';
        msg = r.problems.join('; ');
      } else if (!r.data.consent_method && !(ex && !options.listIds.length)) {
        cls = 'missing_consent';
        msg = 'No consent method for this row and no default consent basis for the import';
      } else if (ex) {
        subId = ex.id;
        const missing = options.listIds.filter((l) => !ex.lists.includes(l));
        if (missing.length) {
          cls = 'existing_add';
          msg = `Will be added to ${missing.length} list(s); existing details and statuses are not changed`;
        } else {
          cls = 'existing_unchanged';
          msg = 'Already exists (subscriptions, including unsubscribes, are left as they are)';
        }
      } else {
        cls = 'new';
      }
      if (r.email) seen.add(r.email);
      counts[cls] = (counts[cls] || 0) + 1;
      out.nos.push(r.row_no);
      out.emails.push(r.email || null);
      out.data.push(JSON.stringify(r.data));
      out.cls.push(cls);
      out.msg.push(msg);
      out.sub.push(subId);
    }
    await ctx.pool.query(
      `UPDATE portal.import_rows ir SET email = t.e, data = t.d, classification = t.c, message = t.m, contact_id = t.s
         FROM UNNEST($2::int[], $3::text[], $4::jsonb[], $5::text[], $6::text[], $7::int[]) AS t(n, e, d, c, m, s)
        WHERE ir.import_id = $1 AND ir.row_no = t.n`,
      [id, out.nos, out.emails, out.data, out.cls, out.msg, out.sub],
    );
  }

  const summary = { preview: counts, importable: (counts.new || 0) + (counts.existing_add || 0) };
  const { rows } = await ctx.pool.query(
    `UPDATE portal.imports SET status = 'previewed', mapping = $2, options = $3, summary = $4, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, mapping, options, summary],
  );
  const { rows: samples } = await ctx.pool.query(
    `SELECT DISTINCT ON (classification) classification, row_no, email, message
       FROM portal.import_rows WHERE import_id = $1 ORDER BY classification, row_no`, [id]);
  return { import: rows[0], samples };
}

/** Starts the commit in the background; the UI polls the import status. */
async function commit(ctx, id) {
  const { rowCount } = await ctx.pool.query(
    `UPDATE portal.imports SET status = 'committing', updated_at = NOW() WHERE id = $1 AND status = 'previewed'`, [id]);
  if (!rowCount) throw conflict('Only a previewed import can be committed');
  await audit(ctx.pool, ctx.req, 'import.commit_started', { targetType: 'import', targetId: id });
  const run = runCommit(ctx, id).catch(async (err) => {
    ctx.logger.error({ err, importId: id }, 'import commit failed');
    await ctx.pool.query(
      `UPDATE portal.imports SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [id, err.message.slice(0, 500)],
    );
  });
  ctx.track?.(run);
  return { id, status: 'committing' };
}

async function runCommit(ctx, id) {
  const imp = await loadImport(ctx.pool, id);
  const opts = imp.options;
  const confirmed = (opts.subscriptionStatus || 'confirmed') === 'confirmed';
  const { rows: lists } = await ctx.pool.query('SELECT id, name, optin FROM portal.lists WHERE id = ANY($1::int[])', [opts.listIds]);
  const results = { imported: 0, added_to_lists: 0, failed: 0 };
  const evidence = opts.consent?.evidence || `CSV import ${imp.filename}`;

  for (let after = 0; ;) {
    const { rows } = await ctx.pool.query(
      `SELECT row_no, email, data, classification FROM portal.import_rows
        WHERE import_id = $1 AND classification IN ('new', 'existing_add') AND row_no > $2 ORDER BY row_no LIMIT $3`,
      [id, after, CHUNK]);
    if (!rows.length) break;
    after = rows[rows.length - 1].row_no;

    await withTransaction(ctx.pool, async (db) => {
      for (const r of rows) {
        const hash = emailHash(r.email);
        // Re-check suppression at commit time in case something changed since the preview.
        const sup = await db.query('SELECT 1 FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL', [hash]);
        if (sup.rowCount) {
          await db.query(`UPDATE portal.import_rows SET classification = 'suppressed', message = 'Suppressed since preview' WHERE import_id = $1 AND row_no = $2`, [id, r.row_no]);
          continue;
        }
        const d = r.data;
        let contactId;
        let created = false;
        const ins = await db.query(
          `INSERT INTO portal.contacts (email, email_hash, first_name, last_name, company, source, attribs, consent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ((LOWER(email))) DO NOTHING RETURNING id`,
          [r.email, hash, d.first_name || '', d.last_name || '', d.company || '', d.source, d.attribs || {},
            { status: 'granted', method: d.consent_method, purpose: d.consent_purpose || '', date: d.consent_date || null, source: d.source, import_id: id }]);
        if (ins.rowCount) {
          contactId = ins.rows[0].id;
          created = true;
        } else {
          contactId = (await db.query('SELECT id FROM portal.contacts WHERE LOWER(email) = $1', [r.email])).rows[0].id;
        }
        const added = await addMemberships(db, [contactId], lists, { confirmed });
        if (!created && !added) {
          await db.query(`UPDATE portal.import_rows SET classification = 'existing_unchanged', contact_id = $3,
            message = 'Already on every selected list (or unsubscribed from it)' WHERE import_id = $1 AND row_no = $2`, [id, r.row_no, contactId]);
          continue;
        }
        await db.query(
          `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, import_id, recorded_by)
           VALUES ($1, $2, $3, 'granted', $4, $5, $6, $7, $8, $9, $10)`,
          [contactId, r.email, hash, d.consent_method, d.consent_purpose || '', d.source, d.consent_date || null, evidence, id, imp.created_by]);
        await recipientEvent(db, { contactId, emailHash: hash, type: created ? 'imported' : 'lists_add', to: created ? 'active' : undefined,
          details: { import_id: id, list_ids: opts.listIds }, actorType: 'user', actorId: imp.created_by });
        if (!confirmed) await queueOptin(db, contactId);
        await db.query(`UPDATE portal.import_rows SET classification = $3, contact_id = $4 WHERE import_id = $1 AND row_no = $2`,
          [id, r.row_no, created ? 'imported' : 'added_to_lists', contactId]);
        results[created ? 'imported' : 'added_to_lists'] += 1;
      }
    });
  }

  const { rows: finalCounts } = await ctx.pool.query(
    `SELECT classification, COUNT(*)::int AS n FROM portal.import_rows WHERE import_id = $1 GROUP BY 1`, [id]);
  const summary = { ...imp.summary, result: Object.fromEntries(finalCounts.map((r) => [r.classification, r.n])), ...results };
  await ctx.pool.query(
    `UPDATE portal.imports SET status = 'completed', summary = $2, completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [id, summary]);
  await audit(ctx.pool, { user: { id: imp.created_by } }, 'import.completed', { targetType: 'import', targetId: id, details: results });
  return summary;
}

/** Imports left "committing" by a restart are marked failed; re-running is safe. */
async function recoverInterrupted(pool) {
  await pool.query(
    `UPDATE portal.imports SET status = 'failed', error = 'Interrupted by a restart. Upload the file again: rows already imported will show as existing.', updated_at = NOW()
      WHERE status = 'committing'`);
}

module.exports = { upload, preview, commit, runCommit, recoverInterrupted, loadImport, CLASS_LABELS, BLOCKING };
