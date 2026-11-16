'use strict';

/**
 * CSV import pipeline (scope §3.4):
 *   upload  -> parse and stage raw rows
 *   preview -> map columns, validate, detect duplicates, check suppression,
 *              match existing contacts, require a consent basis
 *   commit  -> new contacts go through listmonk's bulk importer (never
 *              overwriting), existing contacts are only added to lists they
 *              have never been on; consent evidence is recorded per contact.
 *
 * Importing can never reactivate an unsubscribed, bounced or blocklisted
 * contact: suppressed rows are excluded before anything reaches listmonk.
 */

const { withTransaction } = require('../../db/pool');
const { emailHash } = require('../../lib/email');
const { audit, recipientEvent } = require('../../lib/audit');
const { conflict, notFound, badRequest, validation } = require('../../lib/errors');
const { row: csvRow } = require('../../lib/csv');
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
  if (options.listIds.length) {
    const { rows } = await ctx.pool.query('SELECT id FROM lists WHERE id = ANY($1::int[])', [options.listIds]);
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
        `SELECT s.id, LOWER(s.email) AS email, s.status,
                COALESCE(ARRAY_AGG(x.list_id) FILTER (WHERE x.list_id IS NOT NULL), '{}') AS lists
           FROM subscribers s LEFT JOIN subscriber_lists x ON x.subscriber_id = s.id AND x.list_id = ANY($2::int[])
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
      } else if (ex && ex.status === 'blocklisted') {
        cls = 'suppressed';
        msg = 'Blocklisted in listmonk; will not be re-activated';
        subId = ex.id;
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
      `UPDATE portal.import_rows ir SET email = t.e, data = t.d, classification = t.c, message = t.m, subscriber_id = t.s
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

async function waitForListmonkImport(lm, timeoutMs = 15 * 60 * 1000) {
  const start = Date.now();
  for (;;) {
    const s = await lm.importStatus();
    if (s.status === 'finished') return s;
    if (s.status === 'failed') {
      const logs = await lm.importLogs().catch(() => '');
      throw new Error(`listmonk import failed: ${String(logs).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error('listmonk import timed out');
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function runCommit(ctx, id) {
  const imp = await loadImport(ctx.pool, id);
  const opts = imp.options;
  const subStatus = opts.subscriptionStatus || 'confirmed';
  const results = { imported: 0, added_to_lists: 0, failed: 0 };

  // Re-check suppression at commit time in case something changed since preview.
  await ctx.pool.query(
    `UPDATE portal.import_rows ir SET classification = 'suppressed', message = 'Suppressed since preview'
      WHERE ir.import_id = $1 AND ir.classification IN ('new', 'existing_add')
        AND EXISTS (SELECT 1 FROM portal.suppressions p WHERE p.lifted_at IS NULL
                     AND p.email_hash = encode(sha256(convert_to(LOWER(ir.email), 'UTF8')), 'hex'))`, [id]);

  // --- New contacts via listmonk's bulk importer --------------------------
  const { rows: newRows } = await ctx.pool.query(
    `SELECT row_no, email, data FROM portal.import_rows WHERE import_id = $1 AND classification = 'new' ORDER BY row_no`, [id]);
  // Contacts created by someone else between preview and commit are left alone.
  const { rows: nowExisting } = await ctx.pool.query(
    `SELECT LOWER(email) AS email FROM subscribers WHERE LOWER(email) = ANY($1::text[])`, [newRows.map((r) => r.email)]);
  const existsNow = new Set(nowExisting.map((r) => r.email));
  const toCreate = newRows.filter((r) => !existsNow.has(r.email));

  if (toCreate.length) {
    const status = await ctx.lm.importStatus();
    if (status.status === 'importing' || status.status === 'stopping') {
      throw new Error('listmonk is already running another import. Try again when it has finished.');
    }
    let csv = csvRow(['email', 'name', 'attributes']);
    for (const r of toCreate) {
      const d = r.data;
      const attribs = {
        ...d.attribs,
        first_name: d.first_name || '',
        last_name: d.last_name || '',
        company: d.company || '',
        source: d.source,
        consent: { status: 'granted', method: d.consent_method, purpose: d.consent_purpose || '',
          date: d.consent_date || null, source: d.source },
        import_id: id,
      };
      const name = [d.first_name, d.last_name].filter(Boolean).join(' ');
      // Raw CSV for listmonk (no formula escaping: this file is machine-read).
      csv += [r.email, name, JSON.stringify(attribs)].map((v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',') + '\r\n';
    }
    await ctx.lm.startImport({ csv, listIds: opts.listIds, subscriptionStatus: subStatus });
    await waitForListmonkImport(ctx.lm);
    await ctx.lm.request('DELETE', '/api/import/subscribers').catch(() => {}); // clear importer state
  }

  // Map created emails back to subscriber ids.
  const { rows: created } = await ctx.pool.query(
    `SELECT id, LOWER(email) AS email FROM subscribers WHERE LOWER(email) = ANY($1::text[])`, [toCreate.map((r) => r.email)]);
  const createdMap = new Map(created.map((c) => [c.email, c.id]));

  await withTransaction(ctx.pool, async (db) => {
    for (const r of newRows) {
      const subId = createdMap.get(r.email);
      if (existsNow.has(r.email)) {
        await db.query(`UPDATE portal.import_rows SET classification = 'existing_unchanged', message = 'Created by someone else before commit; left unchanged' WHERE import_id = $1 AND row_no = $2`, [id, r.row_no]);
        continue;
      }
      if (!subId) {
        results.failed += 1;
        await db.query(`UPDATE portal.import_rows SET classification = 'failed', message = 'listmonk did not import this row (see listmonk import log, e.g. domain blocklist)' WHERE import_id = $1 AND row_no = $2`, [id, r.row_no]);
        continue;
      }
      results.imported += 1;
      const hash = emailHash(r.email);
      await db.query(`UPDATE portal.import_rows SET classification = 'imported', subscriber_id = $3 WHERE import_id = $1 AND row_no = $2`, [id, r.row_no, subId]);
      await db.query(
        `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, import_id, recorded_by)
         VALUES ($1, $2, $3, 'granted', $4, $5, $6, $7, $8, $9, $10)`,
        [subId, r.email, hash, r.data.consent_method, r.data.consent_purpose || '', r.data.source,
          r.data.consent_date || null, opts.consent?.evidence || `CSV import ${imp.filename}`, id, imp.created_by]);
      await recipientEvent(db, { subscriberId: subId, emailHash: hash, type: 'imported', to: 'active',
        details: { import_id: id, lists: opts.listIds }, actorType: 'user', actorId: imp.created_by });
    }
  });

  // --- Existing contacts: add only the lists they have never been on -------
  const { rows: addRows } = await ctx.pool.query(
    `SELECT ir.row_no, ir.email, ir.data, ir.subscriber_id FROM portal.import_rows ir
      WHERE ir.import_id = $1 AND ir.classification = 'existing_add'`, [id]);
  if (addRows.length && opts.listIds.length) {
    const { rows: subsNow } = await ctx.pool.query(
      `SELECT x.subscriber_id, x.list_id, s.status FROM subscribers s
         LEFT JOIN subscriber_lists x ON x.subscriber_id = s.id AND x.list_id = ANY($2::int[])
        WHERE s.id = ANY($1::int[])`, [addRows.map((r) => r.subscriber_id), opts.listIds]);
    const has = new Set(subsNow.filter((s) => s.list_id).map((s) => `${s.subscriber_id}:${s.list_id}`));
    const blocked = new Set(subsNow.filter((s) => s.status === 'blocklisted').map((s) => s.subscriber_id));
    const groups = new Map();
    for (const r of addRows) {
      if (blocked.has(r.subscriber_id)) continue;
      const need = opts.listIds.filter((l) => !has.has(`${r.subscriber_id}:${l}`));
      if (!need.length) continue;
      const key = need.join(',');
      if (!groups.has(key)) groups.set(key, { lists: need, rows: [] });
      groups.get(key).rows.push(r);
    }
    for (const g of groups.values()) {
      const ids = g.rows.map((r) => r.subscriber_id);
      for (let i = 0; i < ids.length; i += 1000) {
        await ctx.lm.manageLists({ ids: ids.slice(i, i + 1000), action: 'add', listIds: g.lists, status: subStatus });
      }
      await withTransaction(ctx.pool, async (db) => {
        for (const r of g.rows) {
          const hash = emailHash(r.email);
          await db.query(`UPDATE portal.import_rows SET classification = 'added_to_lists' WHERE import_id = $1 AND row_no = $2`, [id, r.row_no]);
          await db.query(
            `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, import_id, recorded_by)
             VALUES ($1, $2, $3, 'granted', $4, $5, $6, $7, $8, $9, $10)`,
            [r.subscriber_id, r.email, hash, r.data.consent_method, r.data.consent_purpose || '', r.data.source,
              r.data.consent_date || null, opts.consent?.evidence || `CSV import ${imp.filename}`, id, imp.created_by]);
          await recipientEvent(db, { subscriberId: r.subscriber_id, emailHash: hash, type: 'lists_add',
            details: { import_id: id, list_ids: g.lists }, actorType: 'user', actorId: imp.created_by });
        }
      });
      results.added_to_lists += g.rows.length;
    }
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
