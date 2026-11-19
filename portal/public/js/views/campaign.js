import { get, post } from '../api.js';
import { html, mount, $, num, pct, datetime, loading, campStatus, toast, errorToast, confirmModal } from '../ui.js';
import { stackedBars } from '../charts.js';
import { bounceBadge } from './dashboard.js';

export async function render(el, ctx, [id]) {
  let chart;
  let timer;
  mount(el, loading());

  async function draw() {
    const [{ data }, { data: meta }] = await Promise.all([get(`/reports/campaigns/${id}`), get(`/campaigns/${id}`)]);
    const c = data.campaign;
    if (c.status === 'draft' && ctx.can('campaigns:write')) { location.hash = `#/campaigns/${id}/edit`; return; }
    // Every number opens the recipients behind it (#/details).
    const tiles = [
      ['Recipients', c.targeted, 'people', null, 'all'],
      ['Sent', c.sent, 'send-check', null, 'sent'],
      ['Delivery failures', c.delivery_failures, 'exclamation-triangle', c.rates.bounce, 'bounced'],
      ['Hard bounces', c.hard_bounces, 'x-octagon', null, 'hard'],
      ['Soft bounces', c.soft_bounces, 'arrow-repeat', null, 'soft'],
      ['Needs review', c.review_bounces, 'hourglass-split', null, 'review'],
      ['Complaints', c.complaints, 'flag', c.rates.complaint, 'complaint'],
      ['Unsubscribes', c.unsubscribes, 'envelope-x', c.rates.unsubscribe, 'unsubscribed'],
      ['Unique opens', c.unique_opens, 'envelope-open', c.rates.open, 'opened'],
      ['Unique clicks', c.unique_clicks, 'cursor', c.rates.click, 'clicked'],
      // Only shown when they happened, or the campaign used the page
      ...(c.failed + c.skipped ? [['Not sent', c.failed + c.skipped, 'slash-circle', null, c.failed ? 'failed' : 'skipped']] : []),
      ...(c.consented ? [['Gave permission', c.consented, 'person-check', null, 'consented']] : []),
      ...(c.stayed ? [['Stayed subscribed', c.stayed, 'hand-thumbs-up', null, 'stayed']] : []),
      ...(c.preference_changes ? [['Preference changes', c.preference_changes, 'sliders', null, 'preferences']] : []),
    ];
    const detail = (outcome, extra = '') => `#/details?kind=recipients&campaign=${id}&outcome=${outcome}${extra}`;
    const done = c.sent + c.failed + c.skipped;
    const progress = c.targeted ? (done / c.targeted) * 100 : 0;
    const canSend = ctx.can('campaigns:send');
    chart?.destroy();
    mount(el, html`<nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/campaigns">Campaigns</a></li><li class="breadcrumb-item active">${c.name}</li></ol></nav>
      <div class="page-head"><div><h1 class="d-flex gap-2 align-items-center flex-wrap">${c.name} ${campStatus(c.status)}</h1>
        <p>“${c.subject}” · ${c.lists.join(', ') || '–'} · ${c.status === 'scheduled' ? `scheduled for ${datetime(c.send_at)}` : c.started_at ? `started ${datetime(c.started_at)}` : ''}${c.finished_at ? ` · finished ${datetime(c.finished_at)}` : ''}</p></div>
        <div class="d-flex gap-2 flex-wrap">
          ${canSend && c.status === 'sending' ? html`<button class="btn btn-outline-primary" data-act="pause"><i class="bi bi-pause-fill me-1"></i>Pause</button>` : ''}
          ${canSend && c.status === 'paused' ? html`<button class="btn btn-teal" data-act="resume"><i class="bi bi-play-fill me-1"></i>Resume</button>` : ''}
          ${canSend && ['sending', 'paused', 'scheduled'].includes(c.status) ? html`<button class="btn btn-outline-danger" data-act="cancel"><i class="bi bi-x-circle me-1"></i>Cancel</button>` : ''}
          ${ctx.can('campaigns:write') && c.status === 'scheduled' ? html`<a class="btn btn-outline-primary" href="#/campaigns/${id}/edit"><i class="bi bi-pencil me-1"></i>Edit</a>` : ''}
          ${ctx.can('campaigns:write') ? html`<button class="btn btn-light" data-act="duplicate"><i class="bi bi-copy me-1"></i>Duplicate</button>` : ''}
          <a class="btn btn-light" href="/api/campaigns/${id}/preview" target="_blank" rel="noopener"><i class="bi bi-eye me-1"></i>View email</a>
        </div></div>
      ${c.status === 'paused' && meta.pause_reason ? html`<div class="alert-item warning"><i class="bi bi-pause-circle-fill"></i><div><strong>Paused.</strong> ${meta.pause_reason}</div></div>` : ''}
      ${['sending', 'paused'].includes(c.status) ? html`<div class="card mb-3"><div class="card-body"><div class="d-flex justify-content-between small mb-1">
        <span>${c.status === 'sending' ? 'Sending… this page updates automatically' : 'Paused'}</span><span>${num(done)} of ${num(c.targeted)} processed · ${num(c.pending)} waiting</span></div>
        <div class="hbar" role="progressbar" aria-valuenow="${Math.round(progress)}" aria-valuemin="0" aria-valuemax="100"><span data-w="${progress}"></span></div></div></div>` : ''}
      <div class="row g-3 mb-3">${tiles.map(([l, v, icon, rate, outcome]) => html`<div class="col-6 col-md-4 col-xl"><a class="card kpi kpi-link" href="${detail(outcome)}" aria-label="${l}: ${num(v)}. Show the recipients">
        <div class="label"><i class="bi bi-${icon}"></i>${l}</div><div class="value">${num(v)}</div><div class="sub">${rate !== null && rate !== undefined ? `${pct(rate)} of sent` : 'Show recipients'}</div></a></div>`)}</div>
      <div class="row g-3">
        <div class="col-xl-7"><div class="card h-100"><div class="card-header">Activity by hour</div><div class="card-body">
          ${data.timeline.length ? html`<div class="chart-box"><canvas id="tl" role="img" aria-label="Emails sent, opens, clicks and bounces by hour"></canvas></div>` : html`<div class="text-muted-2">No activity yet.</div>`}</div></div></div>
        <div class="col-xl-5"><div class="card h-100"><div class="card-header">Links clicked</div>
          ${data.links.length ? html`<div class="table-responsive"><table class="table table-sm"><thead><tr><th>Link</th><th class="num">Clicks</th><th class="num">People</th></tr></thead><tbody>
            ${data.links.map((l) => html`<tr><td class="small text-truncate mono" title="${l.url}">${l.url}</td><td class="num">${num(l.clicks)}</td>
              <td class="num">${l.unique_clicks ? html`<a class="num-link" href="${detail('clicked', `&link=${l.id}`)}" aria-label="${num(l.unique_clicks)} people clicked ${l.url}">${num(l.unique_clicks)}</a>` : '0'}</td></tr>`)}</tbody></table></div>`
            : html`<div class="card-body text-muted-2">No tracked links in this email.</div>`}</div></div>
      </div>
      <div class="card mt-3"><div class="card-header d-flex justify-content-between">Bounced recipients ${data.bounces.length ? html`<a class="small fw-normal" href="#/details?kind=bounces&campaign=${id}">View all</a>` : ''}</div>
        ${data.bounces.length ? html`<div class="table-responsive"><table class="table table-sm table-hover"><thead><tr><th>Contact</th><th>Type</th><th>Reason</th><th>Action</th><th>When</th></tr></thead><tbody>
          ${data.bounces.map((b) => html`<tr class="row-link" data-href="#/contacts/${b.contact_id}"><td class="cell-email">${b.email || '[deleted]'}</td><td>${bounceBadge(b.classification)}</td>
            <td class="small">${b.reason}${b.enhanced_code ? html` <span class="mono">${b.enhanced_code}</span>` : ''}<div class="text-muted-2">via ${b.source}</div></td>
            <td class="small">${String(b.action_taken).replace(/_/g, ' ')}</td><td class="small text-nowrap">${datetime(b.bounced_at)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body text-muted-2">No bounces.</div>`}</div>
      ${data.failures.length ? html`<div class="card mt-3"><div class="card-header d-flex justify-content-between">Not delivered or skipped <a class="small fw-normal" href="${detail(c.failed ? 'failed' : 'skipped')}">View all</a></div><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Recipient</th><th>Status</th><th>Detail</th><th>When</th></tr></thead><tbody>
        ${data.failures.map((f) => html`<tr><td class="cell-email">${f.email || '[deleted]'}</td><td class="text-capitalize">${f.status}</td><td class="small">${f.error || ''}</td><td class="small text-nowrap">${datetime(f.updated_at)}</td></tr>`)}</tbody></table></div></div>` : ''}`);

    if (data.timeline.length) {
      const hours = [...new Set(data.timeline.map((t) => t.at))].sort();
      const series = (kind) => hours.map((h) => data.timeline.find((t) => t.at === h && t.kind === kind)?.n || 0);
      chart = stackedBars($('#tl', el), hours.map((h) => new Date(h).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit' })), [
        { key: 'added', label: 'Sent', data: series('sent') },
        { key: 'opens', label: 'Opens', data: series('open') },
        { key: 'clicks', label: 'Clicks', data: series('click') },
        { key: 'bounces', label: 'Bounces', data: series('bounce') },
      ]);
    }
    clearTimeout(timer);
    if (c.status === 'sending') timer = setTimeout(() => draw().catch(() => {}), 5000);
  }

  el.addEventListener('click', async (e) => {
    const row = e.target.closest('[data-href]');
    if (row) { location.hash = row.dataset.href; return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === 'cancel') {
        const ok = await confirmModal({ title: 'Cancel this campaign?', danger: true, confirmLabel: 'Cancel campaign',
          message: 'Emails not yet sent will not be sent. Emails already delivered cannot be recalled. This cannot be undone (you can duplicate the campaign later).' });
        if (!ok) return;
      }
      if (act === 'duplicate') {
        const r = await post(`/campaigns/${id}/duplicate`);
        toast('Copy created');
        location.hash = `#/campaigns/${r.data.id}/edit`;
        return;
      }
      await post(`/campaigns/${id}/${act}`);
      toast({ pause: 'Campaign paused', resume: 'Sending resumed', cancel: 'Campaign cancelled' }[act]);
      await draw();
    } catch (err) { errorToast(err); }
  });

  await draw();
  return () => { clearTimeout(timer); chart?.destroy(); };
}
