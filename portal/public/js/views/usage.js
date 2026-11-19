import { get } from '../api.js';
import { html, mount, $, num, datetime, loading } from '../ui.js';
import { stackedBars, shortDay } from '../charts.js';

/** Mail usage: how much MailHarbor sends through your SMTP server. */
export async function render(el) {
  let days = 30;
  let chart;
  mount(el, html`<div class="page-head"><div><h1>Mail usage</h1>
      <p>Everything MailHarbor sends through your own SMTP server: campaigns, test emails and opt-in confirmations.</p></div>
      <div class="btn-group btn-group-sm" role="group" aria-label="Period">${[7, 30, 90, 365].map((d) => html`<button class="btn btn-outline-primary ${d === days ? 'active' : ''}" data-days="${d}">${d === 365 ? '12 months' : `${d} days`}</button>`)}</div></div>
    <div id="usage">${loading()}</div>`);

  async function load() {
    const { data: u } = await get(`/reports/usage?days=${days}`);
    const t = u.totals;
    const cap = u.limits.per_hour;
    const capPct = cap ? Math.min(100, (t.last_hour / cap) * 100) : null;
    const sum = (k) => u.daily.reduce((a, d) => a + d[k], 0);
    const a = u.actions;
    // Every number opens the emails or actions behind it.
    const msgs = (extra) => `#/details?kind=messages&${extra}`;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const monthStart = new Date(midnight.getFullYear(), midnight.getMonth(), 1);
    const hourAgo = new Date(Date.now() - 3600000);
    const since = (d) => `since=${encodeURIComponent(d.toISOString())}`;
    const ev = (type) => `#/details?kind=events&type=${type}&days=${days}`;
    const row = (lbl, n, href, cls = '') => html`<li class="list-group-item d-flex justify-content-between"><span>${lbl}</span>${n ? html`<a class="num-link ${cls}" href="${href}" aria-label="${lbl}: ${num(n)}. Show them">${num(n)}</a>` : html`<strong>0</strong>`}</li>`;
    chart?.destroy();
    mount($('#usage', el), html`
      <div class="row g-3 mb-3">
        <div class="col-6 col-lg-3"><a class="card kpi kpi-link" href="${msgs(`state=sent&${since(midnight)}`)}"><div class="label"><i class="bi bi-send"></i>Sent today</div><div class="value">${num(t.today)}</div><div class="sub">Show emails</div></a></div>
        <div class="col-6 col-lg-3"><a class="card kpi kpi-link" href="${msgs(`state=sent&${since(monthStart)}`)}"><div class="label"><i class="bi bi-calendar-month"></i>This month</div><div class="value">${num(t.this_month)}</div><div class="sub">Show emails</div></a></div>
        <div class="col-6 col-lg-3"><a class="card kpi kpi-link" href="${msgs(`state=sent&${since(hourAgo)}`)}"><div class="label"><i class="bi bi-speedometer2"></i>Last hour</div><div class="value">${num(t.last_hour)}</div>
          <div class="sub">${cap ? html`of ${num(cap)} allowed per hour` : html`No hourly limit (Settings → Sending)`}</div>
          ${cap ? html`<div class="hbar mt-2" role="img" aria-label="${Math.round(capPct)}% of the hourly limit"><span data-w="${capPct}"></span></div>` : ''}</a></div>
        <div class="col-6 col-lg-3"><a class="card kpi kpi-link" href="${msgs('state=pending')}"><div class="label"><i class="bi bi-hourglass-split"></i>Waiting to send</div><div class="value">${num(t.queued)}</div>
          <div class="sub">at up to ${num(u.limits.per_second)} per second</div></a></div>
      </div>
      <div class="row g-3 mb-3">
        <div class="col-xl-8"><div class="card h-100"><div class="card-header">Emails sent per day <span class="small fw-normal text-muted-2">· click a day for its emails</span></div><div class="card-body"><div class="chart-box"><canvas id="ud" role="img" aria-label="Emails sent per day"></canvas></div></div></div></div>
        <div class="col-xl-4"><div class="card mb-3"><div class="card-header">In this period</div><ul class="list-group list-group-flush">
          ${row('Campaign emails', sum('campaign'), msgs(`message_kind=campaign&state=sent&days=${days}`))}
          ${row('Opt-in confirmations', sum('optin'), msgs(`message_kind=optin&state=sent&days=${days}`))}
          ${row('Test emails', sum('test'), msgs(`message_kind=test&state=sent&days=${days}`))}
          ${row('Rejected / not confirmed by SMTP', t.failed, msgs(`state=failed&days=${days}`), 'text-danger')}
        </ul></div>
        <div class="card"><div class="card-header">What recipients did</div><ul class="list-group list-group-flush">
          ${row('Unsubscribed', a.unsubscribed, ev('unsubscribed'))}
          ${row('Changed preferences', a.preferences_updated, ev('preferences_updated'))}
          ${row('Stayed subscribed', a.stayed_subscribed, ev('stayed_subscribed'))}
          ${row('Confirmed opt-in', a.optin_confirmed, ev('optin_confirmed'))}
          ${row('Gave permission', a.consent_given, ev('consent_given'))}
        </ul></div></div>
      </div>
      <div class="card mb-3"><div class="card-header">Campaigns sent in this period</div>
        ${u.byCampaign.length ? html`<div class="table-responsive"><table class="table table-sm align-middle mb-0">
          <thead><tr><th>Campaign</th><th class="num">Emails sent</th><th>First sent</th><th>Last sent</th></tr></thead><tbody>
          ${u.byCampaign.map((c) => html`<tr><td><a href="#/campaigns/${c.id}">${c.name}</a></td><td class="num"><a class="num-link" href="${msgs(`campaign=${c.id}&state=sent&days=${days}`)}">${num(c.sent)}</a></td><td class="small">${datetime(c.first_sent)}</td><td class="small">${datetime(c.last_sent)}</td></tr>`)}
          </tbody></table></div>` : html`<div class="card-body text-muted-2">No campaigns were sent in this period.</div>`}</div>
      <p class="small text-muted-2"><i class="bi bi-info-circle me-1"></i>Sent through ${u.smtp.host ? html`<span class="mono">${u.smtp.host}:${u.smtp.port}</span>` : 'your SMTP server'}.
        Compare these numbers with your SMTP provider's sending limits. Change the speed under Settings → Sending.</p>`);
    chart = stackedBars($('#ud', el), u.daily.map((d) => shortDay(d.day)), [
      { key: 'campaign', label: 'Campaign', data: u.daily.map((d) => d.campaign) },
      { key: 'optin', label: 'Opt-in confirmation', data: u.daily.map((d) => d.optin) },
      { key: 'test', label: 'Test', data: u.daily.map((d) => d.test) },
    ], (i) => {
      // The label shows the local date, so filter on the same local date.
      const dt = new Date(u.daily[i].day);
      const ymd = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      location.hash = msgs(`state=sent&day=${ymd}`);
    });
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (!b) return;
    days = Number(b.dataset.days);
    el.querySelectorAll('[data-days]').forEach((x) => x.classList.toggle('active', x === b));
    load();
  });
  await load();
  return () => chart?.destroy();
}
