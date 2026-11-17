// Galleries of ready-made designs: campaign samples and template designs.
import { get } from './api.js';
import { html, raw, formModal } from './ui.js';

const cache = {};
const load = async (url) => { cache[url] ||= (await get(url)).data; return cache[url]; };

/** A radio-card gallery in a dialog. `onPick(id, item)` runs on confirm; throw to keep it open. */
function gallery({ title, intro, submitLabel, items, note, extra, onPick }) {
  formModal({
    title, submitLabel, size: 'modal-lg',
    body: html`${intro ? html`<p class="small text-muted-2">${intro}</p>` : ''}
      <fieldset><legend class="visually-hidden">Choose a starting design</legend>
      <div class="row g-2 sample-grid">${items.map((s, i) => html`<div class="col-sm-6">
        <input type="radio" class="btn-check" name="sample" id="smp-${s.id}" value="${s.id}" ${i === 0 ? raw('checked') : ''}>
        <label class="sample-card" for="smp-${s.id}">
          <i class="bi bi-${s.icon}" aria-hidden="true"></i>
          <span><strong>${s.name}</strong><span class="d-block small text-muted-2">${s.description}</span>
            ${extra ? extra(s) : ''}</span>
        </label></div>`)}</div></fieldset>
      ${note ? html`<p class="small text-muted-2 mt-3 mb-0">${note}</p>` : ''}`,
    onSubmit: async (fd) => {
      const id = String(fd.get('sample') || items[0].id);
      return onPick(id, items.find((s) => s.id === id));
    },
  });
}

/** Campaign samples (content designs). Each shows the template it uses. */
export async function pickSample({ title = 'Start a new campaign', intro = '', submitLabel = 'Create campaign', onPick }) {
  const items = await load('/campaigns/samples');
  gallery({
    title, intro, submitLabel, items, onPick,
    extra: (s) => (s.templateName ? html`<span class="d-block small mt-1 text-teal"><i class="bi bi-layout-text-window me-1"></i>Uses the ${s.templateName} template</span>` : ''),
    note: 'Every sample is fully editable. Replace the [bracketed] text, add your images and links, and the "Ready to send" checklist tells you what is still missing. You can change the template in the envelope section.',
  });
}

export const getSample = async (id) => (await get(`/campaigns/samples/${encodeURIComponent(id)}`)).data;

/** Template designs (the frame around campaigns). */
export async function pickTemplateSample({ onPick }) {
  const items = await load('/templates/samples');
  gallery({
    title: 'New template', submitLabel: 'Start designing', items, onPick,
    intro: 'Choose a starting design. You can change everything (logo, colours, width, font and footer) in the builder.',
    note: 'Tip: add your logo by selecting the image at the top and pasting its web address.',
  });
}

export const getTemplateSample = async (id) => (await get(`/templates/samples/${encodeURIComponent(id)}`)).data;
