import { get, post } from '../api.js';
import { html, mount, $, num, datetime, ago, loading, toast, errorToast } from '../ui.js';

export async function render(el, ctx) {
  mount(el, loading('Checking systems…'));
  const [{ data: h }, { data: alerts }] = await Promise.all([get('/system/health'), get('/system/alerts')]);
  const failing = h.checks.filter((c) => !c.ok && c.severity === 'critical').length;
  const icon = (ok, sev = 'critical') => (ok ? html`<i class="bi bi-check-circle-fill text-success"></i>`
    : sev === 'info' ? html`<i class="bi bi-info-circle-fill text-primary"></i>` : sev === 'warning' ? html`<i class="bi bi-exclamation-triangle-fill text-warning"></i>` : html`<i class="bi bi-x-circle-fill text-danger"></i>`);
  const openAlerts = alerts.filter((a) => !a.resolved_at);
  const resolvedAlerts = alerts.filter((a) => a.resolved_at);
  const alertItem = (a) => html`<li class="list-group-item">
    <div class="d-flex justify-content-between gap-2"><span class="small fw-semibold ${a.resolved_at ? 'text-muted-2' : a.severity === 'critical' ? 'text-danger' : ''}">${a.message}</span>
    ${!a.resolved_at ? html`<button class="btn btn-sm btn-light" data-resolve="${a.id}">Resolve</button>` : ''}</div>
    <div class="small text-muted-2">${a.resolved_at ? `Resolved ${datetime(a.resolved_at)}` : `${a.severity === 'critical' ? 'Critical' : 'Warning'} · ${num(a.occurrences)}× · last ${ago(a.last_seen)}`}</div></li>`;

  mount(el, html`<div class="page-head"><div><h1>System health</h1><p>Database, email sending, background worker, bounce mailbox, DNS and the go-live checklist.</p></div>
    <div class="d-flex gap-2">${ctx.can('settings:manage') ? html`<a class="btn btn-primary" href="#/settings"><i class="bi bi-gear me-1"></i>Settings</a>` : ''}
      <button class="btn btn-outline-primary" id="recheck"><i class="bi bi-arrow-repeat me-1"></i>Re-check SMTP</button></div></div>
    <div class="row g-3 mb-3">
      <div class="col-md-6 col-xl-3"><div class="card kpi"><div class="label">Database</div><div class="value fs-5 mt-2">${icon(h.database.ok)} ${h.database.ok ? 'Connected' : 'Unavailable'}</div></div></div>
      <div class="col-md-6 col-xl-3"><div class="card kpi"><div class="label">SMTP server</div><div class="value fs-5 mt-2">${icon(h.smtp.ok)} ${h.smtp.ok ? 'Connected' : 'Not working'}</div>
        <div class="sub mono">${h.smtp.host}:${h.smtp.port} · ${h.smtp.security}</div>${h.smtp.error ? html`<div class="sub text-danger">${h.smtp.error}</div>` : ''}</div></div>
      <div class="col-md-6 col-xl-3"><div class="card kpi"><div class="label">Background worker</div><div class="value fs-5 mt-2">${icon(!h.workerStale)} ${h.worker ? `Active ${ago(h.worker.at)}` : 'Not running'}</div>
        <div class="sub">${num(h.queue.queued)} queued · ${num(h.queue.sent_last_hour)} sent in the last hour</div></div></div>
      <div class="col-md-6 col-xl-3"><div class="card kpi"><div class="label">Bounce mailbox</div><div class="value fs-5 mt-2">${h.mailbox ? html`${icon(h.mailbox.ok)} ${h.mailbox.ok ? `Read ${ago(h.mailbox.at)}` : 'Error'}` : html`${icon(false, 'warning')} Not set up`}</div>
        <div class="sub">${h.mailbox?.ok ? `${num(h.mailbox.bounces || 0)} bounce(s) in last check` : h.mailbox?.error || 'Settings → Bounces'}</div></div></div>
    </div>
    <div class="row g-3">
      <div class="col-xl-7"><div class="card"><div class="card-header d-flex justify-content-between">Go-live checklist
        <span class="small fw-normal ${failing ? 'text-danger' : 'text-success'}">${failing ? `${failing} critical item(s) to fix` : 'All critical checks pass'}</span></div><div class="card-body">
        ${h.checks.map((c) => html`<div class="check-row">${icon(c.ok, c.severity)}<div><div class="fw-semibold">${c.title}</div>${c.help ? html`<div class="small text-muted-2 ${c.ok ? 'mono' : ''}">${c.help}</div>` : ''}</div></div>`)}
      </div></div></div>
      <div class="col-xl-5">
        <div class="card mb-3"><div class="card-header">Sending</div><div class="card-body small">
          <div>Rate: <strong>${num(h.sending.ratePerSecond)}</strong> emails/second${h.sending.maxPerHour ? `, at most ${num(h.sending.maxPerHour)} per hour` : ''}.</div>
          <div class="mt-1">${num(h.queue.queued)} queued · ${num(h.queue.sending)} sending now · ${num(h.queue.failed_24h)} failed in 24 h.</div>
          <div class="mt-1">Unsubscribes are <strong>${h.globalUnsubscribe ? 'global (all marketing)' : 'per list'}</strong>.</div>
          <div class="mt-1">Public URL: <span class="mono">${h.publicUrl || 'not set'}</span></div></div></div>
        <div class="card mb-3"><div class="card-header">Backups</div><div class="card-body small">
          ${h.backup ? html`<div class="d-flex gap-2 align-items-start">${icon(h.backup.ok)}<div><div class="fw-semibold">${h.backup.ok ? `Last backup ${ago(h.backup.at)}` : `Last backup FAILED ${ago(h.backup.at)}`}</div>
            ${h.backup.ok ? html`<div class="text-muted-2">${h.backup.file} · ${num(Math.round((h.backup.size || 0) / 1024))} KB</div>` : html`<div class="text-danger">${h.backup.error}</div>`}</div></div>`
            : html`<div class="d-flex gap-2">${icon(false, 'warning')}<div>No backup recorded yet. Set up the backup job (administrator guide).</div></div>`}</div></div>
        <div class="card"><div class="card-header d-flex justify-content-between">Alerts <span class="small fw-normal text-muted-2">${num(openAlerts.length)} open</span></div>
          ${openAlerts.length ? html`<ul class="list-group list-group-flush">${openAlerts.map(alertItem)}</ul>` : html`<div class="card-body text-muted-2"><i class="bi bi-check-circle text-success me-1"></i>No open alerts.</div>`}
          ${resolvedAlerts.length ? html`<details class="resolved-alerts border-top"><summary>Recently resolved (${num(resolvedAlerts.length)})</summary><ul class="list-group list-group-flush">${resolvedAlerts.slice(0, 15).map(alertItem)}</ul></details>` : ''}</div>
      </div></div>`);

  $('#recheck', el).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await post('/system/smtp-recheck'); toast(r.data.ok ? 'SMTP server connected' : `SMTP problem: ${r.data.error}`, r.data.ok ? 'success' : 'danger'); ctx.navigate('#/system'); } catch (err) { errorToast(err); e.target.disabled = false; }
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-resolve]');
    if (!b) return;
    try { await post(`/system/alerts/${b.dataset.resolve}/resolve`); toast('Alert resolved'); ctx.navigate('#/system'); } catch (err) { errorToast(err); }
  });
}
