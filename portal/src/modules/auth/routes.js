'use strict';

const express = require('express');
const argon2 = require('argon2');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { parse, AppError, unauthorized, validation } = require('../../lib/errors');
const { requireAuth, ensureCsrfToken, PERMISSIONS, can } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

// Verifying against a dummy hash when the user does not exist keeps response
// times uniform, so login timing does not reveal which emails are registered.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await argon2.hash('not-a-real-password-' + Math.random()));

const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'Use letters and at least one number');

function permissionsFor(role) {
  return Object.keys(PERMISSIONS).filter((p) => can(role, p));
}

function authRoutes({ pool, config }) {
  const r = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many login attempts. Try again in a few minutes.' },
      }),
  });

  /** Session bootstrap for the SPA: who am I + CSRF token. */
  r.get('/session', (req, res) => {
    const csrfToken = ensureCsrfToken(req);
    res.json({
      success: true,
      data: {
        user: req.user ? { ...req.user, permissions: permissionsFor(req.user.role) } : null,
        csrfToken,
        orgName: config.ORG_NAME,
        listmonkUrl: config.LISTMONK_PUBLIC_URL,
      },
    });
  });

  r.post('/login', loginLimiter, async (req, res) => {
    const body = parse(z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(200) }), req.body);
    const { rows } = await pool.query(
      `SELECT id, email, name, role, status, password_hash, failed_logins, locked_until, password_changed_at
         FROM portal.users WHERE LOWER(email) = LOWER($1)`,
      [body.email],
    );
    const u = rows[0];
    if (!u) {
      await argon2.verify(await getDummyHash(), body.password).catch(() => false);
      throw unauthorized('Incorrect email or password');
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
    }
    const ok = await argon2.verify(u.password_hash, body.password).catch(() => false);
    if (!ok || u.status !== 'active') {
      const failed = u.failed_logins + 1;
      await pool.query(
        `UPDATE portal.users SET failed_logins = $2,
           locked_until = CASE WHEN $2 >= $3 THEN NOW() + ($4 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1`,
        [u.id, failed >= MAX_FAILED ? 0 : failed, MAX_FAILED, String(LOCK_MINUTES)],
      );
      await audit(pool, req, 'auth.login_failed', { targetType: 'user', targetId: u.id });
      throw unauthorized('Incorrect email or password');
    }

    // Prevent session fixation: issue a fresh session id on login.
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
    req.session.userId = u.id;
    req.session.pwdStamp = new Date(u.password_changed_at).getTime();
    const csrfToken = ensureCsrfToken(req);
    await pool.query('UPDATE portal.users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [u.id]);
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    await audit(pool, req, 'auth.login', { targetType: 'user', targetId: u.id });
    res.json({ success: true, data: { user: { ...req.user, permissions: permissionsFor(u.role) }, csrfToken } });
  });

  r.post('/logout', async (req, res) => {
    if (req.user) await audit(pool, req, 'auth.logout', { targetType: 'user', targetId: req.user.id });
    await new Promise((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('mh.sid');
    res.json({ success: true, data: {} });
  });

  r.post('/change-password', requireAuth, async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }), req.body);
    const { rows } = await pool.query('SELECT password_hash FROM portal.users WHERE id = $1', [req.user.id]);
    if (!(await argon2.verify(rows[0].password_hash, body.currentPassword).catch(() => false))) {
      throw validation('Current password is incorrect', [{ field: 'currentPassword', message: 'Incorrect password' }]);
    }
    const hash = await argon2.hash(body.newPassword, { type: argon2.argon2id });
    const { rows: upd } = await pool.query(
      `UPDATE portal.users SET password_hash = $2, password_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING password_changed_at`,
      [req.user.id, hash],
    );
    req.session.pwdStamp = new Date(upd[0].password_changed_at).getTime();
    await audit(pool, req, 'auth.password_changed', { targetType: 'user', targetId: req.user.id });
    res.json({ success: true, data: {} });
  });

  return r;
}

module.exports = { authRoutes, passwordSchema, permissionsFor };
