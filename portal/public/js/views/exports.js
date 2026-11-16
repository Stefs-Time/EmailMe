import { download } from '../api.js';
import { html, mount, $, toast } from '../ui.js';

const EXPORTS = [
  { id: 'contacts', icon: 'people', title: 'All contacts', path: '/exports/contacts.csv', range: false,
    text: 'Every contact with status, lists, source, consent, bounce counts and suppression details. Tip: filter on the Contacts page and use "Export view" for a subset.' },
  { id: 'eligible', icon: 'send-check', title: 'Eligible contacts only', path: '/exports/contacts.csv?status=eligible', range: false,
    text: 'Only contacts who would receive your next campaign.' },
  { id: 'suppressions', icon: 'slash-circle', title: 'Suppression list', path: '/exports/suppressions.csv', range: false,
    text: 'All suppressed addresses and why. Share with any other system that sends email on your behalf.' },
  { id: 'consent', icon: 'patch-check', title: 'Consent & unsubscribe history', path: '/exports/consent.csv', range: true,
    text: 'POPIA evidence: when and how permission was obtained or withdrawn, and who recorded it.' },
  { id: 'events', icon: 'clock-history', title: 'Recipient status history', path: '/exports/events.csv', range: true,
    text: 'Every status change: imports, unsubscribes, bounces, suppressions and reactivations.' },
  { id: 'bounces', icon: 'arrow-return-left', title: 'Bounce log', path: '/exports/bounces.csv', range: true,
    text: 'Each bounce with its classification, SMTP status code and the action taken.' },
  { id: 'campaigns', icon: 'envelope-paper', title: 'Campaign report', path: '/reports/campaigns.csv', range: false,
    text: 'Targeted, sent, failures, bounces, complaints, unsubscribes, opens and clicks per campaign.' },
  { id: 'audit', icon: 'shield-check', title: 'Audit log', path: '/exports/audit.csv', range: true, perm: 'audit:read',
    text: 'Administrative actions by portal users (administrators only).' },
];

export async function render(el, ctx) {
  mount(el, html`<div class="page-head"><div><h1>Exports</h1><p>Download CSV files that open directly in Excel or Google Sheets. Every export is recorded in the audit log.</p></div></div>
    <div class="card mb-3"><div class="card-body d-flex flex-wrap gap-3 align-items-end">
      <div><label class="form-label small mb-1" for="from">From (optional)</label><input type="date" class="form-control" id="from"></div>
      <div><label class="form-label small mb-1" for="to">To (optional)</label><input type="date" class="form-control" id="to"></div>
      <div class="small text-muted-2 pb-2">Applies to exports marked <i class="bi bi-calendar-range"></i></div></div></div>
    <div class="row g-3">${EXPORTS.filter((x) => !x.perm || ctx.can(x.perm)).map((x) => html`<div class="col-md-6 col-xl-4"><div class="card export-card h-100"><div class="card-body d-flex flex-column">
      <div class="d-flex gap-3 align-items-start mb-2"><i class="bi bi-${x.icon}"></i><div><div class="fw-semibold">${x.title} ${x.range ? html`<i class="bi bi-calendar-range text-muted-2 small" title="Date range applies"></i>` : ''}</div>
        <div class="small text-muted-2">${x.text}</div></div></div>
      <button class="btn btn-outline-primary mt-auto align-self-start" data-x="${x.id}"><i class="bi bi-download me-1"></i>Download CSV</button></div></div></div>`)}</div>
    <div class="alert alert-info mt-3 small"><i class="bi bi-person-vcard me-1"></i>For a single person's access request (POPIA s23), open the contact and use <strong>Data export</strong>.
      Personal information in exports must be stored and shared securely.</div>`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x]');
    if (!b) return;
    const x = EXPORTS.find((y) => y.id === b.dataset.x);
    let path = x.path;
    if (x.range) {
      const p = new URLSearchParams();
      if ($('#from', el).value) p.set('from', $('#from', el).value);
      if ($('#to', el).value) p.set('to', new Date(new Date($('#to', el).value).getTime() + 86400000).toISOString().slice(0, 10));
      if ([...p].length) path += `?${p}`;
    }
    download(path);
    toast(`${x.title} is downloading`);
  });
}
