import { api } from '../api.js';
import { html, mount, $, $$ } from '../ui.js';

/** First-run setup: creates the first administrator and the basic settings. */
export async function renderSetup(root, onDone) {
  document.title = 'Set up · MailHarbor';
  const status = await api('GET', '/setup/status');
  mount(root, html`<div class="login-wrap">
    <div class="login-side">
      <img src="/img/logo-mark.svg" alt="" width="52" height="52">
      <div><h2>Welcome to MailHarbor</h2>
        <p class="mt-3 opacity-75">Two minutes of setup and you're ready to import contacts and send your first campaign.</p>
        <ol class="mt-4"><li class="mb-2">Find the <strong>setup code</strong> in the server log<br><small class="opacity-75">Railway → your service → Deployments → View logs</small></li>
          <li class="mb-2">Create your administrator account</li><li>Confirm your organisation and sender details</li></ol></div>
      <small class="opacity-75">This screen disappears once setup is complete.</small>
    </div>
    <div class="login-form">
      <form id="setup" novalidate class="py-4">
        <img src="/img/logo.svg" alt="MailHarbor" class="mb-4" width="220" height="44">
        <h1 class="h4 fw-bold mb-3">Set up MailHarbor</h1>
        <div class="mb-3"><label class="form-label" for="code">Setup code (from the server log)</label>
          <input class="form-control text-uppercase mono" id="code" name="code" autocomplete="off" required></div>
        <h2 class="h6 fw-semibold mt-4">Your administrator account</h2>
        <div class="mb-2"><label class="form-label" for="name">Your name</label><input class="form-control" id="name" name="name" required autocomplete="name"></div>
        <div class="mb-2"><label class="form-label" for="email">Email</label><input class="form-control" id="email" name="email" type="email" required autocomplete="username"></div>
        <div class="mb-2"><label class="form-label" for="password">Password</label><input class="form-control" id="password" name="password" type="password" required minlength="12" autocomplete="new-password">
          <div class="form-text">At least 12 characters, with letters and a number.</div></div>
        <h2 class="h6 fw-semibold mt-4">Organisation</h2>
        <div class="mb-2"><label class="form-label" for="org_name">Organisation name</label><input class="form-control" id="org_name" name="org_name" required></div>
        <div class="mb-2"><label class="form-label" for="from_email">Send emails from</label><input class="form-control" id="from_email" name="from_email" type="email" required placeholder="news@yourdomain.co.za">
          <div class="form-text">Must be an address your SMTP account is allowed to send as.</div></div>
        <div class="mb-3"><label class="form-label" for="public_url">Public web address</label><input class="form-control" id="public_url" name="public_url" type="url" required value="${status.data.suggestedUrl}">
          <div class="form-text">Used for unsubscribe and tracking links. Normally the address in your browser bar.</div></div>
        <div class="alert alert-danger d-none" id="err" role="alert"></div>
        <button class="btn btn-primary btn-lg w-100" type="submit">Complete setup</button>
      </form>
    </div>
  </div>`);
  const form = $('#setup');
  $('#code').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#err');
    err.classList.add('d-none');
    $$('.is-invalid', form).forEach((n) => n.classList.remove('is-invalid'));
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      const r = await api('POST', '/setup', body);
      await onDone(r.data);
    } catch (ex) {
      (ex.details || []).forEach((d) => form.querySelector(`[name="${d.field}"]`)?.classList.add('is-invalid'));
      err.textContent = [ex.message, ...(ex.details || []).filter((d) => d.message).map((d) => `${d.field}: ${d.message}`)].join(' — ');
      err.classList.remove('d-none');
    } finally {
      btn.disabled = false;
    }
  });
}
