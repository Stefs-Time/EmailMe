'use strict';

/**
 * SMTP delivery (nodemailer).
 *
 * The mail server is the customer's: they manage it in Settings → Sending (the
 * password is stored encrypted and never shown again). The SMTP_* environment
 * variables are an optional default set by the operator, used until the
 * customer saves their own server.
 *
 * MailTransport is the one object the rest of the app uses (sendMail, verify).
 * It builds a pooled nodemailer transport for the current server and rebuilds it
 * when the customer changes the server. Servers entered in Settings must be
 * public addresses (lib/hosts.js, SSRF protection).
 */
const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const { resolveMailHost } = require('../lib/hosts');

const TIMEOUTS = { connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 60000 };
const RESOLVE_TTL_MS = 5 * 60000;

/** Server details → nodemailer options. `address`/`servername` pin the checked IP while TLS still verifies the name. */
function transportOptions(srv, { pool = true, poolSize = 3 } = {}) {
  return {
    host: srv.address || srv.host,
    port: srv.port,
    secure: srv.secure,
    requireTLS: !srv.secure && srv.requireTLS,
    auth: srv.user ? { user: srv.user, pass: srv.pass } : undefined,
    ...(pool ? { pool: true, maxConnections: poolSize, maxMessages: 500 } : {}),
    ...TIMEOUTS,
    tls: { minVersion: 'TLSv1.2', ...(srv.servername ? { servername: srv.servername } : {}) },
  };
}

/** Settings value → server details. security: auto (TLS on 465, otherwise STARTTLS) | tls | starttls | none (test servers only). */
function fromSettings(m) {
  const secure = m.security === 'tls' || (m.security === 'auto' && Number(m.port) === 465);
  return { host: m.host, port: Number(m.port), secure, requireTLS: m.security !== 'none', user: m.user || undefined, pass: m.password || undefined };
}

const securityLabel = (srv) => (srv.secure ? 'TLS (implicit)' : srv.requireTLS ? 'STARTTLS (required)' : 'No encryption required (test servers only)');
const maskUser = (u) => (u ? u.replace(/^(.{2}).*?(@.*)?$/, (m, a, b) => `${a}•••${b || ''}`) : null);

class MailTransport {
  constructor(config, settings, logger = null) {
    this.config = config;
    this.settings = settings;
    this.logger = logger;
    this.fingerprint = null;
    this.transport = null;
    this.resolved = null; // { fingerprint, at, address, servername }
  }

  /** The server in use: Settings first, then the operator's SMTP_* default; null when neither is set. */
  async server() {
    const m = this.settings ? await this.settings.mailbox('smtp') : {};
    if (m.host) return { source: 'settings', ...fromSettings(m) };
    const c = this.config;
    if (c.SMTP_HOST) {
      return { source: 'hosting', host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE, requireTLS: c.SMTP_REQUIRE_TLS,
        user: c.SMTP_USER, pass: c.SMTP_PASSWORD };
    }
    return null;
  }

  /** Customer-entered hosts are checked (and pinned); the operator's default is trusted. */
  async pin(srv) {
    if (srv.source !== 'settings') return srv;
    return { ...srv, ...(await resolveMailHost(srv.host, { allowPrivate: this.config.mailAllowPrivateHosts })) };
  }

  async current() {
    const srv = await this.server();
    if (!srv) {
      throw Object.assign(new Error('No mail server is set up. An administrator adds it under Settings → Sending → Your mail server.'),
        { code: 'ENOSMTP', mhConfig: true });
    }
    const fp = crypto.createHash('sha256').update(JSON.stringify(srv)).digest('hex');
    if (!this.resolved || this.resolved.fingerprint !== fp || Date.now() - this.resolved.at > RESOLVE_TTL_MS) {
      const pinned = await this.pin(srv);
      this.resolved = { fingerprint: fp, at: Date.now(), address: pinned.address, servername: pinned.servername };
    }
    const key = `${fp}:${this.resolved.address || ''}`;
    if (this.fingerprint !== key) {
      this.transport?.close();
      this.transport = nodemailer.createTransport(transportOptions({ ...srv, ...this.resolved }, { poolSize: this.config.SMTP_POOL_MAX }));
      this.fingerprint = key;
      this.logger?.info({ host: srv.host, source: srv.source }, 'mail server connection prepared');
    }
    return this.transport;
  }

  async sendMail(message) {
    return (await this.current()).sendMail(message);
  }

  async verify() {
    return (await this.current()).verify();
  }

  /** For the sender's parallelism. */
  get options() {
    return { maxConnections: this.config.SMTP_POOL_MAX };
  }

  /** What Settings and System health show. Never includes the password. */
  async describe() {
    const srv = await this.server();
    if (!srv) return { configured: false, source: null };
    return { configured: true, source: srv.source, host: srv.host, port: srv.port, security: securityLabel(srv),
      authenticated: Boolean(srv.user), user: maskUser(srv.user), poolSize: this.config.SMTP_POOL_MAX };
  }

  /** Checks unsaved Settings values: connects, signs in, disconnects. Blank password = the saved one. */
  async test(values) {
    const saved = this.settings ? await this.settings.mailbox('smtp') : {};
    const srv = fromSettings({ ...saved, ...values, password: values.password || saved.password });
    const pinned = await resolveMailHost(srv.host, { allowPrivate: this.config.mailAllowPrivateHosts });
    const t = nodemailer.createTransport(transportOptions({ ...srv, ...pinned }, { pool: false }));
    try {
      await t.verify();
    } finally {
      t.close();
    }
  }

  close() {
    this.transport?.close();
  }
}

/** Kept for scripts and tests that need a plain transport from environment variables. */
function createTransport(config) {
  return nodemailer.createTransport(transportOptions({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    requireTLS: config.SMTP_REQUIRE_TLS, user: config.SMTP_USER, pass: config.SMTP_PASSWORD }, { poolSize: config.SMTP_POOL_MAX }));
}

/**
 * Classifies a send error:
 *  - 'connection': the server could not be used at all (auth, network, TLS).
 *    The campaign is paused instead of failing every recipient.
 *  - 'permanent':  5xx for this recipient (a bounce at send time).
 *  - 'temporary':  4xx or a transient fault for this recipient (retry).
 */
function classifySendError(err) {
  const code = Number(err.responseCode) || 0;
  const conn = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EAUTH', 'ETLS', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EPROTOCOL'];
  if (err.code === 'ENOSMTP' || err.code === 'EHOSTBLOCKED') return 'connection';
  if (err.code === 'EAUTH' || (conn.includes(err.code) && !code)) return 'connection';
  if (code === 421 || code === 454 || code === 530 || code === 535) return 'connection';
  if (code >= 500) return 'permanent';
  if (code >= 400) return 'temporary';
  if (err.code === 'EENVELOPE' && /rejected|recipient/i.test(err.message)) return 'permanent';
  return 'temporary';
}

module.exports = { MailTransport, createTransport, classifySendError };
