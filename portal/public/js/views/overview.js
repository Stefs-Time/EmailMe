import { html, mount, loading, errorToast } from '../ui.js';

const PDF = '/downloads/mailharbor-overview.pdf';

/** Product overview: the marketing brochure (features + roadmap), viewable and downloadable. */
export async function render(el) {
  mount(el, loading());
  let info = { pages: 0, built: '' };
  try {
    info = await (await fetch('/downloads/overview/pages.json', { cache: 'no-store' })).json();
  } catch (err) { errorToast({ message: 'The product overview is not available.' }); }
  const v = encodeURIComponent(info.built || '1'); // cache-buster when the brochure is rebuilt
  const pages = Array.from({ length: info.pages }, (_, i) => i + 1);

  mount(el, html`<div class="page-head"><div><h1>Product overview</h1>
      <p>What MailHarbor does today, and what's coming next. Share it with your team, management or clients.</p></div>
      <div class="d-flex gap-2 flex-wrap">
        <a class="btn btn-outline-primary" href="${PDF}?v=${v}" target="_blank" rel="noopener"><i class="bi bi-box-arrow-up-right me-1"></i>Open PDF</a>
        <a class="btn btn-primary" href="${PDF}?v=${v}" download="MailHarbor-product-overview.pdf"><i class="bi bi-file-earmark-arrow-down me-1"></i>Download PDF</a>
      </div></div>
    <div class="overview-toc mb-3" role="navigation" aria-label="Pages">
      ${[['1', 'Cover'], ['2', 'Why MailHarbor'], ['3', 'Create'], ['4', 'Audience'], ['5', 'Deliver & protect'], ['6', 'Measure & run'], ['7', 'Roadmap'], ['8', 'Get started']]
        .filter(([n]) => Number(n) <= info.pages)
        .map(([n, l]) => html`<a class="btn btn-sm btn-light" href="#/overview" data-page="${n}">${n} · ${l}</a>`)}
    </div>
    <div class="overview-pages">
      ${pages.map((n) => html`<figure class="overview-page" id="ov-page-${n}">
        <img src="/downloads/overview/page-${n}.jpg?v=${v}" alt="Product overview, page ${n} of ${info.pages}" loading="${n <= 2 ? 'eager' : 'lazy'}" width="1191" height="1684">
        <figcaption class="small text-muted-2">Page ${n} of ${info.pages}</figcaption></figure>`)}
    </div>
    <p class="small text-muted-2 mt-2"><i class="bi bi-info-circle me-1"></i>A4, ${info.pages} pages${info.built ? `, updated ${info.built}` : ''}. The roadmap is indicative.</p>`);

  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-page]');
    if (!a) return;
    e.preventDefault();
    document.getElementById(`ov-page-${a.dataset.page}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
