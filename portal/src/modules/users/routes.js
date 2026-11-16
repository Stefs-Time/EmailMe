'use strict';

const express = require('express');
const argon2 = require('argon2');
const { z } = require('zod');
const { parse, conflict, notFound, badRequest } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { passwordSchema } = require('../auth/routes');

const roleEnum = z.enum(['admin', 'manager', 'viewer']);
const idSchema = z.string().uuid();

function userRoutes({ pool }) {
  const r = express.Router();
  r.use(requirePermission('users:manage'));

  r.get('/', async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, status, last_login_at, created_at FROM portal.users ORDER BY name`,
    );
    res.json({ success: true, data: rows });
  });

  r.post('/', async (req, res) => {
    const body = parse(
      z.object({
        email: z.string().trim().toLowerCase().email().max(254),
        name: z.string().trim().min(1).max(120),
        role: roleEnum,
        password: passwordSchema,
      }),
      req.body,
    );
    const hash = await argon2.hash(body.password, { type: argon2.argon2id });
    try {
      const { rows } = await pool.query(
        `INSERT INTO portal.users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, status, created_at`,
        [body.email, body.name, body.role, hash],
      );
      await audit(pool, req, 'user.created', { targetType: 'user', targetId: rows[0].id, details: { email: body.email, role: body.role } });
      res.status(201).json({ success: true, data: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw conflict('A user with that email already exists');
      throw err;
    }
  });

  r.patch('/:id', async (req, res) => {
    const id = parse(idSchema, req.params.id);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        role: roleEnum.optional(),
        status: z.enum(['active', 'disabled']).optional(),
        password: passwordSchema.optional(),
      }),
      req.body,
    );
    if (id === req.user.id && (body.role && body.role !== 'admin' || body.status === 'disabled')) {
      throw badRequest('You cannot demote or disable your own account');
    }
    const { rows: existing } = await pool.query('SELECT id, role, status FROM portal.users WHERE id = $1', [id]);
    if (!existing.length) throw notFound('User not found');

    // Keep at least one active admin.
    if (existing[0].role === 'admin' && ((body.role && body.role !== 'admin') || body.status === 'disabled')) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM portal.users WHERE role = 'admin' AND status = 'active' AND id <> $1`,
        [id],
      );
      if (rows[0].n === 0) throw badRequest('At least one active administrator is required');
    }

    const sets = [];
    const params = [id];
    const add = (col, v) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.name) add('name', body.name);
    if (body.role) add('role', body.role);
    if (body.status) add('status', body.status);
    if (body.password) {
      add('password_hash', await argon2.hash(body.password, { type: argon2.argon2id }));
      sets.push('password_changed_at = NOW()', 'failed_logins = 0', 'locked_until = NULL');
    }
    if (!sets.length) throw badRequest('Nothing to update');
    const { rows } = await pool.query(
      `UPDATE portal.users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1
       RETURNING id, email, name, role, status, last_login_at, created_at`,
      params,
    );
    const changed = Object.keys(body).map((k) => (k === 'password' ? 'password(reset)' : k));
    await audit(pool, req, 'user.updated', { targetType: 'user', targetId: id, details: { changed, role: body.role, status: body.status } });
    res.json({ success: true, data: rows[0] });
  });

  return r;
}

module.exports = { userRoutes };
