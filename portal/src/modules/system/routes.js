'use strict';

const dns = require('node:dns').promises;
const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { describeSmtp } = require('../../engine/mailer');
const { getState } = require('../../engine/worker');
const { emailDomain } = require('../../lib/email');

let smtpCache = { at: 0, ok: null, error: null };

async function smtpStatus(transport) {
  if (Date.now() - smtpCache.at < 5 * 60000) return smtpCache;
  try {
    await transport.verify();
    smtpCache = { at: Date.now(), ok: true, error: null };
  } catch (err) {
    smtpCache = { at: Date.now(), ok: false, error: String(err.response || err.message).slice(0, 200) };
  }
  return smtpCache;
}

async function txt(name) {
  try {
    return (await dns.resolveTxt(name)).map((r) => r.join(''));
  } catch {
    return [];
  }
}

/** DNS checks for the sending domain (scope §6). */
async function dnsChecks(fromEmail, bounceAddress) {
  const domain = emailDomain(fromEmail);
  if (!domain) return [];
  const spf = (await txt(domain)).find((t) => /^v=spf1\b/i.test(t));
  const dmarc = (await txt(`_dmarc.${domain}`)).find((t) => /^v=DMARC1\b/i.test(t));
  const bounceDomain = emailDomain(bounceAddress || fromEmail);
  let mx = [];
  try { mx = await dns.resolveMx(bounceDomain); } catch { mx = []; }
  return [
    { id: 'dns_spf', ok: Boolean(spf), severity: 'critical', title: `SPF record for ${domain}`,
      help: spf ? spf : `Add a TXT record on ${domain} authorising your SMTP provider, e.g. "v=spf1 include:<provider> -all".` },
    { id: 'dns_dmarc', ok: Boolean(dmarc), severity: 'critical', title: `DMARC record for ${domain}`,
      help: dmarc ? dmarc : `Add a TXT record at _dmarc.${domain}, e.g. "v=DMARC1; p=none; rua=mailto:dmarc@${domain}". Gmail and Yahoo require DMARC for bulk senders.` },
    { id: 'dns_mx', ok: mx.length > 0, severity: 'warning', title: `Mail server (MX) for ${bounceDomain}`,
      help: mx.length ? mx.map((m) => m.exchange).join(', ') : `${bounceDomain} has no MX record, so bounce notices cannot be delivered back to you.` },
    { id: 'dns_dkim', ok: true, severity: 'info', title: 'DKIM signing',
      help: 'Your SMTP provider signs messages with DKIM. Confirm in your provider dashboard that DKIM is enabled for this domain.' },
  ];
}

/** Turns an SMTP verify error into an actionable hint. */
function smtpHelp(error) {
  const e = String(error || 'Not checked yet');
  if (/timeout|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(e)) {
    return `${e}. The server could not be reached: check SMTP_HOST/SMTP_PORT. Some hosts block outbound SMTP `
      + '(on Railway it requires the Pro plan; redeploy after upgrading).';
  }
  if (/auth|535|534|credentials|login/i.test(e)) return `${e}. Check SMTP_USER and SMTP_PASSWORD (some providers need an SMTP-specific password).`;
  if (/greeting|wrong version number|ssl|tls/i.test(e)) return `${e}. Port and TLS mode may not match: 465 uses TLS from the start, 587 uses STARTTLS.`;
  return `${e}. Check the SMTP_* variables.`;
}

function configChecks(s, publicUrl, mailboxState) {
  const checks = [];
  const add = (id, ok, title, help, severity = 'warning') => checks.push({ id, ok: Boolean(ok), title, help, severity });
  add('public_url', /^https:\/\//.test(publicUrl || ''), 'Public URL uses HTTPS',
    'Settings → General → Public URL. Unsubscribe and tracking links use it (on Railway the generated domain is used until you set one).', 'critical');
  add('from_email', s.from_email, 'Default sender address set', 'Settings → Sending → From address.', 'critical');
  add('org_address', s.org_address, 'Postal address for email footers', 'Settings → General → Postal address. Shown in every email (sender identity).', 'critical');
  add('bounce_mailbox', s.bounce_mailbox.enabled && mailboxState?.ok !== false, 'Bounce mailbox connected',
    'Settings → Bounces. Without it, bounces that arrive after sending are not recorded. Use a dedicated mailbox.', 'critical');
  add('bounce_address', s.bounce_address, 'Return-Path (bounce address) set',
    'Settings → Bounces → Bounce address: the dedicated mailbox address where failures are returned.', 'warning');
  add('global_unsub', s.global_unsubscribe, 'Unsubscribes are global (POPIA-safe default)', 'Settings → Compliance.', 'info');
  add('rate', s.send_rate_per_second <= 20, `Sending rate ${s.send_rate_per_second}/s`, 'Keep the rate within your SMTP provider\'s limits; start slowly on a new domain.', 'info');
  add('one_click', true, 'One-click unsubscribe headers (RFC 8058)', 'Always included in every campaign email.', 'info');
  return checks;
}

function systemRoutes({ pool, settings, transport, config, worker }) {
  const r = express.Router();

  r.get('/health', requirePermission('system:read'), async (_req, res) => {
    const out = { database: { ok: false } };
    try {
      await pool.query('SELECT 1');
      out.database.ok = true;
    } catch (err) {
      out.database.error = err.message;
    }
    const s = await settings.all();
    const publicUrl = await settings.publicUrl();
    out.smtp = { ...describeSmtp(config), ...(await smtpStatus(transport)) };
    out.worker = await getState(pool, 'heartbeat', null);
    out.workerStale = !out.worker || Date.now() - new Date(out.worker.at).getTime() > 5 * 60000;
    out.mailbox = s.bounce_mailbox.enabled ? await getState(pool, 'mailbox', null) : null;
    out.backup = await getState(pool, 'backup_heartbeat', null);
    out.backupStaleHours = s.backup_stale_hours;
    const { rows: q } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
              COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
              COUNT(*) FILTER (WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '1 hour')::int AS sent_last_hour,
              COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '24 hours')::int AS failed_24h
         FROM portal.messages`);
    out.queue = q[0];
    out.sending = { ratePerSecond: s.send_rate_per_second, maxPerHour: s.send_max_per_hour };
    out.checks = [
      { id: 'smtp', ok: out.smtp.ok, severity: 'critical', title: `SMTP server ${config.SMTP_HOST}:${config.SMTP_PORT} reachable and accepts login`,
        help: out.smtp.ok ? '' : smtpHelp(out.smtp.error) },
      ...configChecks(s, publicUrl, out.mailbox),
      ...(s.from_email ? await dnsChecks(s.from_email, s.bounce_address) : []),
    ];
    out.publicUrl = publicUrl;
    out.globalUnsubscribe = s.global_unsubscribe;
    res.json({ success: true, data: out });
  });

  r.post('/smtp-recheck', requirePermission('system:read'), async (_req, res) => {
    smtpCache = { at: 0 };
    res.json({ success: true, data: await smtpStatus(transport) });
  });

  r.post('/mailbox-poll', requirePermission('system:read'), async (req, res) => {
    const out = await worker.mailboxIfDue(true);
    await audit(pool, req, 'system.mailbox_polled', { details: out || {} });
    res.json({ success: true, data: out || { skipped: true } });
  });

  r.get('/alerts', requirePermission('system:read'), async (_req, res) => {
    const { rows } = await pool.query(`SELECT * FROM portal.alerts ORDER BY resolved_at IS NOT NULL, last_seen DESC LIMIT 100`);
    res.json({ success: true, data: rows });
  });

  r.post('/alerts/:id/resolve', requirePermission('system:read'), async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const { rowCount } = await pool.query('UPDATE portal.alerts SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL', [id]);
    if (!rowCount) throw notFound('Alert not found or already resolved');
    await audit(pool, req, 'alert.resolved', { targetType: 'alert', targetId: id });
    res.json({ success: true, data: {} });
  });

  r.get('/audit', requirePermission('audit:read'), async (req, res) => {
    const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), action: z.string().trim().max(60).optional() }), req.query);
    const { rows } = await pool.query(
      `SELECT id, actor_email, action, target_type, target_id, details, ip, created_at, COUNT(*) OVER() AS total
         FROM portal.audit_log WHERE ($1::text IS NULL OR action LIKE $1) ORDER BY created_at DESC LIMIT 50 OFFSET $2`,
      [q.action ? `${q.action}%` : null, (q.page - 1) * 50]);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x), meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: 50 } });
  });

  r.get('/review', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.contact_id, c.email, TRIM(c.first_name || ' ' || c.last_name) AS name, r.reason, r.details, r.created_at
         FROM portal.review_queue r LEFT JOIN portal.contacts c ON c.id = r.contact_id
        WHERE r.resolved_at IS NULL ORDER BY r.created_at`);
    res.json({ success: true, data: rows });
  });

  return r;
}

module.exports = { systemRoutes, configChecks, dnsChecks };
