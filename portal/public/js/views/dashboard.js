import { get, post } from '../api.js';
import { html, mount, $, num, pct, ago, campStatus, loading, STATUS_INFO, toast, errorToast, raw } from '../ui.js';
import { lineChart, shortDay } from '../charts.js';

const KPIS = [
  ['active', 'Active', 'Eligible for campaigns'],
  ['unconfirmed', 'Unconfirmed', 'Awaiting opt-in'],
  ['soft_bounced', 'Soft bounced', 'Temporary failures'],
  ['hard_bounced', 'Hard bounced', 'Suppressed'],
  ['unsubscribed', 'Unsubscribed', 'Suppressed'],
  ['complaint', 'Complaints', 'Suppressed'],
  ['blocklisted', 'Blocklisted', 'Suppressed'],
  ['pending_review', 'Pending review', 'Held – needs a decision'],
];

export async function render(el, ctx) {
  mount(el, loading('Loading your dashboard…'));
  const { data: d } = await get('/reports/overview');
  const s = d.statuses;
  const total = d.totals.contacts;
  const eligible = (s.active || 0) + (s.soft_bounced || 0);
  const order = ['active', 'soft_bounced', 'unconfirmed', 'pending_review', 'unsubscribed', 'hard_bounced', 'complaint', 'blocklisted', 'no_lists'];

  mount(el, html`
    <div class="page-head">
      <div><h1>Good ${greeting()}, ${ctx.user.name.split(' ')[0]}</h1>
        <p>Here is the health of your contact database${d.sync ? html` · synced ${ago(d.sync.at)}` : ''}.</p></div>
      <div class="d-flex gap-2 flex-wrap">
        ${ctx.can('imports:write') ? html`<a class="btn btn-teal" href="#/import"><i class="bi bi-cloud-arrow-up me-1"></i>Import contacts</a>` : ''}
        <a class="btn btn-outline-primary" href="#/contacts"><i class="bi bi-people me-1"></i>Browse contacts</a>
      </div>
    </div>

    ${d.alerts.length ? html`<div class="mb-3">${d.alerts.map((a) => html`<div class="alert-item ${a.severity}" role="alert">
        <i class="bi bi-${a.severity === 'critical' ? 'exclamation-octagon-fill' : a.severity === 'warning' ? 'exclamation-triangle-fill' : 'info-circle-fill'}"></i>
        <div class="flex-grow-1"><strong>${a.severity === 'critical' ? 'Action needed: ' : ''}</strong>${a.message}
          <div class="meta">${a.occurrences > 1 ? `${num(a.occurrences)} occurrences · ` : ''}last seen ${ago(a.last_seen)}</div></div>
        ${a.id && ctx.can('system:read') ? html`<button class="btn btn-sm btn-light" data-resolve="${a.id}">Dismiss</button>` : ''}
      </div>`)}</div>` : ''}

    <div class="row g-3 mb-3">
      <div class="col-lg-4"><a class="card kpi" href="#/contacts">
        <div class="label"><i class="bi bi-people"></i>Total contacts</div>
        <div class="value">${num(total)}</div>
        <div class="sub mb-2">${num(eligible)} will receive your next campaign (${total ? pct((eligible / total) * 100) : '–'})</div>
        <div class="stack-bar" role="img" aria-label="Contact status distribution">${order.filter((k) => s[k]).map((k) => html`<span class="bg-s-${k}" data-w="${(s[k] / total) * 100}" title="${STATUS_INFO[k].label}: ${num(s[k])}"></span>`)}</div>
      </a></div>
      <div class="col-lg-8"><div class="row g-3">
        ${KPIS.map(([k, l, sub]) => html`<div class="col-6 col-md-3"><a class="card kpi" href="#/contacts?status=${k}">
          <div class="label"><span class="dot bg-s-${k}"></span>${l}</div>
          <div class="value">${num(s[k] || 0)}</div><div class="sub">${sub}</div></a></div>`)}
      </div></div>
    </div>

    <div id="inbox-card"></div>
    <div class="row g-3 mb-3">
      <div class="col-6 col-md-3"><a class="card kpi kpi-link" href="#/campaigns"><div class="label"><i class="bi bi-envelope-paper"></i>Campaigns</div><div class="value">${num(d.totals.campaigns)}</div><div class="sub">${num(d.totals.active_campaigns)} running or scheduled</div></a></div>
      <div class="col-6 col-md-3"><a class="card kpi kpi-link" href="#/details?kind=messages&message_kind=campaign&state=sent"><div class="label"><i class="bi bi-send-check"></i>Emails sent</div><div class="value">${num(d.totals.emails_sent)}</div><div class="sub">All campaigns</div></a></div>
      <div class="col-6 col-md-3"><a class="card kpi kpi-link" href="#/details?kind=bounces&days=30"><div class="label"><i class="bi bi-arrow-return-left"></i>Bounces (30 days)</div><div class="value">${num(d.totals.bounces_30d)}</div><div class="sub">Show every bounce</div></a></div>
      <div class="col-6 col-md-3"><a class="card kpi" href="#/suppression"><div class="label"><i class="bi bi-slash-circle"></i>Suppressed</div><div class="value">${num(d.totals.suppressed)}</div><div class="sub">Never re-activated by imports</div></a></div>
    </div>

    <div class="row g-3">
      <div class="col-xl-7"><div class="card h-100"><div class="card-header">Contacts added vs suppressed · last 30 days</div>
        <div class="card-body"><div class="chart-box"><canvas id="growth" aria-label="Contacts added and suppressed per day" role="img"></canvas></div></div></div></div>
      <div class="col-xl-5"><div class="card h-100"><div class="card-header d-flex justify-content-between">Recent bounce activity <a class="small fw-normal" href="#/details?kind=bounces&days=30">View all</a></div>
        ${d.recentBounces.length ? html`<div class="table-responsive"><table class="table table-sm table-hover">
          <thead><tr><th>Contact</th><th>Type</th><th>When</th></tr></thead><tbody>
          ${d.recentBounces.map((b) => html`<tr class="${b.contact_id ? 'row-link' : ''}" data-href="${b.contact_id ? `#/contacts/${b.contact_id}` : ''}">
            <td><div class="cell-email">${b.email || '[deleted]'}</div><div class="small text-muted-2">${b.reason}</div></td>
            <td>${bounceBadge(b.classification)}</td><td class="small text-nowrap">${ago(b.bounced_at)}</td></tr>`)}
          </tbody></table></div>` : html`<div class="empty"><i class="bi bi-emoji-smile"></i>No bounces recorded yet.</div>`}
      </div></div>
    </div>

    <div class="card mt-3"><div class="card-header d-flex justify-content-between">Latest campaigns <a class="small fw-normal" href="#/campaigns">All campaign reports</a></div>
      ${d.recentCampaigns.length ? html`<div class="table-responsive"><table class="table table-hover">
        <thead><tr><th>Campaign</th><th>Status</th><th class="num">Sent</th><th class="num">Bounce %</th><th class="num">Open %</th><th class="num">Click %</th><th class="num">Unsubs</th></tr></thead><tbody>
        ${d.recentCampaigns.map((c) => html`<tr class="row-link" data-href="#/campaigns/${c.id}">
          <td><div class="fw-semibold">${c.name}</div><div class="small text-muted-2">${c.subject}</div></td><td>${campStatus(c.status)}</td>
          <td class="num">${num(c.sent)}</td><td class="num">${pct(c.rates.bounce)}</td><td class="num">${pct(c.rates.open)}</td>
          <td class="num">${pct(c.rates.click)}</td><td class="num">${num(c.unsubscribes)}</td></tr>`)}
        </tbody></table></div>` : html`<div class="empty"><i class="bi bi-envelope"></i>No campaigns yet. <a href="#/guides/campaigns">How to send your first campaign</a></div>`}
    </div>`);

  if (ctx.can('inbox:read')) {
    get('/inbox/counts').then(({ data: ib }) => {
      if (!ib.open && ib.collecting) return;
      mount($('#inbox-card', el), html`<a class="card kpi kpi-link mb-3 d-flex flex-row align-items-center gap-3 flex-wrap" href="#/inbox">
        <i class="bi bi-inbox fs-3 text-primary" aria-hidden="true"></i>
        <div class="flex-grow-1"><div class="label">Inbox</div>
          ${ib.open ? html`<div><strong>${num(ib.open)}</strong> conversation${ib.open === 1 ? '' : 's'} need${ib.open === 1 ? 's' : ''} a reply${ib.unread ? html` · <strong>${num(ib.unread)}</strong> unread` : ''}</div>` : ''}
          ${!ib.collecting ? html`<div class="small text-muted-2">Replies to campaigns are not collected yet: they go to ${ib.reply_to || 'your sender address'}.</div>` : ''}</div>
        ${ib.unsubscribe ? html`<span class="badge text-bg-danger fs-6"><i class="bi bi-envelope-x me-1"></i>${num(ib.unsubscribe)} unsubscribe request${ib.unsubscribe === 1 ? '' : 's'}</span>` : ''}
      </a>`);
    }).catch(() => {});
  }
  const chart = lineChart($('#growth', el), d.growth.map((g) => shortDay(g.day)), [
    { key: 'added', label: 'Added', data: d.growth.map((g) => g.added) },
    { key: 'suppressed', label: 'Suppressed', data: d.growth.map((g) => g.suppressed) },
  ]);

  el.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-href]');
    if (row?.dataset.href) { location.hash = row.dataset.href; return; }
    const r = e.target.closest('[data-resolve]');
    if (r) {
      try { await post(`/system/alerts/${r.dataset.resolve}/resolve`); toast('Alert dismissed'); ctx.navigate('#/'); } catch (err) { errorToast(err); }
    }
  });
  return () => chart.destroy();
}

export function bounceBadge(c) {
  const map = { hard: ['hard_bounced', 'Hard'], soft: ['soft_bounced', 'Soft'], complaint: ['complaint', 'Complaint'], review: ['pending_review', 'Review'] };
  const [cls, l] = map[c] || ['no_lists', c];
  return html`<span class="status s-${cls}">${l}</span>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}
export { raw };
