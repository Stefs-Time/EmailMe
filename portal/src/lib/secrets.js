'use strict';

/**
 * Application secrets generated on first start and stored in portal.app_secrets,
 * so the only required environment variables are the database and SMTP.
 *
 *  - session_secret: signs session cookies (unless SESSION_SECRET is set)
 *  - enc_key:        AES-256-GCM key for secrets saved in Settings (e.g. the
 *                    bounce mailbox password), so they never sit in plain text
 *                    in the settings table, exports or backups of that table.
 *
 * Note: anyone with full database access can also read these keys. They
 * protect against casual exposure, not against a database compromise.
 */
const crypto = require('node:crypto');

async function getOrCreate(pool, key, bytes = 48) {
  const fresh = crypto.randomBytes(bytes).toString('base64url');
  await pool.query(`INSERT INTO portal.app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, fresh]);
  const { rows } = await pool.query('SELECT value FROM portal.app_secrets WHERE key = $1', [key]);
  return rows[0].value;
}

function keyBytes(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('mailharbor:settings:v1'), 32));
}

function encrypt(secret, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(secret), iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(secret, value) {
  const [v, iv, tag, data] = String(value || '').split('.');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { getOrCreate, encrypt, decrypt };
