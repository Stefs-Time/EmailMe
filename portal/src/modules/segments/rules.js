'use strict';

/**
 * Saved segments: rule sets compiled to SQL.
 *
 * Rules are validated against a fixed catalogue of fields and operators, and
 * every value is a bound parameter: no user text is ever placed in SQL.
 * Conditions are evaluated against the contact read model (repo BASE_SQL), so
 * the derived status, list memberships and dates are all available.
 *
 *   { match: 'all' | 'any', conditions: [{ field, op, value?, key? }, ...] }
 */
const { z } = require('zod');

const STATUSES = ['active', 'unconfirmed', 'soft_bounced', 'hard_bounced', 'complaint', 'unsubscribed', 'blocklisted', 'pending_review', 'no_lists', 'eligible'];
const ATTR_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/;
const days = z.coerce.number().int().min(1).max(3650);
const text = z.string().trim().min(1).max(200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-30');

/** Field catalogue: label, allowed operators and value schema per operator. */
const FIELDS = {
  status: { label: 'Status', ops: { is: z.enum(STATUSES), is_not: z.enum(STATUSES) } },
  list: { label: 'List', ops: { in: z.coerce.number().int().positive(), not_in: z.coerce.number().int().positive() } },
  source: { label: 'Source', ops: { is: text, is_not: text, contains: text } },
  consent: { label: 'Consent method', ops: { is: text, is_not: text, missing: null } },
  email_domain: { label: 'Email domain', ops: { is: text, is_not: text, ends_with: text } },
  company: { label: 'Company', ops: { contains: text, is: text, empty: null, not_empty: null } },
  first_name: { label: 'First name', ops: { empty: null, not_empty: null } },
  attribute: { label: 'Imported column', key: true, ops: { is: text, is_not: text, contains: text, set: null, not_set: null } },
  created_at: { label: 'Added', ops: { within_days: days, older_than_days: days, after: date, before: date } },
  last_open_at: { label: 'Last opened', ops: { within_days: days, not_within_days: days, never: null, ever: null } },
  last_click_at: { label: 'Last clicked', ops: { within_days: days, not_within_days: days, never: null, ever: null } },
  last_sent_at: { label: 'Last emailed', ops: { within_days: days, not_within_days: days, never: null, ever: null } },
  soft_bounces: { label: 'Soft bounces', ops: { at_least: z.coerce.number().int().min(1).max(100) } },
};

const condition = z.object({
  field: z.enum(Object.keys(FIELDS)),
  op: z.string().max(30),
  value: z.unknown().optional(),
  key: z.string().max(50).optional(),
}).superRefine((c, ctx) => {
  const f = FIELDS[c.field];
  if (!Object.hasOwn(f.ops, c.op)) { ctx.addIssue({ code: 'custom', path: ['op'], message: `"${c.op}" is not valid for ${f.label}` }); return; }
  const schema = f.ops[c.op];
  if (schema) {
    const r = schema.safeParse(c.value);
    if (!r.success) ctx.addIssue({ code: 'custom', path: ['value'], message: `${f.label}: ${r.error.issues[0].message}` });
  }
  if (f.key && !ATTR_KEY.test(c.key || '')) ctx.addIssue({ code: 'custom', path: ['key'], message: 'Choose the imported column' });
});

const rulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(condition).min(1, 'Add at least one condition').max(20),
});

/**
 * Compiles validated rules to a SQL boolean expression over alias `a`
 * (a row of the contact read model). `p(value)` binds a parameter and
 * returns its placeholder.
 */
function compileRules(rules, p, a = 'c') {
  const parts = rules.conditions.map((c) => {
    const f = FIELDS[c.field];
    const v = f.ops[c.op] ? f.ops[c.op].parse(c.value) : null;
    const lower = (x) => `LOWER(${x})`;
    // Build only the chosen variant: every p() call binds a parameter, and
    // PostgreSQL rejects unused parameters whose type it cannot infer.
    const dateCol = (col) => ({
      within_days: () => `${a}.${col} >= NOW() - ${p(v)}::int * INTERVAL '1 day'`,
      not_within_days: () => `(${a}.${col} IS NULL OR ${a}.${col} < NOW() - ${p(v)}::int * INTERVAL '1 day')`,
      older_than_days: () => `${a}.${col} < NOW() - ${p(v)}::int * INTERVAL '1 day'`,
      after: () => `${a}.${col} >= ${p(v)}::date`,
      before: () => `${a}.${col} < ${p(v)}::date`,
      never: () => `${a}.${col} IS NULL`,
      ever: () => `${a}.${col} IS NOT NULL`,
    })[c.op]();
    switch (c.field) {
      case 'status':
        if (v === 'eligible') return `${a}.status ${c.op === 'is' ? '' : 'NOT '}IN ('active', 'soft_bounced')`;
        return `${a}.status ${c.op === 'is' ? '=' : '<>'} ${p(v)}`;
      case 'list': {
        const sub = `EXISTS (SELECT 1 FROM portal.list_members lm WHERE lm.contact_id = ${a}.id AND lm.list_id = ${p(v)} AND lm.status = 'subscribed')`;
        return c.op === 'in' ? sub : `NOT ${sub}`;
      }
      case 'source':
        if (c.op === 'contains') return `${a}.source ILIKE ${p(`%${like(v)}%`)}`;
        return `${lower(`${a}.source`)} ${c.op === 'is' ? '=' : '<>'} LOWER(${p(v)})`;
      case 'consent':
        if (c.op === 'missing') return `COALESCE(${a}.consent->>'method', '') = ''`;
        return `COALESCE(${a}.consent->>'method', '') ${c.op === 'is' ? '=' : '<>'} ${p(v)}`;
      case 'email_domain': {
        const dom = `split_part(LOWER(${a}.email), '@', 2)`;
        if (c.op === 'ends_with') return `${dom} LIKE ${p(`%${like(String(v).toLowerCase())}`)}`;
        return `${dom} ${c.op === 'is' ? '=' : '<>'} LOWER(${p(v)})`;
      }
      case 'company':
        if (c.op === 'empty') return `COALESCE(${a}.company, '') = ''`;
        if (c.op === 'not_empty') return `COALESCE(${a}.company, '') <> ''`;
        if (c.op === 'contains') return `${a}.company ILIKE ${p(`%${like(v)}%`)}`;
        return `LOWER(${a}.company) = LOWER(${p(v)})`;
      case 'first_name':
        return c.op === 'empty' ? `COALESCE(${a}.first_name, '') = ''` : `COALESCE(${a}.first_name, '') <> ''`;
      case 'attribute': {
        const col = `(${a}.attribs->>${p(c.key)})`;
        if (c.op === 'set') return `COALESCE(${col}, '') <> ''`;
        if (c.op === 'not_set') return `COALESCE(${col}, '') = ''`;
        if (c.op === 'contains') return `${col} ILIKE ${p(`%${like(v)}%`)}`;
        return `LOWER(COALESCE(${col}, '')) ${c.op === 'is' ? '=' : '<>'} LOWER(${p(v)})`;
      }
      case 'created_at':
      case 'last_open_at':
      case 'last_click_at':
      case 'last_sent_at':
        return dateCol(c.field);
      case 'soft_bounces':
        return `${a}.soft_bounces >= ${p(v)}`;
      default:
        throw new Error('unknown field');
    }
  });
  return `(${parts.join(rules.match === 'any' ? ' OR ' : ' AND ')})`;
}

const like = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

/** Catalogue for the UI rule builder. */
function catalogue() {
  return Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, {
    label: f.label, key: Boolean(f.key),
    ops: Object.fromEntries(Object.entries(f.ops).map(([op, s]) => [op, s ? (s === days ? 'days' : s === date ? 'date' : 'text') : null])),
  }]));
}

module.exports = { rulesSchema, compileRules, catalogue, FIELDS, STATUSES };
