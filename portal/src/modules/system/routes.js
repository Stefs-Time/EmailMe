'use strict';

const express = require('express');
const { z } = require('zod');
const { parse, notFound } = require('../../lib/errors');
const { requirePermission } = require('../../middleware/auth');
const { audit } = require('../../lib/audit');
const { getState } = require('../sync/worker');

/**
 * Checks listmonk's configuration against the scope's go-live requirements.
 * Read-only: the portal never changes listmonk settings (and never sees SMTP
 * passwords, which listmonk masks).
 */
function configChecks(s, config) {
  const checks = [];
  const add = (id, ok, title, help, severity = 'warning') => checks.push({ id, ok: Boolean(ok), title, help, severity });
  const smtp = (s.smtp || []).filter((x) => x.enabled);
  const placeholder = smtp.some((x) => /yoursite\.com$/i.test(x.host) || x.host === 'smtp.gmail.com' && x.username === 'username@gmail.com');
  add('smtp', smtp.length > 0 && !placeholder, 'Outgoing SMTP server configured',
    'listmonk → Settings → SMTP. Enter your mail server host, port, TLS mode and credentials, then use "Test connection".', 'critical');
  add('smtp_tls', smtp.every((x) => x.tls_type && x.tls_type !== 'none'), 'SMTP uses TLS or STARTTLS',
    'listmonk → Settings → SMTP → TLS. Use STARTTLS (port 587) or TLS (port 465).');
  const mailboxes = (s['bounce.mailboxes'] || []).filter((m) => m.enabled);
  const webhooks = s['bounce.webhooks_enabled'] || s['bounce.ses_enabled'] || s['bounce.sendgrid_enabled'] ||
    s['bounce.postmark']?.enabled || s['bounce.azure']?.enabled || s['bounce.forwardemail']?.enabled || s['bounce.lettermint']?.enabled;
  add('bounce_enabled', s['bounce.enabled'] && (mailboxes.length || webhooks), 'Bounce processing enabled',
    'listmonk → Settings → Bounces. Enable bounce processing and configure the dedicated POP3 bounce mailbox or your provider webhook.', 'critical');
  const actions = s['bounce.actions'] || {};
  add('bounce_hard', actions.hard?.action === 'blocklist' && actions.hard?.count === 1, 'Hard bounce → blocklist after 1 bounce',
    'listmonk → Settings → Bounces → Actions: set Hard to count 1, action "blocklist".', 'critical');
  add('bounce_complaint', actions.complaint?.action === 'blocklist' && actions.complaint?.count === 1, 'Complaint → blocklist immediately',
    'listmonk → Settings → Bounces → Actions: set Complaint to count 1, action "blocklist".', 'critical');
  add('bounce_soft', actions.soft && actions.soft.count >= 1, `Soft bounce threshold set (currently ${actions.soft?.count ?? '–'} → ${actions.soft?.action ?? '–'})`,
    'listmonk → Settings → Bounces → Actions: choose how many soft bounces trigger an action. Recommended: 3 → blocklist.', 'info');
  add('unsub_header', s['privacy.unsubscribe_header'], 'One-click List-Unsubscribe header',
    'listmonk → Settings → Privacy → "Include List-Unsubscribe header". Required by Gmail/Yahoo bulk-sender rules.', 'critical');
  add('root_https', /^https:\/\//.test(s['app.root_url'] || ''), 'Public root URL uses HTTPS',
    'listmonk → Settings → General → Root URL. Unsubscribe and tracking links use this address; it must be your public https:// domain.', 'critical');
  add('from_email', s['app.from_email'] && !/example\.com|yoursite/i.test(s['app.from_email']), 'Default sender address set',
    'listmonk → Settings → General → Default "from" email, e.g. "Acme News <news@acme.co.za>".');
  add('global_unsub', config.GLOBAL_UNSUBSCRIBE, 'Unsubscribes are global (POPIA-safe default)',
    'Set GLOBAL_UNSUBSCRIBE=true in the portal environment unless you run a documented per-list preference model.', 'info');
  return checks;
}

function systemRoutes({ pool, lm, config, sync }) {
  const r = express.Router();

  r.get('/health', requirePermission('system:read'), async (_req, res) => {
    const out = { database: { ok: false }, listmonk: { ok: false }, sync: null, checks: [] };
    try {
      await pool.query('SELECT 1');
      out.database.ok = true;
    } catch (err) {
      out.database.error = err.message;
    }
    try {
      await lm.health();
      out.listmonk.ok = true;
      const cfg = await lm.config().catch(() => null);
      out.listmonk.version = cfg?.version || null;
      const settings = await lm.settings();
      out.checks = configChecks(settings, config);
      out.listmonk.smtp = (settings.smtp || []).filter((s) => s.enabled)
        .map((s) => ({ host: s.host, port: s.port, tls: s.tls_type, maxConns: s.max_conns }));
      out.listmonk.sending = { concurrency: settings['app.concurrency'], ratePerSecond: settings['app.message_rate'],
        batchSize: settings['app.batch_size'], slidingWindow: settings['app.message_sliding_window'] };
    } catch (err) {
      out.listmonk.error = err.message;
    }
    out.sync = await getState(pool, 'heartbeat', null);
    out.backup = await getState(pool, 'backup_heartbeat', null);
    out.backupStaleHours = config.BACKUP_STALE_HOURS;
    out.syncStale = !out.sync || Date.now() - new Date(out.sync.at).getTime() > config.SYNC_STALE_MINUTES * 60000;
    out.listmonkUrl = config.LISTMONK_PUBLIC_URL;
    out.globalUnsubscribe = config.GLOBAL_UNSUBSCRIBE;
    res.json({ success: true, data: out });
  });

  r.post('/sync', requirePermission('system:read'), async (req, res) => {
    const stats = await sync.runOnce();
    await audit(pool, req, 'system.sync_triggered', { details: stats || { skipped: 'already running' } });
    res.json({ success: true, data: stats || { skipped: true } });
  });

  r.get('/alerts', requirePermission('system:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM portal.alerts ORDER BY resolved_at IS NOT NULL, last_seen DESC LIMIT 100`);
    res.json({ success: true, data: rows });
  });

  r.post('/alerts/:id/resolve', requirePermission('system:read'), async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const { rowCount } = await pool.query(
      'UPDATE portal.alerts SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL', [id]);
    if (!rowCount) throw notFound('Alert not found or already resolved');
    await audit(pool, req, 'alert.resolved', { targetType: 'alert', targetId: id });
    res.json({ success: true, data: {} });
  });

  r.get('/audit', requirePermission('audit:read'), async (req, res) => {
    const q = parse(z.object({
      page: z.coerce.number().int().min(1).default(1),
      action: z.string().trim().max(60).optional(),
    }), req.query);
    const params = [q.action ? `${q.action}%` : null, (q.page - 1) * 50];
    const { rows } = await pool.query(
      `SELECT id, actor_email, action, target_type, target_id, details, ip, created_at, COUNT(*) OVER() AS total
         FROM portal.audit_log WHERE ($1::text IS NULL OR action LIKE $1)
        ORDER BY created_at DESC LIMIT 50 OFFSET $2`, params);
    res.json({ success: true, data: rows.map(({ total, ...x }) => x),
      meta: { total: Number(rows[0]?.total || 0), page: q.page, perPage: 50 } });
  });

  r.get('/review', requirePermission('contacts:read'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT r.id, r.subscriber_id, s.email, s.name, r.reason, r.details, r.created_at
         FROM portal.review_queue r LEFT JOIN subscribers s ON s.id = r.subscriber_id
        WHERE r.resolved_at IS NULL ORDER BY r.created_at`);
    res.json({ success: true, data: rows });
  });

  return r;
}

module.exports = { systemRoutes, configChecks };
