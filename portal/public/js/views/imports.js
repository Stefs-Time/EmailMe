import { get, download } from '../api.js';
import { html, mount, $, num, datetime, loading, empty, pager, label } from '../ui.js';

const STATUS = { uploaded: 'Awaiting mapping', previewed: 'Awaiting confirmation', committing: 'Importing…', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };

export async function render(el, ctx) {
  let page = 1;
  mount(el, html`<div class="page-head"><div><h1>Import history</h1><p>Every import, who ran it and what happened to each row.</p></div>
    ${ctx.can('imports:write') ? html`<a class="btn btn-teal" href="#/import"><i class="bi bi-cloud-arrow-up me-1"></i>New import</a>` : ''}</div>
    <div class="card" id="t">${loading()}</div>`);
  async function load() {
    const r = await get(`/imports?page=${page}`);
    if (!r.data.length) { mount($('#t', el), empty('cloud-arrow-up', 'No imports yet')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>File</th><th>Status</th><th class="num">Rows</th><th class="num">Created</th><th class="num">Added to lists</th><th class="num">Excluded</th><th>By</th><th>When</th><th></th></tr></thead><tbody>
      ${r.data.map((i) => {
        const res = i.summary?.result || {};
        const excluded = ['suppressed', 'invalid_email', 'duplicate', 'missing_consent', 'invalid_data', 'failed'].reduce((a, k) => a + (res[k] || 0), 0);
        const resumable = ['uploaded', 'previewed', 'committing'].includes(i.status) && ctx.can('imports:write');
        return html`<tr><td class="fw-semibold">${i.filename}${i.error ? html`<div class="small text-danger">${i.error}</div>` : ''}</td>
          <td><span class="camp-status ${i.status === 'completed' ? 'finished' : i.status === 'failed' ? 'paused' : 'scheduled'}">${STATUS[i.status] || label(i.status)}</span></td>
          <td class="num">${num(i.total_rows)}</td><td class="num">${num(i.summary?.imported)}</td><td class="num">${num(i.summary?.added_to_lists)}</td>
          <td class="num">${i.status === 'completed' ? num(excluded) : '–'}</td><td class="small">${i.created_by_name || '–'}</td>
          <td class="small text-nowrap">${datetime(i.created_at)}</td>
          <td class="text-end text-nowrap">${resumable ? html`<a class="btn btn-sm btn-outline-primary" href="#/import/${i.id}">Continue</a>` : ''}
            ${i.status === 'completed' && ctx.can('exports:read') ? html`<button class="btn btn-sm btn-light" data-dl="${i.id}" title="Row report"><i class="bi bi-download"></i></button>` : ''}</td></tr>`;
      })}</tbody></table></div>${pager(r.meta, (p) => { page = p; load(); })}`);
  }
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-dl]'); if (b) download(`/imports/${b.dataset.dl}/rows.csv`); });
  await load();
}
