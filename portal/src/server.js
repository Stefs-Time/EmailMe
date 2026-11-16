'use strict';

const pino = require('pino');
const { loadConfig } = require('./config');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { ListmonkClient } = require('./lib/listmonk');
const { SyncWorker } = require('./modules/sync/worker');
const { recoverInterrupted } = require('./modules/imports/service');
const { createApp } = require('./app');
const { ensureEnvAdmin, resolveListmonkCredentials, withRetry } = require('./lib/startup');
const { raiseAlert, resolveAlert } = require('./lib/audit');

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
  await ensureEnvAdmin(pool, config, logger);
  await recoverInterrupted(pool);

  const lm = new ListmonkClient({
    baseUrl: config.LISTMONK_URL,
    apiUser: null,
    apiToken: null,
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

  // Resolve listmonk API credentials in the background so the health check
  // passes while listmonk is still starting; the sync worker waits for them.
  const connectListmonk = async () => {
    const creds = await withRetry(() => resolveListmonkCredentials(pool, config, logger), logger, { attempts: 100, delayMs: 5000 });
    lm.setCredentials(creds.user, creds.token);
    await resolveAlert(pool, 'listmonk_credentials');
    logger.info({ user: creds.user, source: creds.source }, 'connected to listmonk API');
  };
  sync.onAuthFailure = async () => {
    if (!config.LISTMONK_ADMIN_USER) {
      await raiseAlert(pool, 'listmonk_credentials', 'critical',
        'listmonk rejected the portal API token. Update LISTMONK_API_TOKEN, or set LISTMONK_ADMIN_USER / LISTMONK_ADMIN_PASSWORD so MailHarbor can renew it.');
      return;
    }
    lm.setCredentials(null, null);
    await connectListmonk();
  };
  track(connectListmonk().then(() => sync.start()).catch(async (err) => {
    logger.error({ err: err.message }, 'could not connect to listmonk');
    await raiseAlert(pool, 'listmonk_credentials', 'critical', `MailHarbor cannot connect to listmonk: ${err.message}`).catch(() => {});
  }));

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
