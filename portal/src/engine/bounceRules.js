'use strict';

/**
 * Bounce classification rules (scope §3.6.2).
 *
 * Many tools mark every 5.x.x status as a hard bounce. That is wrong for
 * policy / spam / authentication rejections (5.7.x), which say nothing about
 * whether the mailbox exists. These rules use the enhanced status code and the
 * response text; `hint` is the source's own verdict, used only as a fallback.
 *
 * Classifications:
 *   hard      -> permanently undeliverable: suppress
 *   soft      -> temporary: counted; suppressed after the soft-bounce limit
 *   complaint -> spam complaint: suppress immediately
 *   review    -> needs a human: hold (exclude from sends) until resolved
 */

const ENHANCED_RE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const BASIC_RE = /\b([45]\d\d)\b/;

const HARD_TEXT_RE =
  /(user unknown|unknown user|no such user|mailbox (?:not found|unavailable|does not exist)|address not found|does not exist|invalid recipient|recipient (?:address )?rejected|NXDOMAIN|account (?:has been )?disabled)/i;
const POLICY_TEXT_RE = /(spam|blocked|blacklist|blocklist|policy|reputation|dmarc|spf|dkim|not authorized|denied)/i;
const FULL_TEXT_RE = /(mailbox full|over quota|quota exceeded|insufficient storage)/i;

/** Rules keyed by enhanced status code prefix; first match wins (most specific first). */
const ENHANCED_RULES = [
  { match: '5.1.1', classification: 'hard', reason: 'Bad destination mailbox address' },
  { match: '5.1.0', classification: 'hard', reason: 'Bad address' },
  { match: '5.1.2', classification: 'hard', reason: 'Bad destination domain' },
  { match: '5.1.3', classification: 'hard', reason: 'Bad destination address syntax' },
  { match: '5.1.6', classification: 'hard', reason: 'Mailbox has moved' },
  { match: '5.1.10', classification: 'hard', reason: 'Recipient address has null MX' },
  { match: '5.2.1', classification: 'hard', reason: 'Mailbox disabled' },
  { match: '5.2.2', classification: 'soft', reason: 'Mailbox full' },
  { match: '5.2.3', classification: 'review', reason: 'Message too large for recipient' },
  { match: '5.3.4', classification: 'review', reason: 'Message too big for system' },
  { match: '5.4.4', classification: 'hard', reason: 'Unable to route (domain has no mail server)' },
  { match: '5.7.', classification: 'review', reason: 'Policy, security or spam rejection' },
  { match: '5.6.', classification: 'review', reason: 'Message content rejected' },
  { match: '5.5.', classification: 'review', reason: 'Protocol error' },
  { match: '5.3.', classification: 'soft', reason: 'Recipient mail system issue' },
  { match: '5.', classification: 'hard', reason: 'Permanent failure' },
  { match: '4.2.2', classification: 'soft', reason: 'Mailbox full' },
  { match: '4.', classification: 'soft', reason: 'Temporary failure' },
];

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;

/**
 * Builds the text the rules inspect. Received headers are dropped and IPv4
 * addresses stripped so that e.g. "10.5.1.1" is never read as status 5.1.1.
 * a `classify_reason` field (e.g. "smtp_status=5.7.1") is put first.
 */
function flatten(meta) {
  if (!meta) return '';
  let obj = meta;
  if (typeof meta === 'string') {
    try {
      obj = JSON.parse(meta);
    } catch {
      return meta.replace(IPV4_RE, ' ');
    }
  }
  if (typeof obj !== 'object' || obj === null) return String(obj).replace(IPV4_RE, ' ');
  const { received, classify_reason: reason, ...rest } = obj; // eslint-disable-line no-unused-vars
  let text = '';
  try {
    text = JSON.stringify(rest);
  } catch {
    text = '';
  }
  return `${reason || ''} ${text}`.replace(IPV4_RE, ' ');
}

/**
 * @param {string|undefined} hint  the source's verdict: hard | soft | complaint
 * @param {object|string} meta  response / diagnostic text or object
 * @returns {{classification:string, enhancedCode:string|null, smtpCode:string|null, reason:string}}
 */
function classifyBounce(hint, meta) {
  const text = flatten(meta);
  const enhanced = text.match(ENHANCED_RE);
  const enhancedCode = enhanced ? `${enhanced[1]}.${enhanced[2]}.${enhanced[3]}` : null;
  const basic = text.replace(ENHANCED_RE, ' ').match(BASIC_RE);
  const smtpCode = basic ? basic[1] : null;

  if (hint === 'complaint') {
    return { classification: 'complaint', enhancedCode, smtpCode, reason: 'Spam complaint' };
  }

  if (enhancedCode && !enhancedCode.startsWith('2.')) {
    const rule = ENHANCED_RULES.find((r) => enhancedCode === r.match || (r.match.endsWith('.') && enhancedCode.startsWith(r.match)));
    if (rule) return { classification: rule.classification, enhancedCode, smtpCode, reason: `${enhancedCode}: ${rule.reason}` };
  }

  if (FULL_TEXT_RE.test(text)) return { classification: 'soft', enhancedCode, smtpCode, reason: 'Mailbox full' };
  if (HARD_TEXT_RE.test(text)) return { classification: 'hard', enhancedCode, smtpCode, reason: 'Recipient address does not exist' };

  if (smtpCode) {
    if (smtpCode.startsWith('4')) return { classification: 'soft', enhancedCode, smtpCode, reason: `${smtpCode}: Temporary failure` };
    if (POLICY_TEXT_RE.test(text)) return { classification: 'review', enhancedCode, smtpCode, reason: `${smtpCode}: Possible policy rejection` };
    if (smtpCode === '550' || smtpCode === '551' || smtpCode === '553') {
      return { classification: 'hard', enhancedCode, smtpCode, reason: `${smtpCode}: Mailbox unavailable` };
    }
  }

  if (POLICY_TEXT_RE.test(text) && hint === 'hard') {
    return { classification: 'review', enhancedCode, smtpCode, reason: 'Possible policy rejection' };
  }

  // Fall back to the source's own verdict (unknown → soft, the cautious choice).
  return {
    classification: hint === 'hard' ? 'hard' : 'soft',
    enhancedCode,
    smtpCode,
    reason: hint === 'hard' ? 'Permanent failure (reported by the receiving server)' : 'Temporary or unclassified failure',
  };
}

module.exports = { classifyBounce, ENHANCED_RULES };
