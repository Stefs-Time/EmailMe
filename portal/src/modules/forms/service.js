'use strict';

/**
 * Sign-up forms: settings validation and the sign-up itself.
 *
 * A sign-up never re-subscribes a suppressed address and never turns an
 * "unsubscribed" list membership back on (addMemberships is insert-only).
 * Consent evidence (statement, form, IP, time) is recorded for POPIA.
 * Double opt-in lists get a confirmation email first.
 */
const crypto = require('node:crypto');
const { z } = require('zod');
const { withTransaction } = require('../../db/pool');
const { emailHash, normalizeEmail } = require('../../lib/email');
const { recipientEvent } = require('../../lib/audit');
const { activeForEmail } = require('../suppression/service');
const { addMemberships } = require('../contacts/service');
const { queueOptin } = require('../../engine/sender');

const fieldMode = z.enum(['off', 'optional', 'required']);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const settingsSchema = z.object({
  heading: z.string().trim().min(1).max(120).default('Join our mailing list'),
  intro: z.string().trim().max(500).default('Get our news, specials and invitations by email.'),
  fields: z.object({ first_name: fieldMode.default('optional'), last_name: fieldMode.default('off'), company: fieldMode.default('off') }).prefault({}),
  consent_text: z.string().trim().min(10).max(500).default('Yes, I would like to receive marketing emails. I can unsubscribe at any time.'),
  button_label: z.string().trim().min(1).max(40).default('Subscribe'),
  success_message: z.string().trim().min(1).max(500).default('Thank you! If this is a new subscription, please check your inbox: we may ask you to confirm your email address.'),
  redirect_url: z.union([z.string().trim().url().max(500).refine((u) => /^https:\/\//i.test(u), 'Use an https:// address'), z.literal('')]).default(''),
  accent: hex.default('#1f4e8c'),
  source: z.string().trim().max(80).default(''),
});

const formBody = z.object({
  name: z.string().trim().min(1).max(120),
  list_ids: z.array(z.coerce.number().int().positive()).min(1, 'Choose at least one list').max(20),
  status: z.enum(['active', 'disabled']).default('active'),
  settings: settingsSchema.prefault({}),
});

// ---- Anti-spam: signed render time ------------------------------------------------
const MIN_FILL_MS = 2500;
const MAX_AGE_MS = 24 * 3600 * 1000;
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

/** A token proving the form was rendered by us, and when. */
function renderToken(secret, formId) {
  const t = Date.now().toString(36);
  return `${t}.${sign(secret, `${formId}.${t}`)}`;
}

/** 'ok' | 'too_fast' | 'invalid' */
function checkToken(secret, formId, token) {
  const [t, sig] = String(token || '').split('.');
  if (!t || !sig) return 'invalid';
  const expected = sign(secret, `${formId}.${t}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 'invalid';
  const age = Date.now() - parseInt(t, 36);
  if (!(age >= 0) || age > MAX_AGE_MS) return 'invalid';
  return age < MIN_FILL_MS ? 'too_fast' : 'ok';
}

/**
 * Processes one sign-up. Returns the outcome:
 *   subscribed | confirmation_sent | already_subscribed | suppressed
 */
async function signUp(pool, { form, email, firstName = '', lastName = '', company = '', ip, formUrl }) {
  const addr = normalizeEmail(email);
  const hash = emailHash(addr);
  const s = form.settings;
  const source = s.source || `Form: ${form.name}`;
  const evidence = `Signed up with the form "${form.name}" (${formUrl}) from IP ${ip || 'unknown'} at ${new Date().toISOString()}. `
    + `Statement accepted: "${s.consent_text}"`;

  if (await activeForEmail(pool, addr)) {
    await pool.query(`INSERT INTO portal.form_submissions (form_id, email_hash, outcome) VALUES ($1, $2, 'suppressed')`, [form.id, hash]);
    return 'suppressed';
  }

  return withTransaction(pool, async (db) => {
    const { rows: lists } = await db.query('SELECT id, name, optin FROM portal.lists WHERE id = ANY($1::int[])', [form.list_ids]);
    let contactId;
    let created = false;
    const ins = await db.query(
      `INSERT INTO portal.contacts (email, email_hash, first_name, last_name, company, source, consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ((LOWER(email))) DO NOTHING RETURNING id`,
      [addr, hash, firstName, lastName, company, source,
        { status: 'granted', method: 'web_form', purpose: s.consent_text.slice(0, 200), date: new Date().toISOString().slice(0, 10), source }]);
    if (ins.rowCount) {
      contactId = ins.rows[0].id;
      created = true;
    } else {
      const { rows } = await db.query('SELECT id FROM portal.contacts WHERE LOWER(email) = $1', [addr]);
      contactId = rows[0].id;
      // Fill in missing details only; never overwrite what is already known.
      await db.query(
        `UPDATE portal.contacts SET first_name = CASE WHEN first_name = '' THEN $2 ELSE first_name END,
                last_name = CASE WHEN last_name = '' THEN $3 ELSE last_name END,
                company = CASE WHEN company = '' THEN $4 ELSE company END, updated_at = NOW() WHERE id = $1`,
        [contactId, firstName, lastName, company]);
    }
    const added = await addMemberships(db, [contactId], lists, { confirmed: false });
    let outcome = 'already_subscribed';
    if (added) {
      await db.query(
        `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, purpose, source, obtained_at, evidence)
         VALUES ($1, $2, $3, 'granted', 'web_form', $4, $5, NOW(), $6)`,
        [contactId, addr, hash, s.consent_text, source, evidence]);
      await queueOptin(db, contactId); // double opt-in lists: one confirmation email
      const { rows: pending } = await db.query(
        `SELECT 1 FROM portal.list_members WHERE contact_id = $1 AND list_id = ANY($2::int[]) AND status = 'unconfirmed' LIMIT 1`, [contactId, form.list_ids]);
      outcome = pending.length ? 'confirmation_sent' : 'subscribed';
      await recipientEvent(db, { contactId, emailHash: hash, type: created ? 'created' : 'form_signup', to: outcome === 'subscribed' ? 'active' : 'unconfirmed',
        details: { form: form.name, form_id: form.id, lists: lists.map((l) => l.name) }, actorType: 'recipient' });
    }
    await db.query('INSERT INTO portal.form_submissions (form_id, contact_id, email_hash, outcome) VALUES ($1, $2, $3, $4)', [form.id, contactId, hash, outcome]);
    return outcome;
  });
}

module.exports = { settingsSchema, formBody, renderToken, checkToken, signUp, MIN_FILL_MS };
