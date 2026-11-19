import { get } from '../api.js';
import { html, mount, $, num, loading, label, CONSENT_LABELS, STATUS_INFO } from '../ui.js';
import { stackedBars, hbar, shortDay } from '../charts.js';

export async function render(el) {
  mount(el, loading());
  let days = 30;
  const charts = [];
  const { data: a } = await get('/reports/audience');
  // Every number opens the contacts or bounces behind it.
  const contacts = (f) => `#/contacts?${new URLSearchParams(f)}`;
  const go = (href) => { location.hash = href; };
  const month = (m) => { // 'YYYY-MM' → [first day, first day of next month]
    const [y, mo] = m.split('-').map(Number);
    const pad = (n) => String(n).padStart(2, '0');
    return [`${y}-${pad(mo)}-01`, mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`];
  };

  mount(el, html`<div class="page-head"><div><h1>Audience & deliverability</h1><p>Where your contacts come from, how they gave consent, and how healthy delivery is.</p></div></div>
    <div class="row g-3 mb-3">
      <div class="col-xl-6"><div class="card h-100"><div class="card-header">Contacts by source <span class="small fw-normal text-muted-2">· click a bar for its contacts</span></div><div class="card-body"><div class="chart-box"><canvas id="src" role="img" aria-label="Contacts by source"></canvas></div></div></div></div>
      <div class="col-xl-6"><div class="card h-100"><div class="card-header">Consent basis</div><div class="card-body">
        ${a.byConsent.map((r) => html`<div class="mb-2"><div class="d-flex justify-content-between small"><span>${CONSENT_LABELS[r.label] || r.label}</span>
          <a class="num-link" href="${contacts({ consent_method: r.label === '(not recorded)' ? 'none' : r.label })}" aria-label="${CONSENT_LABELS[r.label] || r.label}: ${num(r.n)} contacts. Show them">${num(r.n)}</a></div>
          <div class="hbar"><span data-w="${(r.n / Math.max(...a.byConsent.map((x) => x.n))) * 100}"></span></div></div>`)}
        ${a.byConsent.some((r) => r.label === '(not recorded)') ? html`<div class="alert alert-warning small mt-3 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Some contacts have no consent record. <a href="#/contacts?consent_method=none">Review them</a> before sending marketing.</div>` : ''}
      </div></div></div>
    </div>
    <div class="row g-3 mb-3">
      <div class="col-xl-6"><div class="card h-100"><div class="card-header">Status by source</div><div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>Source</th><th class="num">Total</th><th class="num">Active</th><th class="num">Suppressed</th><th class="num">Bounce rate</th></tr></thead><tbody>
        ${sourceRows(a.byStatusSource).map((r) => { const src = r.source === '(none)' ? null : r.source; const f = (extra) => contacts({ ...(src ? { source: src } : {}), ...extra });
          return html`<tr><td>${r.source}</td>
          <td class="num">${src ? html`<a class="num-link" href="${f({})}">${num(r.total)}</a>` : num(r.total)}</td>
          <td class="num">${src ? html`<a class="num-link" href="${f({ status: 'eligible' })}">${num(r.active)}</a>` : num(r.active)}</td>
          <td class="num">${src ? html`<a class="num-link" href="${f({ status: 'suppressed' })}">${num(r.suppressed)}</a>` : num(r.suppressed)}</td>
          <td class="num ${r.bouncePct > 5 ? 'text-danger fw-semibold' : ''}">${r.bouncePct.toFixed(1)}%</td></tr>`; })}</tbody></table></div></div></div>
      <div class="col-xl-6"><div class="card h-100"><div class="card-header">Top email domains <span class="small fw-normal text-muted-2">· click a bar for its contacts</span></div><div class="card-body"><div class="chart-box"><canvas id="dom" role="img" aria-label="Top email domains"></canvas></div></div></div></div>
    </div>
    <div class="card mb-3"><div class="card-header">Growth · last 12 months</div><div class="table-responsive"><table class="table table-sm">
      <thead><tr><th>Month</th>${a.byMonth.map((m) => html`<th class="num">${m.month.slice(2)}</th>`)}</tr></thead><tbody>
      <tr><td>Added</td>${a.byMonth.map((m) => { const [from, to] = month(m.month); return html`<td class="num">${m.added ? html`<a class="num-link" href="${contacts({ created_from: from, created_to: to })}" aria-label="${num(m.added)} contacts added in ${m.month}">${num(m.added)}</a>` : '0'}</td>`; })}</tr>
      <tr><td>Suppressed</td>${a.byMonth.map((m) => { const [from, to] = month(m.month); return html`<td class="num">${m.suppressed ? html`<a class="num-link" href="#/suppression?${new URLSearchParams({ created_from: from, created_to: to })}" aria-label="${num(m.suppressed)} addresses suppressed in ${m.month}">${num(m.suppressed)}</a>` : '0'}</td>`; })}</tr></tbody></table></div></div>

    <div class="d-flex justify-content-between align-items-center mb-2 mt-4"><h2 class="h5 fw-bold text-primary mb-0">Bounces</h2>
      <div class="btn-group btn-group-sm" role="group" aria-label="Period">${[7, 30, 90].map((d) => html`<button class="btn btn-outline-primary ${d === days ? 'active' : ''}" data-days="${d}">${d} days</button>`)}</div></div>
    <div id="bounces">${loading()}</div>`);

  charts.push(hbar($('#src', el), a.bySource.map((r) => r.label), a.bySource.map((r) => r.n), 'added',
    (i) => { const l = a.bySource[i].label; go(l === '(none)' ? '#/contacts' : contacts({ source: l })); }));
  charts.push(hbar($('#dom', el), a.byDomain.map((r) => r.label), a.byDomain.map((r) => r.n), 'clicks',
    (i) => go(contacts({ q: `@${a.byDomain[i].label}` }))));

  let bounceChart;
  async function loadBounces() {
    const { data: b } = await get(`/reports/bounces?days=${days}`);
    const bounces = (f) => `#/details?${new URLSearchParams({ kind: 'bounces', days: String(days), ...f })}`;
    bounceChart?.destroy();
    mount($('#bounces', el), html`<div class="row g-3">
      <div class="col-xl-8"><div class="card h-100"><div class="card-header d-flex justify-content-between">Bounces per day by classification <a class="small fw-normal" href="${bounces({})}">Show all ${num(b.byClass.reduce((x, r) => x + r.n, 0))}</a></div><div class="card-body"><div class="chart-box"><canvas id="bd" role="img" aria-label="Bounces per day"></canvas></div></div></div></div>
      <div class="col-xl-4"><div class="card mb-3"><div class="card-header">Most common responses</div>
        ${b.byCode.length ? html`<ul class="list-group list-group-flush">${b.byCode.map((r) => html`<li class="list-group-item d-flex justify-content-between gap-2"><span class="small"><span class="mono">${r.label}</span> ${r.reason?.replace(/^[\d.]+: /, '')}</span><a class="num-link" href="${bounces({ code: r.label })}" aria-label="${num(r.n)} bounces with response ${r.label}. Show them">${num(r.n)}</a></li>`)}</ul>` : html`<div class="card-body text-muted-2">No bounces in this period.</div>`}</div>
        <div class="card"><div class="card-header">Domains bouncing most</div>
        ${b.byDomain.length ? html`<ul class="list-group list-group-flush">${b.byDomain.map((r) => html`<li class="list-group-item d-flex justify-content-between"><span class="small">${r.label}</span><a class="num-link" href="${bounces({ domain: r.label })}" aria-label="${num(r.n)} bounces at ${r.label}. Show them">${num(r.n)}</a></li>`)}</ul>` : html`<div class="card-body text-muted-2">–</div>`}</div></div></div>`);
    bounceChart = stackedBars($('#bd', el), b.daily.map((d) => shortDay(d.day)), [
      { key: 'hard', label: 'Hard', data: b.daily.map((d) => d.hard) },
      { key: 'soft', label: 'Soft', data: b.daily.map((d) => d.soft) },
      { key: 'complaint', label: 'Complaint', data: b.daily.map((d) => d.complaint) },
      { key: 'review', label: 'Needs review', data: b.daily.map((d) => d.review) },
    ], () => go(bounces({})));
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-days]');
    if (!b) return;
    days = Number(b.dataset.days);
    el.querySelectorAll('[data-days]').forEach((x) => x.classList.toggle('active', x === b));
    loadBounces();
  });
  await loadBounces();
  return () => { charts.forEach((c) => c.destroy()); bounceChart?.destroy(); };
}

function sourceRows(rows) {
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.source) || { source: r.source, total: 0, active: 0, suppressed: 0, bounced: 0 };
    x.total += r.n;
    if (r.status === 'active' || r.status === 'soft_bounced') x.active += r.n; // = "Eligible to receive"
    if (r.suppressed) x.suppressed += r.n; // = "Any suppression"
    if (['hard_bounced', 'soft_bounced'].includes(r.status)) x.bounced += r.n;
    by.set(r.source, x);
  }
  return [...by.values()].map((x) => ({ ...x, bouncePct: x.total ? (x.bounced / x.total) * 100 : 0 }))
    .sort((p, q) => q.total - p.total).slice(0, 15);
}
export { label, STATUS_INFO };
