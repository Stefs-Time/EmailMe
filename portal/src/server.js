'use strict';

const pino = require('pino');
const argon2 = require('argon2');
const { loadConfig } = require('./config');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { ListmonkClient } = require('./lib/listmonk');
const { SyncWorker } = require('./modules/sync/worker');
const { recoverInterrupted } = require('./modules/imports/service');
const { createApp } = require('./app');

async function ensureFirstAdmin(pool, config, logger) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM portal.users');
  if (rows[0].n > 0) return;
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
    logger.warn('No portal users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (or run `npm run create-admin`) to create the first administrator.');
    return;
  }
  const hash = await argon2.hash(config.ADMIN_PASSWORD, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO portal.users (email, name, role, password_hash) VALUES ($1, 'Administrator', 'admin', $2)`,
    [config.ADMIN_EMAIL.toLowerCase(), hash],
  );
  logger.info({ email: config.ADMIN_EMAIL }, 'created first administrator; remove ADMIN_PASSWORD from the environment now');
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const logger = pino({
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.token'], remove: true },
  });

  const pool = createPool(config);
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  await migrate(pool, logger);
  await ensureFirstAdmin(pool, config, logger);
  await recoverInterrupted(pool);

  const lm = new ListmonkClient({
    baseUrl: config.LISTMONK_URL,
    apiUser: config.LISTMONK_API_USER,
    apiToken: config.LISTMONK_API_TOKEN,
    timeoutMs: config.LISTMONK_TIMEOUT_MS,
    logger,
  });

  const background = new Set();
  const track = (p) => {
    background.add(p);
    p.finally(() => background.delete(p));
  };

  const sync = new SyncWorker({ pool, listmonk: lm, config, logger });
  const app = createApp({ pool, lm, config, logger, sync, track });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT }, 'MailHarbor portal listening');
  });
  server.requestTimeout = 10 * 60 * 1000; // large exports
  server.headersTimeout = 65 * 1000;
  server.keepAliveTimeout = 61 * 1000;
  sync.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25000);
    force.unref();
    server.close();
    await sync.stop();
    await Promise.allSettled([...background]);
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
