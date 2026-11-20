'use strict';

const crypto = require('node:crypto');
const { unauthorized, forbidden, AppError } = require('../lib/errors');

/**
 * Role model. Server-side checks are the only enforcement; the UI merely
 * hides controls a role cannot use.
 *   viewer  - dashboards, contacts (read), reports
 *   manager - + edit contacts and lists, import, export, suppress, review
 *   admin   - + lift suppression, erase contacts, users, audit log
 */
const PERMISSIONS = {
  'contacts:read': ['viewer', 'manager', 'admin'],
  'reports:read': ['viewer', 'manager', 'admin'],
  // Inbox: everyone can read replies; managers and administrators answer and manage them.
  'inbox:read': ['viewer', 'manager', 'admin'],
  'inbox:reply': ['manager', 'admin'],
  'contacts:write': ['manager', 'admin'],
  'lists:write': ['manager', 'admin'],
  'lists:delete': ['admin'],
  'imports:write': ['manager', 'admin'],
  'exports:read': ['manager', 'admin'],
  'suppression:add': ['manager', 'admin'],
  'review:resolve': ['manager', 'admin'],
  'suppression:lift': ['admin'],
  'contacts:erase': ['admin'],
  'users:manage': ['admin'],
  'audit:read': ['admin'],
  'system:read': ['manager', 'admin'],
  'campaigns:write': ['manager', 'admin'],
  'campaigns:send': ['manager', 'admin'],
  'settings:manage': ['admin'],
};

function can(role, permission) {
  return (PERMISSIONS[permission] || []).includes(role);
}

/** Loads the session user from the database on every request so disabling or
 *  demoting a user takes effect immediately. */
function loadUser(pool) {
  return async (req, _res, next) => {
    const id = req.session?.userId;
    if (!id) return next();
    const { rows } = await pool.query(
      `SELECT id, email, name, role, status, password_changed_at, managed_by_env FROM portal.users WHERE id = $1`,
      [id],
    );
    const u = rows[0];
    const pwdStamp = u ? new Date(u.password_changed_at).getTime() : null;
    if (!u || u.status !== 'active' || req.session.pwdStamp !== pwdStamp) {
      // User removed, disabled, or password changed elsewhere: end this session.
      await new Promise((r) => req.session.regenerate(() => r()));
      return next();
    }
    req.user = { id: u.id, email: u.email, name: u.name, role: u.role, managedByEnv: u.managed_by_env };
    next();
  };
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user.role, permission)) return next(forbidden());
    next();
  };
}

/**
 * CSRF protection (synchronizer token). The token lives in the session and the
 * SPA sends it in the X-CSRF-Token header on every state-changing request.
 * Combined with SameSite=Lax cookies this blocks cross-site form posts.
 */
function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

function csrfProtection(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || '';
  const expected = req.session?.csrfToken || '';
  const ok =
    sent.length > 0 &&
    sent.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return next(new AppError(403, 'CSRF_FAILED', 'Your session has expired. Please refresh the page.'));
  next();
}

module.exports = { PERMISSIONS, can, loadUser, requireAuth, requirePermission, ensureCsrfToken, csrfProtection };
