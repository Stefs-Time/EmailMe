'use strict';

/**
 * Optional break-glass administrator from ADMIN_EMAIL / ADMIN_PASSWORD.
 * When set, the account is created or repaired on every start: always an
 * active administrator with exactly that password. Without them, the first
 * administrator is created through the first-run setup screen.
 */
const argon2 = require('argon2');
const { audit } = require('./audit');

async function ensureEnvAdmin(pool, config, logger) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    await pool.query('UPDATE portal.users SET managed_by_env = FALSE WHERE managed_by_env');
    return;
  }
  const email = config.ADMIN_EMAIL;
  await pool.query('UPDATE portal.users SET managed_by_env = FALSE WHERE managed_by_env AND LOWER(email) <> $1', [email]);
  const { rows } = await pool.query('SELECT id, role, status, password_hash, managed_by_env FROM portal.users WHERE LOWER(email) = $1', [email]);
  const u = rows[0];
  if (!u) {
    const hash = await argon2.hash(config.ADMIN_PASSWORD, { type: argon2.argon2id });
    const ins = await pool.query(
      `INSERT INTO portal.users (email, name, role, password_hash, managed_by_env) VALUES ($1, $2, 'admin', $3, TRUE) RETURNING id`,
      [email, config.ADMIN_NAME, hash]);
    await audit(pool, null, 'user.env_admin_created', { targetType: 'user', targetId: ins.rows[0].id, details: { email } });
    logger.info({ email }, 'created administrator from ADMIN_EMAIL / ADMIN_PASSWORD');
    return;
  }
  const passwordOk = await argon2.verify(u.password_hash, config.ADMIN_PASSWORD).catch(() => false);
  const changes = [];
  if (!passwordOk) changes.push('password');
  if (u.role !== 'admin') changes.push('role');
  if (u.status !== 'active') changes.push('status');
  if (!u.managed_by_env) changes.push('managed');
  if (!changes.length) return;
  const hash = passwordOk ? u.password_hash : await argon2.hash(config.ADMIN_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `UPDATE portal.users SET password_hash = $2, role = 'admin', status = 'active', managed_by_env = TRUE,
       failed_logins = 0, locked_until = NULL, updated_at = NOW(),
       password_changed_at = CASE WHEN $3 THEN password_changed_at ELSE NOW() END
     WHERE id = $1`, [u.id, hash, passwordOk]);
  await audit(pool, null, 'user.env_admin_synced', { targetType: 'user', targetId: u.id, details: { changed: changes } });
  logger.info({ email, changed: changes }, 'administrator synchronised from environment variables');
}

module.exports = { ensureEnvAdmin };
