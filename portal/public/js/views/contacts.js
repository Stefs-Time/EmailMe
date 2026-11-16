import { get, post, qs, download } from '../api.js';
import { html, raw, mount, $, $$, num, date, ago, statusBadge, loading, empty, pager, options, toast, errorToast,
  formModal, confirmModal, STATUS_INFO, label, CONSENT_LABELS, consentFields, consentFromForm } from '../ui.js';

const COLS = [
  ['email', 'Contact'], ['status', 'Status'], [null, 'Lists'], ['source', 'Source'],
  ['bounces', 'Bounces'], ['created_at', 'Added'],
];

export async function render(el, ctx) {
  const q = ctx.query();
  const state = {
    q: q.get('q') || '', status: q.get('status') || '', list_id: q.get('list_id') || '', source: q.get('source') || '',
    consent_method: q.get('consent_method') || '', sort: q.get('sort') || 'created_at', dir: q.get('dir') || 'desc',
    page: Number(q.get('page') || 1), per_page: Number(q.get('per_page')) || 25,
  };
  const selected = new Set();
  let lastTotal = 0;
  mount(el, loading());
  const { data: facets } = await get('/contacts/facets');
  const listName = new Map(facets.lists.map((l) => [l.id, l.name]));
  const canWrite = ctx.can('contacts:write');

  mount(el, html`
    <div class="page-head">
      <div><h1>Contacts</h1><p>Search, sort and manage every recipient. Statuses update automatically from bounces and unsubscribes.</p></div>
      <div class="d-flex gap-2 flex-wrap">
        ${ctx.can('exports:read') ? html`<button class="btn btn-outline-primary" id="export"><i class="bi bi-download me-1"></i>Export view</button>` : ''}
        ${canWrite ? html`<button class="btn btn-primary" id="add"><i class="bi bi-person-plus me-1"></i>Add contact</button>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-body border-bottom">
        <form class="filter-bar" id="filters" role="search" aria-label="Filter contacts">
          <div class="input-group search"><span class="input-group-text bg-white"><i class="bi bi-search"></i></span>
            <input class="form-control" name="q" placeholder="Email, name or company" value="${state.q}" aria-label="Search contacts"></div>
          <select class="form-select" name="status" aria-label="Status">
            ${options([{ value: 'eligible', label: 'Eligible to receive' }, { value: 'suppressed', label: 'Any suppression' },
              ...Object.entries(STATUS_INFO).map(([value, i]) => ({ value, label: i.label }))], state.status, { blank: 'All statuses' })}</select>
          <select class="form-select" name="list_id" aria-label="List">${options(facets.lists.map((l) => ({ value: l.id, label: l.name })), state.list_id, { blank: 'All lists' })}</select>
          <select class="form-select" name="source" aria-label="Source">${options(facets.sources.map((s) => ({ value: s.v, label: `${s.v} (${num(s.n)})` })), state.source, { blank: 'All sources' })}</select>
          <select class="form-select" name="consent_method" aria-label="Consent method">${options([{ value: 'none', label: 'No consent recorded' }, ...Object.entries(CONSENT_LABELS).map(([value, l]) => ({ value, label: l }))], state.consent_method, { blank: 'Any consent' })}</select>
          <button class="btn btn-light" type="button" id="reset">Reset</button>
        </form>
      </div>
      <div class="bulk-bar m-3 d-none" id="bulk"></div>
      <div id="table">${loading()}</div>
    </div>`);

  async function load() {
    ctx.setQuery({ ...state, per_page: state.per_page !== 25 ? state.per_page : undefined, page: state.page > 1 ? state.page : undefined,
      sort: state.sort !== 'created_at' ? state.sort : undefined, dir: state.dir !== 'desc' ? state.dir : undefined });
    const t = $('#table', el);
    try {
      const r = await get(`/contacts${qs(state)}`);
      if (!r.data.length) {
        mount(t, empty('people', 'No contacts match', state.q || state.status ? 'Try clearing a filter.' : 'Import a CSV file to get started.',
          ctx.can('imports:write') && !state.q ? html`<a class="btn btn-teal" href="#/import">Import contacts</a>` : ''));
        return;
      }
      mount(t, html`<div class="table-responsive"><table class="table table-hover align-middle">
        <thead><tr>
          ${canWrite ? html`<th class="ps-3"><input type="checkbox" class="form-check-input" id="all" aria-label="Select all on page"></th>` : ''}
          ${COLS.map(([k, l]) => (k ? html`<th class="sortable ${state.sort === k ? 'sorted' : ''}" data-sort="${k}" tabindex="0" aria-sort="${state.sort === k ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${l}
            ${state.sort === k ? html`<i class="bi bi-caret-${state.dir === 'asc' ? 'up' : 'down'}-fill"></i>` : ''}</th>` : html`<th>${l}</th>`))}
        </tr></thead><tbody>
        ${r.data.map((c) => html`<tr class="row-link" data-id="${c.id}">
          ${canWrite ? html`<td class="ps-3"><input type="checkbox" class="form-check-input" data-sel="${c.id}" ${selected.has(c.id) ? raw('checked') : ''} aria-label="Select ${c.email}"></td>` : ''}
          <td><a class="cell-email text-decoration-none" href="#/contacts/${c.id}">${c.email}</a><div class="small text-muted-2">${c.name}${c.attribs?.company ? ` · ${c.attribs.company}` : ''}</div></td>
          <td>${statusBadge(c.status)}</td>
          <td class="small">${(c.list_ids || []).slice(0, 2).map((id) => listName.get(id) || `#${id}`).join(', ')}${(c.list_ids || []).length > 2 ? ` +${c.list_ids.length - 2}` : ''}</td>
          <td class="small">${c.attribs?.source || '–'}</td>
          <td class="small">${c.hard_bounces + c.soft_bounces + c.complaints > 0
            ? html`${c.hard_bounces ? html`<span class="text-danger">${c.hard_bounces} hard</span> ` : ''}${c.soft_bounces ? `${c.soft_bounces} soft ` : ''}${c.complaints ? html`<span class="text-danger">${c.complaints} complaint</span>` : ''}<div class="text-muted-2">${ago(c.last_bounce_at)}</div>`
            : '–'}</td>
          <td class="small text-nowrap">${date(c.created_at)}</td>
        </tr>`)}
        </tbody></table></div>
        ${pager(r.meta, (p) => { state.page = p; load(); })}
        <div class="d-flex align-items-center gap-2 px-3 pb-3 small"><label for="per-page" class="text-muted-2">Rows per page</label>
          <select id="per-page" class="form-select form-select-sm w-auto">${options([25, 50, 100, 200].map((n) => ({ value: n, label: String(n) })), state.per_page)}</select>
          ${canWrite && r.meta.total > r.data.length ? html`<button class="btn btn-sm btn-link ms-auto" id="select-matching">Select all ${num(Math.min(r.meta.total, 5000))} matching contacts</button>` : ''}</div>`);
      lastTotal = r.meta.total;
    } catch (err) {
      errorToast(err);
      mount(t, html`<div class="p-3 text-danger">${err.message}</div>`);
    }
  }

  function renderBulk() {
    const b = $('#bulk', el);
    b.classList.toggle('d-none', selected.size === 0);
    mount(b, html`<strong>${num(selected.size)} selected</strong>
      <button class="btn btn-sm btn-light" data-bulk="add_to_lists"><i class="bi bi-plus-circle me-1"></i>Add to list</button>
      <button class="btn btn-sm btn-light" data-bulk="remove_from_lists"><i class="bi bi-dash-circle me-1"></i>Remove from list</button>
      <button class="btn btn-sm btn-light" data-bulk="unsubscribe"><i class="bi bi-envelope-x me-1"></i>Unsubscribe</button>
      <button class="btn btn-sm btn-light" data-bulk="suppress"><i class="bi bi-slash-circle me-1"></i>Suppress</button>
      <button class="btn btn-sm btn-link ms-auto" data-bulk="clear">Clear selection</button>`);
  }

  async function bulk(action) {
    const ids = [...selected];
    if (action === 'clear') { selected.clear(); renderBulk(); load(); return; }
    if (action === 'add_to_lists' || action === 'remove_from_lists') {
      formModal({
        title: action === 'add_to_lists' ? `Add ${ids.length} contact(s) to lists` : `Remove ${ids.length} contact(s) from lists`,
        body: html`<label class="form-label">Lists</label>
          <select class="form-select" name="lists" multiple size="6" required>${options(facets.lists.map((l) => ({ value: l.id, label: `${l.name}${l.optin === 'double' ? ' (double opt-in)' : ''}` })), [])}</select>
          <div class="form-text">Hold Ctrl / Cmd to select several.</div>
          ${action === 'add_to_lists' ? html`<div class="alert alert-info small mt-3 mb-0"><i class="bi bi-shield-check me-1"></i>
            Suppressed contacts are skipped, and anyone who previously unsubscribed from a list is never re-added to it.</div>`
            : html`<div class="form-text mt-2">Unsubscribe records are kept so people are never accidentally re-added.</div>`}`,
        submitLabel: action === 'add_to_lists' ? 'Add to lists' : 'Remove',
        onSubmit: async (fd) => {
          const listIds = fd.getAll('lists').map(Number);
          if (!listIds.length) throw { message: 'Choose at least one list' };
          const r = await post('/contacts/actions', { action, ids, listIds });
          toast(`Done: ${num(r.data.changed)} change(s)${r.data.skipped ? `, ${num(r.data.skipped)} skipped (suppressed, unsubscribed or already in place)` : ''}`);
          selected.clear(); renderBulk(); load();
        },
      });
      return;
    }
    formModal({
      title: action === 'unsubscribe' ? `Unsubscribe ${ids.length} contact(s)` : `Suppress ${ids.length} contact(s)`,
      body: html`<p>${action === 'unsubscribe'
        ? 'Records an opt-out (for example a phone or email request). They will be removed from all lists and never emailed again unless an administrator records new consent.'
        : 'Adds the addresses to the permanent suppression list. They will not receive campaigns and cannot be re-imported.'}</p>
        <label class="form-label">Note (recommended)</label>
        <textarea class="form-control" name="note" rows="2" maxlength="1000" placeholder="e.g. Requested by phone on 12 Nov"></textarea>`,
      submitLabel: action === 'unsubscribe' ? 'Unsubscribe' : 'Suppress', danger: true,
      onSubmit: async (fd) => {
        await post('/contacts/actions', { action, ids, note: fd.get('note') });
        toast(`${num(ids.length)} contact(s) ${action === 'unsubscribe' ? 'unsubscribed' : 'suppressed'}`);
        selected.clear(); renderBulk(); load();
      },
    });
  }

  // ---- Events ---------------------------------------------------------------
  const form = $('#filters', el);
  let timer;
  form.addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const k of ['q', 'status', 'list_id', 'source', 'consent_method']) state[k] = form[k].value;
      state.page = 1;
      load();
    }, e.target.name === 'q' ? 300 : 0);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('#reset', el).addEventListener('click', () => {
    form.reset();
    for (const k of ['q', 'status', 'list_id', 'source', 'consent_method']) { state[k] = ''; form[k].value = ''; }
    state.page = 1; load();
  });
  $('#export', el)?.addEventListener('click', () => {
    const { page, per_page, sort, dir, ...f } = state; // eslint-disable-line no-unused-vars
    download(`/exports/contacts.csv${qs(f)}`);
    toast('Your export is downloading');
  });
  $('#add', el)?.addEventListener('click', () => addContact(ctx, facets));

  $('#table', el).addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (th) {
      state.dir = state.sort === th.dataset.sort && state.dir === 'desc' ? 'asc' : 'desc';
      state.sort = th.dataset.sort; state.page = 1; load(); return;
    }
    if (e.target.id === 'all') {
      $$('[data-sel]', el).forEach((c) => { c.checked = e.target.checked; selected[c.checked ? 'add' : 'delete'](Number(c.dataset.sel)); });
      renderBulk(); return;
    }
    const cb = e.target.closest('[data-sel]');
    if (cb) { selected[cb.checked ? 'add' : 'delete'](Number(cb.dataset.sel)); renderBulk(); return; }
    if (e.target.id === 'select-matching') {
      const { page, per_page, sort, dir, ...f } = state; // eslint-disable-line no-unused-vars
      get(`/contacts/ids${qs(f)}`).then((x) => {
        x.data.ids.forEach((id) => selected.add(id));
        renderBulk(); load();
        if (x.data.truncated) toast(`Selected the first ${num(x.data.ids.length)} of ${num(lastTotal)}. Narrow the filter to act on the rest.`, 'warning');
      }).catch(errorToast);
      return;
    }
    if (e.target.closest('td:first-child input') || e.target.closest('a')) return;
    const row = e.target.closest('tr[data-id]');
    if (row) location.hash = `#/contacts/${row.dataset.id}`;
  });
  $('#table', el).addEventListener('change', (e) => {
    if (e.target.id === 'per-page') { state.per_page = Number(e.target.value); state.page = 1; load(); }
  });
  $('#table', el).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-sort]')) e.target.click();
  });
  $('#bulk', el).addEventListener('click', (e) => { const b = e.target.closest('[data-bulk]'); if (b) bulk(b.dataset.bulk); });

  await load();
  return () => clearTimeout(timer);
}

export function addContact(ctx, facets) {
  formModal({
    title: 'Add a contact', size: 'modal-lg', submitLabel: 'Add contact',
    body: html`<div class="row g-2">
      <div class="col-12"><label class="form-label">Email <span class="text-danger">*</span></label><input class="form-control" type="email" name="email" required maxlength="254"></div>
      <div class="col-md-6"><label class="form-label">First name</label><input class="form-control" name="firstName" maxlength="100"></div>
      <div class="col-md-6"><label class="form-label">Surname</label><input class="form-control" name="lastName" maxlength="100"></div>
      <div class="col-md-6"><label class="form-label">Company</label><input class="form-control" name="company" maxlength="200"></div>
      <div class="col-md-6"><label class="form-label">Source</label><input class="form-control" name="source" maxlength="100" value="manual" list="sources">
        <datalist id="sources">${facets.sources.map((s) => html`<option value="${s.v}">`)}</datalist></div>
      <div class="col-12"><label class="form-label">Lists</label>
        <select class="form-select" name="lists" multiple size="4">${options(facets.lists.map((l) => ({ value: l.id, label: `${l.name}${l.optin === 'double' ? ' (double opt-in)' : ''}` })), [])}</select></div>
      <div class="col-12"><div class="form-check"><input class="form-check-input" type="checkbox" name="preconfirm" id="preconfirm">
        <label class="form-check-label" for="preconfirm">Mark subscriptions as confirmed (skip the double opt-in email)</label></div></div>
    </div>
    <hr><h3 class="h6 fw-semibold">Consent <span class="text-muted-2 fw-normal small">— required by POPIA: having an address is not consent</span></h3>
    ${consentFields()}`,
    onSubmit: async (fd) => {
      const r = await post('/contacts', {
        email: fd.get('email'), firstName: fd.get('firstName'), lastName: fd.get('lastName'), company: fd.get('company'),
        source: fd.get('source') || 'manual', listIds: fd.getAll('lists').map(Number), preconfirm: fd.get('preconfirm') === 'on',
        consent: consentFromForm(fd),
      });
      toast('Contact added');
      location.hash = `#/contacts/${r.data.id}`;
    },
  });
}

export { label };
