import { get } from '../api.js';
import { html, mount, $, num, pct, datetime, loading, campStatus } from '../ui.js';
import { stackedBars } from '../charts.js';
import { bounceBadge } from './dashboard.js';

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const { data } = await get(`/reports/campaigns/${id}`);
  const c = data.campaign;
  const tiles = [
    ['Recipients targeted', c.targeted, 'people', null],
    ['Emails sent', c.sent, 'send-check', null],
    ['Delivery failures', c.delivery_failures, 'exclamation-triangle', c.rates.bounce],
    ['Hard bounces', c.hard_bounces, 'x-octagon', null],
    ['Soft bounces', c.soft_bounces, 'arrow-repeat', null],
    ['Needs review', c.review_bounces, 'hourglass-split', null],
    ['Complaints', c.complaints, 'flag', c.rates.complaint],
    ['Unsubscribes (7 days)', c.unsubscribes, 'envelope-x', c.rates.unsubscribe],
    ['Unique opens', c.unique_opens, 'envelope-open', c.rates.open],
    ['Unique clicks', c.unique_clicks, 'cursor', c.rates.click],
  ];
  const progress = c.targeted ? Math.min(100, (c.sent / c.targeted) * 100) : 0;
  mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/campaigns">Campaign reports</a></li><li class="breadcrumb-item active">${c.name}</li></ol></nav>
    <div class="page-head"><div><h1 class="d-flex gap-2 align-items-center flex-wrap">${c.name} ${campStatus(c.status)}</h1>
      <p>Subject: “${c.subject}” · Lists: ${c.lists.join(', ') || '–'} · Started ${datetime(c.started_at)}</p></div>
      ${ctx.can('campaigns:compose') ? html`<a class="btn btn-outline-primary" href="${data.listmonkUrl}" target="_blank" rel="noopener">Open in listmonk <i class="bi bi-box-arrow-up-right small" aria-hidden="true"></i><span class="visually-hidden"> (new tab)</span></a>` : ''}</div>
    ${['running', 'paused'].includes(c.status) ? html`<div class="card mb-3"><div class="card-body"><div class="d-flex justify-content-between small mb-1"><span>Sending progress</span><span>${num(c.sent)} / ${num(c.targeted)}</span></div>
      <div class="hbar"><span data-w="${progress}"></span></div></div></div>` : ''}
    <div class="row g-3 mb-3">${tiles.map(([l, v, icon, rate]) => html`<div class="col-6 col-md-4 col-xl"><div class="card kpi">
      <div class="label"><i class="bi bi-${icon}"></i>${l}</div><div class="value">${num(v)}</div><div class="sub">${rate !== null ? `${pct(rate)} of sent` : ' '}</div></div></div>`)}</div>
    <div class="row g-3">
      <div class="col-xl-7"><div class="card h-100"><div class="card-header">Activity by hour (first 14 days)</div><div class="card-body">
        ${data.timeline.length ? html`<div class="chart-box"><canvas id="tl" role="img" aria-label="Opens, clicks and bounces by hour"></canvas></div>` : html`<div class="text-muted-2">No activity recorded yet.</div>`}</div></div></div>
      <div class="col-xl-5"><div class="card h-100"><div class="card-header">Top links</div>
        ${data.links.length ? html`<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Link</th><th class="num">Clicks</th><th class="num">Unique</th></tr></thead><tbody>
          ${data.links.map((l) => html`<tr><td class="small text-truncate mono" title="${l.url}">${l.url}</td><td class="num">${num(l.clicks)}</td><td class="num">${num(l.unique_clicks)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body text-muted-2">No clicks recorded.</div>`}</div></div>
    </div>
    <div class="card mt-3"><div class="card-header">Bounced recipients</div>
      ${data.bounces.length ? html`<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Contact</th><th>Type</th><th>Reason</th><th>Action</th><th>When</th></tr></thead><tbody>
        ${data.bounces.map((b) => html`<tr class="row-link" data-href="#/contacts/${b.subscriber_id}"><td class="cell-email">${b.email || '[deleted]'}</td><td>${bounceBadge(b.classification)}</td>
          <td class="small">${b.reason}</td><td class="small">${b.action_taken.replace(/_/g, ' ')}</td><td class="small text-nowrap">${datetime(b.bounced_at)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="card-body text-muted-2">No bounces for this campaign.</div>`}</div>`);

  let chart;
  if (data.timeline.length) {
    const hours = [...new Set(data.timeline.map((t) => t.at))].sort();
    const series = (kind) => hours.map((h) => data.timeline.find((t) => t.at === h && t.kind === kind)?.n || 0);
    const lbl = hours.map((h) => new Date(h).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit' }));
    chart = stackedBars($('#tl', el), lbl, [
      { key: 'opens', label: 'Opens', data: series('open') },
      { key: 'clicks', label: 'Clicks', data: series('click') },
      { key: 'bounces', label: 'Bounces', data: series('bounce') },
    ]);
  }
  el.addEventListener('click', (e) => { const r = e.target.closest('[data-href]'); if (r) location.hash = r.dataset.href; });
  return () => chart?.destroy();
}
