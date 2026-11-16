'use strict';

const crypto = require('node:crypto');

/**
 * Pragmatic address syntax check (not full RFC 5322): one @, a sane local
 * part, and a dotted domain with valid labels. Delivery outcome remains the
 * real source of truth for validity (see scope §6).
 */
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

function normalizeEmail(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase();
}

function isValidEmail(input) {
  const email = normalizeEmail(input);
  if (email.length < 6 || email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]) && !/^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) return false;
  return true;
}

/** Stable, non-reversible identifier used for suppression after erasure. */
function emailHash(input) {
  return crypto.createHash('sha256').update(normalizeEmail(input)).digest('hex');
}

function emailDomain(input) {
  const e = normalizeEmail(input);
  const at = e.lastIndexOf('@');
  return at > 0 ? e.slice(at + 1) : '';
}

module.exports = { normalizeEmail, isValidEmail, emailHash, emailDomain };
