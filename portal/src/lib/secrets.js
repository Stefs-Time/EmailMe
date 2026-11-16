'use strict';

/**
 * Small encrypted key/value store (portal.secrets) for values the portal
 * generates itself, such as the listmonk API token it creates on Railway.
 * AES-256-GCM with a key derived from SESSION_SECRET (HKDF). If SESSION_SECRET
 * changes, stored values become unreadable and are regenerated.
 */
const crypto = require('node:crypto');

function keyFrom(secret) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('mailharbor:secrets:v1'), 32));
}

function encrypt(secret, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

function decrypt(secret, value) {
  const [v, iv, tag, data] = String(value).split('.');
  if (v !== 'v1') return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

async function getSecret(db, secret, key) {
  const { rows } = await db.query('SELECT value FROM portal.secrets WHERE key = $1', [key]);
  return rows[0] ? decrypt(secret, rows[0].value) : null;
}

async function setSecret(db, secret, key, plaintext) {
  await db.query(
    `INSERT INTO portal.secrets (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, encrypt(secret, plaintext)],
  );
}

module.exports = { encrypt, decrypt, getSecret, setSecret };
