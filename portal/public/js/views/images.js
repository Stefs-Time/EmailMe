import { get, del } from '../api.js';
import { html, mount, $, loading, empty, toast, errorToast, confirmModal, num } from '../ui.js';
import { uploadImages, imageCard, kb } from '../images.js';

/** Image library: upload (auto-compressed, stored in the database), copy links, delete. */
export async function render(el, ctx) {
  const canWrite = ctx.can('templates:write');
  let q = '';
  mount(el, html`<div class="page-head"><div><h1>Images</h1>
      <p>Your logos, banners and product photos. Uploads are resized for email and compressed automatically, then stored safely in MailHarbor (and included in backups).</p></div></div>
    ${canWrite ? html`<div class="img-drop mb-3" id="drop">
      <i class="bi bi-cloud-arrow-up fs-3"></i>
      <div><label class="btn btn-primary mb-0" for="file"><i class="bi bi-upload me-1"></i>Upload images</label>
        <input class="visually-hidden" type="file" id="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
        <span class="small text-muted-2 ms-2">or drag and drop up to 10 at a time. JPG, PNG, GIF or WebP, up to 15 MB each.</span></div>
    </div>` : ''}
    <div class="card"><div class="card-body border-bottom d-flex flex-wrap gap-2 align-items-center">
      <input class="form-control search mw-520" id="q" placeholder="Search by name" aria-label="Search images">
      <span class="small text-muted-2 ms-auto" id="usage"></span></div>
      <div class="card-body" id="grid">${loading()}</div></div>`);

  async function load() {
    const r = await get(`/images?per_page=100${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    const s = r.meta.storage;
    $('#usage', el).textContent = s.count
      ? `${num(s.count)} image(s) · ${kb(s.bytes)} stored (${kb(s.original_bytes)} before compression, ${Math.round((1 - s.bytes / Math.max(1, s.original_bytes)) * 100)}% saved)`
      : '';
    if (!r.data.length) {
      mount($('#grid', el), empty('images', q ? 'No images match' : 'No images yet', q ? '' : 'Upload your logo and campaign images. Then pick them from the image block in the builder.'));
      return;
    }
    mount($('#grid', el), html`<div class="img-grid">${r.data.map((i) => html`<div class="img-item">${imageCard(i)}
      <div class="img-actions">
        <button class="btn btn-sm btn-light" data-copy="${i.url}" title="Copy the image address"><i class="bi bi-link-45deg me-1"></i>Copy link</button>
        ${canWrite ? html`<button class="btn btn-sm btn-light" data-del="${i.id}" data-name="${i.name}" aria-label="Delete ${i.name}"><i class="bi bi-trash3"></i></button>` : ''}
      </div></div>`)}</div>`);
  }

  async function handle(files) {
    if (!files?.length) return;
    $('#drop', el)?.classList.add('busy');
    try { await uploadImages(files); await load(); } catch (err) { errorToast(err); } finally { $('#drop', el)?.classList.remove('busy'); }
  }
  $('#file', el)?.addEventListener('change', (e) => handle(e.target.files));
  const drop = $('#drop', el);
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); });
  }
  let t;
  $('#q', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); load(); }, 250); });
  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) {
      try { await navigator.clipboard.writeText(c.dataset.copy); toast('Image address copied'); } catch { toast(c.dataset.copy, 'info'); }
      return;
    }
    const d = e.target.closest('[data-del]');
    if (d) {
      const ok = await confirmModal({ title: 'Delete image?', danger: true, confirmLabel: 'Delete',
        message: `"${d.dataset.name}" will be removed. Images used by a campaign or template can't be deleted.` });
      if (!ok) return;
      try { await del(`/images/${d.dataset.del}`); toast('Image deleted'); load(); } catch (err) { errorToast(err); }
    }
  });
  await load();
  return () => clearTimeout(t);
}
