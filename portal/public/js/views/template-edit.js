import { get, post, put } from '../api.js';
import { html, mount, $, $$, loading, toast, errorToast, confirmModal } from '../ui.js';
import { createBuilder } from '../builder.js';
import { enableTagChips } from '../tags.js';
import { getTemplateSample } from '../samples.js';

/** Starting design for a new template: name header, campaign content, footer. */
const STARTER = {
  version: 1,
  settings: {},
  blocks: [
    { id: 't1', type: 'heading', props: { text: '{{ org_name }}', level: 3, pad: 16 } },
    { id: 't2', type: 'content', props: {} },
    { id: 't3', type: 'footer', props: {} },
  ],
};

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const isNew = id === 'new';
  let t;
  if (isNew) {
    // Started from a ready-made design (Templates → New template → gallery)?
    const sampleId = ctx.query().get('sample');
    const sample = sampleId ? await getTemplateSample(sampleId).catch(() => null) : null;
    t = { name: sample && sample.id !== 'standard' ? `${sample.name} (my copy)` : 'New template', editor: 'builder', body_json: sample?.doc || STARTER, html: '' };
  } else {
    t = (await get(`/templates/${id}`)).data;
  }
  let editor = t.editor === 'builder' ? 'builder' : 'html';
  let builder = null;
  let dirty = false;
  let previewTimer;

  mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/templates">Templates</a></li><li class="breadcrumb-item active">${t.name}</li></ol></nav>
    <div class="page-head"><div><h1>${isNew ? 'New template' : 'Edit template'}</h1>
      <p>The frame around every campaign that uses it: header, colours, width and footer. <span id="tstate" aria-live="polite"></span></p></div>
      <div class="d-flex gap-2"><button class="btn btn-outline-primary" id="pv"><i class="bi bi-eye me-1"></i>Update preview</button><button class="btn btn-primary" id="save"><i class="bi bi-check-lg me-1"></i>Save</button></div></div>
    <div class="card mb-3"><div class="card-body d-flex flex-wrap gap-3 align-items-end">
      <div class="flex-grow-1 mw-520"><label class="form-label" for="tn">Name</label><input class="form-control" id="tn" value="${t.name}" maxlength="120"></div>
      <div class="nav nav-pills" role="group" aria-label="Editor mode">
        <button type="button" class="nav-link py-1 px-2" data-tab="builder" aria-pressed="false"><i class="bi bi-grid-1x2 me-1"></i>Builder</button>
        <button type="button" class="nav-link py-1 px-2" data-tab="html" aria-pressed="false">HTML</button>
      </div>
    </div></div>
    <div class="card mb-3" id="builder-card"><div id="builder"></div>
      <div class="card-footer small text-muted-2">Drag blocks above or below <strong>Campaign content</strong> to build the header and footer. Click empty space for page settings.</div></div>
    <div class="card mb-3 d-none" id="html-card"><div class="card-body">
      <label class="form-label" for="th">HTML</label><textarea class="form-control mono editor-code border" id="th" data-taggable spellcheck="false">${t.html}</textarea>
      <div class="form-text">Use <code>{{ content }}</code> for the campaign body, and tags such as <code>{{ org_name }}</code>, <code>{{ org_address }}</code>, <code>{{ unsubscribe_url }}</code>, <code>{{ view_url }}</code>.
        Scripts, forms and embedded frames are removed when you save. Use inline styles; many email clients ignore external CSS.</div>
    </div></div>
    <div class="card preview-card"><div class="card-header d-flex align-items-center">Preview <span class="small text-muted-2 ms-2">with sample content</span>
      <div class="btn-group btn-group-sm ms-auto" role="group" aria-label="Preview width">
        <button type="button" class="btn btn-outline-secondary active" data-width="100%">Desktop</button>
        <button type="button" class="btn btn-outline-secondary" data-width="375px">Mobile</button></div></div>
      <div class="preview-frame-wrap"><iframe id="preview" title="Template preview" sandbox="allow-popups"></iframe></div></div>`);

  const state = $('#tstate', el);
  const setDirty = (v) => { dirty = v; state.textContent = v ? '· Unsaved changes' : ''; };
  const payload = () => ({
    name: $('#tn', el).value, editor,
    ...(editor === 'builder' ? { body_json: builder.getDoc() } : { html: $('#th', el).value }),
  });
  const startBuilder = (doc) => {
    builder = createBuilder($('#builder', el), doc, {
      mode: 'template',
      onChange: () => { setDirty(true); clearTimeout(previewTimer); previewTimer = setTimeout(preview, 1200); },
    });
  };

  async function preview() {
    clearTimeout(previewTimer);
    try {
      const r = await post('/templates/preview', payload());
      $('#preview', el).src = `/api/templates/preview/${r.data.id}`;
      return r.data.html;
    } catch (err) { errorToast(err); return null; }
  }

  function showPane(tab) {
    $$('[data-tab]', el).forEach((x) => { const on = x.dataset.tab === tab; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    $('#builder-card', el).classList.toggle('d-none', tab !== 'builder');
    $('#html-card', el).classList.toggle('d-none', tab !== 'html');
  }

  el.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (tab && tab !== editor) {
      if (tab === 'html') {
        const ok = await confirmModal({ title: 'Convert the design to HTML?', confirmLabel: 'Convert to HTML',
          message: 'The design becomes HTML code that you edit directly. Going back to the builder later starts a new design.' });
        if (!ok) return;
        const rendered = await preview();
        if (rendered === null) return;
        $('#th', el).value = rendered;
      } else {
        const ok = await confirmModal({ title: 'Start a design in the builder?', confirmLabel: 'Use the builder',
          message: 'The builder starts from the standard design (header, campaign content, footer). Your current HTML is replaced when you save.' });
        if (!ok) return;
        startBuilder(STARTER);
      }
      editor = tab;
      setDirty(true);
      showPane(tab);
      preview();
    }
    const w = e.target.closest('[data-width]');
    if (w) {
      $('#preview', el).style.width = w.dataset.width;
      $$('[data-width]', el).forEach((x) => x.classList.toggle('active', x === w));
    }
  });
  $('#tn', el).addEventListener('input', () => setDirty(true));
  $('#th', el).addEventListener('input', () => setDirty(true));
  $('#pv', el).addEventListener('click', preview);
  $('#save', el).addEventListener('click', async () => {
    try {
      if (isNew) {
        const r = await post('/templates', payload());
        setDirty(false);
        toast('Template created');
        location.hash = `#/templates/${r.data.id}`;
      } else {
        await put(`/templates/${id}`, payload());
        setDirty(false);
        toast('Template saved');
        preview();
      }
    } catch (err) { errorToast(err); }
  });

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  if (editor === 'builder') startBuilder(t.body_json || STARTER);
  const stopTags = enableTagChips(el, { fallback: () => (editor === 'builder' ? builder?.selectedEditable() : null) });
  showPane(editor);
  preview();
  return () => { window.removeEventListener('beforeunload', beforeUnload); stopTags(); };
}
