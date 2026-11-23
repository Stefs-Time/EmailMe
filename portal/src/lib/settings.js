'use strict';

/**
 * Application settings edited in the UI (Settings page) and stored in
 * portal.settings. Environment variables only carry database and SMTP
 * connection details; everything an operator may want to change lives here.
 */
const crypto = require('node:crypto');
const { z } = require('zod');
const { encrypt, decrypt } = require('./secrets');
const { parse } = require('./errors');

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

// The customer's outgoing mail server (Settings → Sending). Empty host = the operator's SMTP_* default.
const smtp = z.object({
  host: z.string().trim().max(255).regex(/^[a-zA-Z0-9.-]*$/, 'Use a server name like smtp.example.co.za').default(''),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  security: z.enum(['auto', 'tls', 'starttls', 'none']).default('auto'),
  user: z.string().trim().max(255).default(''),
  password: z.string().max(500).optional(), // write-only; stored encrypted
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
  // Replies to campaigns (the Reply-To address's mailbox), read into the Inbox.
  replies_mailbox: mailbox.default({}),
  smtp: smtp.default({}),
  webhook_token: z.string().default(''),
  backup_stale_hours: z.coerce.number().min(0).max(744).default(0),
  // Google Analytics campaign tags added to links (campaigns can switch them off).
  utm_enabled: z.boolean().default(true),
  utm_source: z.string().trim().max(60).default('mailharbor'),
  utm_medium: z.string().trim().max(60).default('email'),
  utm_domains: z.string().trim().max(500).default(''),
  // Email design: the one frame around every email (replaces templates).
  email_logo_url: z.union([z.string().trim().max(2000).regex(/^https?:\/\/[^\s"<>]+$/i, 'Use an image address starting with https://'), z.literal('')]).default(''),
  email_logo_width: z.coerce.number().int().min(40).max(300).default(160),
  email_header_align: z.enum(['left', 'center']).default('left'),
  email_brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #1f4e8c').default('#1f4e8c'),
  email_heading_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #16365f').default('#16365f'),
  email_background: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #f4f6f9').default('#f4f6f9'),
  email_font: z.enum(['arial', 'helvetica', 'verdana', 'trebuchet', 'georgia']).default('arial'),
  email_footer_text: z.string().trim().max(300).default('You are receiving this because you subscribed or are a customer of {{ org_name }}.'),
  email_show_preferences: z.boolean().default(true),
});

// zod 4 returns .default({}) objects as-is, so build nested defaults explicitly.
const DEFAULTS = { ...SCHEMA.parse({}), bounce_mailbox: mailbox.parse({}), replies_mailbox: mailbox.parse({}), smtp: smtp.parse({}) };
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
    const merged = { ...DEFAULTS, ...stored, bounce_mailbox: { ...DEFAULTS.bounce_mailbox, ...(stored.bounce_mailbox || {}) },
      replies_mailbox: { ...DEFAULTS.replies_mailbox, ...(stored.replies_mailbox || {}) }, smtp: { ...DEFAULTS.smtp, ...(stored.smtp || {}) } };
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

  /** Server settings with the password decrypted (server use only). kind: 'bounce' | 'replies' | 'smtp'. */
  async mailbox(kind = 'bounce') {
    const s = await this.all();
    const m = { ...s[{ replies: 'replies_mailbox', smtp: 'smtp', bounce: 'bounce_mailbox' }[kind]] };
    m.password = m.password_enc ? decrypt(this.encKey, m.password_enc) : '';
    delete m.password_enc;
    return m;
  }

  /** Settings as shown in the UI: secrets are never returned. */
  async forUi() {
    const s = await this.all();
    const { password_enc: enc, ...mb } = s.bounce_mailbox;
    const { password_enc: encR, ...rb } = s.replies_mailbox;
    const { password_enc: encS, ...sm } = s.smtp;
    return { ...s, bounce_mailbox: { ...mb, password_set: Boolean(enc) }, replies_mailbox: { ...rb, password_set: Boolean(encR) },
      smtp: { ...sm, password_set: Boolean(encS) },
      public_url_locked: Boolean(this.config?.envPublicUrl),
      effective_public_url: await this.publicUrl() };
  }

  /** Validates and saves a partial update. Returns the list of changed keys. */
  async update(patch, userId) {
    const current = await this.all();
    const partial = parse(SCHEMA.partial(), patch); // invalid values → 422 with the field names
    const changed = [];
    // zod fills defaults even for omitted keys: only write what was sent.
    for (const [key, value] of Object.entries(partial).filter(([k]) => Object.hasOwn(patch, k))) {
      let v = value;
      if (key === 'bounce_mailbox' || key === 'replies_mailbox' || key === 'smtp') {
        const { password, ...rest } = value;
        v = { ...current[key], ...rest };
        if (password !== undefined && password !== '') v.password_enc = encrypt(this.encKey, password);
        // A new server or username without a new password: drop the old password rather than send it elsewhere.
        else if (current[key].password_enc && (rest.host !== undefined && rest.host !== current[key].host)) delete v.password_enc;
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
