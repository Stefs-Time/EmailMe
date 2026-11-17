// Drag-and-drop email builder.
//
// Edits a block document ({ version, blocks: [...] }) on a WYSIWYG canvas:
//   - drag blocks from the palette onto the canvas (or click a block to add it),
//   - drag the ⋮⋮ handle to reorder, or use the move/duplicate/delete buttons,
//   - type directly into headings, text and button labels,
//   - set colours, alignment, links and spacing in the properties panel.
// The server validates the document and renders the email HTML; this module
// never produces the HTML that is sent.
//
// CSP note: inline style attributes are blocked, so canvas styling is applied
// through the CSSOM (element.style.x = …), which CSP allows.
import { html, raw, mount, $, $$, formModal, toast } from './ui.js';
import { tagBar } from './tags.js';

export const BLOCKS = [
  { type: 'heading', label: 'Heading', icon: 'type-h1' },
  { type: 'text', label: 'Text', icon: 'text-paragraph' },
  { type: 'button', label: 'Button', icon: 'hand-index' },
  { type: 'image', label: 'Image', icon: 'image' },
  { type: 'columns', label: 'Two columns', icon: 'layout-split' },
  { type: 'divider', label: 'Divider', icon: 'dash-lg' },
  { type: 'spacer', label: 'Spacer', icon: 'arrows-vertical' },
  { type: 'html', label: 'HTML', icon: 'code-slash' },
  // Templates only
  { type: 'content', label: 'Campaign content', icon: 'body-text', templateOnly: true },
  { type: 'footer', label: 'Footer', icon: 'layout-text-window-reverse', templateOnly: true },
];
const TOP_ONLY = new Set(['columns', 'content']); // cannot go inside columns
const LABEL = Object.fromEntries(BLOCKS.map((b) => [b.type, b.label]));

const DEFAULTS = {
  heading: { text: 'Your heading', level: 2, align: 'left', color: '#16365f', pad: 12, bg: '' },
  text: { html: '<p>Write your text here.</p>', align: 'left', color: '#1b2430', size: 16, pad: 12, bg: '' },
  button: { label: 'Find out more', url: '', align: 'center', bg: '#1f4e8c', color: '#ffffff', radius: 6, full: false, pad: 16, bg_row: '' },
  image: { src: '', alt: '', href: '', width: 100, align: 'center', pad: 12, bg: '' },
  columns: { ratio: '50-50', gap: 16, columns: [[], []], pad: 12, bg: '' },
  divider: { color: '#dde3ea', thickness: 1, pad: 12, bg: '' },
  spacer: { height: 24 },
  html: { html: '<p>Custom HTML</p>', pad: 12, bg: '' },
  content: {},
  footer: { text: 'You are receiving this because you subscribed or are a customer of {{ org_name }}.', align: 'center', color: '#5f6b7a', size: 12, pad: 16, bg: '' },
};
const PAGE_DEFAULTS = { page_bg: '#f4f6f9', body_bg: '#ffffff', width: 600, font: 'arial', radius: 8, body_pad: 28 };
const FONTS = {
  arial: ['Arial', 'Arial, Helvetica, sans-serif'],
  helvetica: ['Helvetica', "'Helvetica Neue', Helvetica, Arial, sans-serif"],
  verdana: ['Verdana', 'Verdana, Geneva, sans-serif'],
  trebuchet: ['Trebuchet MS', "'Trebuchet MS', Arial, sans-serif"],
  georgia: ['Georgia (serif)', "Georgia, 'Times New Roman', serif"],
};
const HEADING_SIZE = { 1: 28, 2: 22, 3: 18 };

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hexColour) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hexColour.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const withDefaults = (b) => ({ ...b, props: { ...clone(DEFAULTS[b.type] || {}), ...(b.props || {}) } });
const newBlock = (type) => ({ id: uid(), type, props: clone(DEFAULTS[type]) });

/**
 * @param {HTMLElement} root
 * @param {object} initial  block document
 * @param {{ onChange: (doc) => void, mode?: 'campaign' | 'template', customTags?: string[] }} opts
 *   mode 'template' adds the Campaign content and Footer blocks and page settings.
 *   customTags: imported column names offered as personalisation chips. The page wires
 *   the chips with enableTagChips() (tags.js), using selectedEditable() as the fallback.
 */
export function createBuilder(root, initial, { onChange, mode = 'campaign', customTags = [] }) {
  const isTemplate = mode === 'template';
  const doc = { version: 1, blocks: (initial?.blocks || []).map((b) => {
    const x = withDefaults(b);
    if (x.type === 'columns') x.props.columns = [0, 1].map((i) => (x.props.columns?.[i] || []).map(withDefaults));
    return x;
  }) };
  if (isTemplate) doc.settings = { ...PAGE_DEFAULTS, ...(initial?.settings || {}) };
  const palette = BLOCKS.filter((b) => isTemplate || !b.templateOnly);
  let selectedId = null;
  let drag = null; // { kind: 'new', type } | { kind: 'move', id }
  const undo = [];
  const redo = [];
  let typingSnapshot = false;

  mount(root, html`
    <div class="bb">
      <div class="bb-palette" role="toolbar" aria-label="Blocks: drag onto the email, or press to add">
        <div class="bb-palette-inner"><div class="bb-palette-title">Blocks</div>
        ${palette.map((b) => html`<div class="bb-tile" role="button" tabindex="0" draggable="true" data-new="${b.type}" title="Drag onto the email, or click to add" aria-label="Add ${b.label}">
          <i class="bi bi-${b.icon}" aria-hidden="true"></i><span>${b.label}</span></div>`)}
      </div></div>
      <div class="bb-stage">
        <div class="bb-bar">
          <button type="button" class="btn btn-sm btn-light" id="bb-undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled><i class="bi bi-arrow-counterclockwise"></i></button>
          <button type="button" class="btn btn-sm btn-light" id="bb-redo" title="Redo (Ctrl+Y)" aria-label="Redo" disabled><i class="bi bi-arrow-clockwise"></i></button>
          <span class="small text-muted-2 ms-2 d-none d-xxl-inline">Drag blocks in · click to edit · type directly in the email</span>
        </div>
        <div class="bb-tagrow">${tagBar({ custom: customTags, label: 'Personalise:' })}
          <div class="small text-muted-2 mt-1">Click in a heading, text or button, then click a field to insert it. The preview shows real names.</div></div>
        <div class="bb-canvas-wrap"><div class="bb-canvas"><div class="bb-list" data-list="root" aria-label="Email content"></div></div></div>
      </div>
      <aside class="bb-props" aria-label="Block settings"><div class="bb-props-inner"></div></aside>
    </div>`);

  const canvas = $('.bb-canvas', root);
  const props = $('.bb-props-inner', root);
  const indicator = document.createElement('div');
  indicator.className = 'bb-indicator';

  // ---- Model helpers ------------------------------------------------------------
  function listById(key) {
    if (key === 'root') return doc.blocks;
    const [pid, i] = key.split(':');
    const parent = doc.blocks.find((b) => b.id === pid);
    return parent?.props.columns[Number(i)];
  }
  function locate(id) {
    for (const [i, b] of doc.blocks.entries()) {
      if (b.id === id) return { list: doc.blocks, index: i, block: b, key: 'root' };
      if (b.type === 'columns') {
        for (const [c, col] of b.props.columns.entries()) {
          const j = col.findIndex((x) => x.id === id);
          if (j >= 0) return { list: col, index: j, block: col[j], key: `${b.id}:${c}` };
        }
      }
    }
    return null;
  }
  const snapshot = () => JSON.stringify({ blocks: doc.blocks, settings: doc.settings });
  function record() {
    undo.push(snapshot());
    if (undo.length > 60) undo.shift();
    redo.length = 0;
    syncHistoryButtons();
  }
  function changed() { onChange(getDoc()); }
  function syncHistoryButtons() {
    $('#bb-undo', root).disabled = !undo.length;
    $('#bb-redo', root).disabled = !redo.length;
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    const state = JSON.parse(from.pop());
    doc.blocks = state.blocks;
    if (isTemplate) doc.settings = state.settings;
    if (selectedId && !locate(selectedId)) selectedId = null;
    applyPage();
    renderAll();
    syncHistoryButtons();
    changed();
  }

  // ---- Canvas rendering -------------------------------------------------------------
  function styleBox(el, p) {
    el.style.paddingTop = `${p.pad ?? 0}px`;
    el.style.paddingBottom = `${p.pad ?? 0}px`;
    el.style.backgroundColor = p.bg || '';
    if (p.bg) { el.style.paddingLeft = '16px'; el.style.paddingRight = '16px'; } else { el.style.paddingLeft = ''; el.style.paddingRight = ''; }
  }

  function renderBody(b) {
    const p = b.props;
    const body = document.createElement('div');
    body.className = 'bb-body';
    // A button's own colour is `bg`; its row background is `bg_row`.
    if (b.type === 'button') styleBox(body, { pad: p.pad, bg: p.bg_row });
    else if (b.type !== 'spacer') styleBox(body, p);
    switch (b.type) {
      case 'heading': {
        const h = document.createElement(`h${p.level}`);
        h.className = 'bb-edit bb-heading';
        h.contentEditable = 'true';
        h.spellcheck = true;
        h.setAttribute('aria-label', 'Heading text');
        h.textContent = p.text;
        Object.assign(h.style, { color: p.color, textAlign: p.align, fontSize: `${HEADING_SIZE[p.level]}px` });
        h.dataset.field = 'text';
        body.append(h);
        break;
      }
      case 'text': {
        const t = document.createElement('div');
        t.className = 'bb-edit bb-text';
        t.contentEditable = 'true';
        t.setAttribute('role', 'textbox');
        t.setAttribute('aria-multiline', 'true');
        t.setAttribute('aria-label', 'Text');
        t.innerHTML = p.html; // cleaned by the server on every save
        Object.assign(t.style, { color: p.color, textAlign: p.align, fontSize: `${p.size}px` });
        t.dataset.field = 'html';
        body.append(t);
        break;
      }
      case 'button': {
        body.style.textAlign = p.align;
        const s = document.createElement('span');
        s.className = 'bb-edit bb-button';
        s.contentEditable = 'true';
        s.setAttribute('aria-label', 'Button label');
        s.textContent = p.label;
        Object.assign(s.style, { backgroundColor: p.bg, color: p.color, borderRadius: `${p.radius}px`, display: p.full ? 'block' : 'inline-block' });
        s.dataset.field = 'label';
        body.append(s);
        if (!p.url) {
          const warn = document.createElement('div');
          warn.className = 'bb-hint text-warning-emphasis';
          warn.textContent = 'Add the button link in the panel →';
          body.append(warn);
        }
        break;
      }
      case 'image': {
        if (p.src) {
          const img = document.createElement('img');
          img.src = p.src;
          img.alt = p.alt;
          img.className = 'bb-img';
          img.style.width = `${p.width}%`;
          img.style.marginLeft = p.align === 'left' ? '0' : 'auto';
          img.style.marginRight = p.align === 'right' ? '0' : 'auto';
          body.append(img);
        } else {
          const ph = document.createElement('div');
          ph.className = 'bb-placeholder';
          ph.innerHTML = '<i class="bi bi-image"></i><span>Image: add the image address (https://…) in the panel</span>';
          body.append(ph);
        }
        break;
      }
      case 'divider': {
        const d = document.createElement('div');
        d.className = 'bb-divider';
        d.style.borderTop = `${p.thickness}px solid ${p.color}`;
        body.append(d);
        break;
      }
      case 'spacer': {
        body.classList.add('bb-spacer');
        body.style.height = `${p.height}px`;
        break;
      }
      case 'html': {
        const pre = document.createElement('div');
        pre.className = 'bb-code';
        pre.textContent = p.html.length > 400 ? `${p.html.slice(0, 400)}…` : p.html;
        const note = document.createElement('div');
        note.className = 'bb-hint';
        note.textContent = 'HTML block: shown fully in the Preview. Edit it in the panel.';
        body.append(pre, note);
        break;
      }
      case 'content': {
        const slot = document.createElement('div');
        slot.className = 'bb-slot';
        const st = doc.settings || PAGE_DEFAULTS;
        Object.assign(slot.style, { backgroundColor: st.body_bg, borderRadius: `${st.radius}px`, padding: `${Math.max(st.body_pad, 16)}px` });
        slot.innerHTML = '<i class="bi bi-body-text"></i><strong>Campaign content</strong><span>Each campaign\'s design appears here.</span>';
        body.append(slot);
        break;
      }
      case 'footer': {
        const f = document.createElement('div');
        f.className = 'bb-footer';
        Object.assign(f.style, { color: p.color, fontSize: `${p.size}px`, textAlign: p.align });
        const line = (t) => { const d = document.createElement('div'); d.textContent = t; return d; };
        const links = document.createElement('div');
        links.innerHTML = '<u>Unsubscribe</u> &nbsp;·&nbsp; <u>View in browser</u>';
        f.append(line('{{ org_name }} · {{ org_address }}'), ...(p.text.trim() ? [line(p.text)] : []), links);
        body.append(f);
        break;
      }
      case 'columns': {
        const grid = document.createElement('div');
        grid.className = 'bb-cols';
        const [l, r] = { '50-50': [1, 1], '33-67': [1, 2], '67-33': [2, 1] }[p.ratio];
        grid.style.gridTemplateColumns = `${l}fr ${r}fr`;
        grid.style.columnGap = `${p.gap}px`;
        p.columns.forEach((col, i) => {
          const list = document.createElement('div');
          list.className = 'bb-list bb-col';
          list.dataset.list = `${b.id}:${i}`;
          list.setAttribute('aria-label', `Column ${i + 1}`);
          col.forEach((child) => list.append(renderBlock(child)));
          if (!col.length) list.append(emptyNote('Drop blocks here'));
          grid.append(list);
        });
        body.append(grid);
        break;
      }
      default:
    }
    return body;
  }

  function emptyNote(text) {
    const e = document.createElement('div');
    e.className = 'bb-empty';
    e.textContent = text;
    return e;
  }

  function renderBlock(b) {
    const el = document.createElement('div');
    el.className = `bb-block bb-type-${b.type}${b.id === selectedId ? ' selected' : ''}`;
    el.dataset.id = b.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `${LABEL[b.type]} block`);
    const tools = document.createElement('div');
    tools.className = 'bb-tools';
    tools.innerHTML = String(html`
      <span class="bb-handle" draggable="true" title="Drag to move" aria-hidden="true"><i class="bi bi-grip-vertical"></i></span>
      <span class="bb-name">${LABEL[b.type]}</span>
      <button type="button" data-act="up" title="Move up" aria-label="Move ${LABEL[b.type]} up"><i class="bi bi-arrow-up"></i></button>
      <button type="button" data-act="down" title="Move down" aria-label="Move ${LABEL[b.type]} down"><i class="bi bi-arrow-down"></i></button>
      ${b.type === 'content' ? '' : html`<button type="button" data-act="dup" title="Duplicate" aria-label="Duplicate ${LABEL[b.type]}"><i class="bi bi-copy"></i></button>
      <button type="button" data-act="del" title="Delete" aria-label="Delete ${LABEL[b.type]}"><i class="bi bi-trash3"></i></button>`}`);
    el.append(tools, renderBody(b));
    return el;
  }

  function renderAll() {
    const list = $('[data-list="root"]', canvas);
    list.replaceChildren(...doc.blocks.map(renderBlock));
    if (!doc.blocks.length) list.append(emptyNote('Drag a block here to start, or click one on the left.'));
    // Only one Campaign content block per template.
    const contentTile = $('.bb-tile[data-new="content"]', root);
    if (contentTile) {
      const has = doc.blocks.some((b) => b.type === 'content');
      contentTile.classList.toggle('disabled', has);
      contentTile.setAttribute('aria-disabled', String(has));
      contentTile.draggable = !has;
      contentTile.title = has ? 'A template has one Campaign content block (already in the template)' : 'Drag onto the email, or click to add';
    }
    renderProps();
  }

  /** Template page settings shown on the canvas: page colour, width and font. */
  function applyPage() {
    if (!isTemplate) return;
    const st = doc.settings;
    $('.bb-canvas-wrap', root).style.backgroundColor = st.page_bg;
    canvas.classList.add('bb-canvas-page');
    canvas.style.maxWidth = `${st.width}px`;
    canvas.style.fontFamily = FONTS[st.font][1];
  }

  function rerender(id) {
    const old = $(`.bb-block[data-id="${id}"]`, canvas);
    const loc = locate(id);
    if (old && loc) old.replaceWith(renderBlock(loc.block));
  }

  function select(id, { focus = false } = {}) {
    selectedId = id;
    $$('.bb-block', canvas).forEach((x) => x.classList.toggle('selected', x.dataset.id === id));
    renderProps();
    if (focus) $(`.bb-block[data-id="${id}"]`, canvas)?.focus();
  }

  // ---- Properties panel ---------------------------------------------------------------
  const colorField = (name, value, lbl) => html`<div class="col-6"><label class="form-label small">${lbl}</label><input type="color" class="form-control form-control-color w-100" data-prop="${name}" value="${value || '#ffffff'}"></div>`;
  const numberField = (name, value, lbl, min, max, step = 1) => html`<div class="col-6"><label class="form-label small">${lbl}</label><input type="number" class="form-control form-control-sm" data-prop="${name}" value="${value}" min="${min}" max="${max}" step="${step}"></div>`;
  const alignField = (value) => html`<div class="col-12"><span class="form-label small d-block">Alignment</span><div class="btn-group btn-group-sm w-100" role="group" aria-label="Alignment">
    ${['left', 'center', 'right'].map((a) => html`<button type="button" class="btn btn-outline-secondary ${value === a ? 'active' : ''}" data-align="${a}" aria-pressed="${value === a}" aria-label="Align ${a}"><i class="bi bi-text-${a === 'center' ? 'center' : a}"></i></button>`)}</div></div>`;
  const bgField = (p, key = 'bg') => html`<div class="col-12"><div class="form-check form-switch small"><input class="form-check-input" type="checkbox" role="switch" id="bb-bg-on" data-bg-toggle="${key}" ${p[key] ? raw('checked') : ''}><label class="form-check-label" for="bb-bg-on">Background colour</label></div>
    ${p[key] ? html`<input type="color" class="form-control form-control-color w-100 mt-1" data-prop="${key}" value="${p[key]}" aria-label="Background colour">` : ''}</div>`;


  function renderProps() {
    const loc = selectedId && locate(selectedId);
    if (!loc && isTemplate) { renderPageProps(); return; }
    if (!loc) {
      mount(props, html`<div class="bb-props-empty"><i class="bi bi-hand-index-thumb"></i><p>Select a block in the email to change its text, colours, links and spacing.</p>
        <p class="small">Drag blocks from the Blocks panel. On a phone or with a keyboard, tap or press a block name to add it below the selected block.</p></div>`);
      return;
    }
    const { block: b } = loc;
    const p = b.props;
    let fields;
    switch (b.type) {
      case 'heading':
        fields = html`<div class="col-12"><label class="form-label small">Size</label><select class="form-select form-select-sm" data-prop="level" data-num>
          ${[[1, 'Large (H1)'], [2, 'Medium (H2)'], [3, 'Small (H3)']].map(([v, l]) => html`<option value="${v}" ${p.level === v ? raw('selected') : ''}>${l}</option>`)}</select></div>
          ${alignField(p.align)}${colorField('color', p.color, 'Text colour')}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}${bgField(p)}`;
        break;
      case 'text':
        fields = html`<div class="col-12"><span class="form-label small d-block">Format selected text</span>
          <div class="btn-toolbar gap-1 bb-format" role="toolbar" aria-label="Text formatting">
            <button type="button" class="btn btn-sm btn-light" data-cmd="bold" aria-label="Bold" title="Bold"><i class="bi bi-type-bold"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="italic" aria-label="Italic" title="Italic"><i class="bi bi-type-italic"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="underline" aria-label="Underline" title="Underline"><i class="bi bi-type-underline"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="insertUnorderedList" aria-label="Bulleted list" title="Bulleted list"><i class="bi bi-list-ul"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="insertOrderedList" aria-label="Numbered list" title="Numbered list"><i class="bi bi-list-ol"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-link aria-label="Add link" title="Add link"><i class="bi bi-link-45deg"></i></button>
            <button type="button" class="btn btn-sm btn-light" data-cmd="unlink" aria-label="Remove link" title="Remove link"><i class="bi bi-link"></i><i class="bi bi-x-lg small"></i></button>
          </div></div>
          ${alignField(p.align)}${colorField('color', p.color, 'Text colour')}${numberField('size', p.size, 'Text size (px)', 12, 22)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}${bgField(p)}`;
        break;
      case 'button':
        fields = html`<div class="col-12"><label class="form-label small">Link (https://…)</label><input type="url" class="form-control form-control-sm" data-prop="url" value="${p.url}" placeholder="https://example.co.za/offer"></div>
          <div class="col-12"><label class="form-label small">Label</label><input class="form-control form-control-sm" data-prop="label" value="${p.label}" maxlength="120"></div>
          ${alignField(p.align)}${colorField('bg', p.bg, 'Button colour')}${colorField('color', p.color, 'Text colour')}
          ${numberField('radius', p.radius, 'Rounded corners', 0, 30)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}
          <div class="col-12"><div class="form-check form-switch small"><input class="form-check-input" type="checkbox" role="switch" id="bb-full" data-prop="full" ${p.full ? raw('checked') : ''}><label class="form-check-label" for="bb-full">Full width</label></div></div>`;
        break;
      case 'image':
        fields = html`<div class="col-12"><label class="form-label small">Image address (https://…)</label><input type="url" class="form-control form-control-sm" data-prop="src" value="${p.src}" placeholder="https://example.co.za/banner.jpg">
            <div class="form-text">Host images on your website or file storage. Use JPG or PNG, about 1200px wide.</div></div>
          <div class="col-12"><label class="form-label small">Description (alt text)</label><input class="form-control form-control-sm" data-prop="alt" value="${p.alt}" maxlength="300" placeholder="What the image shows"></div>
          <div class="col-12"><label class="form-label small">Link when clicked (optional)</label><input type="url" class="form-control form-control-sm" data-prop="href" value="${p.href}" placeholder="https://"></div>
          <div class="col-12"><label class="form-label small">Width: <span data-out="width">${p.width}</span>%</label><input type="range" class="form-range" data-prop="width" data-num min="10" max="100" step="5" value="${p.width}"></div>
          ${alignField(p.align)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}${bgField(p)}`;
        break;
      case 'columns':
        fields = html`<div class="col-12"><label class="form-label small">Layout</label><select class="form-select form-select-sm" data-prop="ratio">
          ${[['50-50', 'Equal (½ + ½)'], ['33-67', 'Narrow + wide (⅓ + ⅔)'], ['67-33', 'Wide + narrow (⅔ + ⅓)']].map(([v, l]) => html`<option value="${v}" ${p.ratio === v ? raw('selected') : ''}>${l}</option>`)}</select>
          <div class="form-text">Drag blocks into each column. On phones the columns stack.</div></div>
          ${numberField('gap', p.gap, 'Gap (px)', 0, 40)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}${bgField(p)}`;
        break;
      case 'divider':
        fields = html`${colorField('color', p.color, 'Line colour')}${numberField('thickness', p.thickness, 'Thickness (px)', 1, 8)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}`;
        break;
      case 'spacer':
        fields = html`<div class="col-12"><label class="form-label small">Height: <span data-out="height">${p.height}</span>px</label><input type="range" class="form-range" data-prop="height" data-num min="4" max="120" step="4" value="${p.height}"></div>`;
        break;
      case 'content':
        fields = html`<div class="col-12 small text-muted-2">Every campaign that uses this template appears here. Move it to put a header above
          and a footer below. Change the content area's colour, corners and padding under <button type="button" class="btn btn-link btn-sm p-0 align-baseline" data-deselect>Page settings</button>.</div>`;
        break;
      case 'footer':
        fields = html`<div class="col-12"><label class="form-label small">Extra line (optional)</label><input class="form-control form-control-sm" data-prop="text" value="${p.text}" maxlength="300">
            <div class="form-text">Your organisation name and postal address (Settings → General), the unsubscribe link and "View in browser" are always included.</div></div>
          ${alignField(p.align)}${colorField('color', p.color, 'Text colour')}${numberField('size', p.size, 'Text size (px)', 10, 16)}${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}${bgField(p)}`;
        break;
      case 'html':
        fields = html`<div class="col-12"><label class="form-label small">HTML</label><textarea class="form-control form-control-sm mono bb-html-src" data-prop="html" spellcheck="false" rows="10">${p.html}</textarea>
          <div class="form-text">Scripts and unsafe content are removed when saved. Prefer the other blocks: they work in every email client.</div></div>${numberField('pad', p.pad, 'Spacing (px)', 0, 64)}`;
        break;
      default: fields = '';
    }
    mount(props, html`<div class="bb-props-head"><strong>${LABEL[b.type]}</strong>
        <button type="button" class="btn btn-sm btn-link text-muted-2 ms-auto" data-deselect>Done</button></div>
      <div class="row g-2">${fields}</div>
      <div class="alert alert-warning small py-2 px-2 mt-2 mb-0 d-none" data-contrast role="status"></div>`);
    updateContrast();
  }

  function renderPageProps() {
    const st = doc.settings;
    mount(props, html`<div class="bb-props-head"><strong>Page settings</strong></div>
      <p class="small text-muted-2">Select a block to edit it. These settings apply to the whole email.</p>
      <div class="row g-2">
        <div class="col-6"><label class="form-label small">Page background</label><input type="color" class="form-control form-control-color w-100" data-page="page_bg" value="${st.page_bg}"></div>
        <div class="col-6"><label class="form-label small">Content background</label><input type="color" class="form-control form-control-color w-100" data-page="body_bg" value="${st.body_bg}"></div>
        <div class="col-12"><label class="form-label small">Email width: <span data-out="width">${st.width}</span>px</label><input type="range" class="form-range" data-page="width" min="480" max="720" step="20" value="${st.width}"></div>
        <div class="col-12"><label class="form-label small">Font</label><select class="form-select form-select-sm" data-page="font">
          ${Object.entries(FONTS).map(([k, [l]]) => html`<option value="${k}" ${st.font === k ? raw('selected') : ''}>${l}</option>`)}</select>
          <div class="form-text">Email-safe fonts that every device has.</div></div>
        <div class="col-6"><label class="form-label small">Content corners (px)</label><input type="number" class="form-control form-control-sm" data-page="radius" min="0" max="24" value="${st.radius}"></div>
        <div class="col-6"><label class="form-label small">Content padding (px)</label><input type="number" class="form-control form-control-sm" data-page="body_pad" min="0" max="48" value="${st.body_pad}"></div>
      </div>
      <p class="small text-muted-2 mt-3 mb-0">Drag blocks from the Blocks panel above or below the Campaign content to build a header (logo, name) and footer.</p>`);
  }

  /** Warns when text would be hard to read (WCAG AA: 4.5:1). */
  function updateContrast() {
    const box = $('[data-contrast]', props);
    const loc = selectedId && locate(selectedId);
    if (!box || !loc) return;
    const p = loc.block.props;
    let pair = null;
    const behind = p.bg || (isTemplate && loc.key === 'root' ? doc.settings.page_bg : '#ffffff');
    if (loc.block.type === 'button') pair = [p.color, p.bg];
    else if (['heading', 'text', 'footer'].includes(loc.block.type)) pair = [p.color, behind];
    const ratio = pair ? contrast(...pair) : 99;
    box.classList.toggle('d-none', ratio >= 4.5);
    box.textContent = ratio < 4.5 ? `Low contrast (${ratio.toFixed(1)}:1): some readers will struggle to read this. Aim for at least 4.5:1, e.g. a darker colour.` : '';
  }

  function setProp(id, key, value, { rerenderBlock = true, history = true } = {}) {
    const loc = locate(id);
    if (!loc) return;
    if (history) record();
    loc.block.props[key] = value;
    if (rerenderBlock) rerender(id);
    changed();
  }

  props.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.page) {
      let v = t.value;
      if (t.type === 'range' || t.type === 'number') {
        v = Number(v);
        if (Number.isNaN(v)) return;
        v = Math.max(Number(t.min), Math.min(Number(t.max), v));
      }
      if (!typingSnapshot) record();
      typingSnapshot = true;
      clearTimeout(props.burstTimer);
      props.burstTimer = setTimeout(() => { typingSnapshot = false; }, 800);
      doc.settings[t.dataset.page] = v;
      const out = $(`[data-out="${t.dataset.page}"]`, props);
      if (out) out.textContent = v;
      applyPage();
      const slot = doc.blocks.find((b) => b.type === 'content');
      if (slot) rerender(slot.id);
      changed();
      return;
    }
    if (!t.dataset.prop || !selectedId) return;
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number' || t.type === 'range' || 'num' in t.dataset) v = Number(v);
    if (t.type === 'number') {
      const min = Number(t.min); const max = Number(t.max);
      if (Number.isNaN(v)) return;
      v = Math.max(min, Math.min(max, v));
    }
    const out = $(`[data-out="${t.dataset.prop}"]`, props);
    if (out) out.textContent = v;
    // Typing in text fields: one undo step per burst, not per keystroke.
    const burst = t.matches('input[type=url], input:not([type]), textarea');
    setProp(selectedId, t.dataset.prop, v, { history: !burst || !typingSnapshot });
    if (burst) { typingSnapshot = true; clearTimeout(props.burstTimer); props.burstTimer = setTimeout(() => { typingSnapshot = false; }, 800); }
    if (t.dataset.prop === 'level' || t.dataset.prop === 'full') renderProps();
    else updateContrast();
  });
  props.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.bgToggle && selectedId) {
      setProp(selectedId, t.dataset.bgToggle, t.checked ? '#f4f6f9' : '');
      renderProps();
    }
  });
  // Keep the text selection when pressing formatting buttons.
  props.addEventListener('mousedown', (e) => { if (e.target.closest('.bb-format button')) e.preventDefault(); });
  props.addEventListener('click', (e) => {
    const a = e.target.closest('[data-align]');
    if (a && selectedId) { setProp(selectedId, 'align', a.dataset.align); renderProps(); return; }
    if (e.target.closest('[data-deselect]')) { const id = selectedId; select(null); if (id) $(`.bb-block[data-id="${id}"]`, canvas)?.focus(); return; }
    const cmd = e.target.closest('[data-cmd]');
    const editable = selectedId && $(`.bb-block[data-id="${selectedId}"] .bb-text`, canvas);
    if (cmd && editable) {
      if (!editable.contains(window.getSelection()?.anchorNode)) editable.focus();
      document.execCommand(cmd.dataset.cmd);
      syncEditable(editable);
      return;
    }
    if (e.target.closest('[data-link]') && editable) {
      const sel = window.getSelection();
      const inside = sel.rangeCount && editable.contains(sel.anchorNode);
      const range = inside ? sel.getRangeAt(0).cloneRange() : null;
      if (!range || range.collapsed) { toast('Select the words to turn into a link first', 'info'); return; }
      formModal({
        title: 'Add link', submitLabel: 'Add link',
        body: html`<label class="form-label">Web address</label><input class="form-control" name="url" type="url" required placeholder="https://">`,
        onSubmit: async (fd) => {
          const url = String(fd.get('url') || '').trim();
          if (!/^(https?:\/\/|mailto:)/i.test(url)) throw { message: 'Use a full web address starting with https://' };
          editable.focus();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('createLink', false, url);
          syncEditable(editable);
        },
      });
    }
  });

  // ---- Inline editing ------------------------------------------------------------------
  function syncEditable(el) {
    const blockEl = el.closest('.bb-block');
    const loc = blockEl && locate(blockEl.dataset.id);
    if (!loc) return;
    if (!typingSnapshot) record();
    typingSnapshot = true;
    clearTimeout(canvas.burstTimer);
    canvas.burstTimer = setTimeout(() => { typingSnapshot = false; }, 800);
    const field = el.dataset.field;
    loc.block.props[field] = field === 'html' ? el.innerHTML : el.textContent.replace(/\s+/g, ' ').trim();
    if (field === 'label') { const inp = $('[data-prop="label"]', props); if (inp && document.activeElement !== inp) inp.value = loc.block.props.label; }
    changed();
  }
  canvas.addEventListener('input', (e) => { if (e.target.closest('.bb-edit')) syncEditable(e.target.closest('.bb-edit')); });
  canvas.addEventListener('keydown', (e) => {
    const ed = e.target.closest('.bb-edit');
    // Headings and button labels are single-line.
    if (ed && ed.dataset.field !== 'html' && e.key === 'Enter') e.preventDefault();
    if (!ed && e.target.classList.contains('bb-block') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(e.target.dataset.id); }
  });
  canvas.addEventListener('paste', (e) => {
    const ed = e.target.closest('.bb-edit');
    if (!ed) return;
    // Paste as plain text: Word/web formatting breaks email layouts.
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, ed.dataset.field === 'html' ? t : t.replace(/\s+/g, ' '));
  });

  // ---- Selection and block tools -------------------------------------------------------------
  canvas.addEventListener('click', (e) => {
    const blockEl = e.target.closest('.bb-block');
    if (!blockEl) return; // empty space: handled on the whole canvas area below
    const act = e.target.closest('[data-act]');
    const id = blockEl.dataset.id;
    if (act) {
      const loc = locate(id);
      if (!loc) return;
      record();
      if (act.dataset.act === 'del') {
        loc.list.splice(loc.index, 1);
        if (selectedId === id) selectedId = null;
      } else if (act.dataset.act === 'dup') {
        const copy = clone(loc.block);
        copy.id = uid();
        if (copy.type === 'columns') copy.props.columns.forEach((col) => col.forEach((c) => { c.id = uid(); }));
        loc.list.splice(loc.index + 1, 0, copy);
        selectedId = copy.id;
      } else {
        const to = loc.index + (act.dataset.act === 'up' ? -1 : 1);
        if (to < 0 || to >= loc.list.length) { undo.pop(); syncHistoryButtons(); return; }
        loc.list.splice(to, 0, loc.list.splice(loc.index, 1)[0]);
      }
      renderAll();
      changed();
      if (selectedId) $(`.bb-block[data-id="${selectedId}"]`, canvas)?.focus();
      return;
    }
    // innermost block wins (a column child rather than the columns block)
    if (selectedId !== id) select(id);
  });
  // Clicking empty space (around or inside the email, outside any block) deselects:
  // templates then show their page settings.
  $('.bb-canvas-wrap', root).addEventListener('click', (e) => {
    if (!e.target.closest('.bb-block') && selectedId) select(null);
  });
  canvas.addEventListener('focusin', (e) => {
    const ed = e.target.closest('.bb-edit');
    const blockEl = ed?.closest('.bb-block');
    if (blockEl && blockEl.dataset.id !== selectedId) select(blockEl.dataset.id);
  });

  // ---- Adding blocks by click (keyboard / touch) -----------------------------------------------------
  function insertNew(type, key, index) {
    const list = listById(key);
    if (!list) return;
    record();
    const b = newBlock(type);
    list.splice(index, 0, b);
    selectedId = b.id;
    renderAll();
    changed();
    const el = $(`.bb-block[data-id="${b.id}"]`, canvas);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    (el?.querySelector('.bb-edit') || el)?.focus();
  }
  $('.bb-palette', root).addEventListener('click', (e) => {
    const tile = e.target.closest('[data-new]');
    if (!tile) return;
    const type = tile.dataset.new;
    if (tile.classList.contains('disabled')) { toast('A template has exactly one Campaign content block. Move the existing one instead.', 'info'); return; }
    const loc = selectedId && locate(selectedId);
    if (loc && !(TOP_ONLY.has(type) && loc.key !== 'root')) insertNew(type, loc.key, loc.index + 1);
    else if (loc && TOP_ONLY.has(type)) { const top = locate(loc.key.split(':')[0]); insertNew(type, 'root', top.index + 1); }
    else insertNew(type, 'root', doc.blocks.length);
  });
  $('.bb-palette', root).addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-new]')) { e.preventDefault(); e.target.closest('[data-new]').click(); }
  });

  // ---- Drag and drop -------------------------------------------------------------------------------
  root.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('[data-new]');
    const handle = e.target.closest?.('.bb-handle');
    if (tile) {
      if (tile.classList.contains('disabled')) { e.preventDefault(); return; }
      drag = { kind: 'new', type: tile.dataset.new };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', tile.dataset.new);
    } else if (handle) {
      const blockEl = handle.closest('.bb-block');
      drag = { kind: 'move', id: blockEl.dataset.id, type: locate(blockEl.dataset.id)?.block.type };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', blockEl.dataset.id);
      e.dataTransfer.setDragImage(blockEl, 16, 16);
      requestAnimationFrame(() => blockEl.classList.add('dragging'));
    } else {
      return;
    }
    root.classList.add('is-dragging');
  });

  const stage = $('.bb-canvas-wrap', root);
  const rootList = () => $('[data-list="root"]', canvas);
  function dropTarget(e) {
    if (!drag) return null;
    // Anywhere on the canvas area (including the margins around the email) counts as the main list.
    const list = e.target.closest?.('.bb-list') || (stage.contains(e.target) ? rootList() : null);
    if (!list) return null;
    // Columns cannot be nested inside columns.
    if (TOP_ONLY.has(drag.type) && list.dataset.list !== 'root') return null;
    const siblings = [...list.children].filter((c) => c.classList.contains('bb-block') && c.dataset.id !== drag.id);
    const before = siblings.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    return { list, before, index: before ? siblings.indexOf(before) : siblings.length };
  }

  stage.addEventListener('dragover', (e) => {
    const t = dropTarget(e);
    if (!t) { indicator.remove(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = drag.kind === 'new' ? 'copy' : 'move';
    if (t.before) t.list.insertBefore(indicator, t.before); else t.list.append(indicator);
    $$('.bb-empty', t.list).forEach((x) => x.classList.add('d-none'));
  });
  stage.addEventListener('drop', (e) => {
    // The marker shows where the block will land; trust it over the pointer position.
    let t = null;
    if (drag && indicator.isConnected) {
      const list = indicator.parentElement;
      let index = 0; // blocks (other than the one being moved) before the marker
      for (let n = indicator.previousElementSibling; n; n = n.previousElementSibling) {
        if (n.classList.contains('bb-block') && n.dataset.id !== drag.id) index += 1;
      }
      t = { list, index };
    } else {
      t = dropTarget(e);
    }
    if (!t) { endDrag(); return; }
    e.preventDefault();
    const key = t.list.dataset.list;
    if (drag.kind === 'new') {
      insertNew(drag.type, key, t.index);
    } else {
      const loc = locate(drag.id);
      const target = listById(key);
      if (loc && target) {
        record();
        const [moved] = loc.list.splice(loc.index, 1);
        target.splice(Math.min(t.index, target.length), 0, moved);
        selectedId = moved.id;
        renderAll();
        changed();
      }
    }
    endDrag();
  });
  function endDrag() {
    drag = null;
    indicator.remove();
    root.classList.remove('is-dragging');
    $$('.dragging', canvas).forEach((x) => x.classList.remove('dragging'));
    $$('.bb-empty.d-none', canvas).forEach((x) => x.classList.remove('d-none'));
  }
  root.addEventListener('dragend', endDrag);
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) indicator.remove(); });

  // ---- Undo / redo --------------------------------------------------------------------------------
  $('#bb-undo', root).addEventListener('click', () => restore(undo, redo));
  $('#bb-redo', root).addEventListener('click', () => restore(redo, undo));
  root.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.closest('.bb-edit, input, textarea')) return;
    if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); restore(undo, redo); }
    if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) { e.preventDefault(); restore(redo, undo); }
  });

  /** The editable part of the selected block (heading, text, button label), if any. */
  function selectedEditable() {
    return selectedId ? $(`.bb-block[data-id="${selectedId}"] .bb-edit`, canvas) : null;
  }

  function getDoc() { return { version: 1, ...(isTemplate ? { settings: { ...doc.settings } } : {}), blocks: clone(doc.blocks) }; }

  applyPage();
  renderAll();
  /** Replaces the design (e.g. with a sample). Undo brings the previous one back. */
  function setDoc(next) {
    record();
    doc.blocks = (next?.blocks || []).map((b) => {
      const x = withDefaults(b);
      if (x.type === 'columns') x.props.columns = [0, 1].map((i) => (x.props.columns?.[i] || []).map(withDefaults));
      return x;
    });
    selectedId = null;
    renderAll();
    changed();
  }

  return { getDoc, selectedEditable, setDoc };
}

/** A document holding existing HTML as one block (switching from the HTML/visual editors). */
export function documentFromHtml(h) {
  return { version: 1, blocks: [{ id: uid(), type: 'html', props: { ...clone(DEFAULTS.html), html: h || '', pad: 0 } }] };
}
