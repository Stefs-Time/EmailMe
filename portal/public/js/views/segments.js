import { get, post, put, del } from '../api.js';
import { html, raw, mount, $, $$, num, loading, empty, toast, errorToast, confirmModal, STATUS_INFO, label as labelize } from '../ui.js';

const OPS = {
  is: 'is', is_not: 'is not', in: 'is subscribed to', not_in: 'is not subscribed to', contains: 'contains', missing: 'is not recorded',
  ends_with: 'ends with', empty: 'is empty', not_empty: 'is filled in', set: 'has a value', not_set: 'has no value',
  within_days: 'in the last … days', not_within_days: 'not in the last … days', older_than_days: 'more than … days ago',
  after: 'on or after', before: 'before', never: 'never', ever: 'at least once', at_least: 'at least',
};
const STATUS_LABEL = (s) => (s === 'eligible' ? 'Eligible to receive' : STATUS_INFO[s]?.label || labelize(s));

/** Plain-English summary of a rule set ("Status is Active AND Last opened in the last 90 days"). */
function describe(rules, meta) {
  const listName = (id) => meta?.lists.find((l) => l.id === Number(id))?.name || `list ${id}`;
  const val = (c) => {
    if (c.field === 'status') return STATUS_LABEL(c.value);
    if (c.field === 'list') return listName(c.value);
    if (c.field === 'consent') return labelize(c.value || '');
    if (/days/.test(c.op)) return `${c.value} days`;
    return c.value ?? '';
  };
  return rules.conditions.map((c) => {
    const f = meta?.fields[c.field]?.label || c.field;
    const opText = OPS[c.op].replace(' … days', '');
    const v = OPS[c.op].includes('…') ? `${c.value} days` : val(c);
    return `${f}${c.key ? ` "${c.key}"` : ''} ${opText}${meta?.fields[c.field]?.ops[c.op] ? ` ${v}` : ''}`.replace(/ days days$/, ' days');
  }).join(rules.match === 'any' ? ' OR ' : ' AND ');
}

export async function render(el, ctx, [segId]) {
  if (segId) return renderEditor(el, ctx, segId);
  const canWrite = ctx.can('contacts:write');
  mount(el, html`<div class="page-head"><div><h1>Segments</h1>
      <p>Saved audiences that stay up to date by themselves, e.g. "opened in the last 90 days and lives in Durban". Use them to filter contacts or to narrow a campaign.</p></div>
      ${canWrite ? html`<a class="btn btn-primary" href="#/segments/new"><i class="bi bi-plus-lg me-1"></i>New segment</a>` : ''}</div>
    <div class="card" id="t">${loading()}</div>`);
  const [{ data }, { data: meta }] = await Promise.all([get('/segments'), get('/segments/meta')]);
  if (!data.length) {
    mount($('#t', el), empty('funnel', 'No segments yet', 'Create one to target people by engagement, source, location or any imported column.',
      canWrite ? html`<a class="btn btn-primary" href="#/segments/new">New segment</a>` : ''));
    return undefined;
  }
  mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle mb-0">
    <thead><tr><th>Segment</th><th class="num">Contacts</th><th class="num">Eligible</th><th>Used by</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${data.map((s) => html`<tr><td><a class="fw-semibold text-decoration-none" href="${canWrite ? `#/segments/${s.id}` : `#/contacts?segment_id=${s.id}`}">${s.name}</a>
        <div class="small text-muted-2">${s.description || describe(s.rules, meta)}</div></td>
      <td class="num">${num(s.counts.total)}</td><td class="num">${num(s.counts.eligible)}</td>
      <td class="small">${s.used_by ? `${s.used_by} campaign(s)` : '–'}</td>
      <td class="text-end text-nowrap"><a class="btn btn-sm btn-light" href="#/contacts?segment_id=${s.id}"><i class="bi bi-people me-1"></i>View contacts</a>
        ${canWrite ? html`<button class="btn btn-sm btn-light" data-del="${s.id}" data-name="${s.name}" aria-label="Delete ${s.name}"><i class="bi bi-trash3"></i></button>` : ''}</td></tr>`)}
    </tbody></table></div>`);
  el.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-del]');
    if (!d) return;
    if (!(await confirmModal({ title: 'Delete segment?', danger: true, confirmLabel: 'Delete', message: `"${d.dataset.name}" will be deleted. Contacts are not affected.` }))) return;
    try { await del(`/segments/${d.dataset.del}`); toast('Segment deleted'); ctx.navigate('#/segments'); } catch (err) { errorToast(err); }
  });
  return undefined;
}

async function renderEditor(el, ctx, segId) {
  const isNew = segId === 'new';
  mount(el, loading());
  const { data: meta } = await get('/segments/meta');
  const seg = isNew
    ? { name: '', description: '', rules: { match: 'all', conditions: [{ field: 'last_open_at', op: 'within_days', value: 90 }] } }
    : (await get(`/segments/${segId}`)).data;
  const rules = structuredClone(seg.rules);

  mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/segments">Segments</a></li><li class="breadcrumb-item active">${isNew ? 'New segment' : seg.name}</li></ol></nav>
    <div class="page-head"><div><h1>${isNew ? 'New segment' : 'Edit segment'}</h1><p>Contacts that match the conditions. The segment updates itself as contacts change.</p></div>
      <div class="d-flex gap-2">${isNew ? '' : html`<a class="btn btn-outline-primary" href="#/contacts?segment_id=${segId}"><i class="bi bi-people me-1"></i>View contacts</a>`}
        <button class="btn btn-primary" id="save"><i class="bi bi-check-lg me-1"></i>Save segment</button></div></div>
    <div class="row g-3"><div class="col-xl-8">
      <div class="card mb-3"><div class="card-body"><div class="row g-2">
        <div class="col-md-6"><label class="form-label">Name</label><input class="form-control" id="sn" maxlength="120" value="${seg.name}" placeholder="e.g. Engaged Durban customers" required></div>
        <div class="col-md-6"><label class="form-label">Description <span class="text-muted-2 small">(optional)</span></label><input class="form-control" id="sd" maxlength="500" value="${seg.description}"></div>
      </div></div></div>
      <div class="card"><div class="card-header d-flex align-items-center gap-2 flex-wrap">Contacts who match
        <select class="form-select form-select-sm w-auto" id="match" aria-label="Match"><option value="all">all of these conditions</option><option value="any">any of these conditions</option></select></div>
        <div class="card-body"><div id="conds"></div>
          <button type="button" class="btn btn-sm btn-outline-primary mt-2" id="add"><i class="bi bi-plus-lg me-1"></i>Add condition</button></div></div>
      <datalist id="dl-sources">${meta.sources.map((s) => html`<option value="${s}">`)}</datalist>
    </div>
    <div class="col-xl-4"><div class="card seg-preview"><div class="card-header">Live preview</div><div class="card-body" id="pv">${loading()}</div></div></div></div>`);
  $('#match', el).value = rules.match;

  const fieldOptions = Object.entries(meta.fields).map(([k, f]) => [k, f.label]);
  function valueInput(c, i) {
    const f = meta.fields[c.field];
    const type = f.ops[c.op];
    if (!type) return '';
    const attr = `data-i="${i}" data-k="value" aria-label="Value"`;
    if (c.field === 'status') return html`<select class="form-select form-select-sm" ${raw(attr)}>${[...meta.statuses, 'eligible'].map((s) => html`<option value="${s}" ${c.value === s ? raw('selected') : ''}>${STATUS_LABEL(s)}</option>`)}</select>`;
    if (c.field === 'list') return html`<select class="form-select form-select-sm" ${raw(attr)}>${meta.lists.map((l) => html`<option value="${l.id}" ${Number(c.value) === l.id ? raw('selected') : ''}>${l.name}</option>`)}</select>`;
    if (c.field === 'consent') return html`<select class="form-select form-select-sm" ${raw(attr)}>${meta.consentMethods.map((m) => html`<option value="${m}" ${c.value === m ? raw('selected') : ''}>${labelize(m)}</option>`)}</select>`;
    if (type === 'days') return html`<div class="input-group input-group-sm"><input class="form-control" type="number" min="1" max="3650" value="${c.value ?? 30}" ${raw(attr)}><span class="input-group-text">days</span></div>`;
    if (type === 'date') return html`<input class="form-control form-control-sm" type="date" value="${c.value || ''}" ${raw(attr)}>`;
    if (c.field === 'soft_bounces') return html`<input class="form-control form-control-sm" type="number" min="1" max="100" value="${c.value ?? 1}" ${raw(attr)}>`;
    return html`<input class="form-control form-control-sm" value="${c.value || ''}" maxlength="200" ${raw(c.field === 'source' ? 'list="dl-sources"' : '')} ${raw(attr)}>`;
  }
  function draw() {
    mount($('#conds', el), html`${rules.conditions.map((c, i) => {
      const f = meta.fields[c.field];
      return html`<div class="seg-row" role="group" aria-label="Condition ${i + 1}">
        <select class="form-select form-select-sm" data-i="${i}" data-k="field" aria-label="Field">${fieldOptions.map(([k, l]) => html`<option value="${k}" ${c.field === k ? raw('selected') : ''}>${l}</option>`)}</select>
        ${f.key ? html`<input class="form-control form-control-sm" data-i="${i}" data-k="key" value="${c.key || ''}" list="dl-attrs-${i}" placeholder="column, e.g. city" aria-label="Imported column">
          <datalist id="dl-attrs-${i}">${meta.attributes.map((a) => html`<option value="${a}">`)}</datalist>` : ''}
        <select class="form-select form-select-sm" data-i="${i}" data-k="op" aria-label="Condition">${Object.keys(f.ops).map((o) => html`<option value="${o}" ${c.op === o ? raw('selected') : ''}>${OPS[o]}</option>`)}</select>
        ${valueInput(c, i)}
        <button type="button" class="btn btn-sm btn-light" data-rm="${i}" aria-label="Remove condition ${i + 1}" ${rules.conditions.length < 2 ? raw('disabled') : ''}><i class="bi bi-x-lg"></i></button>
      </div>`;
    })}`);
    // Drop-downs (status, list, consent) show their first option: make that the value.
    $$('select[data-k="value"]', el).forEach((sel) => { rules.conditions[Number(sel.dataset.i)].value = sel.value; });
  }

  let pvTimer;
  async function preview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      try {
        const { data } = await post('/segments/preview', { rules });
        mount($('#pv', el), html`<div class="d-flex gap-3 mb-3">
            <div><div class="fs-3 fw-bold text-primary">${num(data.counts.total)}</div><div class="small text-muted-2">contacts match</div></div>
            <div><div class="fs-3 fw-bold text-success">${num(data.counts.eligible)}</div><div class="small text-muted-2">eligible to receive email</div></div></div>
          ${data.sample.length ? html`<div class="small fw-semibold mb-1">Examples</div><ul class="list-unstyled small mb-0">${data.sample.map((x) => html`<li class="d-flex justify-content-between gap-2 py-1 border-bottom"><span class="text-truncate">${x.name || x.email}</span><span class="text-muted-2">${STATUS_LABEL(x.status)}</span></li>`)}</ul>` : html`<p class="small text-muted-2 mb-0">Nobody matches yet.</p>`}`);
      } catch (err) {
        mount($('#pv', el), html`<p class="small text-danger mb-0">${err.details?.[0]?.message || err.message}</p>`);
      }
    }, 350);
  }

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'match') { rules.match = t.value; preview(); return; }
    if (t.dataset.i === undefined) return;
    const c = rules.conditions[Number(t.dataset.i)];
    if (t.dataset.k === 'field') {
      const ops = Object.keys(meta.fields[t.value].ops);
      Object.assign(c, { field: t.value, op: ops[0], value: undefined, key: undefined });
      if (meta.fields[t.value].ops[ops[0]] === 'days') c.value = 30;
      draw();
    } else if (t.dataset.k === 'op') {
      c.op = t.value;
      if (meta.fields[c.field].ops[c.op] === 'days' && !Number(c.value)) c.value = 30;
      draw();
    }
    preview();
  });
  el.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.i === undefined || !['value', 'key'].includes(t.dataset.k)) return;
    const c = rules.conditions[Number(t.dataset.i)];
    c[t.dataset.k] = t.type === 'number' ? Number(t.value) : t.value;
    preview();
  });
  el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { rules.conditions.splice(Number(rm.dataset.rm), 1); draw(); preview(); return; }
    if (e.target.closest('#add')) {
      rules.conditions.push({ field: 'status', op: 'is', value: 'active' });
      draw(); preview();
      $$('.seg-row select[data-k="field"]', el).pop()?.focus();
      return;
    }
    if (e.target.closest('#save')) {
      // Status/list/consent selects show a first option even before a change event: capture it.
      $$('select[data-k="value"]', el).forEach((s) => { rules.conditions[Number(s.dataset.i)].value = s.value; });
      const body = { name: $('#sn', el).value.trim(), description: $('#sd', el).value.trim(), rules };
      try {
        if (isNew) { const r = await post('/segments', body); toast('Segment saved'); ctx.navigate(`#/segments/${r.data.id}`); } else { await put(`/segments/${segId}`, body); toast('Segment saved'); }
      } catch (err) { errorToast(err); }
    }
  });
  draw();
  $$('select[data-k="value"]', el).forEach((s) => { rules.conditions[Number(s.dataset.i)].value = s.value; });
  preview();
  return () => clearTimeout(pvTimer);
}
