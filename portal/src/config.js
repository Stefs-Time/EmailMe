'use strict';

/**
 * Central configuration. Every value comes from environment variables and is
 * validated once at startup so the process fails fast with a clear message
 * instead of misbehaving later.
 */
const { z } = require('zod');

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => ['true', '1', 'yes'].includes(v));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // PostgreSQL. The portal keeps its own tables in the `portal` schema and
  // reads (never writes) listmonk's tables in the same database.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: bool(false),
  // Verify the server certificate when SSL is on. Only disable for providers
  // that use self-signed certificates on a private network.
  DATABASE_SSL_VERIFY: bool(true),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  SESSION_MAX_AGE_HOURS: z.coerce.number().min(1).max(168).default(8),
  TRUST_PROXY: z.string().default('1'),
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

  // listmonk API (internal network address) and the public admin URL used for
  // deep links such as "Create campaign".
  LISTMONK_URL: z.string().url(),
  LISTMONK_PUBLIC_URL: z.string().url().optional(),
  LISTMONK_API_USER: z.string().regex(/^[a-zA-Z0-9_.-]{2,50}$/).default('mailharbor'),
  // Either give a token, or give listmonk admin credentials and the portal
  // creates its own least-privilege API user at startup (Railway friendly).
  LISTMONK_API_TOKEN: z.string().min(1).optional(),
  LISTMONK_ADMIN_USER: z.string().min(1).optional(),
  LISTMONK_ADMIN_PASSWORD: z.string().min(1).optional(),
  // With admin credentials: once, apply the scope's bounce policy and the
  // List-Unsubscribe header, and set listmonk's root URL to LISTMONK_PUBLIC_URL.
  LISTMONK_APPLY_RECOMMENDED: bool(true),
  LISTMONK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),

  // Business rules.
  GLOBAL_UNSUBSCRIBE: bool(true),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  SYNC_STALE_MINUTES: z.coerce.number().int().min(2).max(1440).default(15),
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(500000).default(100000),
  IMPORT_MAX_MB: z.coerce.number().min(1).max(100).default(25),

  ORG_NAME: z.string().default('MailHarbor'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Break-glass administrator controlled by environment variables. When set,
  // this account is created or repaired on every start: always an active admin
  // whose password equals ADMIN_PASSWORD. Change the variable to rotate it.
  ADMIN_EMAIL: z.string().trim().toLowerCase().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters')
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'ADMIN_PASSWORD needs letters and at least one number')
    .optional(),
  ADMIN_NAME: z.string().trim().min(1).max(120).default('Administrator'),

  // Alert when the last successful backup is older than this (0 = no check).
  BACKUP_STALE_HOURS: z.coerce.number().min(0).max(24 * 31).default(0),
}).superRefine((c, ctx) => {
  if (!c.LISTMONK_API_TOKEN && !(c.LISTMONK_ADMIN_USER && c.LISTMONK_ADMIN_PASSWORD)) {
    ctx.addIssue({ code: 'custom', path: ['LISTMONK_API_TOKEN'],
      message: 'Set LISTMONK_API_TOKEN, or LISTMONK_ADMIN_USER and LISTMONK_ADMIN_PASSWORD so the portal can create its own API user' });
  }
  if (Boolean(c.ADMIN_EMAIL) !== Boolean(c.ADMIN_PASSWORD)) {
    ctx.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'Set both ADMIN_EMAIL and ADMIN_PASSWORD, or neither' });
  }
});

function loadConfig(env = process.env) {
  // Platforms such as Railway may define variables as empty strings; treat
  // those as unset so defaults and "optional" behave as expected.
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    const err = new Error(`Invalid configuration:\n${lines.join('\n')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  const c = parsed.data;
  return Object.freeze({
    ...c,
    isProd: c.NODE_ENV === 'production',
    LISTMONK_URL: c.LISTMONK_URL.replace(/\/+$/, ''),
    LISTMONK_PUBLIC_URL: (c.LISTMONK_PUBLIC_URL || c.LISTMONK_URL).replace(/\/+$/, ''),
  });
}

module.exports = { loadConfig };
