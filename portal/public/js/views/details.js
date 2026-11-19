// Report details: the people and events behind a number. Every report number links here
// (#/details?kind=…&…); the filters travel in the address, so a detail page can be bookmarked or shared.
import { get } from '../api.js';
import { html, mount, $, num, datetime, loading, errorBox, pager, label, CONSENT_LABELS } from '../ui.js';

const OUTCOME_TITLE = {
  all: 'All recipients', sent: 'Sent', failed: 'Failed to send', skipped: 'Not sent (skipped or cancelled)', pending: 'Still queued',
  bounced: 'Delivery failures (bounced)', hard: 'Hard bounces', soft: 'Soft bounces', review: 'Held for review', complaint: 'Complaints',
  opened: 'Opened', not_opened: 'Sent but not opened', clicked: 'Clicked', unsubscribed: 'Unsubscribed', consented: 'Gave permission',
  stayed: 'Stayed subscribed', preferences: 'Changed preferences',
};
const EVENT_TITLE = { unsubscribed: 'Unsubscribed', stayed_subscribed: 'Stayed subscribed', preferences_updated: 'Changed preferences',
  optin_confirmed: 'Confirmed opt-in', consent_given: 'Gave permission' };
const BOUNCE_TITLE = { hard: 'Hard bounces', soft: 'Soft bounces', review: 'Held for review', complaint: 'Complaints' };
const STATUS_TEXT = { sent: 'Sent', failed: 'Failed', unknown: 'Unknown', skipped: 'Skipped', cancelled: 'Cancelled', queued: 'Queued', sending: 'Sending' };

function titleFor(q, meta) {
  const kind = q.get('kind');
  const days = q.get('days');
  const period = q.get('day') ? ` on ${q.get('day')}` : days ? ` · last ${days} days` : '';
  if (kind === 'recipients') {
    const t = OUTCOME_TITLE[q.get('outcome') || 'all'] || 'Recipients';
    return meta.link ? `${t}: ${meta.link.url}` : t;
  }
  if (kind === 'bounces') {
    const parts = [BOUNCE_TITLE[q.get('classification')] || 'Bounces'];
    if (q.get('domain')) parts.push(`at ${q.get('domain')}`);
    if (q.get('code')) parts.push(`with response ${q.get('code')}`);
    return parts.join(' ') + period;
  }
  if (kind === 'events') return (EVENT_TITLE[q.get('type')] || 'Recipient actions') + period;
  const state = { sent: 'Emails sent', failed: 'Emails that failed', pending: 'Emails waiting to send' }[q.get('state')] || 'Emails';
  const mk = { campaign: 'campaign', test: 'test', optin: 'opt-in confirmation' }[q.get('message_kind')];
  return `${state}${mk ? ` (${mk})` : ''}${period}`;
}

function cell(row, key) {
  const v = row[key];
  switch (key) {
    case 'email':
      return row.contact_id ? html`<a href="#/contacts/${row.contact_id}">${v || '–'}</a>` : (v || '–');
    case 'campaign':
      return row.campaign_id ? html`<a href="#/campaigns/${row.campaign_id}">${v || `#${row.campaign_id}`}</a>` : '–';
    case 'status':
      return html`<span class="status s-${v === 'sent' ? 'active' : ['failed', 'unknown'].includes(v) ? 'hard_bounced' : 'unconfirmed'}">${STATUS_TEXT[v] || label(v)}</span>`;
    case 'sent_at': case 'bounced_at': case 'created_at': case 'at':
      return v ? datetime(v) : '–';
    case 'opens': case 'clicks':
      return v ? num(v) : '–';
    case 'event_type':
      return EVENT_TITLE[v] || label(v);
    case 'actions':
      return v ? v.split(', ').map((x) => EVENT_TITLE[x] || label(x)).join(', ') : '–';
    case 'classification': case 'kind':
      return label(v);
    case 'method':
      return CONSENT_LABELS[v] || label(v);
    default:
      return v === null || v === undefined || v === '' ? '–' : String(v);
  }
}

export async function render(el, ctx) {
  const q = ctx.query();
  if (!q.get('kind')) { location.hash = '#/reports'; return; }
  const state = { page: Number(q.get('page') || 1), q: q.get('q') || '' };
  mount(el, loading());

  async function load() {
    const params = new URLSearchParams(q);
    params.set('page', String(state.page));
    params.set('per_page', '50');
    if (state.q) params.set('q', state.q); else params.delete('q');
    let res;
    try { res = await get(`/reports/details?${params}`); } catch (err) { mount(el, errorBox(err)); return; }
    const { data: rows, meta } = res;
    const csv = new URLSearchParams(params);
    csv.delete('page'); csv.delete('per_page'); csv.set('format', 'csv');
    const back = meta.campaign ? html`<li class="breadcrumb-item"><a href="#/campaigns">Campaigns</a></li><li class="breadcrumb-item"><a href="#/campaigns/${meta.campaign.id}">${meta.campaign.name}</a></li>`
      : q.get('kind') === 'messages' ? html`<li class="breadcrumb-item"><a href="#/usage">Mail usage</a></li>`
        : html`<li class="breadcrumb-item"><a href="#/reports">Audience &amp; bounces</a></li>`;
    mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small">${back}<li class="breadcrumb-item active">Details</li></ol></nav>
      <div class="page-head"><div><h1 class="text-break">${titleFor(q, meta)}</h1><p>${num(meta.total)} ${meta.total === 1 ? 'row' : 'rows'}${meta.campaign ? html` · campaign <strong>${meta.campaign.name}</strong>` : ''}</p></div>
        ${ctx.can('exports:read') ? html`<div><a class="btn btn-outline-primary" href="/api/reports/details?${csv}" download><i class="bi bi-download me-1"></i>Download CSV</a></div>` : ''}</div>
      <div class="card">
        <div class="card-body border-bottom py-2"><form id="dq" class="d-flex gap-2" role="search">
          <label class="visually-hidden" for="dq-q">Search by email</label>
          <input class="form-control form-control-sm mw-320" id="dq-q" name="q" value="${state.q}" placeholder="Search by email">
          <button class="btn btn-sm btn-outline-secondary" type="submit">Search</button></form></div>
        ${rows.length ? html`<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0">
          <thead><tr>${meta.columns.map((c) => html`<th scope="col" class="${['opens', 'clicks'].includes(c.key) ? 'num' : ''}">${c.label}</th>`)}</tr></thead>
          <tbody>${rows.map((r) => html`<tr>${meta.columns.map((c) => html`<td class="${['opens', 'clicks'].includes(c.key) ? 'num' : ['reason', 'error', 'bounce'].includes(c.key) ? 'small text-break' : ''}">${cell(r, c.key)}</td>`)}</tr>`)}</tbody>
        </table></div>${pager(meta, (pg) => { state.page = pg; load(); })}`
        : html`<div class="empty"><i class="bi bi-inbox"></i>Nothing here${state.q ? ' for that search' : ''}.</div>`}
      </div>`);
    $('#dq', el).addEventListener('submit', (e) => {
      e.preventDefault();
      state.q = e.target.q.value.trim();
      state.page = 1;
      load();
    });
  }
  await load();
}
