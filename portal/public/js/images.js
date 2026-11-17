// Image library helpers: upload and a picker dialog (used by the builder).
import { api, get } from './api.js';
import { html, raw, mount, $, formModal, toast } from './ui.js';

export const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Uploads files; returns the stored images and shows a toast with the result. */
export async function uploadImages(files) {
  const form = new FormData();
  [...files].slice(0, 10).forEach((f) => form.append('files', f));
  const r = await api('POST', '/images', undefined, { form });
  const ok = r.data.filter((x) => x.ok);
  const failed = r.data.filter((x) => !x.ok);
  if (ok.length) {
    const before = ok.reduce((a, x) => a + x.image.original_bytes, 0);
    const after = ok.reduce((a, x) => a + x.image.bytes, 0);
    toast(`${ok.length} image(s) ready: ${kb(before)} → ${kb(after)} after compression`);
  }
  failed.forEach((x) => toast(`${x.name}: ${x.error}`, 'warning'));
  return ok.map((x) => x.image);
}

export const imageCard = (img, { selectable = false } = {}) => html`
  ${selectable ? html`<input type="radio" class="btn-check" name="image" id="img-${img.id}" value="${img.id}">` : ''}
  <${raw(selectable ? 'label' : 'div')} class="img-card" ${selectable ? raw(`for="img-${img.id}"`) : ''}>
    <span class="img-thumb"><img src="${img.path}" alt="" loading="lazy"></span>
    <span class="img-meta"><span class="img-name" title="${img.name}">${img.name}</span>
      <span class="small text-muted-2">${img.width}×${img.height} · ${kb(img.bytes)}</span></span>
  </${raw(selectable ? 'label' : 'div')}>`;

/**
 * Picker dialog: choose a library image or upload new ones.
 * onPick(image) receives { url, name, width, height, ... }.
 */
export async function pickImage({ onPick }) {
  let images = (await get('/images?per_page=60')).data;
  const grid = () => (images.length
    ? html`<div class="img-grid">${images.map((i) => html`<div>${imageCard(i, { selectable: true })}</div>`)}</div>`
    : html`<div class="text-center text-muted-2 py-4"><i class="bi bi-images fs-2 d-block mb-2"></i>No images yet. Upload your first one above.</div>`);
  formModal({
    title: 'Choose an image', submitLabel: 'Use this image', size: 'modal-lg',
    body: html`<div class="img-drop mb-3" id="img-drop">
        <i class="bi bi-cloud-arrow-up fs-4"></i>
        <div><label class="btn btn-sm btn-outline-primary mb-0" for="img-file">Upload images</label>
          <input class="visually-hidden" type="file" id="img-file" accept="image/jpeg,image/png,image/gif,image/webp" multiple>
          <span class="small text-muted-2 ms-2">or drop them here. JPG, PNG, GIF or WebP, up to 15 MB. Compressed automatically for email.</span></div>
      </div>
      <fieldset><legend class="visually-hidden">Library</legend><div id="img-grid">${grid()}</div></fieldset>`,
    onSubmit: async (fd) => {
      const chosen = images.find((i) => String(i.id) === String(fd.get('image')));
      if (!chosen) throw { message: 'Select an image first (or upload one).' };
      onPick(chosen);
    },
  });
  const modalEl = document.getElementById('modal');
  const refresh = (selectId) => {
    mount($('#img-grid', modalEl), grid());
    if (selectId) { const r = $(`#img-${selectId}`, modalEl); if (r) r.checked = true; }
  };
  const handle = async (files) => {
    if (!files?.length) return;
    $('#img-drop', modalEl).classList.add('busy');
    try {
      const added = await uploadImages(files);
      images = [...added, ...images.filter((i) => !added.some((a) => a.id === i.id))];
      refresh(added[0]?.id);
    } catch (err) { toast(err.message, 'danger'); } finally { $('#img-drop', modalEl)?.classList.remove('busy'); }
  };
  $('#img-file', modalEl).addEventListener('change', (e) => handle(e.target.files));
  const drop = $('#img-drop', modalEl);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); });
}
