import { get, post } from '../api.js';
import { html, mount, $, datetime, loading, empty, toast, formModal } from '../ui.js';

export async function render(el, ctx) {
  mount(el, html`<div class="page-head"><div><h1>Review queue</h1>
    <p>Contacts held back from campaigns because a mail server rejected a message for a reason that does not prove the address is bad
    (for example a spam-policy block, 5.7.x). Decide each one.</p></div><a class="btn btn-light" href="#/guides/bounces">How bounces are handled</a></div>
    <div class="card" id="t">${loading()}</div>`);
  let rows = [];
  async function load() {
    rows = (await get('/system/review')).data;
    ctx.refreshBadges();
    if (!rows.length) { mount($('#t', el), empty('check2-all', 'Nothing to review', 'Held contacts will appear here.')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table align-middle">
      <thead><tr><th>Contact</th><th>Why it was held</th><th>Held since</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td><a class="cell-email" href="#/contacts/${r.subscriber_id}">${r.email}</a><div class="small text-muted-2">${r.name}</div></td>
        <td class="small">${r.reason}${r.details?.code ? html` <span class="mono">${r.details.code}</span>` : ''}</td>
        <td class="small text-nowrap">${datetime(r.created_at)}</td>
        <td class="text-end text-nowrap">${ctx.can('review:resolve') ? html`<button class="btn btn-sm btn-success" data-r="valid" data-id="${r.subscriber_id}">Valid – release</button>
          <button class="btn btn-sm btn-outline-danger" data-r="invalid" data-id="${r.subscriber_id}">Suppress</button>` : ''}</td></tr>`)}
      </tbody></table></div>`);
  }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const valid = b.dataset.r === 'valid';
    formModal({ title: valid ? 'Release hold' : 'Suppress address', danger: !valid, submitLabel: valid ? 'Release' : 'Suppress',
      body: html`<p>${valid ? 'The contact is re-enabled and restored to the lists the hold removed.' : 'The address is permanently suppressed.'}</p>
        <label class="form-label">Note</label><textarea class="form-control" name="note" rows="2" maxlength="1000"></textarea>`,
      onSubmit: async (fd) => { await post(`/contacts/${b.dataset.id}/review`, { resolution: b.dataset.r, note: fd.get('note') }); toast('Resolved'); load(); } });
  });
  await load();
}
