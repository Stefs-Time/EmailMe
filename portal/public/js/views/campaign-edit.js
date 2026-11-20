// Campaign editor: 1 Audience → 2 Email (subject, sender, content) → 3 Review & send.
// The header and footer of every email come from Settings → Email design; a campaign is only its content.
import { get, put, post, del } from '../api.js';
import { html, raw, mount, $, $$, num, loading, toast, errorToast, formModal, confirmModal } from '../ui.js';
import { createBuilder } from '../builder.js';
import { tagBar, enableTagChips } from '../tags.js';
import { pickSample, getSample } from '../samples.js';

/** Mirrors the server's default utm_campaign (slug of the campaign name). */
const slug = (str) => String(str || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'campaign';

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const [{ data: c }, { data: facets }, { data: segments }] = await Promise.all([
    get(`/campaigns/${id}`), get('/contacts/facets'), get('/segments'),
  ]);
  if (c.status !== 'draft' && c.status !== 'scheduled') { location.hash = `#/campaigns/${id}`; return undefined; }
  let dirty = false;
  let saving = null;
  let timer;
  const selected = new Set(c.lists.map((l) => l.id));
  const d = c.defaults || {};
  const customSender = Boolean(c.from_name || c.from_email || c.reply_to);
  const advancedNonDefault = !c.track_opens || !c.track_clicks || c.utm_enabled === false || c.utm_campaign;

  mount(el, html`
    <nav aria-label="breadcrumb"><ol class="breadcrumb small"><li class="breadcrumb-item"><a href="#/campaigns">Campaigns</a></li><li class="breadcrumb-item active">${c.name}</li></ol></nav>
    <div class="page-head">
      <div><h1>${c.status === 'scheduled' ? 'Scheduled campaign' : 'Edit campaign'}</h1><p id="save-state" aria-live="polite">All changes saved</p></div>
      <div class="d-flex gap-2 flex-wrap">
        <button class="btn btn-light" id="delete" ${c.status !== 'draft' ? raw('hidden') : ''}><i class="bi bi-trash3 me-1"></i>Delete</button>
        <button class="btn btn-outline-primary" id="test"><i class="bi bi-envelope-check me-1"></i>Send test</button>
        ${ctx.can('campaigns:send') ? html`${c.status === 'scheduled'
          ? html`<button class="btn btn-outline-primary" id="unschedule"><i class="bi bi-calendar-x me-1"></i>Unschedule</button>`
          : html`<button class="btn btn-outline-primary" id="schedule"><i class="bi bi-calendar-event me-1"></i>Schedule</button>`}
          <button class="btn btn-teal" id="send"><i class="bi bi-send me-1"></i>Send now</button>` : ''}
      </div>
    </div>
    <form id="cform" novalidate>
    <div class="row g-3">
      <div class="col-xl-7">
        <div class="card mb-3"><div class="card-header">1 · Audience</div><div class="card-body">
          <div class="list-pick" role="group" aria-label="Lists">
            ${facets.lists.length ? facets.lists.map((l) => html`<div class="form-check">
              <input class="form-check-input" type="checkbox" id="l${l.id}" value="${l.id}" data-list ${selected.has(l.id) ? raw('checked') : ''}>
              <label class="form-check-label" for="l${l.id}">${l.name}${l.optin === 'double' ? html` <span class="badge text-bg-light">double opt-in</span>` : ''}</label></div>`)
              : html`<div class="text-muted-2">No lists yet. <a href="#/lists">Create a list</a> and add contacts first.</div>`}
          </div>
          <div class="mt-3"><label class="form-label" for="seg">Narrow to a segment <span class="text-muted-2 small">(optional)</span></label>
            <select class="form-select" id="seg" name="segment_id">
              <option value="">Everyone on the selected lists</option>
              ${segments.map((g) => html`<option value="${g.id}" ${c.segment_id === g.id ? raw('selected') : ''}>${g.name} (${g.counts.eligible} eligible)</option>`)}
            </select>
            <div class="form-text">Only people on the selected lists <strong>and</strong> in the segment receive it. <a href="#/segments">Manage segments</a></div></div>
          <div class="mt-2 small" id="estimate"></div>
        </div></div>
        <div class="card mb-3"><div class="card-header">2 · Email</div><div class="card-body"><div class="row g-2">
          <div class="col-12"><label class="form-label" for="f-subject">Subject line</label><input class="form-control" id="f-subject" name="subject" data-taggable maxlength="300" value="${c.subject}" placeholder="e.g. Thandi, our November specials"></div>
          <div class="col-12"><label class="form-label" for="f-pre">Preview text <span class="text-muted-2 small">(shown after the subject in most inboxes)</span></label><input class="form-control" id="f-pre" name="preheader" data-taggable maxlength="300" value="${c.preheader}"></div>
          <div class="col-12">${tagBar({ custom: facets.attributes || [], label: 'Personalise subject or preview text:', compact: true })}</div>
          <div class="col-12"><label class="form-label" for="f-name">Campaign name <span class="text-muted-2 small">(internal, used in reports)</span></label><input class="form-control" id="f-name" name="name" maxlength="200" value="${c.name}" required></div>
          <div class="col-12">
            <details class="mh-details" ${customSender ? raw('open') : ''}>
              <summary><span class="fw-semibold">From:</span> <span id="sender-summary"></span> <span class="small text-muted-2">· change</span></summary>
              <div class="row g-2 mt-1">
                <div class="col-md-6"><label class="form-label" for="f-fn">From name</label><input class="form-control" id="f-fn" name="from_name" maxlength="120" value="${c.from_name}" placeholder="${d.from_name || ''}"></div>
                <div class="col-md-6"><label class="form-label" for="f-fe">From address</label><input class="form-control" id="f-fe" name="from_email" type="email" value="${c.from_email}" placeholder="${d.from_email || ''}"></div>
                <div class="col-md-6"><label class="form-label" for="f-rt">Reply-to <span class="text-muted-2 small">(optional)</span></label><input class="form-control" id="f-rt" name="reply_to" type="email" value="${c.reply_to}" placeholder="${d.reply_to || ''}"></div>
                <div class="col-12 form-text">Leave empty to use the sender from Settings → Sending.</div>
              </div>
            </details>
            <div class="small text-muted-2 mt-1" id="reply-summary"></div>
          </div>
          <div class="col-12">
            <details class="mh-details" ${advancedNonDefault ? raw('open') : ''}>
              <summary><span class="fw-semibold">Tracking</span> <span id="tracking-summary" class="text-muted-2"></span></summary>
              <div class="d-flex gap-4 flex-wrap mt-2">
                <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="to" name="track_opens" ${c.track_opens ? raw('checked') : ''}><label class="form-check-label" for="to">Track opens</label></div>
                <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="tc" name="track_clicks" ${c.track_clicks ? raw('checked') : ''}><label class="form-check-label" for="tc">Track link clicks</label></div>
                <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="tu" name="utm_enabled" ${c.utm_enabled !== false ? raw('checked') : ''}><label class="form-check-label" for="tu">Google Analytics (UTM) tags</label></div>
              </div>
              <div class="mt-2" id="utm-wrap"><label class="form-label" for="f-utm">Campaign name in Google Analytics <span class="text-muted-2 small">(utm_campaign)</span></label>
                <input class="form-control" id="f-utm" name="utm_campaign" maxlength="80" value="${c.utm_campaign || ''}" placeholder="${slug(c.name)}">
                <div class="form-text">Leave empty to use the campaign name. Applies only if UTM tags are on in Settings → Sending.</div></div>
            </details>
          </div>
        </div></div></div>
      </div>
      <div class="col-xl-5">
        <div class="card mb-3" id="ready"></div>
        <div class="card preview-card"><div class="card-header d-flex align-items-center">Preview <span class="small text-muted-2 ms-2">as a recipient sees it, with sample data</span>
          <div class="btn-group btn-group-sm ms-auto" role="group" aria-label="Preview width">
            <button type="button" class="btn btn-outline-secondary active" data-width="100%">Desktop</button>
            <button type="button" class="btn btn-outline-secondary" data-width="375px">Mobile</button></div></div>
          <div class="preview-frame-wrap"><iframe id="preview" title="Email preview" sandbox="allow-popups"></iframe></div></div>
      </div>
      <div class="col-12">
        <div class="card mb-3"><div class="card-header d-flex align-items-center gap-2 flex-wrap">Content
          <button type="button" class="btn btn-sm btn-outline-secondary ms-auto" id="use-sample"><i class="bi bi-collection me-1"></i>Start from a sample</button></div>
          <div id="builder"></div>
          <div class="card-footer small text-muted-2"><i class="bi bi-layout-text-window me-1"></i>Your logo, colours and the footer (address, unsubscribe and preferences links) are added to every email from
            ${ctx.can('settings:manage') ? html`<a href="#/settings/design">Settings → Email design</a>` : 'Settings → Email design'}.</div>
        </div>
      </div>
    </div>
    </form>`);

  const form = $('#cform', el);
  const builder = createBuilder($('#builder', el), c.body_json || { version: 1, blocks: [] },
    { onChange: () => changed(), customTags: facets.attributes || [], theme: d.design || {} });
  // Personalisation chips: insert at the cursor of the field last clicked into.
  const stopTags = enableTagChips(el, { fallback: () => builder.selectedEditable() });

  function summaries() {
    const name = form.from_name.value.trim() || d.from_name || '';
    const email = form.from_email.value.trim() || d.from_email || '(no sender set)';
    $('#sender-summary', el).textContent = `${name} <${email}>`;
    const replyTo = form.reply_to.value.trim() || d.reply_to || form.from_email.value.trim() || d.from_email || '';
    const collected = d.replies_collected && (!form.reply_to.value.trim() || form.reply_to.value.trim().toLowerCase() === String(d.reply_to || '').toLowerCase());
    mount($('#reply-summary', el), collected
      ? html`<i class="bi bi-inbox me-1"></i>Replies go to ${replyTo} and arrive in the <a href="#/inbox">Inbox</a>.`
      : html`<i class="bi bi-exclamation-circle me-1"></i>Replies go to ${replyTo || 'the From address'}${d.replies_collected ? ', not the replies mailbox, so they won\'t reach the Inbox.' : ', outside MailHarbor (Settings → Replies).'}`);
    const t = [form.track_opens.checked && 'opens', form.track_clicks.checked && 'clicks', form.utm_enabled.checked && 'Google Analytics tags'].filter(Boolean);
    $('#tracking-summary', el).textContent = t.length ? `· ${t.join(', ')}` : '· off';
    $('#utm-wrap', el).classList.toggle('d-none', !form.utm_enabled.checked);
  }

  const collect = () => ({
    name: form.name.value, subject: form.subject.value, preheader: form.preheader.value,
    from_name: form.from_name.value, from_email: form.from_email.value, reply_to: form.reply_to.value,
    body_json: builder.getDoc(),
    track_opens: form.track_opens.checked, track_clicks: form.track_clicks.checked, list_ids: [...selected],
    segment_id: Number(form.segment_id.value) || null, utm_enabled: form.utm_enabled.checked, utm_campaign: form.utm_campaign.value.trim(),
  });

  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return true;
    dirty = false;
    $('#save-state', el).textContent = 'Saving…';
    saving = put(`/campaigns/${id}`, collect()).then((r) => {
      $('#save-state', el).textContent = 'All changes saved';
      renderReady(r.data);
      refreshPreview();
      return true;
    }).catch((err) => {
      dirty = true;
      $('#save-state', el).textContent = 'Not saved';
      errorToast(err);
      return false;
    }).finally(() => { saving = null; });
    return saving;
  }
  const changed = () => { dirty = true; summaries(); $('#save-state', el).textContent = 'Unsaved changes…'; clearTimeout(timer); timer = setTimeout(save, 1200); };

  function refreshPreview() {
    $('#preview', el).src = `/api/campaigns/${id}/preview?ts=${Date.now()}`;
  }

  async function renderReady(data) {
    const info = data?.problems ? data : (await get(`/campaigns/${id}`)).data;
    mount($('#ready', el), html`<div class="card-header">3 · Review &amp; send</div>
      ${info.problems.length
        ? html`<ul class="list-group list-group-flush">${info.problems.map((p) => html`<li class="list-group-item small"><i class="bi bi-circle me-2 text-warning"></i>${p}</li>`)}</ul>`
        : html`<div class="card-body d-flex gap-2 align-items-center"><i class="bi bi-check-circle-fill text-success fs-4"></i><div><div class="fw-semibold">Ready to send</div><div class="small text-muted-2">${num(info.eligible)} recipient(s). Send yourself a test first.</div></div></div>`}`);
    // Consent requests: POPIA s69 allows one request to a non-customer, and silence is not consent.
    if (/\{\{\s*consent_url\s*\}\}/.test(info.body_html || '')) {
      $('#ready', el).insertAdjacentHTML('beforeend', String(html`<div class="card-body border-top small" id="consent-note">
        <div class="fw-semibold mb-1"><i class="bi bi-person-check me-1 text-teal"></i>This email asks for permission</div>
        <ul class="mb-0 ps-3">
          <li>POPIA lets you ask someone who isn't a customer <strong>only once</strong>. Don't resend it to people who didn't answer.</li>
          <li>"Yes" is recorded on the contact as consent (with the campaign, time and IP address) and counted in the report as <em>Gave permission</em>.</li>
          <li>Afterwards, email only people who said yes: create a segment with <em>Consent method</em> = <em>Permission email</em>.</li>
        </ul></div>`));
    }
    mount($('#estimate', el), html`<i class="bi bi-people me-1"></i><strong>${num(info.eligible)}</strong> contact(s) will receive this campaign <span class="text-muted-2">(suppressed, unsubscribed, unconfirmed and held contacts are excluded)</span>`);
  }

  form.addEventListener('input', (e) => { if (!e.target.matches('[data-list]') && !e.target.closest('#builder')) changed(); });
  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-list]')) {
      selected[e.target.checked ? 'add' : 'delete'](Number(e.target.value));
      changed();
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  // Replace the content with a ready-made sample (Undo above the email restores it).
  $('#use-sample', el).addEventListener('click', () => pickSample({
    title: 'Start from a sample', submitLabel: 'Use this design',
    intro: 'This replaces the current content. Changed your mind? Press Undo above the email.',
    onPick: async (sampleId) => {
      const s = await getSample(sampleId);
      builder.setDoc(s.doc);
      if (!form.subject.value.trim() && s.subject) form.subject.value = s.subject;
      if (!form.preheader.value.trim() && s.preheader) form.preheader.value = s.preheader;
      changed();
      toast('Sample loaded. Replace the [bracketed] text and add your images and links.');
    },
  }));

  el.addEventListener('click', (e) => {
    const w = e.target.closest('[data-width]');
    if (!w) return;
    $('#preview', el).style.width = w.dataset.width;
    $$('[data-width]', el).forEach((x) => x.classList.toggle('active', x === w));
  });

  // ---- Actions ---------------------------------------------------------------
  $('#test', el).addEventListener('click', async () => {
    if (!(await save())) return;
    formModal({
      title: 'Send a test email', submitLabel: 'Send test',
      body: html`<label class="form-label" for="t-emails">Send to (up to 5 addresses, comma separated)</label>
        <input class="form-control" id="t-emails" name="emails" required value="${ctx.user.email}">
        <div class="form-text">Tests use sample data (e.g. "Thandi"), have "[TEST]" in the subject and are not tracked or counted.</div>`,
      onSubmit: async (fd) => {
        const emails = String(fd.get('emails')).split(/[\s,;]+/).filter(Boolean);
        await post(`/campaigns/${id}/test`, { emails });
        toast(`Test sent to ${emails.join(', ')}. It should arrive within a minute.`);
      },
    });
  });
  $('#schedule', el)?.addEventListener('click', async () => {
    if (!(await save())) return;
    const at = new Date(Date.now() + 3600000);
    at.setMinutes(0, 0, 0);
    const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    formModal({
      title: 'Schedule campaign', submitLabel: 'Schedule',
      body: html`<label class="form-label" for="s-at">Send at (your local time)</label><input class="form-control" id="s-at" type="datetime-local" name="at" required value="${local}" min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}">`,
      onSubmit: async (fd) => {
        await post(`/campaigns/${id}/schedule`, { send_at: new Date(String(fd.get('at'))).toISOString() });
        toast('Campaign scheduled');
        location.hash = `#/campaigns/${id}`;
      },
    });
  });
  $('#unschedule', el)?.addEventListener('click', async () => {
    try { await post(`/campaigns/${id}/unschedule`); toast('Campaign moved back to draft'); ctx.navigate(`#/campaigns/${id}/edit`); } catch (err) { errorToast(err); }
  });
  $('#send', el)?.addEventListener('click', async () => {
    if (!(await save())) return;
    const info = (await get(`/campaigns/${id}`)).data;
    if (info.problems.length) { toast(info.problems[0], 'warning'); return; }
    const ok = await confirmModal({ title: 'Send this campaign now?', confirmLabel: `Send to ${num(info.eligible)} recipient(s)`,
      message: `"${info.subject}" will be sent to ${num(info.eligible)} recipient(s) on ${info.lists.map((l) => l.name).join(', ')}. You can pause it while it is sending, but sent emails cannot be recalled.` });
    if (!ok) return;
    try {
      const r = await post(`/campaigns/${id}/send`);
      toast(`Sending started to ${num(r.data.recipients)} recipient(s)`);
      location.hash = `#/campaigns/${id}`;
    } catch (err) { errorToast(err); }
  });
  $('#delete', el)?.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Delete this draft?', danger: true, confirmLabel: 'Delete', message: 'The draft is removed permanently.' });
    if (!ok) return;
    try { await del(`/campaigns/${id}`); toast('Draft deleted'); location.hash = '#/campaigns'; } catch (err) { errorToast(err); }
  });

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  summaries();
  renderReady(c);
  refreshPreview();
  return () => { window.removeEventListener('beforeunload', beforeUnload); stopTags(); if (dirty) save(); };
}
