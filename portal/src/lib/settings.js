'use strict';

/**
 * Application settings edited in the UI (Settings page) and stored in
 * portal.settings. Environment variables only carry database and SMTP
 * connection details; everything an operator may want to change lives here.
 */
const crypto = require('node:crypto');
const { z } = require('zod');
const { encrypt, decrypt } = require('./secrets');

const mailbox = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().max(255).default(''),
  port: z.coerce.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().max(255).default(''),
  password: z.string().max(500).optional(), // write-only; stored encrypted
  folder: z.string().trim().min(1).max(200).default('INBOX'),
  after: z.enum(['move', 'delete']).default('move'),
  interval_minutes: z.coerce.number().int().min(1).max(1440).default(5),
});

const SCHEMA = z.object({
  org_name: z.string().trim().min(1).max(120).default('MailHarbor'),
  // Postal address shown in every email footer (sender identity, scope §3.5).
  org_address: z.string().trim().max(300).default(''),
  public_url: z.union([z.string().url().max(300), z.literal('')]).default(''),
  from_name: z.string().trim().max(120).default(''),
  from_email: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  reply_to: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  // Envelope sender (Return-Path) where delivery failures are returned.
  bounce_address: z.union([z.string().trim().email().max(254), z.literal('')]).default(''),
  send_rate_per_second: z.coerce.number().min(0.1).max(100).default(5),
  send_max_per_hour: z.coerce.number().int().min(0).max(1000000).default(0),
  soft_bounce_limit: z.coerce.number().int().min(1).max(20).default(3),
  global_unsubscribe: z.boolean().default(true),
  track_opens: z.boolean().default(true),
  track_clicks: z.boolean().default(true),
  bounce_mailbox: mailbox.default({}),
  webhook_token: z.string().default(''),
  backup_stale_hours: z.coerce.number().min(0).max(744).default(0),
});

// zod 4 returns .default({}) objects as-is, so build nested defaults explicitly.
const DEFAULTS = { ...SCHEMA.parse({}), bounce_mailbox: mailbox.parse({}) };
const CACHE_MS = 5000;

class Settings {
  constructor(pool, encKey, config) {
    this.pool = pool;
    this.encKey = encKey;
    this.config = config;
    this.cache = null;
    this.cachedAt = 0;
  }

  async all() {
    if (this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    const { rows } = await this.pool.query('SELECT key, value FROM portal.settings');
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const merged = { ...DEFAULTS, ...stored, bounce_mailbox: { ...DEFAULTS.bounce_mailbox, ...(stored.bounce_mailbox || {}) } };
    if (!merged.from_email && this.config?.SMTP_FROM) {
      const m = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/.exec(this.config.SMTP_FROM.trim());
      merged.from_email = m ? m[2] : this.config.SMTP_FROM.trim();
      if (!merged.from_name && m?.[1]) merged.from_name = m[1].trim();
    }
    if (!merged.webhook_token) {
      const token = crypto.randomBytes(24).toString('base64url');
      await this.pool.query(
        `INSERT INTO portal.settings (key, value) VALUES ('webhook_token', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE portal.settings.value = '""'::jsonb`,
        [JSON.stringify(token)]);
      const { rows: t } = await this.pool.query(`SELECT value FROM portal.settings WHERE key = 'webhook_token'`);
      merged.webhook_token = t[0].value;
    }
    this.cache = merged;
    this.cachedAt = Date.now();
    return merged;
  }

  invalidate() { this.cache = null; }

  /** Public base URL for links in emails: env (PUBLIC_URL / Railway) wins, then Settings. */
  async publicUrl() {
    if (this.config?.envPublicUrl) return this.config.envPublicUrl;
    const s = await this.all();
    return (s.public_url || '').replace(/\/+$/, '') || this.config?.platformPublicUrl || '';
  }

  /** Bounce mailbox settings with the password decrypted (server use only). */
  async mailbox() {
    const s = await this.all();
    const m = { ...s.bounce_mailbox };
    m.password = m.password_enc ? decrypt(this.encKey, m.password_enc) : '';
    delete m.password_enc;
    return m;
  }

  /** Settings as shown in the UI: secrets are never returned. */
  async forUi() {
    const s = await this.all();
    const { password_enc: enc, ...mb } = s.bounce_mailbox; // eslint-disable-line no-unused-vars
    return { ...s, bounce_mailbox: { ...mb, password_set: Boolean(enc) }, public_url_locked: Boolean(this.config?.envPublicUrl),
      effective_public_url: await this.publicUrl() };
  }

  /** Validates and saves a partial update. Returns the list of changed keys. */
  async update(patch, userId) {
    const current = await this.all();
    const partial = SCHEMA.partial().parse(patch);
    const changed = [];
    // zod fills defaults even for omitted keys: only write what was sent.
    for (const [key, value] of Object.entries(partial).filter(([k]) => Object.hasOwn(patch, k))) {
      let v = value;
      if (key === 'bounce_mailbox') {
        const { password, ...rest } = value;
        v = { ...current.bounce_mailbox, ...rest };
        if (password !== undefined && password !== '') v.password_enc = encrypt(this.encKey, password);
      }
      await this.pool.query(
        `INSERT INTO portal.settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [key, JSON.stringify(v), userId || null]);
      changed.push(key);
    }
    this.invalidate();
    return changed;
  }
}

module.exports = { Settings, SETTINGS_SCHEMA: SCHEMA, DEFAULTS };
