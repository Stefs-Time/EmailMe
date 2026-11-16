import { get, post } from '../api.js';
import { html, mount, $, num, datetime, ago, loading, toast, errorToast } from '../ui.js';

export async function render(el, ctx) {
  mount(el, loading('Checking systems…'));
  const [{ data: h }, { data: alerts }] = await Promise.all([get('/system/health'), get('/system/alerts')]);
  const failing = h.checks.filter((c) => !c.ok && c.severity === 'critical').length;
  const openAlerts = alerts.filter((a) => !a.resolved_at);
  const resolvedAlerts = alerts.filter((a) => a.resolved_at);
  const alertItem = (a) => html`<li class="list-group-item">
    <div class="d-flex justify-content-between gap-2"><span class="small fw-semibold ${a.resolved_at ? 'text-muted-2' : a.severity === 'critical' ? 'text-danger' : ''}">${a.message}</span>
    ${!a.resolved_at ? html`<button class="btn btn-sm btn-light" data-resolve="${a.id}">Resolve</button>` : ''}</div>
    <div class="small text-muted-2">${a.resolved_at ? `Resolved ${datetime(a.resolved_at)}` : `${a.severity === 'critical' ? 'Critical' : 'Warning'} · ${num(a.occurrences)}× · last ${ago(a.last_seen)}`}</div>
    ${a.details?.lines ? html`<pre class="small mono bg-light p-2 mt-1 mb-0 text-wrap">${a.details.lines.join('\n')}</pre>` : ''}</li>`;
  const icon = (ok, sev = 'critical') => (ok ? html`<i class="bi bi-check-circle-fill text-success"></i>`
    : sev === 'info' ? html`<i class="bi bi-info-circle-fill text-primary"></i>` : sev === 'warning' ? html`<i class="bi bi-exclamation-triangle-fill text-warning"></i>` : html`<i class="bi bi-x-circle-fill text-danger"></i>`);

  mount(el, html`<div class="page-head"><div><h1>System health</h1><p>Live status of the database, listmonk, the recipient sync and the go-live configuration checklist.</p></div>
    <div class="d-flex gap-2"><button class="btn btn-outline-primary" id="sync"><i class="bi bi-arrow-repeat me-1"></i>Run sync now</button>
      <a class="btn btn-primary" href="${h.listmonkUrl}/admin/settings" target="_blank" rel="noopener">listmonk settings <i class="bi bi-box-arrow-up-right small"></i></a></div></div>
    <div class="row g-3 mb-3">
      <div class="col-md-4"><div class="card kpi"><div class="label">Database</div><div class="value fs-5 mt-2">${icon(h.database.ok)} ${h.database.ok ? 'Connected' : 'Unavailable'}</div></div></div>
      <div class="col-md-4"><div class="card kpi"><div class="label">listmonk</div><div class="value fs-5 mt-2">${icon(h.listmonk.ok)} ${h.listmonk.ok ? `Running ${h.listmonk.version || ''}` : 'Unreachable'}</div>
        ${h.listmonk.error ? html`<div class="sub text-danger">${h.listmonk.error}</div>` : ''}</div></div>
      <div class="col-md-4"><div class="card kpi"><div class="label">Recipient sync</div><div class="value fs-5 mt-2">${icon(!h.syncStale && h.sync?.ok)} ${h.sync ? `Last run ${ago(h.sync.at)}` : 'Not run yet'}</div>
        ${h.sync?.error ? html`<div class="sub text-danger">${h.sync.error}</div>` : html`<div class="sub">Bounces, unsubscribes & suppressions every few minutes</div>`}</div></div>
    </div>
    <div class="row g-3">
      <div class="col-xl-7"><div class="card"><div class="card-header d-flex justify-content-between">Go-live checklist
        <span class="small fw-normal ${failing ? 'text-danger' : 'text-success'}">${failing ? `${failing} critical item(s) to fix` : 'All critical checks pass'}</span></div><div class="card-body">
        ${h.checks.length ? h.checks.map((c) => html`<div class="check-row">${icon(c.ok, c.severity)}<div><div class="fw-semibold">${c.title}</div>${c.ok ? '' : html`<div class="small text-muted-2">${c.help}</div>`}</div></div>`)
          : html`<div class="text-muted-2">listmonk must be reachable to run the checks.</div>`}
        <div class="small text-muted-2 mt-3">Also confirm DNS for your sending domain: SPF, DKIM, DMARC, Return-Path and reverse DNS. See the <a href="#/guides/deliverability">deliverability guide</a>.</div>
      </div></div></div>
      <div class="col-xl-5">
        <div class="card mb-3"><div class="card-header">Backups</div><div class="card-body small">
          ${h.backup ? html`<div class="d-flex gap-2 align-items-start">${icon(h.backup.ok)}<div>
              <div class="fw-semibold">${h.backup.ok ? `Last backup ${ago(h.backup.at)}` : `Last backup FAILED ${ago(h.backup.at)}`}</div>
              ${h.backup.ok ? html`<div class="text-muted-2">${h.backup.file} · ${num(Math.round((h.backup.size || 0) / 1024))} KB · ${(h.backup.locations || []).map((l) => (l.startsWith('s3://') ? 'off-site (S3)' : 'local volume')).join(' + ')}</div>`
                : html`<div class="text-danger">${h.backup.error}</div>`}</div></div>`
            : html`<div class="d-flex gap-2">${icon(false, 'warning')}<div>No backup has been recorded. Set up the backup job (see the administrator guide).</div></div>`}
          ${h.backupStaleHours ? html`<div class="text-muted-2 mt-2">An alert is raised if no successful backup happens within ${num(h.backupStaleHours)} hours.</div>` : ''}
        </div></div>
        <div class="card mb-3"><div class="card-header">Sending configuration</div><div class="card-body small">
          ${(h.listmonk.smtp || []).map((s) => html`<div class="mb-2"><span class="mono">${s.host}:${s.port}</span> · ${s.tls} · ${num(s.maxConns)} connections</div>`)}
          ${h.listmonk.sending ? html`<div>Rate: ${num(h.listmonk.sending.ratePerSecond)} msg/s · concurrency ${num(h.listmonk.sending.concurrency)} · batch ${num(h.listmonk.sending.batchSize)}</div>` : ''}
          <div class="mt-2">Unsubscribes are <strong>${h.globalUnsubscribe ? 'global (all lists)' : 'per list'}</strong>.</div>
          <div class="text-muted-2 mt-2">SMTP passwords are stored only in listmonk and are never shown here.</div></div></div>
        <div class="card"><div class="card-header d-flex justify-content-between">Alerts <span class="small fw-normal text-muted-2">${num(openAlerts.length)} open</span></div>
          ${openAlerts.length ? html`<ul class="list-group list-group-flush">${openAlerts.map(alertItem)}</ul>`
            : html`<div class="card-body text-muted-2"><i class="bi bi-check-circle text-success me-1"></i>No open alerts.</div>`}
          ${resolvedAlerts.length ? html`<details class="resolved-alerts border-top"><summary>Recently resolved (${num(resolvedAlerts.length)})</summary>
            <ul class="list-group list-group-flush">${resolvedAlerts.slice(0, 15).map(alertItem)}</ul></details>` : ''}</div>
      </div></div>`);

  $('#sync', el).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await post('/system/sync');
      toast(r.data.skipped ? 'A sync is already running' : `Sync complete: ${r.data.bounces} bounces, ${r.data.unsubscribes} unsubscribes, ${r.data.enforced} enforced`);
      ctx.navigate('#/system');
    } catch (err) { errorToast(err); e.target.disabled = false; }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-resolve]');
    if (!b) return;
    try { await post(`/system/alerts/${b.dataset.resolve}/resolve`); toast('Alert resolved'); ctx.navigate('#/system'); } catch (err) { errorToast(err); }
  });
}
