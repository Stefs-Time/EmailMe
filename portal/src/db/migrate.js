'use strict';

/**
 * Minimal, forward-only migration runner.
 * - Applies src/db/migrations/*.sql in filename order.
 * - Each file runs in its own transaction.
 * - A PostgreSQL advisory lock prevents two instances migrating at once.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 74219031; // arbitrary constant for pg_advisory_lock

async function migrate(pool, log = console) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {
      // gen_random_uuid() is built in from PostgreSQL 13; the extension is a
      // fallback for older servers and may be unavailable to non-superusers.
    });
    // Check first: CREATE SCHEMA IF NOT EXISTS still requires the CREATE
    // privilege on the database, which the least-privilege role does not have
    // when the schema was pre-created for it (deploy/postgres/portal-role.sql).
    const { rowCount: hasSchema } = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'portal'`);
    if (!hasSchema) await client.query('CREATE SCHEMA portal');
    await client.query(`CREATE TABLE IF NOT EXISTS portal.schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    const { rows } = await client.query('SELECT version FROM portal.schema_migrations');
    const applied = new Set(rows.map((r) => r.version));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info?.({ migration: file }, 'applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO portal.schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const { Pool } = require('pg');
  (async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_VERIFY !== 'false' } : undefined,
    });
    try {
      await migrate(pool, { info: (o, m) => console.log(m, o.migration) });
      console.log('Migrations complete.');
    } finally {
      await pool.end();
    }
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
