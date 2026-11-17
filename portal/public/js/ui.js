// UI helpers. `html` is an auto-escaping tagged template: every interpolated
// value is HTML-escaped unless it is itself produced by `html` (or `raw`).

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s));

export function esc(v) {
  if (v === null || v === undefined || v === false) return '';
  return String(v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

function interp(v) {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(interp).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += interp(v) + strings[i + 1]; });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) {
  el.innerHTML = String(content);
  applyWidths(el);
}

/** CSP forbids inline style attributes; widths are applied via the CSSOM. */
let labelSeq = 0;
/** Associates each .form-label with the control that follows it (WCAG 1.3.1 / 4.1.2). */
function linkLabels(root) {
  $$('label.form-label:not([for])', root).forEach((l) => {
    let n = l.nextElementSibling;
    while (n && !n.matches('input,select,textarea') && !n.querySelector?.('input,select,textarea')) n = n.nextElementSibling;
    const control = n && (n.matches('input,select,textarea') ? n : n.querySelector('input,select,textarea'));
    if (!control) return;
    if (!control.id) { labelSeq += 1; control.id = `fld-${labelSeq}`; }
    l.htmlFor = control.id;
  });
}

export function applyWidths(root) {
  linkLabels(root);
  // Scrollable tables must be reachable by keyboard (WCAG 2.1.1).
  $$('.table-responsive', root).forEach((n) => { n.tabIndex = 0; if (!n.hasAttribute('aria-label')) n.setAttribute('aria-label', 'Table (scrollable)'); });
  $$('[data-w]', root).forEach((n) => { n.style.width = `${Math.max(0, Math.min(100, Number(n.dataset.w)))}%`; });
  $$('[data-bg]', root).forEach((n) => { n.style.background = n.dataset.bg; });
}

// ---- Formatting -------------------------------------------------------------
const nf = new Intl.NumberFormat('en-ZA');
export const num = (n) => (n === null || n === undefined ? '–' : nf.format(Number(n)));
export const pct = (n) => (n === null || n === undefined ? '–' : `${Number(n).toFixed(1)}%`);
export function date(d) {
  if (!d) return '–';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '–' : x.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function datetime(d) {
  if (!d) return '–';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '–' : x.toLocaleString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function ago(d) {
  if (!d) return '–';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return date(d);
}
export const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const STATUS_INFO = {
  active: { label: 'Active', help: 'Valid and eligible for campaigns' },
  unconfirmed: { label: 'Unconfirmed', help: 'Awaiting double opt-in confirmation; not sent to' },
  soft_bounced: { label: 'Soft bounced', help: 'Temporary delivery problem; still eligible until the soft-bounce limit' },
  hard_bounced: { label: 'Hard bounced', help: 'Permanently undeliverable; suppressed' },
  complaint: { label: 'Complaint', help: 'Marked as spam; suppressed' },
  unsubscribed: { label: 'Unsubscribed', help: 'Opted out; suppressed' },
  blocklisted: { label: 'Blocklisted', help: 'Manually or automatically suppressed' },
  pending_review: { label: 'Pending review', help: 'Held: a person must decide (e.g. spam/policy rejection)' },
  no_lists: { label: 'No lists', help: 'Not subscribed to any list, so receives nothing' },
};

export function statusBadge(s) {
  const i = STATUS_INFO[s] || { label: label(s), help: '' };
  return html`<span class="status s-${s}" title="${i.help}">${i.label}</span>`;
}
export function campStatus(s) {
  return html`<span class="camp-status ${s}">${s}</span>`;
}

// ---- Feedback ---------------------------------------------------------------
export function toast(message, type = 'success') {
  const icon = { success: 'check-circle-fill text-success', danger: 'exclamation-octagon-fill text-danger', warning: 'exclamation-triangle-fill text-warning', info: 'info-circle-fill text-primary' }[type];
  const el = document.createElement('div');
  el.className = 'toast align-items-center border-0 shadow-sm';
  el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
  el.innerHTML = String(html`<div class="d-flex"><div class="toast-body d-flex gap-2 align-items-start"><i class="bi bi-${icon} mt-1"></i><div>${message}</div></div>
    <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`);
  $('#toasts').appendChild(el);
  const t = new bootstrap.Toast(el, { delay: type === 'danger' ? 8000 : 4000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

export function errorToast(err) {
  // Only add field details that say something the main message doesn't.
  const main = String(err.message || '').toLowerCase();
  const details = (err.details || [])
    .filter((d) => d.message && !main.includes(String(d.message).toLowerCase()))
    .map((d) => (d.field ? `${label(d.field.split('.').pop())}: ${d.message}` : d.message));
  toast(details.length ? `${err.message} — ${details.slice(0, 3).join('; ')}` : err.message, 'danger');
}

let modalInstance;
function modal() {
  if (!modalInstance) modalInstance = new bootstrap.Modal($('#modal'));
  return modalInstance;
}

/**
 * Opens a modal containing a form. `onSubmit(formData, form)` may throw an
 * ApiError; field errors are shown inline and the modal stays open.
 */
export function formModal({ title, body, submitLabel = 'Save', danger = false, size = '', onSubmit }) {
  const content = $('#modal-content');
  $('#modal .modal-dialog').className = `modal-dialog modal-dialog-centered modal-dialog-scrollable ${size}`;
  mount(content, html`<form novalidate>
    <div class="modal-header"><h2 class="modal-title fs-5" id="modal-title">${title}</h2>
      <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
    <div class="modal-body">${body}<div class="alert alert-danger d-none mt-3 mb-0" data-error></div></div>
    <div class="modal-footer"><button type="button" class="btn btn-light" data-bs-dismiss="modal">Cancel</button>
      <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button></div></form>`);
  const form = $('form', content);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const errBox = $('[data-error]', form);
    errBox.classList.add('d-none');
    $$('.is-invalid', form).forEach((n) => n.classList.remove('is-invalid'));
    btn.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      modal().hide();
    } catch (err) {
      const details = err.details || [];
      details.forEach((d) => {
        const f = d.field && form.querySelector(`[name="${CSS.escape(d.field.split('.').pop())}"]`);
        if (f) f.classList.add('is-invalid');
      });
      errBox.textContent = [err.message, ...details.filter((d) => d.message).map((d) => `${d.field ? `${d.field}: ` : ''}${d.message}`)].join(' — ');
      errBox.classList.remove('d-none');
    } finally {
      btn.disabled = false;
    }
  });
  modal().show();
  setTimeout(() => form.querySelector('input:not([type=hidden]),select,textarea')?.focus(), 300);
  return form;
}

export function confirmModal({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    formModal({ title, body: html`<p class="mb-0">${message}</p>`, submitLabel: confirmLabel, danger,
      onSubmit: async () => { done = true; resolve(true); } });
    $('#modal').addEventListener('hidden.bs.modal', () => { if (!done) resolve(false); }, { once: true });
  });
}

export function loading(text = 'Loading…') {
  return html`<div class="py-5 text-center text-muted-2"><div class="spinner-border spinner-border-sm me-2" role="status"></div>${text}</div>`;
}
export function empty(icon, title, text = '', action = '') {
  return html`<div class="empty"><i class="bi bi-${icon}"></i><div class="fw-semibold text-body">${title}</div><div class="small">${text}</div>${action ? html`<div class="mt-3">${action}</div>` : ''}</div>`;
}
export function errorBox(err) {
  return html`<div class="alert alert-danger"><i class="bi bi-exclamation-octagon me-2"></i>${err.message || 'Something went wrong'}</div>`;
}

export function pager(meta, onPage) {
  const pages = Math.max(1, Math.ceil((meta.total || 0) / meta.perPage));
  const p = meta.page;
  const id = `pg${Math.random().toString(36).slice(2, 8)}`;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (b && !b.disabled) onPage(Number(b.dataset.page));
    });
  });
  const from = meta.total ? (p - 1) * meta.perPage + 1 : 0;
  const to = Math.min(p * meta.perPage, meta.total || 0);
  return html`<div class="d-flex justify-content-between align-items-center flex-wrap gap-2 px-3 py-2 border-top" id="${id}">
    <span class="small text-muted-2">${num(from)}–${num(to)} of ${num(meta.total)}</span>
    <div class="btn-group btn-group-sm">
      <button class="btn btn-outline-secondary" data-page="1" ${p <= 1 ? raw('disabled') : ''} aria-label="First page"><i class="bi bi-chevron-double-left"></i></button>
      <button class="btn btn-outline-secondary" data-page="${p - 1}" ${p <= 1 ? raw('disabled') : ''} aria-label="Previous page"><i class="bi bi-chevron-left"></i></button>
      <span class="btn btn-outline-secondary pager-label" aria-live="polite">Page ${p} of ${num(pages)}</span>
      <button class="btn btn-outline-secondary" data-page="${p + 1}" ${p >= pages ? raw('disabled') : ''} aria-label="Next page"><i class="bi bi-chevron-right"></i></button>
      <button class="btn btn-outline-secondary" data-page="${pages}" ${p >= pages ? raw('disabled') : ''} aria-label="Last page"><i class="bi bi-chevron-double-right"></i></button>
    </div></div>`;
}

export function options(items, selected, { valueKey = 'value', labelKey = 'label', blank } = {}) {
  const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
  return html`${blank !== undefined ? html`<option value="">${blank}</option>` : ''}${items.map((i) => {
    const v = typeof i === 'object' ? i[valueKey] : i;
    const l = typeof i === 'object' ? i[labelKey] : label(i);
    return html`<option value="${v}" ${sel.includes(String(v)) ? raw('selected') : ''}>${l}</option>`;
  })}`;
}

export const CONSENT_LABELS = {
  double_opt_in: 'Double opt-in (confirmed by email)',
  web_form: 'Website sign-up form',
  paper_form: 'Paper / printed form',
  verbal: 'Verbal / telephone (recorded)',
  email_request: 'Written request by email',
  event_signup: 'Event or trade-show sign-up',
  existing_customer: 'Existing customer (POPIA s69(3))',
  other: 'Other (describe in evidence)',
};

/** Form fields for recording a consent basis. */
export function consentFields(prefix = '', { required = true, values = {} } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return html`<div class="row g-2">
    <div class="col-md-6"><label class="form-label">Consent method ${required ? html`<span class="text-danger">*</span>` : ''}</label>
      <select class="form-select" name="${prefix}method" ${required ? raw('required') : ''}>
        ${options(Object.entries(CONSENT_LABELS).map(([value, l]) => ({ value, label: l })), values.method || '', { blank: required ? 'Choose…' : 'No default (use CSV column)' })}
      </select></div>
    <div class="col-md-6"><label class="form-label">Date obtained</label>
      <input type="date" class="form-control" name="${prefix}obtainedAt" max="${today}" value="${values.obtainedAt || ''}"></div>
    <div class="col-12"><label class="form-label">Purpose</label>
      <input class="form-control" name="${prefix}purpose" maxlength="200" placeholder="e.g. Monthly newsletter and product updates" value="${values.purpose || ''}"></div>
    <div class="col-12"><label class="form-label">Evidence / reference</label>
      <textarea class="form-control" name="${prefix}evidence" rows="2" maxlength="1000" placeholder="Where is the proof kept? e.g. 'Signed form in CRM ref 4411' or 'Web form, IP logged'">${values.evidence || ''}</textarea></div>
  </div>`;
}

export function consentFromForm(fd, prefix = '') {
  const o = {
    method: fd.get(`${prefix}method`) || '',
    purpose: fd.get(`${prefix}purpose`) || '',
    evidence: fd.get(`${prefix}evidence`) || '',
  };
  const d = fd.get(`${prefix}obtainedAt`);
  if (d) o.obtainedAt = d;
  return o;
}
