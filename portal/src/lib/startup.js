'use strict';

/**
 * Startup tasks that make the portal self-configuring on Railway:
 *  - ensureEnvAdmin: the ADMIN_EMAIL / ADMIN_PASSWORD account always exists,
 *    is an active administrator and has that password.
 *  - resolveListmonkCredentials: use LISTMONK_API_TOKEN, or create (and
 *    remember, encrypted) a least-privilege API user with the listmonk admin
 *    credentials. Optionally applies the recommended listmonk settings once.
 */
const argon2 = require('argon2');
const { ListmonkClient } = require('./listmonk');
const { loginSession, createApiUser, applyRecommended } = require('./listmonkAdmin');
const { getSecret, setSecret } = require('./secrets');
const { audit } = require('./audit');

async function ensureEnvAdmin(pool, config, logger) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    await pool.query('UPDATE portal.users SET managed_by_env = FALSE WHERE managed_by_env');
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM portal.users WHERE role = 'admin' AND status = 'active'`);
    if (!rows[0].n) logger.warn('No active portal administrator. Set ADMIN_EMAIL and ADMIN_PASSWORD (or run scripts/create-admin.js).');
    return;
  }
  const email = config.ADMIN_EMAIL;
  // Only one account is environment-managed at a time.
  await pool.query('UPDATE portal.users SET managed_by_env = FALSE WHERE managed_by_env AND LOWER(email) <> $1', [email]);
  const { rows } = await pool.query(
    'SELECT id, role, status, password_hash, managed_by_env FROM portal.users WHERE LOWER(email) = $1', [email]);
  const u = rows[0];
  if (!u) {
    const hash = await argon2.hash(config.ADMIN_PASSWORD, { type: argon2.argon2id });
    const ins = await pool.query(
      `INSERT INTO portal.users (email, name, role, password_hash, managed_by_env)
       VALUES ($1, $2, 'admin', $3, TRUE) RETURNING id`, [email, config.ADMIN_NAME, hash]);
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

const TOKEN_KEY = 'listmonk_api_token';

async function tokenWorks(config, user, token, logger) {
  const lm = new ListmonkClient({ baseUrl: config.LISTMONK_URL, apiUser: user, apiToken: token, timeoutMs: config.LISTMONK_TIMEOUT_MS, logger });
  try {
    await lm.getLists();
    return true;
  } catch (err) {
    if (/credentials|permission/i.test(err.message)) return false;
    throw err; // listmonk unreachable: let the caller retry
  }
}

async function resolveListmonkCredentials(pool, config, logger) {
  const user = config.LISTMONK_API_USER;
  if (config.LISTMONK_API_TOKEN) return { user, token: config.LISTMONK_API_TOKEN, source: 'environment' };

  const stored = await getSecret(pool, config.SESSION_SECRET, TOKEN_KEY);
  if (stored && (await tokenWorks(config, user, stored, logger))) {
    await maybeApplyRecommended(pool, config, logger);
    return { user, token: stored, source: 'stored' };
  }

  logger.info({ user }, stored ? 'stored listmonk token no longer valid; creating a new API user' : 'creating listmonk API user for the portal');
  const api = await loginSession(config.LISTMONK_URL, config.LISTMONK_ADMIN_USER, config.LISTMONK_ADMIN_PASSWORD, config.LISTMONK_TIMEOUT_MS);
  const token = await createApiUser(api, user, { replace: true });
  await setSecret(pool, config.SESSION_SECRET, TOKEN_KEY, token);
  await audit(pool, null, 'system.listmonk_api_user_created', { details: { user } });
  await maybeApplyRecommended(pool, config, logger, api);
  return { user, token, source: 'created' };
}

async function maybeApplyRecommended(pool, config, logger, api) {
  if (!config.LISTMONK_APPLY_RECOMMENDED || !config.LISTMONK_ADMIN_USER) return;
  const { rows } = await pool.query(`SELECT 1 FROM portal.sync_state WHERE key = 'listmonk_recommended_applied'`);
  if (rows.length) return;
  try {
    const session = api || (await loginSession(config.LISTMONK_URL, config.LISTMONK_ADMIN_USER, config.LISTMONK_ADMIN_PASSWORD, config.LISTMONK_TIMEOUT_MS));
    const rootUrl = config.LISTMONK_PUBLIC_URL !== config.LISTMONK_URL ? config.LISTMONK_PUBLIC_URL : undefined;
    const changed = await applyRecommended(session, { rootUrl });
    await pool.query(
      `INSERT INTO portal.sync_state (key, value) VALUES ('listmonk_recommended_applied', $1)
       ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ at: new Date().toISOString(), changed })]);
    if (changed.length) logger.info({ changed }, 'applied recommended listmonk settings');
  } catch (err) {
    logger.warn({ err: err.message }, 'could not apply recommended listmonk settings');
  }
}

/** Retries while listmonk is still starting (common on a fresh Railway deploy). */
async function withRetry(fn, logger, { attempts = 20, delayMs = 3000 } = {}) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts || /login failed|already exists/.test(err.message)) throw err;
      logger.warn({ attempt: i, err: err.message }, 'listmonk not ready; retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { ensureEnvAdmin, resolveListmonkCredentials, withRetry, TOKEN_KEY };
