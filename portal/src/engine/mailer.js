'use strict';

/**
 * SMTP delivery (nodemailer). Connection details come only from environment
 * variables; credentials are never stored in the database or shown in the UI.
 */
const nodemailer = require('nodemailer');

function createTransport(config) {
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE && config.SMTP_REQUIRE_TLS,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    pool: true,
    maxConnections: config.SMTP_POOL_MAX,
    maxMessages: 500,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    tls: { minVersion: 'TLSv1.2' },
  });
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
  if (err.code === 'EAUTH' || (conn.includes(err.code) && !code)) return 'connection';
  if (code === 421 || code === 454 || code === 530 || code === 535) return 'connection';
  if (code >= 500) return 'permanent';
  if (code >= 400) return 'temporary';
  if (err.code === 'EENVELOPE' && /rejected|recipient/i.test(err.message)) return 'permanent';
  return 'temporary';
}

function describeSmtp(config) {
  return {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    security: config.SMTP_SECURE ? 'TLS (implicit)' : config.SMTP_REQUIRE_TLS ? 'STARTTLS (required)' : 'STARTTLS if offered',
    authenticated: Boolean(config.SMTP_USER),
    user: config.SMTP_USER ? config.SMTP_USER.replace(/^(.{2}).*(@.*)?$/, (m, a, b) => `${a}•••${b || ''}`) : null,
    poolSize: config.SMTP_POOL_MAX,
  };
}

module.exports = { createTransport, classifySendError, describeSmtp };
