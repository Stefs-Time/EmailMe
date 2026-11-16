import { post } from '../api.js';
import { html, mount, $, toast } from '../ui.js';

export async function render(el, ctx) {
  const u = ctx.user;
  mount(el, html`<div class="page-head"><div><h1>My account</h1></div></div>
    <div class="row g-3"><div class="col-lg-5"><div class="card"><div class="card-header">Profile</div><div class="card-body">
      <dl class="dl-grid"><dt>Name</dt><dd>${u.name}</dd><dt>Email</dt><dd>${u.email}</dd><dt>Role</dt><dd class="text-capitalize">${u.role}</dd></dl></div></div></div>
    <div class="col-lg-7"><div class="card"><div class="card-header">Change password</div><div class="card-body">
      <form id="pw" novalidate>
        <div class="mb-2"><label class="form-label" for="cur">Current password</label><input class="form-control" id="cur" type="password" name="currentPassword" autocomplete="current-password" required></div>
        <div class="mb-2"><label class="form-label" for="np">New password</label><input class="form-control" id="np" type="password" name="newPassword" autocomplete="new-password" minlength="12" required>
          <div class="form-text">At least 12 characters, with letters and at least one number. A passphrase is best.</div></div>
        <div class="alert alert-danger d-none" id="err"></div>
        <button class="btn btn-primary" type="submit">Update password</button></form></div></div></div></div>`);
  $('#pw', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err', el);
    err.classList.add('d-none');
    try {
      await post('/auth/change-password', { currentPassword: e.target.currentPassword.value, newPassword: e.target.newPassword.value });
      e.target.reset();
      toast('Password updated');
    } catch (ex) {
      err.textContent = [ex.message, ...(ex.details || []).map((d) => d.message)].join(' — ');
      err.classList.remove('d-none');
    }
  });
}
