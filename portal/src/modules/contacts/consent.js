'use strict';

const { z } = require('zod');

/** How permission was obtained. Kept short so reports group cleanly. */
const CONSENT_METHODS = [
  'double_opt_in',
  'web_form',
  'paper_form',
  'verbal',
  'email_request',
  'event_signup',
  'existing_customer',
  'other',
];

const consentSchema = z.object({
  method: z.enum(CONSENT_METHODS),
  purpose: z.string().trim().max(200).default(''),
  obtainedAt: z.coerce.date().max(new Date(Date.now() + 86400000), 'Date cannot be in the future').optional(),
  evidence: z.string().trim().max(1000).default(''),
});

/** The consent summary stored on the contact (latest basis); full history is in consent_records. */
function consentAttrib(c, source) {
  return {
    status: 'granted',
    method: c.method,
    purpose: c.purpose || '',
    date: c.obtainedAt ? new Date(c.obtainedAt).toISOString().slice(0, 10) : null,
    source: source || '',
  };
}

module.exports = { CONSENT_METHODS, consentSchema, consentAttrib };
