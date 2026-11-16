import { get, post, put, del } from '../api.js';
import { html, mount, $, num, date, loading, empty, toast, errorToast, formModal, confirmModal, raw } from '../ui.js';

export async function render(el, ctx) {
  const canWrite = ctx.can('lists:write');
  mount(el, html`<div class="page-head"><div><h1>Lists</h1><p>Group contacts by audience or interest. "Will receive" excludes unsubscribed, suppressed and unconfirmed double opt-in members.</p></div>
    ${canWrite ? html`<button class="btn btn-primary" id="new"><i class="bi bi-plus-lg me-1"></i>New list</button>` : ''}</div>
    <div class="card" id="t">${loading()}</div>`);

  let lists = [];
  async function load() {
    lists = (await get('/lists')).data;
    if (!lists.length) { mount($('#t', el), empty('card-list', 'No lists yet', 'Create a list, then import contacts into it.')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle">
      <thead><tr><th>List</th><th>Opt-in</th><th class="num">Members</th><th class="num">Confirmed</th><th class="num">Unconfirmed</th><th class="num">Unsubscribed</th><th class="num">Will receive</th><th>Created</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
      ${lists.map((l) => html`<tr>
        <td><a class="fw-semibold" href="#/contacts?list_id=${l.id}">${l.name}</a>
          <div class="small text-muted-2">${l.type === 'public' ? 'Public (shown on subscription forms)' : 'Private'}${l.description ? ` · ${l.description}` : ''}</div></td>
        <td>${l.optin === 'double' ? html`<span class="badge text-bg-info">Double</span>` : html`<span class="badge text-bg-light">Single</span>`}</td>
        <td class="num">${num(l.total)}</td><td class="num">${num(l.confirmed)}</td><td class="num">${num(l.unconfirmed)}</td>
        <td class="num">${num(l.unsubscribed)}</td><td class="num fw-semibold">${num(l.eligible)}</td><td class="small">${date(l.created_at)}</td>
        <td class="text-end text-nowrap">${canWrite ? html`<button class="btn btn-sm btn-light" data-edit="${l.id}" aria-label="Edit ${l.name}"><i class="bi bi-pencil"></i></button>` : ''}
          ${ctx.can('lists:delete') ? html`<button class="btn btn-sm btn-light text-danger" data-del="${l.id}" aria-label="Delete ${l.name}"><i class="bi bi-trash3"></i></button>` : ''}</td></tr>`)}
      </tbody></table></div>`);
  }

  function edit(l = {}) {
    formModal({
      title: l.id ? 'Edit list' : 'New list', submitLabel: l.id ? 'Save' : 'Create list',
      body: html`<div class="mb-3"><label class="form-label">Name <span class="text-danger">*</span></label><input class="form-control" name="name" required maxlength="200" value="${l.name || ''}"></div>
        <div class="mb-3"><label class="form-label">Description</label><input class="form-control" name="description" maxlength="2000" value="${l.description || ''}"></div>
        <div class="row g-2"><div class="col-6"><label class="form-label">Opt-in</label><select class="form-select" name="optin">
          <option value="single" ${l.optin !== 'double' ? raw('selected') : ''}>Single opt-in</option>
          <option value="double" ${l.optin === 'double' ? raw('selected') : ''}>Double opt-in (confirmation email)</option></select></div>
        <div class="col-6"><label class="form-label">Visibility</label><select class="form-select" name="type">
          <option value="private" ${l.type !== 'public' ? raw('selected') : ''}>Private</option>
          <option value="public" ${l.type === 'public' ? raw('selected') : ''}>Public (sign-up forms)</option></select></div></div>`,
      onSubmit: async (fd) => {
        const body = { name: fd.get('name'), description: fd.get('description'), optin: fd.get('optin'), type: fd.get('type'), tags: l.tags || [] };
        if (l.id) await put(`/lists/${l.id}`, body); else await post('/lists', body);
        toast(l.id ? 'List updated' : 'List created');
        load();
      },
    });
  }

  $('#new', el)?.addEventListener('click', () => edit());
  el.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return edit(lists.find((l) => l.id === Number(ed.dataset.edit)));
    const d = e.target.closest('[data-del]');
    if (d) {
      const l = lists.find((x) => x.id === Number(d.dataset.del));
      const ok = await confirmModal({ title: `Delete "${l.name}"?`, danger: true, confirmLabel: 'Delete list',
        message: `The list and its ${num(l.total)} memberships are removed. Contacts themselves are kept, and suppressions still apply.` });
      if (!ok) return;
      try { await del(`/lists/${l.id}`); toast('List deleted'); load(); } catch (err) { errorToast(err); }
    }
  });
  await load();
}
