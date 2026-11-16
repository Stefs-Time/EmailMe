import { get, qs, download } from '../api.js';
import { html, mount, $, num, pct, date, loading, empty, pager, campStatus, options } from '../ui.js';

export async function render(el, ctx) {
  const state = { q: '', status: '', page: 1 };
  const lm = ctx.session.listmonkUrl;
  mount(el, html`<div class="page-head"><div><h1>Campaign reports</h1><p>Delivery, bounces, unsubscribes and engagement for every campaign sent from listmonk.</p></div>
    <div class="d-flex gap-2 flex-wrap">
      ${ctx.can('exports:read') ? html`<button class="btn btn-outline-primary" id="csv"><i class="bi bi-download me-1"></i>Export report</button>` : ''}
      <a class="btn btn-primary" href="${lm}/admin/campaigns/new" target="_blank" rel="noopener"><i class="bi bi-send me-1"></i>New campaign <i class="bi bi-box-arrow-up-right small"></i></a></div></div>
    <div class="card"><div class="card-body border-bottom"><form class="filter-bar" id="f">
      <input class="form-control search" name="q" placeholder="Search name or subject" aria-label="Search campaigns">
      <select class="form-select" name="status" aria-label="Status">${options(['draft', 'scheduled', 'running', 'paused', 'cancelled', 'finished'], '', { blank: 'All statuses' })}</select>
    </form></div><div id="t">${loading()}</div></div>
    <p class="small text-muted-2 mt-3 mb-0"><i class="bi bi-info-circle me-1"></i>Opens are indicative: image blocking and privacy protection hide some opens, and security scanners create false ones.
      Unsubscribes are counted on the campaign's lists for 7 days after sending (listmonk does not link unsubscribes to a campaign).</p>`);

  async function load() {
    const r = await get(`/reports/campaigns${qs(state)}`);
    if (!r.data.length) { mount($('#t', el), empty('envelope-paper', 'No campaigns found', 'Create one in listmonk; it will appear here automatically.')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>Campaign</th><th>Status</th><th class="num">Targeted</th><th class="num">Sent</th><th class="num">Failures</th>
        <th class="num">Hard</th><th class="num">Soft</th><th class="num">Complaints</th><th class="num">Unsubs</th><th class="num">Opens</th><th class="num">Clicks</th></tr></thead><tbody>
      ${r.data.map((c) => html`<tr class="row-link" data-href="#/campaigns/${c.id}">
        <td><div class="fw-semibold">${c.name}</div><div class="small text-muted-2">${c.lists.join(', ') || 'No lists'} · ${date(c.started_at || c.created_at)}</div></td>
        <td>${campStatus(c.status)}</td><td class="num">${num(c.targeted)}</td><td class="num">${num(c.sent)}</td>
        <td class="num">${num(c.delivery_failures)} <span class="small text-muted-2">${pct(c.rates.bounce)}</span></td>
        <td class="num">${num(c.hard_bounces)}</td><td class="num">${num(c.soft_bounces)}</td><td class="num">${num(c.complaints)}</td>
        <td class="num">${num(c.unsubscribes)}</td><td class="num">${num(c.unique_opens)} <span class="small text-muted-2">${pct(c.rates.open)}</span></td>
        <td class="num">${num(c.unique_clicks)} <span class="small text-muted-2">${pct(c.rates.click)}</span></td></tr>`)}
      </tbody></table></div>${pager(r.meta, (p) => { state.page = p; load(); })}`);
  }
  let t;
  $('#f', el).addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.currentTarget?.q?.value ?? $('#f', el).q.value; state.status = $('#f', el).status.value; state.page = 1; load(); }, 300);
  });
  $('#f', el).addEventListener('submit', (e) => e.preventDefault());
  $('#csv', el)?.addEventListener('click', () => download('/reports/campaigns.csv'));
  el.addEventListener('click', (e) => { const r = e.target.closest('[data-href]'); if (r) location.hash = r.dataset.href; });
  await load();
  return () => clearTimeout(t);
}
