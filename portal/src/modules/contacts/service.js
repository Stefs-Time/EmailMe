'use strict';

/**
 * Contact operations. Each write is a single PostgreSQL transaction that also
 * records evidence (recipient events, consent records, audit log).
 */
const { withTransaction } = require('../../db/pool');
const repo = require('./repo');
const { emailHash, normalizeEmail, isValidEmail } = require('../../lib/email');
const { audit, recipientEvent } = require('../../lib/audit');
const { activeForEmail, addSuppression } = require('../suppression/service');
const { consentAttrib } = require('./consent');
const { queueOptin } = require('../../engine/sender');
const { notFound, conflict, validation, badRequest } = require('../../lib/errors');

async function getDetail(ctx, id) {
  const db = ctx.pool;
  const contact = await repo.getContact(db, id);
  if (!contact) throw notFound('Contact not found');
  const hash = emailHash(contact.email);
  const [subscriptions, bounces, messages, events, consent, review, suppression] = await Promise.all([
    repo.getSubscriptions(db, id),
    repo.getBounces(db, id),
    repo.getMessages(db, id),
    db.query(
      `SELECT e.id, e.event_type, e.from_status, e.to_status, e.details, e.actor_type, e.created_at, u.name AS actor_name,
              c.name AS campaign_name
         FROM portal.recipient_events e LEFT JOIN portal.users u ON u.id = e.actor_id
         LEFT JOIN portal.campaigns c ON c.id = e.campaign_id
        WHERE e.contact_id = $1 OR e.email_hash = $2 ORDER BY e.created_at DESC LIMIT 200`, [id, hash]),
    db.query(
      `SELECT c.id, c.action, c.method, c.purpose, c.source, c.obtained_at, c.evidence, c.created_at, u.name AS recorded_by
         FROM portal.consent_records c LEFT JOIN portal.users u ON u.id = c.recorded_by
        WHERE c.email_hash = $1 ORDER BY c.created_at DESC`, [hash]),
    db.query(`SELECT id, reason, details, created_at FROM portal.review_queue WHERE contact_id = $1 AND resolved_at IS NULL`, [id]),
    db.query(`SELECT id, reason, source, details, created_at FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL`, [hash]),
  ]);
  const engagement = {
    opens: messages.filter((m) => m.opened).length,
    clicks: messages.filter((m) => m.clicked).length,
    received: messages.filter((m) => m.status === 'sent' && m.kind === 'campaign').length,
  };
  return { contact, subscriptions, bounces, messages, engagement, events: events.rows, consent: consent.rows,
    review: review.rows[0] || null, suppression: suppression.rows[0] || null };
}

async function assertListsExist(db, listIds) {
  if (!listIds.length) return [];
  const { rows } = await db.query('SELECT id, name, optin FROM portal.lists WHERE id = ANY($1::int[])', [listIds]);
  if (rows.length !== new Set(listIds).size) throw validation('One or more selected lists do not exist');
  return rows;
}

/**
 * Adds list memberships without ever touching an existing row, so an
 * "unsubscribed" membership can never be turned back into a subscription.
 * Double opt-in lists get "unconfirmed" unless `confirmed` is true.
 * Returns the number of memberships created.
 */
async function addMemberships(db, contactIds, lists, { confirmed }) {
  let created = 0;
  for (const l of lists) {
    const status = l.optin === 'double' && !confirmed ? 'unconfirmed' : 'subscribed';
    const r = await db.query(
      `INSERT INTO portal.list_members (contact_id, list_id, status, confirmed_at)
       SELECT x, $2, $3, CASE WHEN $3 = 'subscribed' THEN NOW() END FROM UNNEST($1::int[]) x
       ON CONFLICT (contact_id, list_id) DO NOTHING`, [contactIds, l.id, status]);
    created += r.rowCount;
  }
  return created;
}

async function createContact(ctx, input) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw validation('Invalid email address', [{ field: 'email', message: 'Invalid email address' }]);
  const sup = await activeForEmail(ctx.pool, email);
  if (sup) {
    throw conflict(`This address is suppressed (${sup.reason.replace('_', ' ')}). An administrator must lift the suppression with a documented permission basis before it can be added.`,
      [{ field: 'email', message: 'Suppressed' }]);
  }
  const id = await withTransaction(ctx.pool, async (db) => {
    const lists = await assertListsExist(db, input.listIds);
    const source = input.source || 'manual';
    const ins = await db.query(
      `INSERT INTO portal.contacts (email, email_hash, first_name, last_name, company, source, attribs, consent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ((LOWER(email))) DO NOTHING RETURNING id`,
      [email, emailHash(email), input.firstName || '', input.lastName || '', input.company || '', source,
        input.attribs || {}, consentAttrib(input.consent, source)]);
    if (!ins.rowCount) {
      const { rows } = await db.query('SELECT id FROM portal.contacts WHERE LOWER(email) = $1', [email]);
      throw conflict('A contact with this email already exists', [{ field: 'email', id: rows[0]?.id }]);
    }
    const contactId = ins.rows[0].id;
    await addMemberships(db, [contactId], lists, { confirmed: Boolean(input.preconfirm) });
    await db.query(
      `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, recorded_by)
       VALUES ($1, $2, $3, 'granted', $4, $5, $6, $7, $8, $9)`,
      [contactId, email, emailHash(email), input.consent.method, input.consent.purpose, source,
        input.consent.obtainedAt || null, input.consent.evidence, ctx.user.id]);
    await recipientEvent(db, { contactId, emailHash: emailHash(email), type: 'created', to: 'active',
      details: { source, lists: input.listIds }, actorType: 'user', actorId: ctx.user.id });
    await queueOptin(db, contactId);
    await audit(db, ctx.req, 'contact.created', { targetType: 'contact', targetId: contactId });
    return contactId;
  });
  return { id };
}

async function updateContact(ctx, id, input) {
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query('SELECT * FROM portal.contacts WHERE id = $1 FOR UPDATE', [id]);
    const cur = rows[0];
    if (!cur) throw notFound('Contact not found');
    const next = {
      first_name: input.firstName ?? cur.first_name,
      last_name: input.lastName ?? cur.last_name,
      company: input.company ?? cur.company,
      source: input.source ?? cur.source,
      email: cur.email,
      attribs: { ...cur.attribs },
    };
    if (input.attribs) {
      for (const [k, v] of Object.entries(input.attribs)) {
        if (v === null) delete next.attribs[k];
        else next.attribs[k] = v;
      }
    }
    if (input.email && normalizeEmail(input.email) !== normalizeEmail(cur.email)) {
      const email = normalizeEmail(input.email);
      if (!isValidEmail(email)) throw validation('Invalid email address');
      if (await activeForEmail(db, email)) throw conflict('The new address is suppressed and cannot be used');
      const dupe = await db.query('SELECT 1 FROM portal.contacts WHERE LOWER(email) = $1 AND id <> $2', [email, id]);
      if (dupe.rowCount) throw conflict('Another contact already uses that email address');
      next.email = email;
    }
    await db.query(
      `UPDATE portal.contacts SET email = $2, email_hash = $3, first_name = $4, last_name = $5, company = $6, source = $7,
              attribs = $8, updated_at = NOW() WHERE id = $1`,
      [id, next.email, emailHash(next.email), next.first_name, next.last_name, next.company, next.source, next.attribs]);
    await recipientEvent(db, { contactId: id, emailHash: emailHash(next.email), type: 'profile_updated',
      details: { fields: Object.keys(input) }, actorType: 'user', actorId: ctx.user.id });
    await audit(db, ctx.req, 'contact.updated', { targetType: 'contact', targetId: id, details: { fields: Object.keys(input) } });
    return { id };
  });
}

/** Bulk/single list changes. `add` never re-subscribes an unsubscribed member; `remove` keeps unsubscribe records. */
async function changeLists(ctx, ids, action, listIds, { confirmed = true } = {}) {
  return withTransaction(ctx.pool, async (db) => {
    const lists = await assertListsExist(db, listIds);
    const { rows: contacts } = await db.query(
      `SELECT c.id, c.email_hash,
              EXISTS (SELECT 1 FROM portal.suppressions s WHERE s.email_hash = c.email_hash AND s.lifted_at IS NULL) AS suppressed
         FROM portal.contacts c WHERE c.id = ANY($1::int[])`, [ids]);
    if (!contacts.length) throw notFound('No matching contacts');
    const result = { changed: 0, skipped: 0 };
    const total = contacts.length * listIds.length;
    if (action === 'add') {
      const eligible = contacts.filter((c) => !c.suppressed).map((c) => c.id);
      result.changed = eligible.length ? await addMemberships(db, eligible, lists, { confirmed }) : 0;
      for (const id of eligible) await queueOptin(db, id);
    } else if (action === 'remove') {
      const r = await db.query(
        `DELETE FROM portal.list_members WHERE contact_id = ANY($1::int[]) AND list_id = ANY($2::int[]) AND status <> 'unsubscribed'`,
        [ids, listIds]);
      result.changed = r.rowCount;
    } else if (action === 'unsubscribe') {
      const r = await db.query(
        `UPDATE portal.list_members SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW()
          WHERE contact_id = ANY($1::int[]) AND list_id = ANY($2::int[]) AND status <> 'unsubscribed'`, [ids, listIds]);
      result.changed = r.rowCount;
    }
    result.skipped = total - result.changed;
    for (const c of contacts) {
      await recipientEvent(db, { contactId: c.id, emailHash: c.email_hash, type: `lists_${action}`,
        details: { list_ids: listIds }, actorType: 'user', actorId: ctx.user.id });
    }
    await audit(db, ctx.req, `contact.lists_${action}`, { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null,
      details: { count: contacts.length, list_ids: listIds, ...result } });
    return result;
  });
}

/**
 * Records an opt-out. With global unsubscribe (default) the address is
 * suppressed from all marketing; otherwise only the given lists are left.
 * Used by staff (on the person's behalf) and by the public unsubscribe page.
 */
async function unsubscribeContact(db, { contactId, campaignId = null, listIds = null, global, note = '', actorType, actorId = null, source }) {
  const { rows } = await db.query('SELECT id, email, email_hash FROM portal.contacts WHERE id = $1', [contactId]);
  const c = rows[0];
  if (!c) return false;
  await db.query(
    `UPDATE portal.list_members SET status = 'unsubscribed', unsubscribed_at = NOW(), updated_at = NOW()
      WHERE contact_id = $1 AND status <> 'unsubscribed' AND ($2::int[] IS NULL OR list_id = ANY($2::int[]))`,
    [contactId, global ? null : listIds]);
  await recipientEvent(db, { contactId, emailHash: c.email_hash, campaignId, type: 'unsubscribed', to: 'unsubscribed',
    details: { note, global, source }, actorType, actorId });
  await db.query(
    `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, source, evidence, campaign_id, recorded_by)
     VALUES ($1, $2, $3, 'withdrawn', 'unsubscribe', $4, $5, $6, $7)`,
    [contactId, normalizeEmail(c.email), c.email_hash, source, note || '', campaignId, actorId]);
  await db.query(`UPDATE portal.contacts SET consent = consent || '{"status":"withdrawn"}'::jsonb, updated_at = NOW() WHERE id = $1`, [contactId]);
  if (global) {
    await addSuppression(db, { email: c.email, contactId, campaignId, reason: 'unsubscribe', source, details: { note }, userId: actorId, actorType });
  }
  return true;
}

async function unsubscribe(ctx, ids, note) {
  const s = await ctx.settings.all();
  return withTransaction(ctx.pool, async (db) => {
    let n = 0;
    for (const id of ids) {
      if (await unsubscribeContact(db, { contactId: id, global: s.global_unsubscribe, note, actorType: 'user', actorId: ctx.user.id, source: 'portal' })) n += 1;
    }
    if (!n) throw notFound('No matching contacts');
    await audit(db, ctx.req, 'contact.unsubscribed', { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null, details: { count: n } });
    return { count: n };
  });
}

async function suppress(ctx, ids, note) {
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query('SELECT id, email FROM portal.contacts WHERE id = ANY($1::int[])', [ids]);
    if (!rows.length) throw notFound('No matching contacts');
    for (const c of rows) {
      await addSuppression(db, { email: c.email, contactId: c.id, reason: 'manual', source: 'portal', details: { note }, userId: ctx.user.id, actorType: 'user' });
    }
    await audit(db, ctx.req, 'contact.suppressed', { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null, details: { count: rows.length, note } });
    return { count: rows.length };
  });
}

async function recordConsent(ctx, id, consent) {
  const c = await repo.getContact(ctx.pool, id);
  if (!c) throw notFound('Contact not found');
  if (c.suppression_reason) {
    throw badRequest('This contact is suppressed. Use "Lift suppression" (administrators) to record a new permission basis.');
  }
  await withTransaction(ctx.pool, async (db) => {
    await db.query(
      `INSERT INTO portal.consent_records (contact_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, recorded_by)
       VALUES ($1, $2, $3, 'reconfirmed', $4, $5, 'portal', $6, $7, $8)`,
      [id, normalizeEmail(c.email), emailHash(c.email), consent.method, consent.purpose, consent.obtainedAt || null, consent.evidence, ctx.user.id]);
    await db.query('UPDATE portal.contacts SET consent = $2, updated_at = NOW() WHERE id = $1', [id, consentAttrib(consent, c.source)]);
    await audit(db, ctx.req, 'contact.consent_recorded', { targetType: 'contact', targetId: id, details: { method: consent.method } });
  });
}

/** valid -> release the hold (nothing else changed while held); invalid -> suppress. */
async function resolveReview(ctx, id, resolution, note) {
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query(
      `SELECT r.id, c.email, c.email_hash FROM portal.review_queue r JOIN portal.contacts c ON c.id = r.contact_id
        WHERE r.contact_id = $1 AND r.resolved_at IS NULL FOR UPDATE OF r`, [id]);
    const item = rows[0];
    if (!item) throw notFound('This contact has no open review');
    await db.query(`UPDATE portal.review_queue SET resolved_at = NOW(), resolved_by = $2, resolution = $3 WHERE id = $1`,
      [item.id, ctx.user.id, `${resolution}: ${note || ''}`.trim()]);
    if (resolution === 'valid') {
      await recipientEvent(db, { contactId: id, emailHash: item.email_hash, type: 'review_resolved', from: 'pending_review', to: 'active',
        details: { resolution, note }, actorType: 'user', actorId: ctx.user.id });
      await db.query('UPDATE portal.contacts SET soft_bounces = 0 WHERE id = $1', [id]);
    } else {
      await addSuppression(db, { email: item.email, contactId: id, reason: 'hard_bounce', source: 'review',
        details: { note, review_id: item.id }, userId: ctx.user.id, actorType: 'user' });
    }
    await audit(db, ctx.req, 'contact.review_resolved', { targetType: 'contact', targetId: id, details: { resolution } });
  });
}

/**
 * POPIA erasure: deletes the contact and personal data, keeping only a hashed
 * suppression entry so the person is never re-imported or contacted again.
 */
async function erase(ctx, id) {
  return withTransaction(ctx.pool, async (db) => {
    const { rows } = await db.query('SELECT email, email_hash FROM portal.contacts WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw notFound('Contact not found');
    const { email, email_hash: hash } = rows[0];
    await addSuppression(db, { email, contactId: id, reason: 'erased', source: 'portal', userId: ctx.user.id, actorType: 'user' });
    await db.query(`UPDATE portal.suppressions SET email = NULL, contact_id = NULL, details = '{}'::jsonb WHERE email_hash = $1`, [hash]);
    await db.query(`UPDATE portal.consent_records SET email = NULL, evidence = '[erased]', contact_id = NULL WHERE email_hash = $1`, [hash]);
    await db.query(`DELETE FROM portal.import_rows WHERE LOWER(email) = $1`, [normalizeEmail(email)]);
    await db.query(`UPDATE portal.recipient_events SET details = '{}'::jsonb, contact_id = NULL WHERE email_hash = $1 OR contact_id = $2`, [hash, id]);
    await db.query(`UPDATE portal.messages SET email = NULL, payload = '{}'::jsonb WHERE contact_id = $1`, [id]);
    await db.query('DELETE FROM portal.contacts WHERE id = $1', [id]);
    await recipientEvent(db, { emailHash: hash, type: 'erased', actorType: 'user', actorId: ctx.user.id });
    await audit(db, ctx.req, 'contact.erased', { targetType: 'contact_hash', targetId: hash.slice(0, 16) });
  });
}

/** POPIA access request: everything held about one contact. */
async function exportData(ctx, id) {
  const detail = await getDetail(ctx, id);
  await audit(ctx.pool, ctx.req, 'contact.data_exported', { targetType: 'contact', targetId: id });
  return { generated_at: new Date().toISOString(), ...detail };
}

module.exports = {
  getDetail, createContact, updateContact, changeLists, unsubscribe, unsubscribeContact, suppress,
  recordConsent, resolveReview, erase, exportData, addMemberships, assertListsExist,
};
