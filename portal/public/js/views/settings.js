import { get, put, post } from '../api.js';
import { html, raw, mount, $, $$, loading, toast, errorToast, num, ago } from '../ui.js';
import { pickImage } from '../images.js';

const TABS = [['general', 'General'], ['design', 'Email design'], ['sending', 'Sending'], ['bounces', 'Bounces'], ['compliance', 'Compliance & backups']];
const FONTS = [['arial', 'Arial'], ['helvetica', 'Helvetica'], ['verdana', 'Verdana'], ['trebuchet', 'Trebuchet MS'], ['georgia', 'Georgia (serif)']];
const DESIGN_KEYS = ['email_logo_url', 'email_logo_width', 'email_header_align', 'email_brand_color', 'email_heading_color', 'email_background', 'email_font', 'email_footer_text', 'email_show_preferences'];

export async function render(el, ctx, [tabArg]) {
  const tab = TABS.some(([k]) => k === tabArg) ? tabArg : 'general';
  mount(el, loading());
  const { data: s } = await get('/settings');
  const m = s.bounce_mailbox;
  const check = (v) => (v ? raw('checked') : '');
  const webhookUrl = `${s.effective_public_url || location.origin}/webhooks/bounce?token=${s.webhook_token}`;

  const sections = {
    general: html`<div class="card"><div class="card-body"><div class="row g-3">
      <div class="col-md-6"><label class="form-label">Organisation name</label><input class="form-control" name="org_name" value="${s.org_name}" maxlength="120" required>
        <div class="form-text">Shown in the app and in every email footer.</div></div>
      <div class="col-md-6"><label class="form-label">Postal address <span class="text-danger">*</span></label><input class="form-control" name="org_address" value="${s.org_address}" maxlength="300" placeholder="12 Main Road, Rosebank, Johannesburg, 2196">
        <div class="form-text">Required before sending: every marketing email must identify the sender.</div></div>
      <div class="col-12"><label class="form-label">Public web address</label>
        <input class="form-control" name="public_url" type="url" value="${s.public_url}" placeholder="${s.effective_public_url || 'https://mail.example.co.za'}" ${s.public_url_locked ? raw('disabled') : ''}>
        <div class="form-text">${s.public_url_locked ? html`Set by MailHarbor for your service: <strong>${s.effective_public_url}</strong>. Contact support to change it.` : s.public_url || !s.effective_public_url ? 'Used in unsubscribe, tracking and "view in browser" links. Must be https:// in production.' : html`Leave empty to use the hosting platform's address (<strong>${s.effective_public_url}</strong>), or enter your custom domain.`}</div></div>
    </div></div></div>`,
    design: html`<div class="row g-3">
      <div class="col-xl-5"><div class="card"><div class="card-body"><div class="row g-3">
        <div class="col-12"><p class="small text-muted-2 mb-0">Every email uses this design: your logo or name at the top, the campaign in a white card, and a footer with your
          address and the unsubscribe and preferences links. Campaigns only contain their content. Sent campaigns keep the design they were sent with.</p></div>
        <div class="col-12"><label class="form-label" for="d-logo">Logo <span class="text-muted-2 small">(optional; without one, your organisation name is shown)</span></label>
          <div class="input-group"><input class="form-control" id="d-logo" name="email_logo_url" type="url" value="${s.email_logo_url}" placeholder="https://…">
            <button class="btn btn-outline-secondary" type="button" id="d-pick"><i class="bi bi-images me-1"></i>Images</button></div></div>
        <div class="col-6"><label class="form-label" for="d-lw">Logo width (px)</label><input class="form-control" id="d-lw" name="email_logo_width" type="number" min="40" max="300" value="${s.email_logo_width}"></div>
        <div class="col-6"><label class="form-label" for="d-al">Header position</label><select class="form-select" id="d-al" name="email_header_align">
          ${[['left', 'Left'], ['center', 'Centred']].map(([k, l]) => html`<option value="${k}" ${s.email_header_align === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
        <div class="col-4"><label class="form-label" for="d-brand">Brand colour</label><input class="form-control form-control-color w-100" id="d-brand" name="email_brand_color" type="color" value="${s.email_brand_color}">
          <div class="form-text">Buttons and links</div></div>
        <div class="col-4"><label class="form-label" for="d-head">Headings</label><input class="form-control form-control-color w-100" id="d-head" name="email_heading_color" type="color" value="${s.email_heading_color}"></div>
        <div class="col-4"><label class="form-label" for="d-bg">Background</label><input class="form-control form-control-color w-100" id="d-bg" name="email_background" type="color" value="${s.email_background}"></div>
        <div class="col-12"><label class="form-label" for="d-font">Font</label><select class="form-select" id="d-font" name="email_font">
          ${FONTS.map(([k, l]) => html`<option value="${k}" ${s.email_font === k ? raw('selected') : ''}>${l}</option>`)}</select>
          <div class="form-text">Email-safe fonts that every device has.</div></div>
        <div class="col-12"><label class="form-label" for="d-foot">Footer line</label><input class="form-control" id="d-foot" name="email_footer_text" maxlength="300" value="${s.email_footer_text}">
          <div class="form-text">Shown under your organisation name and postal address. You can use {{ org_name }}.</div></div>
        <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="d-prefs" name="email_show_preferences" ${check(s.email_show_preferences)}><label class="form-check-label" for="d-prefs">Show a "Manage preferences" link in the footer</label></div>
          <div class="form-text">The unsubscribe and "View in browser" links are always included.</div></div>
      </div></div></div></div>
      <div class="col-xl-7"><div class="card"><div class="card-header">Preview <span class="small text-muted-2">· updates as you change the design (not saved until you press Save)</span></div>
        <div class="card-body p-2"><iframe id="d-preview" class="design-preview" title="Email design preview" sandbox="allow-popups"></iframe></div></div></div>
    </div>`,
    sending: html`<div class="card mb-3"><div class="card-header">Sender</div><div class="card-body"><div class="row g-3">
      <div class="col-md-6"><label class="form-label">From name</label><input class="form-control" name="from_name" value="${s.from_name}" maxlength="120"></div>
      <div class="col-md-6"><label class="form-label">From address</label><input class="form-control" name="from_email" type="email" value="${s.from_email}">
        <div class="form-text">Your SMTP account must be allowed to send as this address, and its domain needs SPF, DKIM and DMARC.</div></div>
      <div class="col-md-6"><label class="form-label">Reply-to (optional)</label><input class="form-control" name="reply_to" type="email" value="${s.reply_to}"></div>
    </div></div></div>
    <div class="card mb-3"><div class="card-header">Speed &amp; tracking</div><div class="card-body"><div class="row g-3">
      <div class="col-md-4"><label class="form-label">Emails per second</label><input class="form-control" name="send_rate_per_second" type="number" min="0.1" max="100" step="0.1" value="${s.send_rate_per_second}">
        <div class="form-text">Start at 2–5 on a new domain; check your provider's limits.</div></div>
      <div class="col-md-4"><label class="form-label">Maximum per hour (0 = no limit)</label><input class="form-control" name="send_max_per_hour" type="number" min="0" value="${s.send_max_per_hour}"></div>
      <div class="col-md-4 d-flex flex-column justify-content-end gap-2">
        <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="t1" name="track_opens" ${check(s.track_opens)}><label class="form-check-label" for="t1">Track opens by default</label></div>
        <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="t2" name="track_clicks" ${check(s.track_clicks)}><label class="form-check-label" for="t2">Track clicks by default</label></div></div>
    </div></div></div>
    <div class="card mb-3"><div class="card-header">Google Analytics (UTM) tags</div><div class="card-body"><div class="row g-3">
      <div class="col-12"><div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="utm" name="utm_enabled" ${check(s.utm_enabled)}><label class="form-check-label" for="utm">Add UTM tags to links in campaigns</label></div>
        <div class="form-text">Visits from your emails then show up in Google Analytics as <span class="mono">source / medium</span> with the campaign's name. Each campaign can switch this off or use its own name.</div></div>
      <div class="col-md-4"><label class="form-label">utm_source</label><input class="form-control" name="utm_source" maxlength="60" value="${s.utm_source}"></div>
      <div class="col-md-4"><label class="form-label">utm_medium</label><input class="form-control" name="utm_medium" maxlength="60" value="${s.utm_medium}"></div>
      <div class="col-md-4"><label class="form-label">Only for these websites <span class="text-muted-2 small">(optional)</span></label><input class="form-control" name="utm_domains" maxlength="500" value="${s.utm_domains}" placeholder="acme.co.za, shop.acme.co.za">
        <div class="form-text">Leave empty to tag every web link.</div></div>
    </div></div></div>
    <div class="card"><div class="card-header">Your mail server (SMTP) <span class="small fw-normal text-muted-2">· connected by MailHarbor</span></div><div class="card-body">
      <dl class="dl-grid mb-3"><dt>Server</dt><dd class="mono">${s.smtp.host}:${s.smtp.port}</dd><dt>Security</dt><dd>${s.smtp.security}</dd>
        <dt>Login</dt><dd>${s.smtp.authenticated ? s.smtp.user : 'none (relay)'}</dd><dt>Connections</dt><dd>${s.smtp.poolSize}</dd></dl>
      <div class="input-group mw-520"><input class="form-control" id="smtp-to" type="email" placeholder="Send a test email to…" value="${ctx.user.email}" aria-label="Test email address">
        <button class="btn btn-outline-primary" type="button" id="smtp-test">Send test email</button></div>
      <div id="smtp-result" class="mt-2 small"></div>
      <div class="form-text">MailHarbor sends through your own mail server. To connect a different server, or if its password changed, send the new details to MailHarbor support. Passwords are never shown or stored in Settings.</div>
    </div></div>`,
    bounces: html`<div class="card mb-3"><div class="card-header">Where bounces go</div><div class="card-body"><div class="row g-3">
      <div class="col-md-6"><label class="form-label">Bounce address (Return-Path)</label><input class="form-control" name="bounce_address" type="email" value="${s.bounce_address}" placeholder="bounces@yourdomain.co.za">
        <div class="form-text">Delivery failures are returned here. Use a dedicated mailbox and connect it below. Leave empty to use the From address.</div></div>
      <div class="col-md-6"><label class="form-label">Soft-bounce limit</label><input class="form-control" name="soft_bounce_limit" type="number" min="1" max="20" value="${s.soft_bounce_limit}">
        <div class="form-text">After this many temporary failures (with no click in between) the address is suppressed.</div></div>
    </div></div></div>
    <div class="card mb-3"><div class="card-header d-flex align-items-center">Bounce mailbox (IMAP)
      ${m.enabled ? html`<button type="button" class="btn btn-sm btn-light ms-auto" id="mb-poll"><i class="bi bi-arrow-repeat me-1"></i>Check now</button>` : ''}</div><div class="card-body">
      <div class="form-check form-switch mb-3"><input class="form-check-input" type="checkbox" role="switch" id="mb-on" name="mb_enabled" ${check(m.enabled)}><label class="form-check-label" for="mb-on">Read bounce notifications from this mailbox</label></div>
      <div class="row g-3">
        <div class="col-md-6"><label class="form-label">IMAP server</label><input class="form-control" name="mb_host" value="${m.host}" placeholder="imap.yourprovider.com"></div>
        <div class="col-md-3"><label class="form-label">Port</label><input class="form-control" name="mb_port" type="number" value="${m.port}"></div>
        <div class="col-md-3 d-flex align-items-end"><div class="form-check"><input class="form-check-input" type="checkbox" id="mb-tls" name="mb_secure" ${check(m.secure)}><label class="form-check-label" for="mb-tls">TLS (port 993)</label></div></div>
        <div class="col-md-6"><label class="form-label">Username</label><input class="form-control" name="mb_user" value="${m.user}" autocomplete="off"></div>
        <div class="col-md-6"><label class="form-label">Password</label><input class="form-control" name="mb_password" type="password" autocomplete="new-password" placeholder="${m.password_set ? '•••••••• (saved, leave empty to keep)' : ''}">
          <div class="form-text">Stored encrypted.</div></div>
        <div class="col-md-4"><label class="form-label">Folder</label><input class="form-control" name="mb_folder" value="${m.folder}"></div>
        <div class="col-md-4"><label class="form-label">Check every (minutes)</label><input class="form-control" name="mb_interval" type="number" min="1" max="1440" value="${m.interval_minutes}"></div>
        <div class="col-md-4"><label class="form-label">After processing</label><select class="form-select" name="mb_after">
          <option value="move" ${m.after === 'move' ? raw('selected') : ''}>Move to "MailHarbor-Processed"</option><option value="delete" ${m.after === 'delete' ? raw('selected') : ''}>Delete</option></select></div>
      </div>
      <button type="button" class="btn btn-outline-primary mt-3" id="mb-test">Test connection</button><span id="mb-result" class="ms-2 small"></span>
      <div class="alert alert-warning small mt-3 mb-0"><i class="bi bi-exclamation-triangle me-1"></i>Every message in this folder is processed. Never connect a personal or shared inbox.</div>
    </div></div>
    <div class="card"><div class="card-header">Provider webhook (optional)</div><div class="card-body small">
      <p>If your email provider can post bounce or complaint events, point it at this address (POST, JSON: <code>{"email","type":"hard|soft|complaint","reason","message_id"}</code>):</p>
      <div class="input-group"><input class="form-control mono" readonly value="${webhookUrl}" aria-label="Webhook URL"><button class="btn btn-outline-secondary" type="button" id="wh-copy">Copy</button>
        <button class="btn btn-outline-secondary" type="button" id="wh-rotate">New token</button></div>
    </div></div>`,
    compliance: html`<div class="card mb-3"><div class="card-header">Unsubscribes</div><div class="card-body">
      <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="gu" name="global_unsubscribe" ${check(s.global_unsubscribe)}><label class="form-check-label" for="gu">An unsubscribe stops <strong>all</strong> marketing (recommended under POPIA)</label></div>
      <div class="form-text">When off, an unsubscribe only removes the person from the lists of the campaign they unsubscribed from. Only switch off if you run a documented preference model.</div>
    </div></div>
    <div class="card"><div class="card-header">Backups</div><div class="card-body">
      <label class="form-label">Alert when no successful backup in (hours, 0 = off)</label><input class="form-control mw-200" name="backup_stale_hours" type="number" min="0" max="744" value="${s.backup_stale_hours}">
      <div class="form-text">MailHarbor backs up your database every day. This only controls when a missing backup is flagged on System health (26 is a good value).</div>
    </div></div>`,
  };

  mount(el, html`<div class="page-head"><div><h1>Settings</h1><p>Organisation, email design, sending, bounce handling and compliance. Your database and mail server connection are managed by MailHarbor.</p></div></div>
    <ul class="nav nav-tabs mb-3">${TABS.map(([k, l]) => html`<li class="nav-item"><a class="nav-link ${k === tab ? 'active' : ''}" href="#/settings/${k}" ${k === tab ? raw('aria-current="page"') : ''}>${l}</a></li>`)}</ul>
    <form id="sf" novalidate>${sections[tab]}
      <div class="mt-3 d-flex gap-2 align-items-center"><button class="btn btn-primary" type="submit"><i class="bi bi-check-lg me-1"></i>Save settings</button><span class="small text-muted-2" id="saved"></span></div></form>`);

  const f = $('#sf', el);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (n) => f.elements[n];
    const body = {};
    for (const k of ['org_name', 'org_address', 'public_url', 'from_name', 'from_email', 'reply_to', 'bounce_address', 'utm_source', 'utm_medium', 'utm_domains']) if (v(k) && !v(k).disabled) body[k] = v(k).value.trim();
    for (const k of ['send_rate_per_second', 'send_max_per_hour', 'soft_bounce_limit', 'backup_stale_hours', 'email_logo_width']) if (v(k)) body[k] = Number(v(k).value);
    for (const k of ['track_opens', 'track_clicks', 'global_unsubscribe', 'utm_enabled', 'email_show_preferences']) if (v(k)) body[k] = v(k).checked;
    for (const k of ['email_logo_url', 'email_header_align', 'email_brand_color', 'email_heading_color', 'email_background', 'email_font', 'email_footer_text']) if (v(k)) body[k] = v(k).value.trim();
    if (v('mb_host')) {
      body.bounce_mailbox = { enabled: v('mb_enabled').checked, host: v('mb_host').value.trim(), port: Number(v('mb_port').value), secure: v('mb_secure').checked,
        user: v('mb_user').value.trim(), folder: v('mb_folder').value.trim() || 'INBOX', after: v('mb_after').value, interval_minutes: Number(v('mb_interval').value) };
      if (v('mb_password').value) body.bounce_mailbox.password = v('mb_password').value;
    }
    try {
      await put('/settings', body);
      toast('Settings saved');
      $('#saved', el).textContent = `Saved ${new Date().toLocaleTimeString('en-ZA')}`;
      if (v('mb_password')) v('mb_password').value = '';
    } catch (err) { errorToast(err); }
  });

  // Email design: live preview from the unsaved values (rendered by the server, shown sandboxed).
  const preview = $('#d-preview', el);
  if (preview) {
    let t;
    const refresh = () => {
      const q = new URLSearchParams();
      for (const k of DESIGN_KEYS) {
        const input = f.elements[k];
        if (input) q.set(k, input.type === 'checkbox' ? String(input.checked) : input.value.trim());
      }
      preview.src = `/api/settings/email-preview?${q}`;
    };
    f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 400); });
    f.addEventListener('change', () => { clearTimeout(t); t = setTimeout(refresh, 100); });
    $('#d-pick', el).addEventListener('click', () => pickImage({
      onPick: (img) => { f.elements.email_logo_url.value = img.url; refresh(); },
    }));
    refresh();
  }

  $('#smtp-test', el)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const out = $('#smtp-result', el);
    out.textContent = 'Connecting…';
    try {
      const r = await post('/settings/smtp-test', { to: $('#smtp-to', el).value });
      mount(out, r.data.ok ? html`<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>Sent. Server replied: ${r.data.response}</span>`
        : html`<span class="text-danger"><i class="bi bi-x-circle-fill me-1"></i>${r.data.error}</span>`);
    } catch (err) { errorToast(err); out.textContent = ''; } finally { e.target.disabled = false; }
  });
  $('#mb-test', el)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const out = $('#mb-result', el);
    out.textContent = 'Connecting…';
    try {
      const r = await post('/settings/mailbox-test', { host: f.mb_host.value, port: Number(f.mb_port.value), secure: f.mb_secure.checked,
        user: f.mb_user.value, password: f.mb_password.value || undefined, folder: f.mb_folder.value });
      mount(out, r.data.ok ? html`<span class="text-success"><i class="bi bi-check-circle-fill me-1"></i>Connected. ${num(r.data.messages)} message(s) waiting.</span>`
        : html`<span class="text-danger"><i class="bi bi-x-circle-fill me-1"></i>${r.data.error}</span>`);
    } catch (err) { errorToast(err); out.textContent = ''; } finally { e.target.disabled = false; }
  });
  $('#mb-poll', el)?.addEventListener('click', async () => {
    try {
      const r = await post('/settings/mailbox-poll');
      toast(r.data.error ? `Mailbox error: ${r.data.error}` : `Checked ${num(r.data.checked || 0)} message(s): ${num(r.data.bounces || 0)} bounce(s) recorded`, r.data.error ? 'danger' : 'success');
    } catch (err) { errorToast(err); }
  });
  $('#wh-copy', el)?.addEventListener('click', async () => { await navigator.clipboard?.writeText(webhookUrl).catch(() => {}); toast('Webhook URL copied'); });
  $('#wh-rotate', el)?.addEventListener('click', async () => {
    try { await post('/settings/webhook-token'); toast('New webhook token created. Update your provider.'); ctx.navigate('#/settings/bounces'); } catch (err) { errorToast(err); }
  });
  void $$; void ago;
}
