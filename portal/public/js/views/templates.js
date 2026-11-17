import { get, post, del } from '../api.js';
import { html, mount, $, datetime, loading, empty, toast, errorToast, confirmModal } from '../ui.js';
import { pickTemplateSample } from '../samples.js';

export async function render(el, ctx) {
  const canWrite = ctx.can('templates:write');
  mount(el, html`<div class="page-head"><div><h1>Templates</h1><p>The frame around every campaign: your branding, layout and footer. Campaign content is placed where the template says <code>{{ content }}</code>.</p></div>
    ${canWrite ? html`<button class="btn btn-primary" id="new-tpl"><i class="bi bi-plus-lg me-1"></i>New template</button>` : ''}</div>
    <div class="card" id="t">${loading()}</div>`);
  async function load() {
    const { data } = await get('/templates');
    if (!data.length) { mount($('#t', el), empty('layout-text-window', 'No templates')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>Template</th><th>Used by</th><th>Updated</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
      ${data.map((t) => html`<tr><td><a class="fw-semibold text-decoration-none" href="${canWrite ? `#/templates/${t.id}` : `/api/templates/${t.id}`}">${t.name}</a>${t.is_default ? html` <span class="badge text-bg-primary">Default</span>` : ''}${t.editor === 'builder' ? html` <span class="badge text-bg-light"><i class="bi bi-grid-1x2 me-1"></i>Builder</span>` : ''}${t.sample_key ? html` <span class="badge text-bg-light"><i class="bi bi-stars me-1"></i>Ready-made</span>` : ''}</td>
        <td class="small">${t.used_by} campaign(s)</td><td class="small">${datetime(t.updated_at)}</td>
        <td class="text-end text-nowrap">${canWrite && !t.is_default ? html`<button class="btn btn-sm btn-light" data-default="${t.id}">Make default</button>
          <button class="btn btn-sm btn-light text-danger" data-del="${t.id}" aria-label="Delete ${t.name}"><i class="bi bi-trash3"></i></button>` : ''}</td></tr>`)}
      </tbody></table></div>`);
  }
  $('#new-tpl', el)?.addEventListener('click', () => pickTemplateSample({
    onPick: async (sampleId) => { location.hash = `#/templates/new?sample=${encodeURIComponent(sampleId)}`; },
  }).catch(errorToast));
  el.addEventListener('click', async (e) => {
    const d = e.target.closest('[data-default]');
    const x = e.target.closest('[data-del]');
    try {
      if (d) { await post(`/templates/${d.dataset.default}/default`); toast('Default template changed'); load(); }
      if (x) {
        if (!(await confirmModal({ title: 'Delete template?', danger: true, confirmLabel: 'Delete', message: 'Campaigns that already used it keep their sent emails; drafts must use another template.' }))) return;
        await del(`/templates/${x.dataset.del}`); toast('Template deleted'); load();
      }
    } catch (err) { errorToast(err); }
  });
  await load();
}
