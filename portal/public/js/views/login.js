import { api } from '../api.js';
import { html, mount, $ } from '../ui.js';

export function renderLogin(root, session, onLoggedIn) {
  document.title = 'Sign in · MailHarbor';
  mount(root, html`<div class="login-wrap">
    <div class="login-side">
      <img src="/img/logo-mark.svg" alt="" width="52" height="52">
      <div>
        <h2>Your contacts, safely in harbour.</h2>
        <ul class="list-unstyled mt-4">
          <li><i class="bi bi-check2-circle me-2"></i>Import, clean and sort your contact database</li>
          <li><i class="bi bi-check2-circle me-2"></i>Bounces and unsubscribes handled automatically</li>
          <li><i class="bi bi-check2-circle me-2"></i>Suppression that survives every re-import</li>
          <li><i class="bi bi-check2-circle me-2"></i>Campaign reports and POPIA-ready exports</li>
        </ul>
      </div>
      <small class="opacity-75">${session.orgName} · powered by listmonk</small>
    </div>
    <div class="login-form">
      <form id="login-form" novalidate>
        <img src="/img/logo.svg" alt="MailHarbor" class="mb-4" width="220" height="44">
        <h1 class="h4 fw-bold mb-1">Sign in</h1>
        <p class="text-muted-2 mb-4">Use the account your administrator created for you.</p>
        <div class="mb-3"><label class="form-label" for="email">Email</label>
          <input class="form-control form-control-lg" id="email" name="email" type="email" autocomplete="username" required></div>
        <div class="mb-3"><label class="form-label" for="password">Password</label>
          <input class="form-control form-control-lg" id="password" name="password" type="password" autocomplete="current-password" required></div>
        <div class="alert alert-danger d-none" id="login-error" role="alert"></div>
        <button class="btn btn-primary btn-lg w-100" type="submit">Sign in</button>
        <p class="small text-muted-2 mt-4 mb-0">Forgotten your password? Ask a MailHarbor administrator to reset it.</p>
      </form>
    </div>
  </div>`);
  const form = $('#login-form');
  $('#email').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const err = $('#login-error');
    err.classList.add('d-none');
    btn.disabled = true;
    try {
      const r = await api('POST', '/auth/login', { email: form.email.value, password: form.password.value });
      await onLoggedIn(r.data);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('d-none');
      form.password.value = '';
      form.password.focus();
    } finally {
      btn.disabled = false;
    }
  });
}
