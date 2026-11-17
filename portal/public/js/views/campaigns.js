import { get, post, qs, download } from '../api.js';
import { html, mount, $, num, pct, datetime, loading, empty, pager, campStatus, options, errorToast } from '../ui.js';

export async function render(el, ctx) {
  const state = { q: '', status: '', page: 1 };
  const canWrite = ctx.can('campaigns:write');

  async function createNew() {
    try {
      const r = await post('/campaigns', { name: `Campaign ${new Date().toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}` });
      location.hash = `#/campaigns/${r.data.id}/edit`;
    } catch (err) { errorToast(err); }
  }
  if (ctx.query().get('new') && canWrite) { await createNew(); return; }

  mount(el, html`<div class="page-head"><div><h1>Campaigns</h1><p>Write, test, schedule and send emails. Suppressed, unsubscribed and held contacts are excluded automatically.</p></div>
    <div class="d-flex gap-2 flex-wrap">
      ${ctx.can('exports:read') ? html`<button class="btn btn-outline-primary" id="csv"><i class="bi bi-download me-1"></i>Export report</button>` : ''}
      ${canWrite ? html`<button class="btn btn-primary" id="new"><i class="bi bi-plus-lg me-1"></i>New campaign</button>` : ''}</div></div>
    <div class="card"><div class="card-body border-bottom"><form class="filter-bar" id="f" role="search" aria-label="Filter campaigns">
      <input class="form-control search" name="q" placeholder="Search name or subject" aria-label="Search campaigns">
      <select class="form-select" name="status" aria-label="Status">${options(['draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled'], '', { blank: 'All statuses' })}</select>
    </form></div><div id="t">${loading()}</div></div>
    <p class="small text-muted-2 mt-3 mb-0"><i class="bi bi-info-circle me-1"></i>Opens are indicative: image blocking and privacy protection hide some opens and security scanners add others. Clicks and unsubscribes are exact.</p>`);

  async function load() {
    const r = await get(`/reports/campaigns${qs(state)}`);
    if (!r.data.length) {
      mount($('#t', el), empty('send', state.q || state.status ? 'No campaigns match' : 'No campaigns yet',
        canWrite && !state.q ? 'Create your first campaign: write it, send yourself a test, then send or schedule it.' : '',
        canWrite && !state.q ? html`<button class="btn btn-primary" data-new>New campaign</button>` : ''));
      return;
    }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>Campaign</th><th>Status</th><th class="num">Recipients</th><th class="num">Sent</th><th class="num">Bounced</th>
        <th class="num">Opened</th><th class="num">Clicked</th><th class="num">Unsubs</th><th class="num">Complaints</th></tr></thead><tbody>
      ${r.data.map((c) => html`<tr class="row-link" data-href="${['draft'].includes(c.status) && canWrite ? `#/campaigns/${c.id}/edit` : `#/campaigns/${c.id}`}">
        <td><a class="fw-semibold text-decoration-none" href="${['draft'].includes(c.status) && canWrite ? `#/campaigns/${c.id}/edit` : `#/campaigns/${c.id}`}">${c.name}</a>
          <div class="small text-muted-2">${c.subject || 'No subject yet'} · ${c.lists.join(', ') || 'No lists'}</div>
          <div class="small text-muted-2">${c.status === 'scheduled' ? `Scheduled for ${datetime(c.send_at)}` : c.started_at ? `Started ${datetime(c.started_at)}` : `Created ${datetime(c.created_at)}`}</div></td>
        <td>${campStatus(c.status)}${c.status === 'sending' || c.status === 'paused' ? html`<div class="small text-muted-2">${num(c.sent)} / ${num(c.targeted)}</div>` : ''}</td>
        <td class="num">${c.targeted ? num(c.targeted) : '–'}</td><td class="num">${c.targeted ? num(c.sent) : '–'}</td>
        <td class="num">${c.sent ? html`${num(c.delivery_failures)} <span class="small text-muted-2">${pct(c.rates.bounce)}</span>` : '–'}</td>
        <td class="num">${c.sent ? html`${num(c.unique_opens)} <span class="small text-muted-2">${pct(c.rates.open)}</span>` : '–'}</td>
        <td class="num">${c.sent ? html`${num(c.unique_clicks)} <span class="small text-muted-2">${pct(c.rates.click)}</span>` : '–'}</td>
        <td class="num">${c.sent ? num(c.unsubscribes) : '–'}</td><td class="num">${c.sent ? num(c.complaints) : '–'}</td></tr>`)}
      </tbody></table></div>${pager(r.meta, (p) => { state.page = p; load(); })}`);
  }
  let t;
  const f = $('#f', el);
  f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = f.q.value; state.status = f.status.value; state.page = 1; load(); }, 300); });
  f.addEventListener('submit', (e) => e.preventDefault());
  $('#csv', el)?.addEventListener('click', () => download('/reports/campaigns.csv'));
  $('#new', el)?.addEventListener('click', createNew);
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) return createNew();
    if (e.target.closest('a')) return undefined;
    const r = e.target.closest('[data-href]');
    if (r) location.hash = r.dataset.href;
    return undefined;
  });
  await load();
  return () => clearTimeout(t);
}
