#!/usr/bin/env node
'use strict';

/**
 * Creates (or resets the password of) a portal administrator.
 * Usage: DATABASE_URL=... node scripts/create-admin.js admin@company.co.za "Full Name"
 * The password is read from the ADMIN_PASSWORD environment variable or prompted for.
 */
const readline = require('node:readline');
const argon2 = require('argon2');
const { Pool } = require('pg');
const { migrate } = require('../src/db/migrate');

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

(async () => {
  const [email, name = 'Administrator'] = process.argv.slice(2);
  if (!email || !process.env.DATABASE_URL) {
    console.error('Usage: DATABASE_URL=... node scripts/create-admin.js <email> ["Full Name"]');
    process.exit(1);
  }
  const password = process.env.ADMIN_PASSWORD || (await ask('Password (min 12 characters, letters and a number): '));
  if (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    console.error('Password too weak.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: process.env.DATABASE_SSL_VERIFY !== 'false' } : undefined });
  try {
    await migrate(pool, { info: () => {} });
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const { rows } = await pool.query(
      `INSERT INTO portal.users (email, name, role, password_hash) VALUES (LOWER($1), $2, 'admin', $3)
       ON CONFLICT ((LOWER(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', status = 'active',
         failed_logins = 0, locked_until = NULL, password_changed_at = NOW(), updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [email, name, hash],
    );
    console.log(rows[0].inserted ? `Administrator ${email} created.` : `Administrator ${email} updated (password reset).`);
  } finally {
    await pool.end();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
