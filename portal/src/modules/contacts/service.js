'use strict';

/**
 * Contact business operations. Pattern for every write:
 *   1. validate and check suppression rules in the portal
 *   2. record portal-side evidence (events, consent, suppression)
 *   3. call the listmonk API to change the subscriber
 * If step 3 fails after a suppression was recorded, the sync worker's
 * enforcement pass blocklists the contact on its next cycle.
 */

const { readOnly, withTransaction, sequential } = require('../../db/pool');
const repo = require('./repo');
const { emailHash, normalizeEmail, isValidEmail } = require('../../lib/email');
const { audit, recipientEvent } = require('../../lib/audit');
const { activeForEmail, addSuppression } = require('../suppression/service');
const { consentAttrib } = require('./consent');
const { withSyncLock } = require('../sync/worker');
const { notFound, conflict, validation, badRequest } = require('../../lib/errors');

function displayName(first, last, email) {
  const n = [first, last].filter(Boolean).join(' ').trim();
  return n || email.split('@')[0];
}

async function getContactOrThrow(ctx, id) {
  const c = await readOnly(ctx.pool, (db) => repo.getContact(db, id));
  if (!c) throw notFound('Contact not found');
  return c;
}

async function getDetail(ctx, id) {
  return readOnly(ctx.pool, async (db) => {
    const contact = await repo.getContact(db, id);
    if (!contact) throw notFound('Contact not found');
    const hash = emailHash(contact.email);
    const [subscriptions, bounces, engagement, events, consent, review, suppression] = await sequential([
      () => repo.getSubscriptions(db, id),
      () => repo.getBounces(db, id),
      () => repo.getEngagement(db, id),
      () => db.query(
        `SELECT e.id, e.event_type, e.from_status, e.to_status, e.details, e.actor_type, e.created_at, u.name AS actor_name
           FROM portal.recipient_events e LEFT JOIN portal.users u ON u.id = e.actor_id
          WHERE e.subscriber_id = $1 OR e.email_hash = $2 ORDER BY e.created_at DESC LIMIT 200`,
        [id, hash],
      ),
      () => db.query(
        `SELECT c.id, c.action, c.method, c.purpose, c.source, c.obtained_at, c.evidence, c.created_at, u.name AS recorded_by
           FROM portal.consent_records c LEFT JOIN portal.users u ON u.id = c.recorded_by
          WHERE c.email_hash = $1 ORDER BY c.created_at DESC`,
        [hash],
      ),
      () => db.query(
        `SELECT id, reason, details, created_at FROM portal.review_queue WHERE subscriber_id = $1 AND resolved_at IS NULL`,
        [id],
      ),
      () => db.query(
        `SELECT id, reason, source, details, created_at FROM portal.suppressions WHERE email_hash = $1 AND lifted_at IS NULL`,
        [hash],
      ),
    ]);
    return {
      contact,
      subscriptions,
      bounces,
      engagement,
      events: events.rows,
      consent: consent.rows,
      review: review.rows[0] || null,
      suppression: suppression.rows[0] || null,
    };
  });
}

async function assertListsExist(ctx, listIds) {
  if (!listIds.length) return;
  const { rows } = await ctx.pool.query('SELECT id FROM lists WHERE id = ANY($1::int[])', [listIds]);
  if (rows.length !== new Set(listIds).size) throw validation('One or more selected lists do not exist');
}

async function createContact(ctx, input) {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw validation('Invalid email address', [{ field: 'email', message: 'Invalid email address' }]);
  const sup = await activeForEmail(ctx.pool, email);
  if (sup) {
    throw conflict(
      `This address is suppressed (${sup.reason.replace('_', ' ')}). An administrator must lift the suppression with a documented permission basis before it can be added.`,
      [{ field: 'email', message: 'Suppressed' }],
    );
  }
  const existing = await readOnly(ctx.pool, (db) => repo.findByEmails(db, [email]));
  if (existing.length) throw conflict('A contact with this email already exists', [{ field: 'email', id: existing[0].id }]);
  await assertListsExist(ctx, input.listIds);

  const attribs = {
    ...(input.attribs || {}),
    first_name: input.firstName || '',
    last_name: input.lastName || '',
    company: input.company || '',
    source: input.source || 'manual',
    consent: consentAttrib(input.consent, input.source || 'manual'),
  };
  const sub = await ctx.lm.createSubscriber({
    email,
    name: displayName(input.firstName, input.lastName, email),
    status: 'enabled',
    lists: input.listIds,
    attribs,
    preconfirm_subscriptions: Boolean(input.preconfirm),
  });

  const hash = emailHash(email);
  await withTransaction(ctx.pool, async (db) => {
    await db.query(
      `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, recorded_by)
       VALUES ($1, $2, $3, 'granted', $4, $5, $6, $7, $8, $9)`,
      [sub.id, email, hash, input.consent.method, input.consent.purpose, input.source || 'manual',
        input.consent.obtainedAt || null, input.consent.evidence, ctx.user.id],
    );
    await recipientEvent(db, { subscriberId: sub.id, emailHash: hash, type: 'created', to: 'active',
      details: { source: input.source || 'manual', lists: input.listIds }, actorType: 'user', actorId: ctx.user.id });
    await audit(db, ctx.req, 'contact.created', { targetType: 'contact', targetId: sub.id });
  });
  return sub;
}

async function updateContact(ctx, id, input) {
  const current = await ctx.lm.getSubscriber(id);
  const attribs = { ...(current.attribs || {}) };
  for (const k of ['firstName', 'lastName', 'company', 'source']) {
    const key = { firstName: 'first_name', lastName: 'last_name', company: 'company', source: 'source' }[k];
    if (input[k] !== undefined) attribs[key] = input[k];
  }
  if (input.attribs) {
    for (const [k, v] of Object.entries(input.attribs)) {
      if (['consent', 'first_name', 'last_name'].includes(k)) continue; // managed fields
      if (v === null) delete attribs[k];
      else attribs[k] = v;
    }
  }
  const body = { attribs };
  if (input.firstName !== undefined || input.lastName !== undefined) {
    body.name = displayName(attribs.first_name, attribs.last_name, current.email);
  }
  if (input.email && normalizeEmail(input.email) !== normalizeEmail(current.email)) {
    const email = normalizeEmail(input.email);
    if (!isValidEmail(email)) throw validation('Invalid email address');
    if (await activeForEmail(ctx.pool, email)) throw conflict('The new address is suppressed and cannot be used');
    body.email = email;
  }
  const updated = await ctx.lm.patchSubscriber(id, body);
  await recipientEvent(ctx.pool, { subscriberId: id, emailHash: emailHash(updated.email), type: 'profile_updated',
    details: { fields: Object.keys(input) }, actorType: 'user', actorId: ctx.user.id });
  await audit(ctx.pool, ctx.req, 'contact.updated', { targetType: 'contact', targetId: id, details: { fields: Object.keys(input) } });
  return updated;
}

/**
 * List membership changes. "add" only creates subscriptions that do not exist
 * yet: listmonk's add action would otherwise overwrite an existing
 * "unsubscribed" status and silently re-subscribe the person.
 */
async function changeLists(ctx, ids, action, listIds, { subscriptionStatus = 'confirmed' } = {}) {
  await assertListsExist(ctx, listIds);
  const contacts = await readOnly(ctx.pool, async (db) => {
    const { rows } = await db.query(
      `SELECT s.id, s.email, s.status FROM subscribers s WHERE s.id = ANY($1::int[])`, [ids]);
    return rows;
  });
  if (!contacts.length) throw notFound('No matching contacts');
  const result = { changed: 0, skipped: 0 };

  if (action === 'add') {
    const hashes = contacts.map((c) => emailHash(c.email));
    const { rows: blocked } = await ctx.pool.query(
      `SELECT email_hash FROM portal.suppressions WHERE lifted_at IS NULL AND email_hash = ANY($1::text[])`, [hashes]);
    const blockedSet = new Set(blocked.map((b) => b.email_hash));
    const { rows: existingSubs } = await ctx.pool.query(
      `SELECT subscriber_id, list_id FROM subscriber_lists WHERE subscriber_id = ANY($1::int[]) AND list_id = ANY($2::int[])`,
      [contacts.map((c) => c.id), listIds]);
    const has = new Set(existingSubs.map((r) => `${r.subscriber_id}:${r.list_id}`));
    // Group eligible contacts by the exact set of lists they still need.
    const groups = new Map();
    for (const c of contacts) {
      if (c.status === 'blocklisted' || blockedSet.has(emailHash(c.email))) {
        result.skipped += listIds.length;
        continue;
      }
      const need = listIds.filter((l) => !has.has(`${c.id}:${l}`));
      result.skipped += listIds.length - need.length;
      if (!need.length) continue;
      const key = need.join(',');
      if (!groups.has(key)) groups.set(key, { lists: need, ids: [] });
      groups.get(key).ids.push(c.id);
    }
    for (const g of groups.values()) {
      await ctx.lm.manageLists({ ids: g.ids, action: 'add', listIds: g.lists, status: subscriptionStatus });
      result.changed += g.ids.length * g.lists.length;
    }
  } else if (action === 'remove') {
    // Never delete an "unsubscribed" subscription: it is the evidence that
    // stops a later "add" from re-subscribing the person.
    const { rows: removable } = await ctx.pool.query(
      `SELECT subscriber_id, list_id FROM subscriber_lists
        WHERE subscriber_id = ANY($1::int[]) AND list_id = ANY($2::int[]) AND status <> 'unsubscribed'`,
      [contacts.map((c) => c.id), listIds]);
    const byList = new Map();
    for (const r of removable) {
      if (!byList.has(r.list_id)) byList.set(r.list_id, []);
      byList.get(r.list_id).push(r.subscriber_id);
    }
    for (const [listId, subIds] of byList) {
      await ctx.lm.manageLists({ ids: subIds, action: 'remove', listIds: [listId] });
      result.changed += subIds.length;
    }
    result.skipped = contacts.length * listIds.length - result.changed;
  } else {
    await ctx.lm.manageLists({ ids: contacts.map((c) => c.id), action, listIds });
    result.changed = contacts.length * listIds.length;
  }

  await withTransaction(ctx.pool, async (db) => {
    for (const c of contacts) {
      await recipientEvent(db, { subscriberId: c.id, emailHash: emailHash(c.email), type: `lists_${action}`,
        details: { list_ids: listIds }, actorType: 'user', actorId: ctx.user.id });
    }
    await audit(db, ctx.req, `contact.lists_${action}`, { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null,
      details: { count: contacts.length, list_ids: listIds, ...result } });
  });
  return result;
}

/** Operator-recorded opt-out (e.g. phone or email request). */
async function unsubscribe(ctx, ids, note) {
  const contacts = await readOnly(ctx.pool, async (db) =>
    (await db.query('SELECT id, email FROM subscribers WHERE id = ANY($1::int[])', [ids])).rows);
  if (!contacts.length) throw notFound('No matching contacts');
  await withTransaction(ctx.pool, async (db) => {
    for (const c of contacts) {
      const hash = emailHash(c.email);
      await recipientEvent(db, { subscriberId: c.id, emailHash: hash, type: 'unsubscribed', to: 'unsubscribed',
        details: { note, global: ctx.config.GLOBAL_UNSUBSCRIBE }, actorType: 'user', actorId: ctx.user.id });
      await db.query(
        `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, source, evidence, recorded_by)
         VALUES ($1, $2, $3, 'withdrawn', 'unsubscribe', 'portal', $4, $5)`,
        [c.id, normalizeEmail(c.email), hash, note || '', ctx.user.id]);
      if (ctx.config.GLOBAL_UNSUBSCRIBE) {
        await addSuppression(db, { email: c.email, subscriberId: c.id, reason: 'unsubscribe', source: 'portal',
          details: { note }, userId: ctx.user.id, actorType: 'user' });
      }
    }
    await audit(db, ctx.req, 'contact.unsubscribed', { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null,
      details: { count: contacts.length } });
  });
  const idList = contacts.map((c) => c.id);
  const { rows: lists } = await ctx.pool.query(
    `SELECT DISTINCT list_id FROM subscriber_lists WHERE subscriber_id = ANY($1::int[])`, [idList]);
  if (lists.length) {
    await ctx.lm.manageLists({ ids: idList, action: 'unsubscribe', listIds: lists.map((l) => l.list_id) });
  }
  if (ctx.config.GLOBAL_UNSUBSCRIBE) await ctx.lm.blocklistSubscribers(idList);
  return { count: contacts.length };
}

async function suppress(ctx, ids, note) {
  const contacts = await readOnly(ctx.pool, async (db) =>
    (await db.query('SELECT id, email FROM subscribers WHERE id = ANY($1::int[])', [ids])).rows);
  if (!contacts.length) throw notFound('No matching contacts');
  await withTransaction(ctx.pool, async (db) => {
    for (const c of contacts) {
      await addSuppression(db, { email: c.email, subscriberId: c.id, reason: 'manual', source: 'portal',
        details: { note }, userId: ctx.user.id, actorType: 'user' });
    }
    await audit(db, ctx.req, 'contact.suppressed', { targetType: 'contact', targetId: ids.length === 1 ? ids[0] : null,
      details: { count: contacts.length, note } });
  });
  await ctx.lm.blocklistSubscribers(contacts.map((c) => c.id));
  return { count: contacts.length };
}

async function recordConsent(ctx, id, consent) {
  const c = await getContactOrThrow(ctx, id);
  if (c.suppression_reason) {
    throw badRequest('This contact is suppressed. Use "Lift suppression" (administrators) to record a new permission basis.');
  }
  const hash = emailHash(c.email);
  await withTransaction(ctx.pool, async (db) => {
    await db.query(
      `INSERT INTO portal.consent_records (subscriber_id, email, email_hash, action, method, purpose, source, obtained_at, evidence, recorded_by)
       VALUES ($1, $2, $3, 'reconfirmed', $4, $5, 'portal', $6, $7, $8)`,
      [id, normalizeEmail(c.email), hash, consent.method, consent.purpose, consent.obtainedAt || null, consent.evidence, ctx.user.id]);
    await audit(db, ctx.req, 'contact.consent_recorded', { targetType: 'contact', targetId: id, details: { method: consent.method } });
  });
  const current = await ctx.lm.getSubscriber(id);
  await ctx.lm.patchSubscriber(id, {
    attribs: { ...(current.attribs || {}), consent: consentAttrib(consent, current.attribs?.source) },
  });
}

/**
 * Resolves a "pending review" hold.
 *  valid   -> un-blocklist and restore the subscriptions the hold switched off
 *  invalid -> keep blocked and record a permanent suppression
 */
async function resolveReview(ctx, id, resolution, note) {
  return withSyncLock(ctx.pool, () => resolveReviewLocked(ctx, id, resolution, note));
}

async function resolveReviewLocked(ctx, id, resolution, note) {
  const { rows } = await ctx.pool.query(
    `SELECT r.id, r.details, s.email FROM portal.review_queue r JOIN subscribers s ON s.id = r.subscriber_id
      WHERE r.subscriber_id = $1 AND r.resolved_at IS NULL`, [id]);
  const item = rows[0];
  if (!item) throw notFound('This contact has no open review');
  const hash = emailHash(item.email);

  if (resolution === 'valid') {
    const since = item.details.bounce_at || item.details.held_at;
    const { rows: subs } = await ctx.pool.query(
      `SELECT list_id FROM subscriber_lists
        WHERE subscriber_id = $1 AND status = 'unsubscribed' AND updated_at >= $2::timestamptz - INTERVAL '1 minute'`,
      [id, since]);
    await ctx.lm.patchSubscriber(id, { status: 'enabled' });
    if (subs.length) {
      await ctx.lm.manageLists({ ids: [id], action: 'add', listIds: subs.map((s) => s.list_id), status: 'confirmed' });
    }
    await withTransaction(ctx.pool, async (db) => {
      await db.query(`UPDATE portal.review_queue SET resolved_at = NOW(), resolved_by = $2, resolution = $3 WHERE id = $1`,
        [item.id, ctx.user.id, `valid: ${note || ''}`.trim()]);
      await recipientEvent(db, { subscriberId: id, emailHash: hash, type: 'review_resolved', from: 'pending_review', to: 'active',
        details: { resolution, note, restored_lists: subs.map((s) => s.list_id) }, actorType: 'user', actorId: ctx.user.id });
      await audit(db, ctx.req, 'contact.review_resolved', { targetType: 'contact', targetId: id, details: { resolution } });
    });
  } else {
    await withTransaction(ctx.pool, async (db) => {
      await db.query(`UPDATE portal.review_queue SET resolved_at = NOW(), resolved_by = $2, resolution = $3 WHERE id = $1`,
        [item.id, ctx.user.id, `invalid: ${note || ''}`.trim()]);
      await addSuppression(db, { email: item.email, subscriberId: id, reason: 'hard_bounce', source: 'review',
        details: { note, review_id: item.id }, userId: ctx.user.id, actorType: 'user' });
      await audit(db, ctx.req, 'contact.review_resolved', { targetType: 'contact', targetId: id, details: { resolution } });
    });
  }
}

/**
 * POPIA erasure: deletes the subscriber from listmonk, removes personal data
 * from portal records and keeps only a hashed suppression entry so the person
 * is never re-imported or contacted again.
 */
async function erase(ctx, id, note) {
  const c = await getContactOrThrow(ctx, id);
  const email = normalizeEmail(c.email);
  const hash = emailHash(email);
  await withTransaction(ctx.pool, async (db) => {
    await addSuppression(db, { email, subscriberId: id, reason: 'erased', source: 'portal', userId: ctx.user.id, actorType: 'user' });
    await db.query(`UPDATE portal.suppressions SET email = NULL, subscriber_id = NULL WHERE email_hash = $1`, [hash]);
    await db.query(`UPDATE portal.consent_records SET email = NULL, evidence = '[erased]' WHERE email_hash = $1`, [hash]);
    await db.query(`DELETE FROM portal.import_rows WHERE LOWER(email) = $1`, [email]);
    await db.query(`UPDATE portal.recipient_events SET details = '{}'::jsonb WHERE email_hash = $1 OR subscriber_id = $2`, [hash, id]);
    await recipientEvent(db, { subscriberId: null, emailHash: hash, type: 'erased', actorType: 'user', actorId: ctx.user.id,
      details: { note: note ? '[provided]' : '' } });
    await audit(db, ctx.req, 'contact.erased', { targetType: 'contact_hash', targetId: hash.slice(0, 16), details: {} });
  });
  await ctx.lm.deleteSubscriber(id);
}

/** POPIA access request: everything held about one contact. */
async function exportData(ctx, id) {
  const detail = await getDetail(ctx, id);
  const listmonkData = await ctx.lm.exportSubscriberData(id).catch(() => null);
  await audit(ctx.pool, ctx.req, 'contact.data_exported', { targetType: 'contact', targetId: id });
  return { generated_at: new Date().toISOString(), listmonk: listmonkData, portal: detail };
}

module.exports = {
  getDetail,
  createContact,
  updateContact,
  changeLists,
  unsubscribe,
  suppress,
  recordConsent,
  resolveReview,
  erase,
  exportData,
};
