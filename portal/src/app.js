'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');

const { loadUser, requireAuth, csrfProtection } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/errors');
const { authRoutes } = require('./modules/auth/routes');
const { userRoutes } = require('./modules/users/routes');
const { contactRoutes } = require('./modules/contacts/routes');
const { listRoutes } = require('./modules/lists/routes');
const { importRoutes } = require('./modules/imports/routes');
const { exportRoutes } = require('./modules/exports/routes');
const { suppressionRoutes } = require('./modules/suppression/routes');
const { reportRoutes } = require('./modules/reports/routes');
const { systemRoutes } = require('./modules/system/routes');
const { campaignRoutes } = require('./modules/campaigns/routes');
const { settingsRoutes, setupRoutes } = require('./modules/settings/routes');
const { publicRoutes } = require('./modules/public/routes');
const { imageRoutes, publicImageRoute } = require('./modules/images/routes');
const { segmentRoutes } = require('./modules/segments/routes');
const { formRoutes, publicFormRoutes } = require('./modules/forms/routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

function createApp(deps) {
  const { pool, config, logger } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Behind Railway / a reverse proxy: trust the proxy hop so req.ip and secure
  // cookies work. A number means "trust N hops".
  app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          // https: lets the campaign editor show images hosted elsewhere.
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          // Only force https sub-resources in production (dev runs on plain http).
          'upgrade-insecure-requests': config.isProd ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    }),
  );

  // Unauthenticated liveness/readiness probe for Railway and Docker.
  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // Recipient-facing pages and provider webhooks (no login).
  app.use(publicRoutes(deps));
  app.use(publicImageRoute(deps));
  app.use(publicFormRoutes(deps));

  // Static assets: the SPA plus vendored Bootstrap / icons / Chart.js (no CDN).
  const staticOpts = { maxAge: config.isProd ? '1h' : 0, index: false };
  app.use('/vendor/bootstrap', express.static(path.join(NODE_MODULES, 'bootstrap', 'dist'), staticOpts));
  app.use('/vendor/bootstrap-icons', express.static(path.join(NODE_MODULES, 'bootstrap-icons', 'font'), staticOpts));
  app.use('/vendor/chart.js', express.static(path.join(NODE_MODULES, 'chart.js', 'dist'), staticOpts));
  app.use(express.static(PUBLIC_DIR, staticOpts));

  // Secure cookies in production (Railway and the reverse proxy terminate HTTPS).
  app.use(
    '/api',
    session({
      name: 'mh.sid',
      store: new PgStore({ pool, schemaName: 'portal', tableName: 'sessions', pruneSessionInterval: 15 * 60 }),
      secret: deps.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd,
        maxAge: 8 * 3600 * 1000,
      },
    }),
  );
  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }),
  }));
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', loadUser(pool));
  app.use('/api', csrfProtection);

  app.use('/api/auth', authRoutes(deps));
  app.use('/api/setup', setupRoutes(deps));
  app.use('/api', requireAuth);
  app.use('/api/users', userRoutes(deps));
  app.use('/api/contacts', contactRoutes(deps));
  app.use('/api/lists', listRoutes(deps));
  app.use('/api/imports', importRoutes(deps));
  app.use('/api/exports', exportRoutes(deps));
  app.use('/api/suppressions', suppressionRoutes(deps));
  app.use('/api/reports', reportRoutes(deps));
  app.use('/api/system', systemRoutes(deps));
  app.use('/api/campaigns', campaignRoutes(deps));
  app.use('/api/images', imageRoutes(deps));
  app.use('/api/segments', segmentRoutes(deps));
  app.use('/api/forms', formRoutes(deps));
  app.use('/api/settings', settingsRoutes(deps));
  app.use('/api', notFoundHandler);

  // SPA shell for every other GET.
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
