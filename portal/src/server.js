'use strict';

const pino = require('pino');
const { loadConfig } = require('./config');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const { getOrCreate } = require('./lib/secrets');
const { Settings } = require('./lib/settings');
const { ensureEnvAdmin } = require('./lib/envAdmin');
const { createTransport } = require('./engine/mailer');
const { Worker } = require('./engine/worker');
const { ensureDefaultTemplate } = require('./modules/templates/routes');
const { announceSetupCode } = require('./modules/settings/routes');
const { recoverInterrupted } = require('./modules/imports/service');
const { createApp } = require('./app');

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
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.pass', '*.token'], remove: true },
  });

  const pool = createPool(config);
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  await migrate(pool, logger);
  const sessionSecret = config.SESSION_SECRET || (await getOrCreate(pool, 'session_secret'));
  const encKey = await getOrCreate(pool, 'enc_key');
  const settings = new Settings(pool, encKey, config);
  await ensureEnvAdmin(pool, config, logger);
  await ensureDefaultTemplate(pool);
  await recoverInterrupted(pool);
  await announceSetupCode(pool, logger);

  const transport = createTransport(config);
  const worker = new Worker({ pool, settings, transport, logger });

  const background = new Set();
  const track = (p) => {
    background.add(p);
    p.finally(() => background.delete(p));
  };

  const app = createApp({ pool, config, logger, settings, transport, worker, track, sessionSecret });
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info({ port: config.PORT, publicUrl: config.envPublicUrl || '(from Settings)' }, 'MailHarbor listening');
  });
  server.requestTimeout = 10 * 60 * 1000; // large exports
  server.headersTimeout = 65 * 1000;
  server.keepAliveTimeout = 61 * 1000;

  if (config.WORKERS) {
    await worker.start();
    transport.verify()
      .then(() => logger.info({ host: config.SMTP_HOST }, 'SMTP connection verified'))
      .catch((err) => logger.error({ host: config.SMTP_HOST, err: err.message }, 'SMTP verification failed: check the SMTP_* variables'));
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 25000);
    force.unref();
    server.close();
    await worker.stop();
    await Promise.allSettled([...background]);
    transport.close();
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
