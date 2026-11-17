import { get, put, post, del } from '../api.js';
import { html, raw, mount, $, $$, num, loading, options, toast, errorToast, formModal, confirmModal, esc } from '../ui.js';
import { createBuilder, documentFromHtml } from '../builder.js';

const TAGS = [
  ['first_name', 'First name'], ['last_name', 'Last name'], ['full_name', 'Full name'], ['company', 'Company'],
  ['email', 'Email address'], ['org_name', 'Your organisation'],
];

export async function render(el, ctx, [id]) {
  mount(el, loading());
  const [{ data: c }, { data: facets }, { data: templates }] = await Promise.all([
    get(`/campaigns/${id}`), get('/contacts/facets'), get('/templates'),
  ]);
  if (c.status !== 'draft' && c.status !== 'scheduled') { location.hash = `#/campaigns/${id}`; return undefined; }
  let dirty = false;
  let saving = null;
  let timer;
  const selected = new Set(c.lists.map((l) => l.id));

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
        <div class="card mb-3"><div class="card-header">1 · Who receives it</div><div class="card-body">
          <div class="list-pick" role="group" aria-label="Lists">
            ${facets.lists.length ? facets.lists.map((l) => html`<div class="form-check">
              <input class="form-check-input" type="checkbox" id="l${l.id}" value="${l.id}" data-list ${selected.has(l.id) ? raw('checked') : ''}>
              <label class="form-check-label" for="l${l.id}">${l.name}${l.optin === 'double' ? html` <span class="badge text-bg-light">double opt-in</span>` : ''}</label></div>`)
              : html`<div class="text-muted-2">No lists yet. <a href="#/lists">Create a list</a> and add contacts first.</div>`}
          </div>
          <div class="mt-2 small" id="estimate"></div>
        </div></div>
        <div class="card mb-3"><div class="card-header">2 · Envelope</div><div class="card-body"><div class="row g-2">
          <div class="col-12"><label class="form-label">Internal name</label><input class="form-control" name="name" maxlength="200" value="${c.name}" required></div>
          <div class="col-12"><label class="form-label">Subject line</label><input class="form-control" name="subject" maxlength="300" value="${c.subject}" placeholder="e.g. {{ first_name | &quot;Hi&quot; }}, our November specials"></div>
          <div class="col-12"><label class="form-label">Preview text <span class="text-muted-2 small">(shown after the subject in most inboxes)</span></label><input class="form-control" name="preheader" maxlength="300" value="${c.preheader}"></div>
          <div class="col-md-6"><label class="form-label">From name</label><input class="form-control" name="from_name" maxlength="120" value="${c.from_name}"></div>
          <div class="col-md-6"><label class="form-label">From address</label><input class="form-control" name="from_email" type="email" value="${c.from_email}"></div>
          <div class="col-md-6"><label class="form-label">Reply-to <span class="text-muted-2 small">(optional)</span></label><input class="form-control" name="reply_to" type="email" value="${c.reply_to}"></div>
          <div class="col-md-6"><label class="form-label">Template</label><select class="form-select" name="template_id">${options(templates.map((t) => ({ value: t.id, label: `${t.name}${t.is_default ? ' (default)' : ''}` })), c.template_id)}</select></div>
          <div class="col-12 d-flex gap-4 flex-wrap mt-2">
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="to" name="track_opens" ${c.track_opens ? raw('checked') : ''}><label class="form-check-label" for="to">Track opens</label></div>
            <div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="tc" name="track_clicks" ${c.track_clicks ? raw('checked') : ''}><label class="form-check-label" for="tc">Track link clicks</label></div>
          </div>
        </div></div></div>
      </div>
      <div class="col-xl-5">
        <div class="card mb-3" id="ready"></div>
        <div class="card preview-card"><div class="card-header d-flex align-items-center">Preview <span class="small text-muted-2 ms-2">with sample data and your template</span>
          <div class="btn-group btn-group-sm ms-auto" role="group" aria-label="Preview width">
            <button type="button" class="btn btn-outline-secondary active" data-width="100%">Desktop</button>
            <button type="button" class="btn btn-outline-secondary" data-width="375px">Mobile</button></div></div>
          <div class="preview-frame-wrap"><iframe id="preview" title="Email preview" sandbox="allow-popups"></iframe></div></div>
      </div>
      <div class="col-12">
        <div class="card mb-3"><div class="card-header d-flex align-items-center gap-2 flex-wrap">3 · Content
          <div class="nav nav-pills ms-auto" role="group" aria-label="Editor mode">
            <button type="button" class="nav-link py-1 px-2" data-tab="builder" aria-pressed="false"><i class="bi bi-grid-1x2 me-1"></i>Builder</button>
            <button type="button" class="nav-link py-1 px-2" data-tab="visual" aria-pressed="false">Visual</button>
            <button type="button" class="nav-link py-1 px-2" data-tab="html" aria-pressed="false">HTML</button>
            <button type="button" class="nav-link py-1 px-2" data-tab="text" aria-pressed="false">Plain text</button>
          </div></div>
          <div id="builder" class="d-none"></div>
          <div class="editor-toolbar border-bottom" id="toolbar" role="toolbar" aria-label="Formatting">
            <button type="button" class="btn btn-sm btn-light" data-cmd="bold" title="Bold" aria-label="Bold"><i class="bi bi-type-bold"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="italic" title="Italic" aria-label="Italic"><i class="bi bi-type-italic"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="underline" title="Underline" aria-label="Underline"><i class="bi bi-type-underline"></i></button>
            <span class="sep"></span>
            <button type="button" class="btn btn-sm btn-light" data-block="h2" title="Heading" aria-label="Heading"><i class="bi bi-type-h2"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-block="h3" title="Sub-heading" aria-label="Sub-heading"><i class="bi bi-type-h3"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-block="p" title="Paragraph" aria-label="Paragraph"><i class="bi bi-paragraph"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="insertUnorderedList" title="Bulleted list" aria-label="Bulleted list"><i class="bi bi-list-ul"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="insertOrderedList" title="Numbered list" aria-label="Numbered list"><i class="bi bi-list-ol"></i></button>
            <span class="sep"></span>
            <button type="button" class="btn btn-sm btn-light" data-align="left" title="Align left" aria-label="Align left"><i class="bi bi-text-left"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-align="center" title="Centre" aria-label="Centre"><i class="bi bi-text-center"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-align="right" title="Align right" aria-label="Align right"><i class="bi bi-text-right"></i></button>
            <span class="sep"></span>
            <button type="button" class="btn btn-sm btn-light" data-insert="link" title="Link" aria-label="Insert link"><i class="bi bi-link-45deg"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-insert="button" title="Button" aria-label="Insert button"><i class="bi bi-hand-index"></i> Button</button>
            <button type="button" class="btn btn-sm btn-light" data-insert="image" title="Image" aria-label="Insert image"><i class="bi bi-image"></i></button>
            <div class="dropdown d-inline-block"><button type="button" class="btn btn-sm btn-light dropdown-toggle" data-bs-toggle="dropdown"><i class="bi bi-person-badge me-1"></i>Personalise</button>
              <ul class="dropdown-menu">${TAGS.map(([t, l]) => html`<li><button type="button" class="dropdown-item" data-tag="${t}">${l} <span class="text-muted-2 small mono">{{ ${t} }}</span></button></li>`)}
                <li><hr class="dropdown-divider"></li><li><span class="dropdown-item-text small text-muted-2">Fallback: {{ first_name | "there" }}<br>Custom field: {{ attribs.city }}</span></li></ul></div>
          </div>
          <div class="editor-surface" id="visual" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Email content"></div>
          <textarea class="form-control mono editor-code d-none" id="htmlsrc" aria-label="HTML source" spellcheck="false"></textarea>
          <div class="d-none" id="textwrap"><textarea class="form-control editor-code" id="textsrc" aria-label="Plain text version" placeholder="Leave empty to generate the plain-text version automatically from the content."></textarea></div>
          <div class="card-footer small text-muted-2">The template adds the header and footer around this content. An unsubscribe link and your organisation's address are always included.</div>
        </div>
      </div>
    </div>
    </form>`);

  const form = $('#cform', el);
  const visual = $('#visual', el);
  const htmlsrc = $('#htmlsrc', el);
  const textsrc = $('#textsrc', el);
  let editor = c.editor;
  let builder = null;
  let lastHtml = c.body_html;
  const startBuilder = (doc) => { builder = createBuilder($('#builder', el), doc, { onChange: () => changed() }); };
  if (editor === 'builder') startBuilder(c.body_json || documentFromHtml(c.body_html));
  // Stored content is sanitised server-side. Builder output (inline styles) is not loaded into the
  // visual editor: the app's CSP blocks inline styles, so it would display wrongly there.
  if (editor !== 'builder') visual.innerHTML = c.body_html;
  htmlsrc.value = c.body_html;
  textsrc.value = c.body_text;

  const currentHtml = () => (editor === 'html' ? htmlsrc.value : visual.innerHTML);
  const collect = () => ({
    name: form.name.value, subject: form.subject.value, preheader: form.preheader.value,
    from_name: form.from_name.value, from_email: form.from_email.value, reply_to: form.reply_to.value,
    template_id: Number(form.template_id.value) || null, editor,
    body_html: editor === 'builder' ? '' : currentHtml(), ...(editor === 'builder' ? { body_json: builder.getDoc() } : {}), body_text: textsrc.value,
    track_opens: form.track_opens.checked, track_clicks: form.track_clicks.checked, list_ids: [...selected],
  });

  async function save() {
    clearTimeout(timer);
    if (saving) await saving;
    if (!dirty) return true;
    dirty = false;
    $('#save-state', el).textContent = 'Saving…';
    saving = put(`/campaigns/${id}`, collect()).then((r) => {
      $('#save-state', el).textContent = 'All changes saved';
      lastHtml = r.data.body_html;
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
  const changed = () => { dirty = true; $('#save-state', el).textContent = 'Unsaved changes…'; clearTimeout(timer); timer = setTimeout(save, 1200); };

  function refreshPreview() {
    $('#preview', el).src = `/api/campaigns/${id}/preview?ts=${Date.now()}`;
  }

  async function renderReady(data) {
    const info = data?.problems ? data : (await get(`/campaigns/${id}`)).data;
    mount($('#ready', el), info.problems.length
      ? html`<div class="card-header">Before you can send</div><ul class="list-group list-group-flush">${info.problems.map((p) => html`<li class="list-group-item small"><i class="bi bi-circle me-2 text-warning"></i>${p}</li>`)}</ul>`
      : html`<div class="card-body d-flex gap-2 align-items-center"><i class="bi bi-check-circle-fill text-success fs-4"></i><div><div class="fw-semibold">Ready to send</div><div class="small text-muted-2">${num(info.eligible)} eligible recipient(s). Send yourself a test first.</div></div></div>`);
    mount($('#estimate', el), html`<i class="bi bi-people me-1"></i><strong>${num(info.eligible)}</strong> contact(s) will receive this campaign <span class="text-muted-2">(suppressed, unsubscribed, unconfirmed and held contacts are excluded)</span>`);
  }

  // ---- Visual editor --------------------------------------------------------
  const block = () => {
    let n = window.getSelection()?.anchorNode;
    while (n && n !== visual && !(n.nodeType === 1 && /^(P|H1|H2|H3|H4|LI|DIV|BLOCKQUOTE)$/.test(n.nodeName))) n = n.parentNode;
    return n && n !== visual ? n : null;
  };
  const insertHtml = (h) => { visual.focus(); document.execCommand('insertHTML', false, h); changed(); };
  $('#toolbar', el).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (editor !== 'visual') { toast('Switch to the Visual tab to use the toolbar', 'info'); return; }
    if (b.dataset.cmd) { visual.focus(); document.execCommand(b.dataset.cmd); changed(); }
    if (b.dataset.block) { visual.focus(); document.execCommand('formatBlock', false, b.dataset.block); changed(); }
    if (b.dataset.align) {
      const n = block();
      if (n) { n.classList.remove('mh-align-left', 'mh-align-center', 'mh-align-right'); if (b.dataset.align !== 'left') n.classList.add(`mh-align-${b.dataset.align}`); changed(); }
    }
    if (b.dataset.tag) insertHtml(`{{ ${b.dataset.tag} }}`);
    if (b.dataset.insert) {
      const sel = window.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const text = sel.toString();
      const kind = b.dataset.insert;
      formModal({
        title: { link: 'Insert link', button: 'Insert button', image: 'Insert image' }[kind], submitLabel: 'Insert',
        body: html`<label class="form-label">${kind === 'image' ? 'Image address (https://…)' : 'Web address (https://…)'}</label>
          <input class="form-control mb-2" name="url" type="url" required placeholder="https://">
          ${kind !== 'image' ? html`<label class="form-label">Text</label><input class="form-control" name="label" value="${text || (kind === 'button' ? 'Find out more' : '')}" required>`
            : html`<label class="form-label">Description (for screen readers and blocked images)</label><input class="form-control" name="label" required>`}`,
        onSubmit: async (fd) => {
          const url = String(fd.get('url') || '');
          if (!/^https?:\/\//i.test(url)) throw { message: 'Use a full web address starting with https://' };
          const label = esc(fd.get('label'));
          if (range) { sel.removeAllRanges(); sel.addRange(range); }
          if (kind === 'link') insertHtml(`<a href="${esc(url)}">${label}</a>`);
          if (kind === 'button') insertHtml(`<p class="mh-align-center"><a href="${esc(url)}" class="mh-button">${label}</a></p><p></p>`);
          if (kind === 'image') insertHtml(`<img src="${esc(url)}" alt="${label}">`);
        },
      });
    }
  });
  visual.addEventListener('input', changed);
  visual.addEventListener('paste', (e) => {
    // Paste as plain text: formatting from Word/web pages breaks email layouts.
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });
  htmlsrc.addEventListener('input', changed);
  textsrc.addEventListener('input', changed);
  form.addEventListener('input', (e) => { if (!e.target.matches('[data-list]') && !e.target.closest('#builder')) changed(); });
  form.addEventListener('change', (e) => {
    if (e.target.matches('[data-list]')) {
      selected[e.target.checked ? 'add' : 'delete'](Number(e.target.value));
      changed();
    }
  });
  form.addEventListener('submit', (e) => e.preventDefault());

  // Editor modes
  function showPane(tab) {
    $$('[data-tab]', el).forEach((x) => { const on = x.dataset.tab === tab; x.classList.toggle('active', on); x.setAttribute('aria-pressed', String(on)); });
    $('#builder', el).classList.toggle('d-none', tab !== 'builder');
    visual.classList.toggle('d-none', tab !== 'visual');
    $('#toolbar', el).classList.toggle('d-none', tab !== 'visual');
    htmlsrc.classList.toggle('d-none', tab !== 'html');
    $('#textwrap', el).classList.toggle('d-none', tab !== 'text');
  }
  async function switchTo(tab) {
    if (tab === 'text' || tab === editor) { showPane(tab); return; }
    if (editor === 'builder') {
      const ok = await confirmModal({ title: 'Convert the design to HTML?', confirmLabel: 'Convert to HTML',
        message: 'The drag-and-drop layout becomes HTML code that you edit directly. You can return to the builder later, but the content then comes back as a single HTML block.' });
      if (!ok) return;
      dirty = true;
      if (!(await save())) return; // the server renders the latest design
      htmlsrc.value = lastHtml;
      tab = 'html'; // designed layouts use inline styles, which only the HTML editor shows faithfully
    } else if (tab === 'builder') {
      const ok = await confirmModal({ title: 'Switch to the drag-and-drop builder?', confirmLabel: 'Use the builder',
        message: 'Your current content is kept as one HTML block. Add, rearrange or replace blocks around it.' });
      if (!ok) return;
      startBuilder(documentFromHtml(currentHtml()));
    } else if (tab === 'html') {
      htmlsrc.value = visual.innerHTML;
    } else {
      visual.innerHTML = htmlsrc.value;
    }
    editor = tab;
    changed();
    showPane(tab);
  }
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) switchTo(t.dataset.tab);
  });
  showPane(editor);

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
      body: html`<label class="form-label">Send to (up to 5 addresses, comma separated)</label>
        <input class="form-control" name="emails" required value="${ctx.user.email}">
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
    const d = new Date(Date.now() + 3600000);
    d.setMinutes(0, 0, 0);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    formModal({
      title: 'Schedule campaign', submitLabel: 'Schedule',
      body: html`<label class="form-label">Send at (your local time)</label><input class="form-control" type="datetime-local" name="at" required value="${local}" min="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)}">`,
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
  renderReady(c);
  refreshPreview();
  return () => { window.removeEventListener('beforeunload', beforeUnload); if (dirty) save(); };
}
