'use strict';

/**
 * Pure helpers for CSV import: parsing, column mapping and row normalisation.
 * Kept free of I/O so they are easy to unit test.
 */

const { parse } = require('csv-parse/sync');
const { normalizeEmail, isValidEmail } = require('../../lib/email');
const { CONSENT_METHODS } = require('../contacts/consent');

const FIELDS = [
  'email',
  'first_name',
  'last_name',
  'full_name',
  'company',
  'source',
  'consent_date',
  'consent_method',
  'consent_purpose',
  'attribute',
  'ignore',
];

const SYNONYMS = {
  email: ['email', 'e-mail', 'email address', 'e-mail address', 'emailaddress', 'mail', 'email_address'],
  first_name: ['first name', 'firstname', 'first_name', 'given name', 'name first', 'fname'],
  last_name: ['last name', 'lastname', 'last_name', 'surname', 'family name', 'lname'],
  full_name: ['name', 'full name', 'fullname', 'full_name', 'contact name'],
  company: ['company', 'organisation', 'organization', 'business', 'company name', 'employer'],
  source: ['source', 'contact source', 'lead source', 'origin'],
  consent_date: ['consent date', 'consent_date', 'opt-in date', 'optin date', 'subscribed date', 'date subscribed'],
  consent_method: ['consent method', 'consent_method', 'opt-in method', 'optin method', 'permission'],
  consent_purpose: ['consent purpose', 'consent_purpose', 'purpose'],
};

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
}

function attributeKey(header) {
  const k = String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
  return /^[a-z]/.test(k) ? k : `f_${k}`.slice(0, 50);
}

/** Picks the delimiter that yields the most columns on the header line. */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t', '|']) {
    const n = firstLine.split(d).length;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** Parses CSV text into {headers, rows(objects keyed by header)}. */
function parseCsv(text, maxRows) {
  const delimiter = detectDelimiter(text);
  const records = parse(text, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  });
  if (!records.length) return { headers: [], rows: [], delimiter };
  const rawHeaders = records[0].map((h, i) => String(h || '').trim() || `column_${i + 1}`);
  // De-duplicate header names so every column is addressable.
  const seen = new Map();
  const headers = rawHeaders.map((h) => {
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h} (${n})` : h;
  });
  const body = records.slice(1);
  if (body.length > maxRows) {
    const err = new Error(`The file has ${body.length.toLocaleString()} rows; the maximum per import is ${maxRows.toLocaleString()}. Split the file and import in parts.`);
    err.code = 'TOO_MANY_ROWS';
    throw err;
  }
  const rows = body.map((rec) => {
    const o = {};
    headers.forEach((h, i) => {
      o[h] = rec[i] !== undefined ? String(rec[i]).slice(0, 2000) : '';
    });
    return o;
  });
  return { headers, rows, delimiter };
}

function suggestMapping(headers) {
  const mapping = {};
  const used = new Set();
  for (const h of headers) {
    const n = normHeader(h);
    let field = 'attribute';
    for (const [f, syns] of Object.entries(SYNONYMS)) {
      if (!used.has(f) && syns.includes(n)) {
        field = f;
        break;
      }
    }
    if (field !== 'attribute') used.add(field);
    mapping[h] = field;
  }
  // If nothing looked like an email header, guess from the column name.
  if (!used.has('email')) {
    const guess = headers.find((h) => /mail/i.test(h));
    if (guess) mapping[guess] = 'email';
  }
  return mapping;
}

const METHOD_ALIASES = {
  'double opt in': 'double_opt_in',
  'double optin': 'double_opt_in',
  doi: 'double_opt_in',
  website: 'web_form',
  'web form': 'web_form',
  webform: 'web_form',
  online: 'web_form',
  paper: 'paper_form',
  'paper form': 'paper_form',
  phone: 'verbal',
  telephone: 'verbal',
  verbal: 'verbal',
  email: 'email_request',
  'email request': 'email_request',
  event: 'event_signup',
  'event signup': 'event_signup',
  customer: 'existing_customer',
  'existing customer': 'existing_customer',
};

function normalizeConsentMethod(v) {
  if (!v) return '';
  const n = String(v).trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (CONSENT_METHODS.includes(n.replace(/ /g, '_'))) return n.replace(/ /g, '_');
  return METHOD_ALIASES[n] || 'other';
}

/** Accepts ISO dates and the common day-first format DD/MM/YYYY used in South Africa. */
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[3] ? undefined : d;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return Number.isNaN(d.getTime()) || d.getUTCDate() !== +m[1] ? undefined : d;
  }
  return undefined; // present but unparseable
}

/**
 * Applies the mapping to one raw row. Returns {email, data, problems[]}.
 * `defaults` holds batch-level source and consent values.
 */
function mapRow(raw, mapping, defaults) {
  const data = { attribs: {} };
  let email = '';
  const problems = [];
  for (const [header, field] of Object.entries(mapping)) {
    const value = raw[header] ?? '';
    switch (field) {
      case 'email':
        email = normalizeEmail(value);
        break;
      case 'first_name':
      case 'last_name':
      case 'company':
      case 'source':
      case 'consent_purpose':
        if (value) data[field] = value.slice(0, 200);
        break;
      case 'full_name':
        if (value) data.full_name = value.slice(0, 200);
        break;
      case 'consent_method':
        if (value) data.consent_method = normalizeConsentMethod(value);
        break;
      case 'consent_date': {
        const d = parseDate(value);
        if (d === undefined) problems.push(`Unrecognised consent date "${value.slice(0, 30)}" (use YYYY-MM-DD)`);
        else if (d) data.consent_date = d.toISOString().slice(0, 10);
        break;
      }
      case 'attribute':
        if (value) data.attribs[attributeKey(header)] = value.slice(0, 1000);
        break;
      default:
        break;
    }
  }
  if (!data.first_name && !data.last_name && data.full_name) {
    const parts = data.full_name.split(/\s+/);
    data.first_name = parts.shift();
    data.last_name = parts.join(' ');
  }
  delete data.full_name;
  data.source = data.source || defaults.source || 'import';
  data.consent_method = data.consent_method || defaults.consent?.method || '';
  data.consent_purpose = data.consent_purpose || defaults.consent?.purpose || '';
  data.consent_date = data.consent_date || defaults.consent?.obtainedAt || null;
  return { email, data, problems, emailValid: isValidEmail(email) };
}

module.exports = {
  FIELDS,
  parseCsv,
  suggestMapping,
  mapRow,
  attributeKey,
  detectDelimiter,
  normalizeConsentMethod,
  parseDate,
};
