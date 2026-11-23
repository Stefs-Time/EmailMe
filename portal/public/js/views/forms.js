import { get, post, put, del } from '../api.js';
import { html, raw, mount, $, $$, num, datetime, loading, empty, toast, errorToast, confirmModal } from '../ui.js';

const OUTCOME = { subscribed: 'Subscribed', confirmation_sent: 'Confirmation sent', already_subscribed: 'Already subscribed', suppressed: 'Not added (unsubscribed or blocked earlier)', rejected: 'Blocked as spam' };

export async function render(el, ctx, [formId]) {
  if (formId) return renderEditor(el, ctx, formId);
  const canWrite = ctx.can('lists:write');
  mount(el, html`<div class="page-head"><div><h1>Sign-up forms</h1>
      <p>Let people join your lists from your website or social media. Consent is recorded automatically, and double opt-in lists send a confirmation email first.</p></div>
      ${canWrite ? html`<a class="btn btn-primary" href="#/forms/new"><i class="bi bi-plus-lg me-1"></i>New form</a>` : ''}</div>
    <div class="card" id="t">${loading()}</div>`);
  const { data } = await get('/forms');
  if (!data.length) {
    mount($('#t', el), empty('ui-checks', 'No sign-up forms yet', 'Create a form, then share its link or embed it on your website.',
      canWrite ? html`<a class="btn btn-primary" href="#/forms/new">New form</a>` : ''));
    return undefined;
  }
  mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle mb-0">
    <thead><tr><th>Form</th><th>Adds to</th><th class="num">Sign-ups (30 days)</th><th class="num">All time</th><th>Last sign-up</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${data.map((f) => html`<tr><td><a class="fw-semibold text-decoration-none" href="#/forms/${f.id}">${f.name}</a>
        ${f.status === 'disabled' ? html` <span class="badge text-bg-light">Closed</span>` : ''}</td>
      <td class="small">${f.list_names.join(', ')}</td><td class="num">${num(f.signups_30d)}</td><td class="num">${num(f.signups)}</td>
      <td class="small">${f.last_signup ? datetime(f.last_signup) : '–'}</td>
      <td class="text-end text-nowrap"><a class="btn btn-sm btn-light" href="${f.url}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right me-1"></i>Open</a>
        <button class="btn btn-sm btn-light" data-copy="${f.url}"><i class="bi bi-link-45deg me-1"></i>Copy link</button></td></tr>`)}
    </tbody></table></div>`);
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Link copied'); } catch { toast(c.dataset.copy, 'info'); } }
  });
  return undefined;
}

async function renderEditor(el, ctx, formId) {
  const isNew = formId === 'new';
  const canWrite = ctx.can('lists:write');
  mount(el, loading());
  const { data: facets } = await get('/contacts/facets');
  const f = isNew
    ? { name: '', status: 'active', list_ids: [], settings: {} }
    : (await get(`/forms/${formId}`)).data;
  const s = { heading: 'Join our mailing list', intro: 'Get our news, specials and invitations by email.',
    consent_text: 'Yes, I would like to receive marketing emails. I can unsubscribe at any time.', button_label: 'Subscribe',
    success_message: 'Thank you! If this is a new subscription, please check your inbox: we may ask you to confirm your email address.',
    redirect_url: '', accent: '#1f4e8c', source: '', ...f.settings, fields: { first_name: 'optional', last_name: 'off', company: 'off', ...(f.settings.fields || {}) } };
  const fieldSel = (k, label) => html`<div class="col-md-4"><label class="form-label">${label}</label><select class="form-select" name="field_${k}">
    ${[['off', 'Hidden'], ['optional', 'Optional'], ['required', 'Required']].map(([v, l]) => html`<option value="${v}" ${s.fields[k] === v ? raw('selected') : ''}>${l}</option>`)}</select></div>`;

  mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/forms">Sign-up forms</a></li><li class="breadcrumb-item active">${isNew ? 'New form' : f.name}</li></ol></nav>
    <div class="page-head"><div><h1>${isNew ? 'New sign-up form' : 'Edit sign-up form'}</h1><p>What visitors see, and which lists they join.</p></div>
      <div class="d-flex gap-2 flex-wrap">${!isNew && canWrite ? html`<button class="btn btn-light" id="delete"><i class="bi bi-trash3 me-1"></i>Delete</button>` : ''}
        ${canWrite ? html`<button class="btn btn-primary" id="save"><i class="bi bi-check-lg me-1"></i>Save form</button>` : ''}</div></div>
    <div class="row g-3"><div class="col-xl-7"><form id="ff" novalidate>
      <div class="card mb-3"><div class="card-header">Basics</div><div class="card-body"><div class="row g-3">
        <div class="col-md-8"><label class="form-label">Form name <span class="text-muted-2 small">(internal)</span></label><input class="form-control" name="name" maxlength="120" value="${f.name}" placeholder="e.g. Website footer" required></div>
        <div class="col-md-4"><label class="form-label">Status</label><select class="form-select" name="status"><option value="active" ${f.status === 'active' ? raw('selected') : ''}>Open</option><option value="disabled" ${f.status === 'disabled' ? raw('selected') : ''}>Closed</option></select></div>
        <div class="col-12"><span class="form-label d-block">Adds people to</span><div class="list-pick border rounded p-2" role="group" aria-label="Lists">
          ${facets.lists.length ? facets.lists.map((l) => html`<div class="form-check"><input class="form-check-input" type="checkbox" id="fl${l.id}" value="${l.id}" data-list ${f.list_ids.includes(l.id) ? raw('checked') : ''}>
            <label class="form-check-label" for="fl${l.id}">${l.name}${l.optin === 'double' ? html` <span class="badge text-bg-light">double opt-in: confirmation email first</span>` : ''}</label></div>`)
            : html`<div class="text-muted-2 small">No lists yet. <a href="#/lists">Create a list</a> first.</div>`}</div></div>
        <div class="col-md-6"><label class="form-label">Contact source label <span class="text-muted-2 small">(optional)</span></label><input class="form-control" name="source" maxlength="80" value="${s.source}" placeholder="Form: ${f.name || 'name'}"></div>
      </div></div></div>
      <div class="card mb-3"><div class="card-header">What visitors see</div><div class="card-body"><div class="row g-3">
        <div class="col-12"><label class="form-label">Heading</label><input class="form-control" name="heading" maxlength="120" value="${s.heading}"></div>
        <div class="col-12"><label class="form-label">Intro text</label><textarea class="form-control" name="intro" rows="2" maxlength="500">${s.intro}</textarea></div>
        ${fieldSel('first_name', 'First name')}${fieldSel('last_name', 'Last name')}${fieldSel('company', 'Company')}
        <div class="col-12"><label class="form-label">Consent statement <span class="text-muted-2 small">(visitors must tick it; stored as POPIA evidence)</span></label><textarea class="form-control" name="consent_text" rows="2" maxlength="500">${s.consent_text}</textarea></div>
        <div class="col-md-6"><label class="form-label">Button label</label><input class="form-control" name="button_label" maxlength="40" value="${s.button_label}"></div>
        <div class="col-md-6"><label class="form-label">Button colour</label><input class="form-control form-control-color w-100" type="color" name="accent" value="${s.accent}"></div>
        <div class="col-12"><label class="form-label">Thank-you message</label><textarea class="form-control" name="success_message" rows="2" maxlength="500">${s.success_message}</textarea></div>
        <div class="col-12"><label class="form-label">…or send people to your own thank-you page <span class="text-muted-2 small">(optional, https://)</span></label><input class="form-control" type="url" name="redirect_url" maxlength="500" value="${s.redirect_url}" placeholder="https://www.example.co.za/thanks"></div>
      </div></div></div></form></div>
    <div class="col-xl-5">${isNew ? html`<div class="card"><div class="card-body text-muted-2 small"><i class="bi bi-info-circle me-1"></i>Save the form to get its link and embed code.</div></div>` : html`
      <div class="card mb-3"><div class="card-header">Share</div><div class="card-body">
        <label class="form-label small">Link (for emails, social media, QR codes)</label>
        <div class="input-group mb-3"><input class="form-control mono small" readonly value="${f.url}" aria-label="Form link"><button class="btn btn-outline-secondary" type="button" data-copy="${f.url}">Copy</button></div>
        <label class="form-label small">Embed on your website (paste into your page's HTML)</label>
        <textarea class="form-control mono small" rows="3" readonly aria-label="Embed code">&lt;iframe src="${f.url}?embed=1" title="${s.heading}" style="width:100%;max-width:480px;height:560px;border:0" loading="lazy"&gt;&lt;/iframe&gt;</textarea>
        <button class="btn btn-sm btn-outline-secondary mt-2" type="button" data-copy-embed><i class="bi bi-code-slash me-1"></i>Copy embed code</button>
      </div></div>
      <div class="card mb-3"><div class="card-header d-flex">Preview <a class="ms-auto small" href="${f.url}" target="_blank" rel="noopener">Open</a></div>
        <div class="preview-frame-wrap"><iframe class="form-preview" src="${f.url.replace(/^https?:\/\/[^/]+/, '')}?embed=1" title="Form preview"></iframe></div></div>
      <div class="card"><div class="card-header">Recent sign-ups</div><div id="subs">${loading()}</div></div>`}</div></div>`);

  const form = $('#ff', el);
  async function loadSubs() {
    if (isNew) return;
    const r = await get(`/forms/${formId}/submissions`);
    const t = r.meta.totals;
    mount($('#subs', el), r.data.length ? html`<div class="card-body small border-bottom">${Object.entries(t).map(([k, n]) => html`<span class="me-3">${OUTCOME[k]}: <strong>${num(n)}</strong></span>`)}</div>
      <ul class="list-group list-group-flush small">${r.data.slice(0, 15).map((x) => html`<li class="list-group-item d-flex justify-content-between gap-2">
        <span class="text-truncate">${x.contact_id ? html`<a href="#/contacts/${x.contact_id}">${x.email}</a>` : html`<span class="text-muted-2">–</span>`}</span>
        <span class="text-muted-2 text-nowrap">${OUTCOME[x.outcome]} · ${datetime(x.created_at)}</span></li>`)}</ul>`
      : html`<div class="card-body small text-muted-2">No sign-ups yet. Share the link to get started.</div>`);
  }
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy], [data-copy-embed]');
    if (c) {
      const text = c.dataset.copy || $('textarea[aria-label="Embed code"]', el).value;
      try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it with Ctrl+C', 'info'); }
      return;
    }
    if (e.target.closest('#save')) {
      const v = (n) => form.elements[n].value;
      const body = {
        name: v('name').trim(), status: v('status'), list_ids: $$('[data-list]:checked', el).map((x) => Number(x.value)),
        settings: { heading: v('heading'), intro: v('intro'), consent_text: v('consent_text'), button_label: v('button_label'), accent: v('accent'),
          success_message: v('success_message'), redirect_url: v('redirect_url').trim(), source: v('source').trim(),
          fields: { first_name: v('field_first_name'), last_name: v('field_last_name'), company: v('field_company') } },
      };
      try {
        if (isNew) { const r = await post('/forms', body); toast('Form created'); ctx.navigate(`#/forms/${r.data.id}`); } else {
          await put(`/forms/${formId}`, body); toast('Form saved');
          const fr = $('.form-preview', el); if (fr) fr.src = fr.src.replace(/(&ts=\d+)?$/, `&ts=${Date.now()}`);
        }
      } catch (err) { errorToast(err); }
      return;
    }
    if (e.target.closest('#delete')) {
      if (!(await confirmModal({ title: 'Delete this form?', danger: true, confirmLabel: 'Delete', message: 'Its link and embed code stop working. Contacts who signed up are kept.' }))) return;
      try { await del(`/forms/${formId}`); toast('Form deleted'); ctx.navigate('#/forms'); } catch (err) { errorToast(err); }
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  await loadSubs();
  return undefined;
}
