// Sample gallery: pick a ready-made campaign design.
import { get } from './api.js';
import { html, raw, formModal } from './ui.js';

let cache = null;
const loadSamples = async () => { cache ||= (await get('/campaigns/samples')).data; return cache; };

/**
 * Opens the gallery. `onPick(sampleId)` runs when the user confirms; throw to
 * keep the dialog open with an error.
 */
export async function pickSample({ title = 'Start a new campaign', intro = '', submitLabel = 'Create campaign', onPick }) {
  const samples = await loadSamples();
  formModal({
    title, submitLabel, size: 'modal-lg',
    body: html`${intro ? html`<p class="small text-muted-2">${intro}</p>` : ''}
      <fieldset><legend class="visually-hidden">Choose a starting design</legend>
      <div class="row g-2 sample-grid">${samples.map((s, i) => html`<div class="col-sm-6">
        <input type="radio" class="btn-check" name="sample" id="smp-${s.id}" value="${s.id}" ${i === 0 ? raw('checked') : ''}>
        <label class="sample-card" for="smp-${s.id}">
          <i class="bi bi-${s.icon}" aria-hidden="true"></i>
          <span><strong>${s.name}</strong><span class="d-block small text-muted-2">${s.description}</span></span>
        </label></div>`)}</div></fieldset>
      <p class="small text-muted-2 mt-3 mb-0">Every sample is fully editable. Replace the [bracketed] text, add your images and links, and the
        "Ready to send" checklist tells you what is still missing.</p>`,
    onSubmit: async (fd) => onPick(String(fd.get('sample') || 'blank'), samples.find((s) => s.id === fd.get('sample'))),
  });
}

export const getSample = async (id) => (await get(`/campaigns/samples/${encodeURIComponent(id)}`)).data;
