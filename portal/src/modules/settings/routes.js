'use strict';

const crypto = require('node:crypto');
const express = require('express');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { parse, badRequest, forbidden, conflict } = require('../../lib/errors');
const { requirePermission, ensureCsrfToken } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { isValidEmail } = require('../../lib/email');
const { describeSmtp } = require('../../engine/mailer');
const { testMailbox } = require('../../engine/mailbox');
const { passwordSchema, permissionsFor } = require('../auth/routes');

function settingsRoutes({ pool, settings, transport, config, worker }) {
  const r = express.Router();
  r.use(requirePermission('settings:manage'));

  r.get('/', async (_req, res) => {
    res.json({ success: true, data: { ...(await settings.forUi()), smtp: describeSmtp(config) } });
  });

  r.put('/', async (req, res) => {
    const changed = await settings.update(req.body || {}, req.user.id);
    await audit(pool, req, 'settings.updated', { details: { changed } });
    res.json({ success: true, data: { ...(await settings.forUi()), smtp: describeSmtp(config) } });
  });

  /** Sends one real email straight through SMTP and reports the server's answer (TC01). */
  r.post('/smtp-test', async (req, res) => {
    const body = parse(z.object({ to: z.string().trim().max(254) }), req.body);
    if (!isValidEmail(body.to)) throw badRequest('Enter a valid email address');
    const s = await settings.all();
    if (!s.from_email) throw badRequest('Set a sender address first (Settings → Sending)');
    try {
      await transport.verify();
      const info = await transport.sendMail({
        from: { name: s.from_name || s.org_name, address: s.from_email }, to: body.to,
        subject: `${s.org_name}: SMTP test from MailHarbor`,
        text: `This is a test email from MailHarbor.\n\nIf you received it, outgoing email is working.\nServer: ${config.SMTP_HOST}:${config.SMTP_PORT}`,
        envelope: { from: s.bounce_address || s.from_email, to: body.to },
      });
      await audit(pool, req, 'settings.smtp_tested', { details: { ok: true } });
      res.json({ success: true, data: { ok: true, response: info.response } });
    } catch (err) {
      await audit(pool, req, 'settings.smtp_tested', { details: { ok: false } });
      res.json({ success: true, data: { ok: false, error: String(err.response || err.message).slice(0, 300) } });
    }
  });

  r.post('/mailbox-test', async (req, res) => {
    const saved = await settings.mailbox();
    const body = parse(z.object({ host: z.string().optional(), port: z.coerce.number().optional(), secure: z.boolean().optional(),
      user: z.string().optional(), password: z.string().optional(), folder: z.string().optional() }), req.body || {});
    const m = { ...saved, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== '')) };
    if (!m.host || !m.user || !m.password) throw badRequest('Enter the host, username and password');
    try {
      const out = await testMailbox(m);
      res.json({ success: true, data: { ok: true, messages: out.messages } });
    } catch (err) {
      res.json({ success: true, data: { ok: false, error: err.authenticationFailed ? 'Login failed: check the username and password' : String(err.responseText || err.message).slice(0, 300) } });
    }
  });

  r.post('/mailbox-poll', async (req, res) => {
    const out = await worker.mailboxIfDue(true);
    await audit(pool, req, 'settings.mailbox_polled', { details: out || {} });
    res.json({ success: true, data: out || { skipped: true } });
  });

  r.post('/webhook-token', async (req, res) => {
    await settings.update({ webhook_token: crypto.randomBytes(24).toString('base64url') }, req.user.id);
    await audit(pool, req, 'settings.webhook_token_rotated');
    res.json({ success: true, data: await settings.forUi() });
  });

  return r;
}

/**
 * First-run setup: creates the first administrator. Protected by a one-time
 * code printed in the server log (deploy logs on Railway), so a stranger who
 * finds the URL first cannot claim the installation.
 */
function setupRoutes({ pool, settings, logger, config }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

  const needed = async () => (await pool.query('SELECT 1 FROM portal.users LIMIT 1')).rowCount === 0;

  r.get('/status', async (req, res) => {
    res.json({ success: true, data: { needed: await needed(), suggestedUrl: `${req.protocol}://${req.get('host')}`, supportEmail: config?.SUPPORT_EMAIL || null } });
  });

  r.post('/', limiter, async (req, res) => {
    if (!(await needed())) throw conflict('Setup has already been completed');
    const body = parse(z.object({
      code: z.string().trim().min(6).max(64),
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().toLowerCase().email().max(254),
      password: passwordSchema,
      org_name: z.string().trim().min(1).max(120),
      public_url: z.string().url().max(300),
      from_email: z.string().trim().email().max(254),
      from_name: z.string().trim().max(120).default(''),
    }), req.body);
    const { rows } = await pool.query(`SELECT value FROM portal.app_secrets WHERE key = 'setup_code'`);
    const want = Buffer.from(rows[0]?.value || '');
    const got = Buffer.from(body.code.toUpperCase());
    if (!want.length || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      logger.warn({ ip: req.ip }, 'setup attempted with a wrong code');
      throw forbidden(`That setup code is not correct. Use the code MailHarbor sent you when your service was created${config?.SUPPORT_EMAIL ? `, or ask ${config.SUPPORT_EMAIL}` : ''}.`);
    }
    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    const ins = await pool.query(
      `INSERT INTO portal.users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)
       RETURNING id, email, name, role, password_changed_at`, [body.email, body.name, hash]);
    await pool.query(`DELETE FROM portal.app_secrets WHERE key = 'setup_code'`);
    const u = ins.rows[0];
    await settings.update({ org_name: body.org_name, public_url: body.public_url.replace(/\/+$/, ''), from_email: body.from_email,
      from_name: body.from_name || body.org_name }, u.id);
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    req.session.userId = u.id;
    req.session.pwdStamp = new Date(u.password_changed_at).getTime();
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    await audit(pool, req, 'setup.completed', { targetType: 'user', targetId: u.id });
    res.status(201).json({ success: true, data: { user: { ...req.user, permissions: permissionsFor('admin') }, csrfToken: ensureCsrfToken(req) } });
  });

  return r;
}

/** Creates (or prints the existing) setup code while no users exist. */
async function announceSetupCode(pool, logger) {
  const { rowCount } = await pool.query('SELECT 1 FROM portal.users LIMIT 1');
  if (rowCount) return null;
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  await pool.query(`INSERT INTO portal.app_secrets (key, value) VALUES ('setup_code', $1) ON CONFLICT (key) DO NOTHING`, [code]);
  const { rows } = await pool.query(`SELECT value FROM portal.app_secrets WHERE key = 'setup_code'`);
  logger.warn(`FIRST-RUN SETUP: open MailHarbor in your browser and enter setup code ${rows[0].value}`);
  return rows[0].value;
}

module.exports = { settingsRoutes, setupRoutes, announceSetupCode };
