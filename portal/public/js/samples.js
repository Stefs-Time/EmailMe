// Gallery of ready-made campaign designs (samples).
import { get } from './api.js';
import { html, raw, formModal } from './ui.js';

const cache = {};
const load = async (url) => { cache[url] ||= (await get(url)).data; return cache[url]; };

/** A radio-card gallery in a dialog. `onPick(id, item)` runs on confirm; throw to keep it open. */
function gallery({ title, intro, submitLabel, items, note, onPick }) {
  formModal({
    title, submitLabel, size: 'modal-lg',
    body: html`${intro ? html`<p class="small text-muted-2">${intro}</p>` : ''}
      <fieldset><legend class="visually-hidden">Choose a starting design</legend>
      <div class="row g-2 sample-grid">${items.map((s, i) => html`<div class="col-sm-6">
        <input type="radio" class="btn-check" name="sample" id="smp-${s.id}" value="${s.id}" ${i === 0 ? raw('checked') : ''}>
        <label class="sample-card" for="smp-${s.id}">
          <i class="bi bi-${s.icon}" aria-hidden="true"></i>
          <span><strong>${s.name}</strong><span class="d-block small text-muted-2">${s.description}</span>
</span>
        </label></div>`)}</div></fieldset>
      ${note ? html`<p class="small text-muted-2 mt-3 mb-0">${note}</p>` : ''}`,
    onSubmit: async (fd) => {
      const id = String(fd.get('sample') || items[0].id);
      return onPick(id, items.find((s) => s.id === id));
    },
  });
}

/** Campaign samples (content designs). Every email gets the header and footer from Settings → Email design. */
export async function pickSample({ title = 'Start a new campaign', intro = '', submitLabel = 'Create campaign', onPick }) {
  const items = await load('/campaigns/samples');
  gallery({
    title, intro, submitLabel, items, onPick,
    note: 'Every sample is fully editable. Replace the [bracketed] text, add your images and links, and the "Review & send" checklist tells you what is still missing. Your logo, colours and footer are added automatically.',
  });
}

export const getSample = async (id) => (await get(`/campaigns/samples/${encodeURIComponent(id)}`)).data;
