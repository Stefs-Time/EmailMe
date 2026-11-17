import { get, post, put } from '../api.js';
import { html, mount, $, loading, toast, errorToast } from '../ui.js';

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const isNew = id === 'new';
  let t;
  if (isNew) {
    const { data: list } = await get('/templates');
    const base = list.find((x) => x.is_default) || list[0];
    t = { name: 'New template', html: base ? (await get(`/templates/${base.id}`)).data.html : '<html><body>{{ content }}</body></html>' };
  } else {
    t = (await get(`/templates/${id}`)).data;
  }
  mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/templates">Templates</a></li><li class="breadcrumb-item active">${t.name}</li></ol></nav>
    <div class="page-head"><div><h1>${isNew ? 'New template' : 'Edit template'}</h1>
      <p>Use <code>{{ content }}</code> for the campaign body, and tags such as <code>{{ org_name }}</code>, <code>{{ org_address }}</code>, <code>{{ unsubscribe_url }}</code>, <code>{{ view_url }}</code>, <code>{{ first_name }}</code>.</p></div>
      <div class="d-flex gap-2"><button class="btn btn-outline-primary" id="pv"><i class="bi bi-eye me-1"></i>Update preview</button><button class="btn btn-primary" id="save"><i class="bi bi-check-lg me-1"></i>Save</button></div></div>
    <div class="row g-3"><div class="col-xl-6"><div class="card"><div class="card-body">
      <label class="form-label" for="tn">Name</label><input class="form-control mb-3" id="tn" value="${t.name}" maxlength="120">
      <label class="form-label" for="th">HTML</label><textarea class="form-control mono editor-code border" id="th" spellcheck="false">${t.html}</textarea>
      <div class="form-text">Scripts, forms and embedded frames are removed when you save. Use inline styles or a &lt;style&gt; block; many email clients ignore external CSS.</div>
    </div></div></div>
    <div class="col-xl-6"><div class="card preview-card"><div class="card-header">Preview with sample content</div>
      <div class="preview-frame-wrap"><iframe id="preview" title="Template preview" sandbox="allow-popups"></iframe></div></div></div></div>`);
  const preview = async () => {
    try {
      const r = await post('/templates/preview', { html: $('#th', el).value });
      $('#preview', el).src = `/api/templates/preview/${r.data.id}`;
    } catch (err) { errorToast(err); }
  };
  $('#pv', el).addEventListener('click', preview);
  $('#save', el).addEventListener('click', async () => {
    try {
      const body = { name: $('#tn', el).value, html: $('#th', el).value };
      if (isNew) { const r = await post('/templates', body); toast('Template created'); location.hash = `#/templates/${r.data.id}`; } else { await put(`/templates/${id}`, body); toast('Template saved'); preview(); }
    } catch (err) { errorToast(err); }
  });
  preview();
}
