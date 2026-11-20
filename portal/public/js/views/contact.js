import { get, post, patch, download } from '../api.js';
import { html, raw, mount, $, num, date, datetime, ago, statusBadge, loading, options, toast, errorToast, formModal,
  STATUS_INFO, label, CONSENT_LABELS, consentFields, consentFromForm } from '../ui.js';
import { bounceBadge } from './dashboard.js';

const EVENT_LABELS = {
  created: 'Contact created', imported: 'Imported', profile_updated: 'Details updated', lists_add: 'Added to list(s)',
  lists_remove: 'Removed from list(s)', lists_unsubscribe: 'Unsubscribed from list(s)', unsubscribed: 'Unsubscribed',
  suppressed: 'Suppressed', optin_confirmed: 'Confirmed subscription (double opt-in)', suppression_lifted: 'Suppression lifted',
  soft_bounce: 'Soft bounce', review_hold: 'Held for review', review_resolved: 'Review resolved', erased: 'Personal data erased',
};

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const [{ data: d }, { data: facets }, convs] = await Promise.all([get(`/contacts/${id}`), get('/contacts/facets'),
    ctx.can('inbox:read') ? get(`/inbox?contact=${id}&per_page=10`) : Promise.resolve({ data: [] })]);
  const c = d.contact;
  const a = c;
  const canWrite = ctx.can('contacts:write');
  const suppressed = Boolean(d.suppression);
  const custom = Object.entries(c.attribs || {});

  mount(el, html`
    <nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/contacts">Contacts</a></li><li class="breadcrumb-item active">${c.email}</li></ol></nav>
    <div class="page-head">
      <div><h1 class="d-flex align-items-center gap-2 flex-wrap">${c.name || c.email} ${statusBadge(c.status)}</h1>
        <p>${c.email} · added ${date(c.created_at)} · ${STATUS_INFO[c.status]?.help || ''}</p></div>
      <div class="d-flex gap-2 flex-wrap">
        ${canWrite ? html`<button class="btn btn-outline-primary" data-act="edit"><i class="bi bi-pencil me-1"></i>Edit</button>` : ''}
        ${canWrite && !suppressed ? html`<div class="dropdown"><button class="btn btn-outline-primary dropdown-toggle" data-bs-toggle="dropdown">Actions</button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><button class="dropdown-item" data-act="lists"><i class="bi bi-card-list me-2"></i>Manage lists</button></li>
            <li><button class="dropdown-item" data-act="consent"><i class="bi bi-patch-check me-2"></i>Record consent</button></li>
            <li><hr class="dropdown-divider"></li>
            <li><button class="dropdown-item" data-act="unsubscribe"><i class="bi bi-envelope-x me-2"></i>Unsubscribe</button></li>
            <li><button class="dropdown-item text-danger" data-act="suppress"><i class="bi bi-slash-circle me-2"></i>Suppress</button></li>
          </ul></div>` : ''}
        ${ctx.can('exports:read') ? html`<button class="btn btn-light" data-act="export" title="POPIA access request: everything held about this person"><i class="bi bi-filetype-json me-1"></i>Data export</button>` : ''}
        ${ctx.can('contacts:erase') ? html`<button class="btn btn-light text-danger" data-act="erase"><i class="bi bi-trash3 me-1"></i>Erase</button>` : ''}
      </div>
    </div>

    ${d.review ? html`<div class="alert-item warning"><i class="bi bi-hourglass-split"></i><div class="flex-grow-1">
        <strong>Held for review:</strong> ${d.review.reason}. This contact is excluded from campaigns until someone decides.
        <div class="small">The mail server's response suggests a policy or spam rejection, not a missing mailbox. Check the bounce details below.</div></div>
        ${ctx.can('review:resolve') ? html`<div class="d-flex gap-2 align-items-start"><button class="btn btn-sm btn-success" data-review="valid">Address is valid</button>
          <button class="btn btn-sm btn-outline-danger" data-review="invalid">Suppress</button></div>` : ''}</div>` : ''}
    ${suppressed ? html`<div class="alert-item critical"><i class="bi bi-slash-circle-fill"></i><div>
        <strong>Suppressed (${label(d.suppression.reason)})</strong> since ${datetime(d.suppression.created_at)}. This address will not receive campaigns and imports cannot reactivate it.
        ${ctx.can('suppression:lift') ? html` <a href="#/suppression?q=${encodeURIComponent(c.email)}">Lift suppression with a new permission basis</a>` : ''}</div></div>` : ''}

    <div class="row g-3">
      <div class="col-lg-5">
        <div class="card mb-3"><div class="card-header">Profile</div><div class="card-body">
          <dl class="dl-grid">
            <dt>First name</dt><dd>${a.first_name || '–'}</dd>
            <dt>Surname</dt><dd>${a.last_name || '–'}</dd>
            <dt>Email</dt><dd>${c.email}</dd>
            <dt>Company</dt><dd>${a.company || '–'}</dd>
            <dt>Source</dt><dd>${a.source || '–'}</dd>
            <dt>Date added</dt><dd>${datetime(c.created_at)}</dd>
            <dt>Contact ID</dt><dd class="mono">${c.id}</dd>
            ${custom.map(([k, v]) => html`<dt>${label(k)}</dt><dd>${typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>`)}
          </dl></div></div>
        <div class="card mb-3"><div class="card-header">Delivery & engagement</div><div class="card-body">
          <dl class="dl-grid">
            <dt>Campaigns received</dt><dd>${num(d.engagement.received)}</dd>
            <dt>Last email sent</dt><dd>${datetime(c.last_sent_at)}</dd>
            <dt>Last open</dt><dd>${datetime(c.last_open_at)} ${d.engagement.opens ? `(${num(d.engagement.opens)} email(s) opened)` : ''}</dd>
            <dt>Last click</dt><dd>${datetime(c.last_click_at)} ${d.engagement.clicks ? `(${num(d.engagement.clicks)} email(s) clicked)` : ''}</dd>
            <dt>Bounces</dt><dd>${num(c.hard_bounces)} hard · ${num(c.soft_bounce_events)} soft · ${num(c.complaints)} complaints${c.soft_bounces ? ` · ${num(c.soft_bounces)} recent soft` : ''}</dd>
            <dt>Last bounce</dt><dd>${datetime(c.last_bounce_at)}</dd>
            <dt>Unsubscribed</dt><dd>${datetime(c.last_unsubscribed_at)}</dd>
          </dl>
          <div class="small text-muted-2 mt-2">Opens are indicative only: image blocking and privacy features hide some, security scanners add others.</div>
        </div></div>
        <div class="card mb-3"><div class="card-header">Consent</div>
          ${d.consent.length ? html`<ul class="list-group list-group-flush">${d.consent.map((x) => html`<li class="list-group-item">
            <div class="d-flex justify-content-between"><strong class="text-capitalize">${x.action}</strong><span class="small text-muted-2">${datetime(x.created_at)}</span></div>
            <div class="small">${CONSENT_LABELS[x.method] || label(x.method)}${x.obtained_at ? ` · obtained ${date(x.obtained_at)}` : ''}${x.source ? ` · via ${x.source}` : ''}</div>
            ${x.purpose ? html`<div class="small text-muted-2">Purpose: ${x.purpose}</div>` : ''}
            ${x.evidence ? html`<div class="small text-muted-2">Evidence: ${x.evidence}</div>` : ''}
            <div class="small text-muted-2">Recorded by ${x.recorded_by || 'system'}</div></li>`)}</ul>`
            : html`<div class="card-body"><div class="text-warning-emphasis small"><i class="bi bi-exclamation-triangle me-1"></i>No consent record. ${c.consent?.method ? `Contact record says: ${CONSENT_LABELS[c.consent.method] || c.consent.method}.` : 'Record the permission basis before sending marketing.'}</div></div>`}
        </div>
      </div>
      <div class="col-lg-7">
        <div class="card mb-3"><div class="card-header">Lists</div>
          ${d.subscriptions.length ? html`<div class="table-responsive"><table class="table table-sm">
            <thead><tr><th>List</th><th>Subscription</th><th>Since</th><th>Updated</th></tr></thead><tbody>
            ${d.subscriptions.map((s) => html`<tr><td>${s.name}${s.optin === 'double' ? html` <span class="badge text-bg-light">double opt-in</span>` : ''}</td>
              <td><span class="status s-${s.status === 'unsubscribed' ? 'unsubscribed' : s.status === 'subscribed' ? 'active' : 'unconfirmed'}">${label(s.status)}</span></td>
              <td class="small">${date(s.created_at)}</td><td class="small">${date(s.updated_at)}</td></tr>`)}
            </tbody></table></div>` : html`<div class="card-body text-muted-2">Not on any list.</div>`}
        </div>
        <div class="card mb-3"><div class="card-header">Bounces</div>
          ${d.bounces.length ? html`<div class="table-responsive"><table class="table table-sm">
            <thead><tr><th>When</th><th>Type</th><th>Reason</th><th>Campaign</th></tr></thead><tbody>
            ${d.bounces.map((b) => html`<tr><td class="small text-nowrap">${datetime(b.bounced_at)}</td>
              <td>${bounceBadge(b.classification)}</td>
              <td class="small">${b.reason || '–'}${b.enhanced_code ? html` <span class="mono">${b.enhanced_code}</span>` : ''}<div class="text-muted-2">via ${b.source} · ${String(b.action_taken).replace(/_/g, ' ')}</div></td>
              <td class="small">${b.campaign_name || '–'}</td></tr>`)}
            </tbody></table></div>` : html`<div class="card-body text-muted-2">No bounces recorded.</div>`}
        </div>
        ${ctx.can('inbox:read') ? html`<div class="card mb-3"><div class="card-header d-flex justify-content-between">Replies and conversations
            ${convs.data.length ? html`<a class="small fw-normal" href="#/inbox?contact=${id}">Open in Inbox</a>` : ''}</div>
          ${convs.data.length ? html`<div class="list-group list-group-flush">${convs.data.map((v) => html`<a class="list-group-item list-group-item-action" href="#/inbox?contact=${id}&c=${v.id}">
              <div class="d-flex justify-content-between gap-2"><span class="fw-semibold small text-truncate">${v.subject}</span><span class="small text-muted-2 text-nowrap">${ago(v.last_message_at)}</span></div>
              <div class="small text-muted-2 text-truncate">${v.snippet || ''}</div>
              <div class="small">${v.status === 'open' ? html`<span class="badge text-bg-primary">Open</span>` : html`<span class="badge text-bg-light border">Closed</span>`}
                ${v.category === 'unsubscribe_request' ? html`<span class="badge text-bg-danger">Unsubscribe request</span>` : ''}${v.campaign ? html` <span class="text-muted-2">· ${v.campaign}</span>` : ''}</div></a>`)}</div>`
            : html`<div class="card-body text-muted-2">No replies from this contact yet.</div>`}
        </div>` : ''}
        <div class="card mb-3"><div class="card-header">Emails</div>
          ${d.messages.length ? html`<div class="table-responsive"><table class="table table-sm">
            <thead><tr><th>Email</th><th>Status</th><th>Opened</th><th>Clicked</th><th>When</th></tr></thead><tbody>
            ${d.messages.map((m) => html`<tr><td class="small">${m.kind === 'optin' ? 'Confirmation request' : m.campaign_id ? html`<a href="#/campaigns/${m.campaign_id}">${m.campaign_name}</a>` : '–'}</td>
              <td class="small text-capitalize">${m.status}${m.error ? html`<div class="text-muted-2 text-normal">${m.error}</div>` : ''}</td>
              <td>${m.opened ? html`<i class="bi bi-check-lg text-success" aria-label="Opened"></i>` : ''}</td><td>${m.clicked ? html`<i class="bi bi-check-lg text-success" aria-label="Clicked"></i>` : ''}</td>
              <td class="small text-nowrap">${datetime(m.sent_at || m.created_at)}</td></tr>`)}</tbody></table></div>`
            : html`<div class="card-body text-muted-2">No emails sent to this contact yet.</div>`}
        </div>
        <div class="card"><div class="card-header">History</div><div class="card-body">
          ${d.events.length ? html`<ul class="timeline">${d.events.map((e) => html`<li>
            <div class="fw-semibold">${EVENT_LABELS[e.event_type] || label(e.event_type)}${e.to_status ? html` <span class="text-muted-2 fw-normal">→ ${label(e.to_status)}</span>` : ''}</div>
            <div class="t">${datetime(e.created_at)} · ${e.actor_name || (e.actor_type === 'recipient' ? 'by the recipient' : 'automatic')}${e.campaign_name ? ` · campaign “${e.campaign_name}”` : ''}${eventDetail(e)}</div></li>`)}</ul>`
            : html`<div class="text-muted-2">No history yet.</div>`}
        </div></div>
      </div>
    </div>`);

  const reload = () => ctx.navigate(`#/contacts/${id}`);

  el.addEventListener('click', async (ev) => {
    const r = ev.target.closest('[data-review]');
    if (r) return review(r.dataset.review);
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'export') { download(`/contacts/${id}/export`); return; }
    if (act === 'edit') {
      formModal({ title: 'Edit contact', submitLabel: 'Save changes', body: html`<div class="row g-2">
        <div class="col-12"><label class="form-label">Email</label><input class="form-control" type="email" name="email" value="${c.email}" required></div>
        <div class="col-md-6"><label class="form-label">First name</label><input class="form-control" name="firstName" value="${a.first_name || ''}" maxlength="100"></div>
        <div class="col-md-6"><label class="form-label">Surname</label><input class="form-control" name="lastName" value="${a.last_name || ''}" maxlength="100"></div>
        <div class="col-md-6"><label class="form-label">Company</label><input class="form-control" name="company" value="${a.company || ''}" maxlength="200"></div>
        <div class="col-md-6"><label class="form-label">Source</label><input class="form-control" name="source" value="${a.source || ''}" maxlength="100"></div></div>`,
        onSubmit: async (fd) => {
          await patch(`/contacts/${id}`, { email: fd.get('email'), firstName: fd.get('firstName'), lastName: fd.get('lastName'),
            company: fd.get('company'), source: fd.get('source') });
          toast('Contact updated'); reload();
        } });
    } else if (act === 'lists') {
      const current = d.subscriptions.filter((s) => s.status !== 'unsubscribed').map((s) => s.id);
      formModal({ title: 'Manage lists', body: html`
        <label class="form-label">Add to lists</label>
        <select class="form-select mb-3" name="add" multiple size="4">${options(facets.lists.filter((l) => !d.subscriptions.some((s) => s.id === l.id)).map((l) => ({ value: l.id, label: l.name })), [])}</select>
        <label class="form-label">Unsubscribe from lists</label>
        <select class="form-select" name="unsub" multiple size="4">${options(facets.lists.filter((l) => current.includes(l.id)).map((l) => ({ value: l.id, label: l.name })), [])}</select>
        <div class="form-text">Lists this person unsubscribed from are not offered again: they would need to opt in themselves.</div>`,
        onSubmit: async (fd) => {
          const add = fd.getAll('add').map(Number);
          const unsub = fd.getAll('unsub').map(Number);
          if (add.length) await post('/contacts/actions', { action: 'add_to_lists', ids: [Number(id)], listIds: add });
          if (unsub.length) await post('/contacts/actions', { action: 'unsubscribe_from_lists', ids: [Number(id)], listIds: unsub });
          toast('Lists updated'); reload();
        } });
    } else if (act === 'consent') {
      formModal({ title: 'Record consent', size: 'modal-lg', body: consentFields(), submitLabel: 'Record consent',
        onSubmit: async (fd) => { await post(`/contacts/${id}/consent`, consentFromForm(fd)); toast('Consent recorded'); reload(); } });
    } else if (act === 'unsubscribe' || act === 'suppress') {
      formModal({ title: act === 'unsubscribe' ? 'Unsubscribe contact' : 'Suppress contact', danger: true,
        submitLabel: act === 'unsubscribe' ? 'Unsubscribe' : 'Suppress',
        body: html`<p>${act === 'unsubscribe' ? 'Record an opt-out request. The contact is removed from all lists and suppressed.' : 'Permanently suppress this address.'}</p>
          <label class="form-label">Note</label><textarea class="form-control" name="note" rows="2" maxlength="1000"></textarea>`,
        onSubmit: async (fd) => { await post('/contacts/actions', { action: act, ids: [Number(id)], note: fd.get('note') }); toast('Done'); reload(); } });
    } else if (act === 'erase') {
      formModal({ title: 'Erase personal information', danger: true, submitLabel: 'Erase permanently',
        body: html`<p>Use this for a POPIA deletion request. The contact and their personal details are deleted from MailHarbor.
          A one-way <strong>hash</strong> of the address is kept on the suppression list so the person is never re-imported or emailed again.</p>
          <p class="text-danger fw-semibold">This cannot be undone. Consider downloading a data export first.</p>
          <label class="form-label">Type <span class="kbd">ERASE</span> to confirm</label><input class="form-control" name="confirm" autocomplete="off" required>
          <label class="form-label mt-2">Reference (e.g. request ticket)</label><input class="form-control" name="note" maxlength="200">`,
        onSubmit: async (fd) => {
          await post(`/contacts/${id}/erase`, { confirm: fd.get('confirm'), note: fd.get('note') });
          toast('Contact erased'); location.hash = '#/contacts';
        } });
    }
  });

  function review(resolution) {
    formModal({
      title: resolution === 'valid' ? 'Release review hold' : 'Suppress this address', danger: resolution !== 'valid',
      submitLabel: resolution === 'valid' ? 'Release and restore lists' : 'Suppress',
      body: html`<p>${resolution === 'valid'
        ? 'The address is valid (for example the rejection was caused by our own sending configuration). The contact will be re-enabled and put back on the lists the hold removed them from.'
        : 'The address should not be emailed again. It will be added to the suppression list.'}</p>
        <label class="form-label">Note</label><textarea class="form-control" name="note" rows="2" maxlength="1000" placeholder="What did you check?"></textarea>`,
      onSubmit: async (fd) => {
        await post(`/contacts/${id}/review`, { resolution, note: fd.get('note') });
        toast('Review resolved'); ctx.refreshBadges(); reload();
      },
    });
  }
}

function eventDetail(e) {
  const x = e.details || {};
  const bits = [];
  if (x.note) bits.push(`“${x.note}”`);
  if (x.reason && typeof x.reason === 'string') bits.push(x.reason);
  if (x.source && e.event_type !== 'created') bits.push(`via ${x.source}`);
  if (x.list_ids?.length) bits.push(`${x.list_ids.length} list(s)`);
  if (x.import_id) bits.push('CSV import');
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

export { raw, ago, errorToast };
