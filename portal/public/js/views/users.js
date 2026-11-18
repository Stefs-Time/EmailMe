import { get, post, patch } from '../api.js';
import { html, raw, mount, $, datetime, loading, toast, formModal, options } from '../ui.js';

const ROLES = [
  { value: 'viewer', label: 'Viewer – dashboards, contacts and reports (read-only)' },
  { value: 'manager', label: 'Manager – plus edit contacts, lists, imports and exports' },
  { value: 'admin', label: 'Administrator – plus users, reactivation, erasure, audit' },
];

export async function render(el, ctx) {
  mount(el, html`<div class="page-head"><div><h1>Users</h1><p>People who can sign in to MailHarbor.</p></div>
    <button class="btn btn-primary" id="new"><i class="bi bi-person-plus me-1"></i>Add user</button></div><div class="card" id="t">${loading()}</div>`);
  let users = [];
  async function load() {
    users = (await get('/users')).data;
    mount($('#t', el), html`<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><div class="fw-semibold">${u.name}${u.id === ctx.user.id ? html` <span class="badge text-bg-light">you</span>` : ''}${u.managed_by_env ? html` <span class="badge badge-managed" title="Support and recovery account managed by MailHarbor">Managed by MailHarbor</span>` : ''}</div><div class="small text-muted-2">${u.email}</div></td>
        <td class="text-capitalize">${u.role}</td><td>${u.status === 'active' ? html`<span class="status s-active">Active</span>` : html`<span class="status s-inactive">Disabled</span>`}</td>
        <td class="small">${datetime(u.last_login_at)}</td><td class="text-end"><button class="btn btn-sm btn-light" data-edit="${u.id}">Edit</button></td></tr>`)}</tbody></table></div>`);
  }
  const pwHelp = html`<div class="form-text">At least 12 characters including letters and a number. Share it securely; ask them to change it after signing in.</div>`;
  $('#new', el).addEventListener('click', () => formModal({ title: 'Add user', submitLabel: 'Create user', body: html`
    <div class="mb-2"><label class="form-label" for="n-name">Name</label><input class="form-control" id="n-name" name="name" required maxlength="120"></div>
    <div class="mb-2"><label class="form-label" for="n-email">Email</label><input class="form-control" id="n-email" type="email" name="email" required></div>
    <div class="mb-2"><label class="form-label" for="n-role">Role</label><select class="form-select" id="n-role" name="role">${options(ROLES, 'manager')}</select></div>
    <div><label class="form-label" for="n-pw">Temporary password</label><input class="form-control" id="n-pw" type="password" name="password" required minlength="12" autocomplete="new-password">${pwHelp}</div>`,
  onSubmit: async (fd) => { await post('/users', Object.fromEntries(fd)); toast('User created'); load(); } }));
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (!b) return;
    const u = users.find((x) => x.id === b.dataset.edit);
    const locked = u.managed_by_env ? raw('disabled') : '';
    formModal({ title: `Edit ${u.name}`, body: html`
      ${u.managed_by_env ? html`<div class="alert alert-info small"><i class="bi bi-lock me-1"></i>This is the support and recovery account managed by MailHarbor.
        Its role, status and password can't be changed here. Contact MailHarbor support with any questions.</div>` : ''}
      <div class="mb-2"><label class="form-label" for="u-name">Name</label><input class="form-control" id="u-name" name="name" value="${u.name}" required maxlength="120"></div>
      <div class="mb-2"><label class="form-label" for="u-role">Role</label><select class="form-select" id="u-role" name="role" ${locked}>${options(ROLES, u.role)}</select></div>
      <div class="mb-2"><label class="form-label" for="u-status">Status</label><select class="form-select" id="u-status" name="status" ${locked}>
        <option value="active" ${u.status === 'active' ? raw('selected') : ''}>Active</option><option value="disabled" ${u.status === 'disabled' ? raw('selected') : ''}>Disabled (cannot sign in)</option></select></div>
      ${u.managed_by_env ? '' : html`<div><label class="form-label" for="u-pw">Reset password (optional)</label><input class="form-control" id="u-pw" type="password" name="password" minlength="12" autocomplete="new-password">${pwHelp}</div>`}`,
    onSubmit: async (fd) => {
      const body = u.managed_by_env ? { name: fd.get('name') } : { name: fd.get('name'), role: fd.get('role'), status: fd.get('status') };
      if (fd.get('password')) body.password = fd.get('password');
      await patch(`/users/${u.id}`, body); toast('User updated'); load();
    } });
  });
  await load();
}
