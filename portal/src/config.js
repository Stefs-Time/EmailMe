'use strict';

/**
 * Environment configuration. Only the database and the SMTP server are
 * required; everything else has a safe default or lives in the in-app
 * Settings page (stored in PostgreSQL).
 *
 * Required:  DATABASE_URL, SMTP_HOST
 * Usual:     SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
 * Platform:  PORT and RAILWAY_PUBLIC_DOMAIN are provided by Railway.
 */
const { z } = require('zod');

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => ['true', '1', 'yes'].includes(v));

const schema = z.object({
  // --- Required ------------------------------------------------------------
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),

  // --- SMTP ----------------------------------------------------------------
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // TLS from the first byte (port 465). Defaults to true on 465, otherwise
  // STARTTLS is used when the server offers it.
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  // Refuse to send without TLS (recommended; disable only for a local relay).
  SMTP_REQUIRE_TLS: bool(true),
  // Default sender, e.g. "Acme News <news@acme.co.za>". Editable in Settings.
  SMTP_FROM: z.string().optional(),
  SMTP_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),

  // --- Optional ------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  DATABASE_SSL: bool(false),
  DATABASE_SSL_VERIFY: bool(true),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
  // Generated and stored in the database when not provided.
  SESSION_SECRET: z.string().min(32).optional(),
  // Optional break-glass administrator, re-applied on every start.
  ADMIN_EMAIL: z.string().trim().toLowerCase().email().optional(),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD must be at least 12 characters')
    .refine((p) => /[a-zA-Z]/.test(p) && /[0-9]/.test(p), 'ADMIN_PASSWORD needs letters and at least one number')
    .optional(),
  ADMIN_NAME: z.string().trim().min(1).max(120).default('Administrator'),
  TRUST_PROXY: z.string().default('1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Background workers can be disabled for one-off scripts and tests.
  WORKERS: bool(true),
  IMPORT_MAX_ROWS: z.coerce.number().int().min(1).max(500000).default(100000),
  IMPORT_MAX_MB: z.coerce.number().min(1).max(100).default(25),
}).superRefine((c, ctx) => {
  if (Boolean(c.ADMIN_EMAIL) !== Boolean(c.ADMIN_PASSWORD)) {
    ctx.addIssue({ code: 'custom', path: ['ADMIN_PASSWORD'], message: 'Set both ADMIN_EMAIL and ADMIN_PASSWORD, or neither' });
  }
  if (Boolean(c.SMTP_USER) !== Boolean(c.SMTP_PASSWORD)) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'Set both SMTP_USER and SMTP_PASSWORD, or neither (unauthenticated relay)' });
  }
});

function loadConfig(env = process.env) {
  // Platforms may define variables as empty strings: treat those as unset.
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(clean);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    const err = new Error(`Invalid configuration:\n${lines.join('\n')}`);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  const c = parsed.data;
  const trim = (u) => (u ? u.replace(/\/+$/, '') : undefined);
  return Object.freeze({
    ...c,
    isProd: c.NODE_ENV === 'production',
    SMTP_SECURE: c.SMTP_SECURE ? c.SMTP_SECURE === 'true' : c.SMTP_PORT === 465,
    // PUBLIC_URL overrides (and locks) the Settings value; the Railway domain is only a fallback,
    // so a custom domain can be entered in Settings.
    envPublicUrl: trim(c.PUBLIC_URL),
    platformPublicUrl: c.RAILWAY_PUBLIC_DOMAIN ? trim(`https://${c.RAILWAY_PUBLIC_DOMAIN}`) : undefined,
  });
}

module.exports = { loadConfig };
