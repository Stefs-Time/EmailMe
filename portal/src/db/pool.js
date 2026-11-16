'use strict';

const { Pool } = require('pg');

/**
 * Creates the shared connection pool. Keep DATABASE_POOL_MAX modest: listmonk
 * shares the same PostgreSQL server and Railway plans cap connections.
 */
function createPool(config) {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: config.DATABASE_SSL_VERIFY } : undefined,
    max: config.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 60000,
    application_name: 'mailharbor-portal',
  });
  return pool;
}

/** Runs fn inside a transaction, committing on success and rolling back on error. */
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs read-only queries against listmonk's tables. The READ ONLY transaction
 * guarantees the portal can never modify listmonk data directly; all writes go
 * through the listmonk API so its business rules always apply.
 */
async function readOnly(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withTransaction, readOnly };

/** Runs query thunks one after another (a pg client handles one query at a time). */
async function sequential(thunks) {
  const out = [];
  for (const t of thunks) out.push(await t());
  return out;
}

module.exports.sequential = sequential;
