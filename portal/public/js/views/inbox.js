// Inbox: replies to campaigns. Conversations on the left, the selected thread on the right (stacked on phones).
// Filters live in the address (#/inbox?view=open&c=12), so a conversation can be linked to.
import { get, post, api } from '../api.js';
import { html, raw, mount, $, $$, num, ago, datetime, loading, empty, pager, toast, errorToast, confirmModal } from '../ui.js';

const VIEWS = [
  ['open', 'Needs reply', 'open'], ['mine', 'Mine', 'mine'], ['unassigned', 'Unassigned', 'unassigned'],
  ['unsubscribe', 'Unsubscribe requests', 'unsubscribe'], ['auto', 'Auto-replies', null], ['closed', 'Closed', null], ['all', 'All', null],
];
const CATEGORY = {
  unsubscribe_request: html`<span class="badge text-bg-danger-subtle text-danger-emphasis border border-danger-subtle"><i class="bi bi-envelope-x me-1"></i>Unsubscribe request</span>`,
  auto_reply: html`<span class="badge text-bg-light border"><i class="bi bi-robot me-1"></i>Auto-reply</span>`,
  reply: '',
};

/** Splits a reply into what the person wrote and the quoted email below it. */
function splitQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*>/.test(l) || /^\s*On .{4,200}wrote:\s*$/i.test(l) || /^\s*-{2,}\s*Original Message/i.test(l));
  if (i <= 0) return [String(text || '').trim(), ''];
  return [lines.slice(0, i).join('\n').trim(), lines.slice(i).join('\n').trim()];
}
const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export async function render(el, ctx) {
  const q = ctx.query();
  const state = { view: q.get('view') || 'open', q: q.get('q') || '', campaign: q.get('campaign') || '', contact: q.get('contact') || '', c: Number(q.get('c')) || null, page: 1 };
  const canReply = ctx.can('inbox:reply');
  mount(el, loading());
  let counts = (await get('/inbox/counts')).data;

  mount(el, html`<div class="page-head"><div><h1>Inbox</h1><p>Replies to your campaigns. Read them, answer from here, and act on unsubscribe requests.</p></div></div>
    ${!counts.collecting ? html`<div class="alert alert-warning d-flex gap-2"><i class="bi bi-exclamation-triangle"></i><div>Replies are not being collected yet: they go to
      <strong>${counts.reply_to || 'your sender address'}</strong>, outside MailHarbor.
      ${ctx.can('settings:manage') ? html`<a href="#/settings/replies">Connect the replies mailbox</a>.` : 'Ask an administrator to connect the replies mailbox (Settings → Replies).'}</div></div>` : ''}
    <div id="filter-chip"></div>
    <div class="row g-3 inbox">
      <div class="col-lg-5 ${state.c ? 'd-none d-lg-block' : ''}" id="list-col"><div class="card">
        <div class="card-body border-bottom pb-2">
          <nav class="nav nav-pills inbox-views mb-2" aria-label="Inbox views" id="views"></nav>
          <form id="iq" role="search"><label class="visually-hidden" for="iq-q">Search replies</label>
            <input class="form-control form-control-sm" id="iq-q" name="q" value="${state.q}" placeholder="Search name, email, subject or text"></form>
        </div>
        <div id="list">${loading()}</div>
      </div></div>
      <div class="col-lg-7 ${state.c ? '' : 'd-none d-lg-block'}" id="thread-col"><div class="card" id="thread">
        <div class="empty"><i class="bi bi-chat-left-text"></i>Select a conversation to read it.</div></div></div>
    </div>`);

  function syncQuery() {
    ctx.setQuery({ view: state.view !== 'open' ? state.view : undefined, q: state.q || undefined, campaign: state.campaign || undefined,
      contact: state.contact || undefined, c: state.c || undefined });
  }
  function renderViews() {
    mount($('#views', el), html`${VIEWS.map(([k, l, countKey]) => html`<button type="button" class="nav-link py-1 px-2 ${state.view === k && !state.campaign && !state.contact ? 'active' : ''}"
      data-view="${k}" aria-pressed="${state.view === k}">${l}${countKey && counts[countKey] ? html` <span class="badge rounded-pill ${k === 'unsubscribe' ? 'text-bg-danger' : 'text-bg-secondary'}">${num(counts[countKey])}</span>` : ''}</button>`)}`);
  }

  async function loadList() {
    renderViews();
    const params = new URLSearchParams({ view: state.view, page: String(state.page) });
    if (state.q) params.set('q', state.q);
    if (state.campaign) params.set('campaign', state.campaign);
    if (state.contact) params.set('contact', state.contact);
    const r = await get(`/inbox?${params}`);
    if (state.campaign || state.contact) {
      mount($('#filter-chip', el), html`<div class="mb-2 small"><span class="badge text-bg-light border">${state.campaign ? html`Replies to <strong>${r.data[0]?.campaign || 'this campaign'}</strong>` : 'Conversations with this contact'}
        <button type="button" class="btn btn-link btn-sm p-0 ms-1 align-baseline" id="clear-filter" aria-label="Show the whole inbox"><i class="bi bi-x-lg"></i></button></span></div>`);
    } else mount($('#filter-chip', el), '');
    if (!r.data.length) {
      mount($('#list', el), empty('inbox', state.view === 'open' ? 'Nothing needs a reply' : 'No conversations here', state.q ? 'Try another search.' : ''));
      return;
    }
    mount($('#list', el), html`<div class="list-group list-group-flush inbox-list" role="list">${r.data.map((c) => html`
      <button type="button" class="list-group-item list-group-item-action inbox-item ${c.unread ? 'unread' : ''} ${state.c === c.id ? 'active' : ''}" data-conv="${c.id}"
        aria-current="${state.c === c.id ? 'true' : 'false'}" role="listitem">
        <div class="d-flex justify-content-between gap-2"><span class="inbox-who text-truncate">${c.unread ? html`<span class="dot-unread" aria-hidden="true"></span><span class="visually-hidden">Unread: </span>` : ''}${c.name || c.email}</span>
          <span class="small text-muted-2 text-nowrap">${c.last_direction === 'out' ? html`<i class="bi bi-reply me-1" title="Answered"></i>` : ''}${ago(c.last_message_at)}</span></div>
        <div class="small fw-semibold text-truncate">${c.subject}</div>
        <div class="small text-muted-2 text-truncate">${c.snippet || ''}</div>
        <div class="d-flex gap-1 flex-wrap mt-1">${CATEGORY[c.category]}${c.campaign ? html`<span class="badge text-bg-light border text-truncate mw-200"><i class="bi bi-send me-1"></i>${c.campaign}</span>` : ''}
          ${c.assigned_name ? html`<span class="badge text-bg-light border"><i class="bi bi-person me-1"></i>${c.assigned_name}</span>` : ''}
          ${c.status === 'closed' && c.category !== 'auto_reply' ? html`<span class="badge text-bg-light border">Closed</span>` : ''}</div>
      </button>`)}</div>${pager(r.meta, (p) => { state.page = p; loadList(); })}`);
  }

  async function refreshCounts() {
    counts = (await get('/inbox/counts')).data;
    ctx.refreshBadges?.();
    renderViews();
  }

  async function loadThread(id) {
    const box = $('#thread', el);
    mount(box, loading());
    let t;
    try { t = (await get(`/inbox/${id}`)).data; } catch (err) { mount(box, html`<div class="card-body text-danger">${err.message}</div>`); return; }
    const first = t.first_name || t.name?.split(' ')[0] || '';
    const signature = `\n\nKind regards\n${ctx.user.name || ''}\n${ctx.session?.orgName || ''}`.replace(/\n+$/, '');
    mount(box, html`
      <div class="card-header d-flex flex-wrap gap-2 align-items-start">
        <button type="button" class="btn btn-sm btn-light d-lg-none" id="back" aria-label="Back to the list"><i class="bi bi-arrow-left"></i></button>
        <div class="flex-grow-1 min-w-0"><h2 class="h6 fw-bold mb-1 text-break">${t.subject}</h2>
          <div class="small">${t.contact_id ? html`<a href="#/contacts/${t.contact_id}">${t.name || [t.first_name, t.last_name].filter(Boolean).join(' ') || t.email}</a>` : (t.name || t.email)}
            <span class="text-muted-2">&lt;${t.email}&gt;</span>${t.company ? html` · ${t.company}` : ''}</div>
          <div class="small text-muted-2">${t.campaign ? html`Reply to <a href="#/campaigns/${t.campaign_id}">${t.campaign}</a>` : 'Not linked to a campaign'}
            ${t.lists.length ? html` · lists: ${t.lists.map((l) => `${l.name}${l.status !== 'subscribed' ? ` (${l.status})` : ''}`).join(', ')}` : ''}</div>
          <div class="d-flex gap-1 flex-wrap mt-1">${CATEGORY[t.category]}${t.suppression_reason ? html`<span class="badge text-bg-warning"><i class="bi bi-slash-circle me-1"></i>Suppressed: ${t.suppression_reason.replace(/_/g, ' ')}</span>` : ''}
            ${t.status === 'closed' ? html`<span class="badge text-bg-light border">Closed</span>` : ''}</div></div>
        ${canReply ? html`<div class="d-flex gap-1 flex-wrap">
          <select class="form-select form-select-sm w-auto" id="assign" aria-label="Assign to">
            <option value="">Unassigned</option>${t.users.map((u) => html`<option value="${u.id}" ${t.assigned_to === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="toggle-status">${t.status === 'open' ? html`<i class="bi bi-check2 me-1"></i>Close` : html`<i class="bi bi-arrow-counterclockwise me-1"></i>Reopen`}</button>
          <button type="button" class="btn btn-sm btn-light" id="mark-unread" title="Mark as unread" aria-label="Mark as unread"><i class="bi bi-envelope"></i></button>
        </div>` : ''}
      </div>
      ${t.category === 'unsubscribe_request' && t.status === 'open' && t.contact_id && ctx.can('contacts:write') ? html`<div class="alert alert-danger m-3 mb-0 d-flex gap-2 align-items-center flex-wrap">
        <i class="bi bi-envelope-x"></i><div class="flex-grow-1">This person seems to be asking to be removed. POPIA requires you to honour that.</div>
        <button type="button" class="btn btn-sm btn-danger" id="unsubscribe">Unsubscribe ${t.email}</button></div>` : ''}
      <div class="card-body inbox-thread" id="messages">${t.messages.map((m) => {
        if (m.direction === 'note') {
          return html`<div class="inbox-msg note"><div class="small fw-semibold"><i class="bi bi-sticky me-1"></i>Internal note · ${m.from_name || m.sent_by_name || ''} · ${datetime(m.created_at)}</div>
            <div class="inbox-text">${m.text_body}</div></div>`;
        }
        const [main, quoted] = m.direction === 'in' ? splitQuoted(m.text_body) : [m.text_body, ''];
        return html`<div class="inbox-msg ${m.direction}">
          <div class="d-flex justify-content-between flex-wrap column-gap-2 small mb-1"><span class="fw-semibold text-break">${m.direction === 'out' ? html`<i class="bi bi-reply me-1"></i>${m.sent_by_name || m.from_name} (sent from MailHarbor)` : (m.from_name ? html`${m.from_name} <span class="text-muted-2">&lt;${m.from_email}&gt;</span>` : m.from_email)}</span>
            <span class="text-muted-2 text-nowrap">${datetime(m.created_at)}</span></div>
          ${m.send_status === 'failed' ? html`<div class="alert alert-danger small py-1 px-2 mb-2"><i class="bi bi-x-circle me-1"></i>Not sent: ${m.error}</div>` : ''}
          <div class="inbox-text">${main || html`<span class="text-muted-2">(no text)</span>`}</div>
          ${quoted ? html`<details class="mt-2 small"><summary class="text-muted-2">Show quoted text</summary><div class="inbox-text text-muted-2 mt-1">${quoted}</div></details>` : ''}
          ${m.attachments.length ? html`<div class="d-flex gap-2 flex-wrap mt-2">${m.attachments.map((a) => (a.stored
            ? html`<a class="btn btn-sm btn-light border" href="/api/inbox/attachments/${a.id}" download><i class="bi bi-paperclip me-1"></i>${a.filename} <span class="text-muted-2">${size(a.size)}</span></a>`
            : html`<span class="btn btn-sm btn-light border disabled" title="Over 10 MB: open it in the mailbox"><i class="bi bi-paperclip me-1"></i>${a.filename} (too large to keep)</span>`))}</div>` : ''}
          ${m.has_html ? html`<button type="button" class="btn btn-link btn-sm px-0 mt-1" data-original="${m.id}"><i class="bi bi-file-richtext me-1"></i>Show original formatting</button>
            <div class="d-none" data-frame="${m.id}"><div class="small text-muted-2 mb-1">Remote images are blocked to protect your privacy. <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-images="${m.id}">Load images</button></div>
              <iframe class="inbox-original" title="Original email" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe></div>` : ''}
          ${m.direction === 'in' && m.matched_by === 'sender' ? html`<div class="small text-muted-2 mt-1"><i class="bi bi-info-circle me-1"></i>Linked by the sender's address (the email didn't say which campaign it answers).</div>` : ''}
        </div>`;
      })}</div>
      ${canReply ? html`<div class="card-footer bg-white">
        ${t.suppression_reason ? html`<div class="alert alert-warning small py-2"><i class="bi bi-info-circle me-1"></i>This person no longer receives marketing. You may answer their message, but don't use the reply to market to them.</div>` : ''}
        <div class="nav nav-tabs small mb-2" role="tablist">
          <button type="button" class="nav-link active" data-mode="reply" role="tab" aria-selected="true"><i class="bi bi-reply me-1"></i>Reply by email</button>
          <button type="button" class="nav-link" data-mode="note" role="tab" aria-selected="false"><i class="bi bi-sticky me-1"></i>Internal note</button></div>
        <label class="visually-hidden" for="compose">Your reply</label>
        <textarea class="form-control" id="compose" rows="7" maxlength="20000">${`Hi ${first || 'there'},\n\n${signature}`}</textarea>
        <div class="d-flex gap-2 mt-2 align-items-center flex-wrap" id="compose-actions"></div>
      </div>` : ''}`);

    let mode = 'reply';
    const compose = $('#compose', box);
    const actions = () => mount($('#compose-actions', box), mode === 'reply'
      ? html`<button type="button" class="btn btn-primary" id="send"><i class="bi bi-send me-1"></i>Send reply</button>
        <button type="button" class="btn btn-outline-primary" id="send-close">Send and close</button>
        <span class="small text-muted-2">To ${t.email}, from your sender address, threaded with their email.</span>`
      : html`<button type="button" class="btn btn-warning" id="add-note"><i class="bi bi-sticky me-1"></i>Add note</button>
        <span class="small text-muted-2">Only your team sees notes. Nothing is emailed.</span>`);
    if (compose) {
      actions();
      const caret = compose.value.indexOf('\n\n') + 2;
      compose.setSelectionRange(caret, caret);
    }
    const send = async (close) => {
      const body = compose.value.trim();
      if (!body) { toast('Write a reply first', 'warning'); return; }
      $$('#compose-actions button', box).forEach((b) => { b.disabled = true; });
      try {
        await post(`/inbox/${id}/reply`, { body, close });
        toast(close ? 'Reply sent and conversation closed' : 'Reply sent');
        await Promise.all([loadThread(id), loadList(), refreshCounts()]);
      } catch (err) { errorToast(err); await loadThread(id); }
    };
    box.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      try {
        if (b.id === 'back') { state.c = null; syncQuery(); $('#list-col', el).classList.remove('d-none'); $('#thread-col', el).classList.add('d-none', 'd-lg-block'); return; }
        if (b.dataset.mode) {
          mode = b.dataset.mode;
          $$('[data-mode]', box).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', String(x === b)); });
          compose.value = mode === 'note' ? '' : `Hi ${first || 'there'},\n\n${signature}`;
          actions(); compose.focus();
          return;
        }
        if (b.id === 'send') return send(false);
        if (b.id === 'send-close') return send(true);
        if (b.id === 'add-note') {
          if (!compose.value.trim()) return;
          await post(`/inbox/${id}/notes`, { body: compose.value.trim() });
          toast('Note added');
          await loadThread(id);
          return;
        }
        if (b.id === 'toggle-status') {
          await api('PATCH', `/inbox/${id}`, { status: t.status === 'open' ? 'closed' : 'open' });
          toast(t.status === 'open' ? 'Conversation closed' : 'Conversation reopened');
          await Promise.all([loadThread(id), loadList(), refreshCounts()]);
          return;
        }
        if (b.id === 'mark-unread') {
          await api('PATCH', `/inbox/${id}`, { unread: true });
          toast('Marked as unread');
          state.c = null; syncQuery();
          await Promise.all([loadList(), refreshCounts()]);
          mount(box, html`<div class="empty"><i class="bi bi-chat-left-text"></i>Select a conversation to read it.</div>`);
          return;
        }
        if (b.id === 'unsubscribe') {
          const ok = await confirmModal({ title: `Unsubscribe ${t.email}?`, confirmLabel: 'Unsubscribe', danger: true,
            message: 'They will stop receiving marketing emails. This is recorded on the contact with this conversation as the reason, and the conversation is closed.' });
          if (!ok) return;
          await post(`/inbox/${id}/unsubscribe`);
          toast('Unsubscribed and recorded');
          await Promise.all([loadThread(id), loadList(), refreshCounts()]);
          return;
        }
        if (b.dataset.original) {
          const wrap = $(`[data-frame="${b.dataset.original}"]`, box);
          wrap.classList.toggle('d-none');
          const fr = wrap.querySelector('iframe');
          if (!fr.src) fr.src = `/api/inbox/messages/${b.dataset.original}/html`;
          b.innerHTML = wrap.classList.contains('d-none') ? '<i class="bi bi-file-richtext me-1"></i>Show original formatting' : '<i class="bi bi-file-richtext me-1"></i>Hide original formatting';
          return;
        }
        if (b.dataset.images) {
          $(`[data-frame="${b.dataset.images}"] iframe`, box).src = `/api/inbox/messages/${b.dataset.images}/html?images=1`;
          b.remove();
        }
      } catch (err) { errorToast(err); }
    };
    $('#assign', box)?.addEventListener('change', async (e) => {
      try {
        await api('PATCH', `/inbox/${id}`, { assigned_to: e.target.value || null });
        toast(e.target.value ? `Assigned to ${e.target.selectedOptions[0].textContent}` : 'Unassigned');
        await Promise.all([loadList(), refreshCounts()]);
      } catch (err) { errorToast(err); }
    });
    $('#messages', box).lastElementChild?.scrollIntoView({ block: 'nearest' });
    // Opening marks it read: update the list and badge.
    if ($(`[data-conv="${id}"]`, el)?.classList.contains('unread')) { $(`[data-conv="${id}"]`, el).classList.remove('unread'); refreshCounts(); }
  }

  el.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { state.view = v.dataset.view; state.campaign = ''; state.contact = ''; state.page = 1; syncQuery(); loadList(); return; }
    if (e.target.closest('#clear-filter')) { state.campaign = ''; state.contact = ''; state.page = 1; syncQuery(); loadList(); return; }
    const item = e.target.closest('[data-conv]');
    if (item) {
      state.c = Number(item.dataset.conv);
      syncQuery();
      $$('[data-conv]', el).forEach((x) => { const on = x === item; x.classList.toggle('active', on); x.setAttribute('aria-current', String(on)); });
      $('#list-col', el).classList.add('d-none', 'd-lg-block');
      $('#thread-col', el).classList.remove('d-none');
      loadThread(state.c);
    }
  });
  let t;
  $('#iq', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; syncQuery(); loadList(); }, 300); });
  $('#iq', el).addEventListener('submit', (e) => e.preventDefault());

  await loadList();
  if (state.c) await loadThread(state.c);
}
