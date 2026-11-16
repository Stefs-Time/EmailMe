import { get, post, qs, download } from '../api.js';
import { html, mount, $, num, datetime, loading, empty, pager, options, toast, formModal, label, consentFields, consentFromForm } from '../ui.js';

const REASONS = ['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'blocklisted', 'erased'];

export async function render(el, ctx) {
  const q = ctx.query();
  const state = { q: q.get('q') || '', reason: '', include_lifted: 'false', page: 1 };
  mount(el, html`<div class="page-head"><div><h1>Suppression list</h1>
      <p>Addresses that must never receive marketing. Imports, list changes and listmonk edits cannot override this list.</p></div>
    <div class="d-flex gap-2 flex-wrap">
      ${ctx.can('exports:read') ? html`<button class="btn btn-outline-primary" id="csv"><i class="bi bi-download me-1"></i>Export</button>` : ''}
      ${ctx.can('suppression:add') ? html`<button class="btn btn-primary" id="add"><i class="bi bi-plus-lg me-1"></i>Suppress addresses</button>` : ''}</div></div>
    <div class="card"><div class="card-body border-bottom"><form class="filter-bar" id="f">
      <input class="form-control search" name="q" placeholder="Search email" value="${state.q}" aria-label="Search">
      <select class="form-select" name="reason" aria-label="Reason">${options(REASONS, '', { blank: 'All reasons' })}</select>
      <div class="form-check ms-2"><input class="form-check-input" type="checkbox" name="lifted" id="lifted"><label class="form-check-label" for="lifted">Include lifted</label></div>
    </form></div><div id="t">${loading()}</div></div>`);

  let rows = [];
  async function load() {
    const r = await get(`/suppressions${qs(state)}`);
    rows = r.data;
    if (!rows.length) { mount($('#t', el), empty('shield-check', 'Nothing suppressed', state.q ? 'No match for that search.' : 'Bounced, complained and unsubscribed addresses will appear here automatically.')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>Email</th><th>Reason</th><th>Source</th><th>Suppressed</th><th>By</th><th></th></tr></thead><tbody>
      ${rows.map((s) => html`<tr><td class="cell-email">${s.email || html`<span class="text-muted-2">[erased – hash only]</span>`}
          ${s.subscriber_id ? html`<a class="small ms-1" href="#/contacts/${s.subscriber_id}">view</a>` : ''}
          ${s.lifted_at ? html`<div class="small text-success">Lifted ${datetime(s.lifted_at)}: ${s.lift_reason}</div>` : ''}</td>
        <td><span class="status s-${{ hard_bounce: 'hard_bounced', complaint: 'complaint', unsubscribe: 'unsubscribed' }[s.reason] || 'blocklisted'}">${label(s.reason)}</span></td>
        <td class="small">${s.source}${s.details?.note ? html`<div class="text-muted-2">“${s.details.note}”</div>` : ''}${s.details?.reason ? html`<div class="text-muted-2">${s.details.reason}</div>` : ''}</td>
        <td class="small text-nowrap">${datetime(s.created_at)}</td><td class="small">${s.created_by_name || 'automatic'}</td>
        <td class="text-end">${!s.lifted_at && s.email && s.reason !== 'erased' && ctx.can('suppression:lift') ? html`<button class="btn btn-sm btn-outline-secondary" data-lift="${s.id}">Lift…</button>` : ''}</td></tr>`)}
      </tbody></table></div>${pager(r.meta, (p) => { state.page = p; load(); })}`);
  }

  function lift(s) {
    formModal({
      title: `Reactivate ${s.email}`, size: 'modal-lg', submitLabel: 'Lift suppression',
      body: html`<div class="alert alert-warning small"><i class="bi bi-shield-exclamation me-1"></i>
          Only lift a suppression when the person has given <strong>new, provable permission</strong> (POPIA s69). This is recorded in the audit log.
          ${s.reason === 'hard_bounce' ? html`<br><strong>This address hard-bounced.</strong> Confirm the address now works and mention “address” in your reason.` : ''}</div>
        <label class="form-label">Reason for reactivation <span class="text-danger">*</span></label>
        <textarea class="form-control mb-3" name="reason" rows="2" minlength="10" maxlength="1000" required placeholder="e.g. Customer re-subscribed by signed form on 3 Nov; address verified"></textarea>
        <h3 class="h6 fw-semibold">New permission basis</h3>${consentFields()}
        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" name="resubscribe" id="resub">
          <label class="form-check-label" for="resub">Also put them back on the lists they were removed from</label></div>`,
      onSubmit: async (fd) => {
        await post(`/suppressions/${s.id}/lift`, { reason: fd.get('reason'), consent: consentFromForm(fd), resubscribe: fd.get('resubscribe') === 'on' });
        toast('Suppression lifted'); load();
      },
    });
  }

  const f = $('#f', el);
  let t;
  f.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = f.q.value; state.reason = f.reason.value; state.include_lifted = f.lifted.checked ? 'true' : 'false'; state.page = 1; load(); }, 300);
  });
  f.addEventListener('submit', (e) => e.preventDefault());
  $('#csv', el)?.addEventListener('click', () => download(`/exports/suppressions.csv?include_lifted=${state.include_lifted}`));
  $('#add', el)?.addEventListener('click', () => formModal({
    title: 'Suppress addresses', submitLabel: 'Suppress', danger: true,
    body: html`<label class="form-label">Email addresses</label>
      <textarea class="form-control" name="emails" rows="6" required placeholder="One per line, or separated by commas"></textarea>
      <div class="form-text">Addresses do not need to be contacts yet: they will be blocked from any future import.</div>
      <label class="form-label mt-3">Note</label><input class="form-control" name="note" maxlength="1000" placeholder="e.g. Legal request, competitor, role address">`,
    onSubmit: async (fd) => {
      const emails = String(fd.get('emails')).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const r = await post('/suppressions', { emails, note: fd.get('note') });
      toast(`${num(r.data.added)} address(es) suppressed${r.data.alreadySuppressed ? `, ${num(r.data.alreadySuppressed)} already were` : ''}`);
      load();
    },
  }));
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-lift]'); if (b) lift(rows.find((r) => r.id === Number(b.dataset.lift))); });
  await load();
  return () => clearTimeout(t);
}
