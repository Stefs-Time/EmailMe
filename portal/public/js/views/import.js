import { get, post, del, api, download } from '../api.js';
import { html, raw, mount, $, $$, num, loading, options, toast, errorToast, label, consentFields, consentFromForm, CONSENT_LABELS } from '../ui.js';

const FIELD_LABELS = {
  email: 'Email (required)', first_name: 'First name', last_name: 'Surname', full_name: 'Full name (split automatically)',
  company: 'Company', source: 'Source', consent_date: 'Consent date', consent_method: 'Consent method',
  consent_purpose: 'Consent purpose', attribute: 'Custom attribute', ignore: "Don't import",
};
const GOOD = ['new', 'existing_add', 'imported', 'added_to_lists'];
const NEUTRAL = ['existing_unchanged'];

export async function render(el, ctx, [importId]) {
  mount(el, loading());
  const [{ data: meta }, { data: facets }] = await Promise.all([get('/imports/meta'), get('/contacts/facets')]);
  let timer;

  const steps = (n) => html`<ol class="steps">${['Upload file', 'Match columns', 'Review', 'Import'].map((s, i) => html`
    <li class="${i + 1 === n ? 'current' : i + 1 < n ? 'done' : ''}"><span class="n">${i + 1 < n ? raw('<i class="bi bi-check"></i>') : i + 1}</span>${s}</li>`)}</ol>`;

  const head = html`<div class="page-head"><div><h1>Import contacts</h1>
    <p>Bring in a CSV file safely: invalid, duplicate and suppressed addresses are caught before anything is saved.</p></div>
    <div class="d-flex gap-2"><a class="btn btn-light" href="#/imports"><i class="bi bi-clock-history me-1"></i>Import history</a>
      <a class="btn btn-light" href="#/guides/importing"><i class="bi bi-question-circle me-1"></i>Help</a></div></div>`;

  // ---- Step 1: upload ---------------------------------------------------------
  function stepUpload() {
    mount(el, html`${head}${steps(1)}
      <div class="row g-3"><div class="col-lg-8"><div class="card"><div class="card-body">
        <label class="dropzone d-block" id="drop" for="file">
          <i class="bi bi-filetype-csv"></i>
          <div class="fw-semibold mt-2">Drop your CSV file here, or click to choose</div>
          <div class="small text-muted-2">Up to ${num(meta.maxRows)} rows · ${meta.maxMb} MB · comma, semicolon or tab separated · UTF-8</div>
          <input type="file" id="file" accept=".csv,text/csv" class="visually-hidden">
        </label>
        <div id="upload-status" class="mt-3"></div>
      </div></div></div>
      <div class="col-lg-4"><div class="card"><div class="card-header">Preparing your file</div><div class="card-body small">
        <ol class="ps-3 mb-3">
          <li>First row must contain column names.</li>
          <li>One column must hold email addresses.</li>
          <li>Recommended: <code>first_name</code>, <code>last_name</code>, <code>company</code>, <code>source</code>, <code>consent_method</code>, <code>consent_date</code>.</li>
          <li>Any other columns become custom attributes you can use for personalisation.</li>
        </ol>
        <a href="/samples/contacts-template.csv" download class="btn btn-sm btn-outline-primary"><i class="bi bi-download me-1"></i>Download template</a>
        <div class="alert alert-info mt-3 mb-0"><i class="bi bi-shield-check me-1"></i>Imports never re-activate people who unsubscribed, bounced or were blocklisted.</div>
      </div></div></div></div>`);
    const input = $('#file', el);
    const drop = $('#drop', el);
    const doUpload = async (file) => {
      if (!file) return;
      const status = $('#upload-status', el);
      mount(status, loading(`Reading ${file.name}…`));
      const form = new FormData();
      form.append('file', file);
      try {
        const r = await api('POST', '/imports', undefined, { form });
        history.replaceState(null, '', `#/import/${r.data.id}`);
        stepMap(r.data);
      } catch (err) {
        mount(status, html`<div class="alert alert-danger mb-0">${err.message}</div>`);
      }
    };
    input.addEventListener('change', () => doUpload(input.files[0]));
    ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', (e) => doUpload(e.dataTransfer.files[0]));
  }

  // ---- Step 2: mapping and options ---------------------------------------------
  function stepMap(imp) {
    const o = imp.options || {};
    const consent = o.consent || {};
    mount(el, html`${head}${steps(2)}
      <form id="map-form" novalidate>
      <div class="row g-3">
        <div class="col-xl-7"><div class="card"><div class="card-header">Match your columns <span class="fw-normal text-muted-2 small">· ${imp.filename} · ${num(imp.total_rows)} rows</span></div>
          <div class="table-responsive"><table class="table align-middle">
            <thead><tr><th>Column in your file</th><th>Example</th><th>Import as</th></tr></thead><tbody>
            ${imp.headers.map((h) => html`<tr><td class="fw-semibold">${h}</td>
              <td class="small text-muted-2 text-truncate">${(imp.sample || []).map((r) => r[h]).filter(Boolean).slice(0, 2).join(', ') || '–'}</td>
              <td><select class="form-select form-select-sm" data-col="${h}">${options(meta.fields.map((f) => ({ value: f, label: FIELD_LABELS[f] })), imp.mapping[h])}</select></td></tr>`)}
            </tbody></table></div></div></div>
        <div class="col-xl-5">
          <div class="card mb-3"><div class="card-header">Where should they go?</div><div class="card-body">
            <label class="form-label">Add to lists <span class="text-danger">*</span></label>
            <select class="form-select" name="lists" multiple size="5" required aria-required="true">${options(facets.lists.map((l) => ({ value: l.id, label: `${l.name}${l.optin === 'double' ? ' (double opt-in)' : ''}` })), o.listIds || [])}</select>
            <div class="form-text">Ctrl / Cmd-click to choose several. Existing contacts are only added to lists they have never been on.</div>
            <label class="form-label mt-3">Subscription status</label>
            <select class="form-select" name="subscriptionStatus">
              <option value="confirmed" ${o.subscriptionStatus !== 'unconfirmed' ? raw('selected') : ''}>Confirmed – consent already obtained</option>
              <option value="unconfirmed" ${o.subscriptionStatus === 'unconfirmed' ? raw('selected') : ''}>Unconfirmed – they must confirm by email (double opt-in lists)</option></select>
            <label class="form-label mt-3">Source (when the file has no source column)</label>
            <input class="form-control" name="source" maxlength="100" value="${o.source || imp.filename.replace(/\.[^.]+$/, '')}">
          </div></div>
          <div class="card"><div class="card-header">Consent basis <span class="fw-normal small text-muted-2">· applies to rows without a consent column</span></div><div class="card-body">
            <p class="small text-muted-2">POPIA: owning an email address is not consent. Rows with no consent method (here or in the file) will be excluded.</p>
            ${consentFields('c_', { required: false, values: consent })}
          </div></div>
        </div>
      </div>
      <div class="d-flex justify-content-between mt-3">
        <button type="button" class="btn btn-light" id="cancel"><i class="bi bi-x-lg me-1"></i>Cancel import</button>
        <button type="submit" class="btn btn-primary btn-lg">Check my data <i class="bi bi-arrow-right ms-1"></i></button>
      </div></form>`);
    $('#cancel', el).addEventListener('click', async () => {
      try { await del(`/imports/${imp.id}`); } catch { /* already gone */ }
      location.hash = '#/import'; ctx.navigate('#/import');
    });
    $('#map-form', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const mapping = {};
      $$('[data-col]', el).forEach((s) => { mapping[s.dataset.col] = s.value; });
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Checking every row…';
      try {
        const c = consentFromForm(fd, 'c_');
        const r = await post(`/imports/${imp.id}/preview`, { mapping, options: {
          listIds: fd.getAll('lists').map(Number), source: fd.get('source') || 'import',
          subscriptionStatus: fd.get('subscriptionStatus'), consent: { ...c, obtainedAt: c.obtainedAt || '' } } });
        stepPreview(r.data.import, r.data.samples);
      } catch (err) {
        errorToast(err);
        btn.disabled = false;
        btn.textContent = 'Check my data';
      }
    });
  }

  // ---- Step 3: preview ---------------------------------------------------------------
  function stepPreview(imp, samples) {
    const counts = imp.summary.preview || {};
    const order = ['new', 'existing_add', 'existing_unchanged', ...meta.blocking];
    const lists = facets.lists.filter((l) => (imp.options.listIds || []).includes(l.id)).map((l) => l.name);
    const importable = imp.summary.importable || 0;
    mount(el, html`${head}${steps(3)}
      <div class="row g-3 mb-3">${order.filter((k) => counts[k]).map((k) => html`<div class="col-6 col-md-4 col-xl-3">
        <div class="class-tile ${GOOD.includes(k) ? 'ok' : NEUTRAL.includes(k) ? 'neutral' : 'bad'}">
          <div class="n">${num(counts[k])}</div><div class="small">${meta.labels[k]}</div>
          ${ctx.can('exports:read') ? html`<button class="btn btn-link btn-sm p-0" data-dl="${k}">Download rows</button>` : ''}</div></div>`)}</div>
      <div class="card mb-3"><div class="card-header">Examples</div><div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>Row</th><th>Email</th><th>Result</th><th>Details</th></tr></thead><tbody>
        ${samples.map((s) => html`<tr><td>${s.row_no}</td><td class="cell-email">${s.email || '–'}</td><td>${meta.labels[s.classification]}</td><td class="small">${s.message || ''}</td></tr>`)}
        </tbody></table></div></div>
      <div class="card"><div class="card-body d-flex flex-wrap gap-3 align-items-center justify-content-between">
        <div><div class="fw-semibold fs-5">${num(importable)} contact(s) ready to import</div>
          <div class="small text-muted-2">${counts.new ? `${num(counts.new)} new` : ''}${counts.existing_add ? ` · ${num(counts.existing_add)} existing to add to lists` : ''}
          ${lists.length ? ` · into ${lists.join(', ')}` : ' · no lists selected'} · consent: ${CONSENT_LABELS[imp.options.consent?.method] || 'from file'}</div></div>
        <div class="d-flex gap-2"><button class="btn btn-light" id="back"><i class="bi bi-arrow-left me-1"></i>Change mapping</button>
          <button class="btn btn-teal btn-lg" id="commit" ${importable ? '' : raw('disabled')}><i class="bi bi-check2-circle me-1"></i>Import ${num(importable)} contact(s)</button></div>
      </div></div>`);
    $('#back', el).addEventListener('click', async () => { const r = await get(`/imports/${imp.id}`); stepMap(r.data); });
    el.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(`/imports/${imp.id}/rows.csv?class=${b.dataset.dl}`)));
    $('#commit', el).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await post(`/imports/${imp.id}/commit`); stepRun(imp.id); } catch (err) { errorToast(err); e.target.disabled = false; }
    });
  }

  // ---- Step 4: progress + result ---------------------------------------------------
  async function stepRun(id) {
    const r = await get(`/imports/${id}`);
    const imp = r.data;
    if (imp.status === 'committing') {
      mount(el, html`${head}${steps(4)}<div class="card"><div class="card-body text-center py-5">
        <div class="spinner-border text-primary mb-3" role="status"></div>
        <div class="fw-semibold">Importing… you can leave this page; the import continues in the background.</div></div></div>`);
      timer = setTimeout(() => stepRun(id), 2000);
      return;
    }
    if (imp.status === 'failed') {
      mount(el, html`${head}${steps(4)}<div class="alert alert-danger"><strong>The import failed.</strong> ${imp.error}</div>
        <a class="btn btn-primary" href="#/import">Start a new import</a>`);
      return;
    }
    const res = imp.summary.result || imp.counts || {};
    mount(el, html`${head}${steps(5)}
      <div class="card mb-3"><div class="card-body d-flex gap-3 align-items-center">
        <i class="bi bi-check-circle-fill text-success fs-1"></i>
        <div><div class="fs-5 fw-semibold">Import complete</div>
        <div class="text-muted-2">${num(imp.summary.imported || 0)} new contact(s) created · ${num(imp.summary.added_to_lists || 0)} existing contact(s) added to lists${imp.summary.failed ? ` · ${num(imp.summary.failed)} failed` : ''}</div></div></div></div>
      <div class="row g-3 mb-3">${Object.entries(res).map(([k, n]) => html`<div class="col-6 col-md-3"><div class="class-tile ${GOOD.includes(k) ? 'ok' : NEUTRAL.includes(k) ? 'neutral' : 'bad'}">
        <div class="n">${num(n)}</div><div class="small">${meta.labels[k] || label(k)}</div></div></div>`)}</div>
      <div class="d-flex gap-2 flex-wrap">
        ${ctx.can('exports:read') ? html`<button class="btn btn-outline-primary" id="report"><i class="bi bi-download me-1"></i>Download full row report</button>` : ''}
        <a class="btn btn-primary" href="#/contacts">View contacts</a><a class="btn btn-light" href="#/import">Import another file</a></div>`);
    $('#report', el)?.addEventListener('click', () => download(`/imports/${id}/rows.csv`));
    ctx.refreshBadges();
  }

  if (importId) {
    const r = await get(`/imports/${importId}`);
    const imp = r.data;
    if (imp.status === 'uploaded') stepMap(imp);
    else if (imp.status === 'previewed') {
      const s = await post(`/imports/${importId}/preview`, { mapping: imp.mapping, options: imp.options });
      stepPreview(s.data.import, s.data.samples);
    } else if (imp.status === 'cancelled') { toast('That import was cancelled', 'info'); stepUpload(); } else stepRun(importId);
  } else {
    stepUpload();
  }
  return () => clearTimeout(timer);
}
