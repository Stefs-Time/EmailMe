// Personalisation "quick clicks": chips that insert {{ tags }} at the cursor.
//
// One handler per page (enableTagChips) serves every chip bar on that page and
// inserts into the field the user last clicked into: inputs/textareas marked
// data-taggable, builder blocks and other contenteditable areas.
import { html, toast } from './ui.js';

/** Built-in fields. Names get a friendly fallback for contacts without one. */
export const TAGS = [
  { key: 'first_name', label: 'First name', example: 'Thandi', fallback: 'there' },
  { key: 'full_name', label: 'Full name', example: 'Thandi Nkosi', fallback: 'there' },
  { key: 'last_name', label: 'Last name', example: 'Nkosi' },
  { key: 'company', label: 'Company', example: 'Example (Pty) Ltd' },
  { key: 'email', label: 'Email', example: 'thandi@example.co.za' },
  { key: 'org_name', label: 'Your organisation', example: 'your organisation name' },
];

export const tagText = (key, fallback) => `{{ ${key}${fallback ? ` | "${fallback}"` : ''} }}`;
const prettify = (k) => k.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * A row of chips. `custom` is a list of imported column names (contact attributes).
 * @param {{ custom?: string[], label?: string, compact?: boolean }} opts
 */
export function tagBar({ custom = [], label = 'Insert', compact = false } = {}) {
  const chip = (text, name, title) => html`<button type="button" class="tag-chip" data-insert-tag="${text}" title="${title}"><i class="bi bi-person-badge" aria-hidden="true"></i>${name}</button>`;
  return html`<div class="tag-bar${compact ? ' tag-bar-compact' : ''}" role="group" aria-label="Insert personalisation">
    <span class="tag-bar-label">${label}</span>
    ${TAGS.map((t) => chip(tagText(t.key, t.fallback), t.label, `Inserts ${tagText(t.key, t.fallback)}, e.g. "${t.example}"${t.fallback ? `; "${t.fallback}" when empty` : ''}`))}
    ${custom.map((k) => chip(tagText(`attribs.${k}`), prettify(k), `Imported column "${k}": inserts {{ attribs.${k} }}`))}
  </div>`;
}

const isTextInput = (n) => n?.matches?.('input[data-taggable], textarea[data-taggable]');
const isEditable = (n) => n?.isContentEditable;

/**
 * Wires every chip bar inside `root`. Returns a cleanup function.
 * @param {HTMLElement} root
 * @param {{ fallback?: () => HTMLElement|null }} opts  field to use when nothing was focused yet
 */
export function enableTagChips(root, { fallback } = {}) {
  let last = null;
  let range = null;

  const onFocus = (e) => {
    const t = e.target;
    if (isTextInput(t)) { last = t; range = null; return; }
    const ed = t.closest?.('[contenteditable="true"]');
    if (ed && root.contains(ed)) { last = ed; }
  };
  // Remember the caret in rich-text areas: clicking a chip must not lose it.
  const onSelection = () => {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !last || !isEditable(last)) return;
    if (last.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange();
  };
  const onMouseDown = (e) => { if (e.target.closest('[data-insert-tag]')) e.preventDefault(); };
  const onClick = (e) => {
    const chip = e.target.closest('[data-insert-tag]');
    if (!chip) return;
    let target = last?.isConnected ? last : null;
    if (!target || target.closest('.d-none')) target = fallback?.() || null;
    if (!target) {
      toast('Click where the name should go (subject, a heading or text), then pick the field.', 'info');
      return;
    }
    insertAt(target, chip.dataset.insertTag, target === last ? range : null);
    last = target;
  };

  root.addEventListener('focusin', onFocus);
  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('click', onClick);
  document.addEventListener('selectionchange', onSelection);
  return () => document.removeEventListener('selectionchange', onSelection);
}

/** Inserts text at the caret of an input/textarea or a contenteditable element. */
export function insertAt(target, text, savedRange) {
  if (isTextInput(target) || target.matches('input, textarea')) {
    target.focus();
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const pad = spacing(target.value.slice(0, start), target.value.slice(end));
    target.setRangeText(pad.before + text + pad.after, start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  target.focus();
  const sel = document.getSelection();
  let r = savedRange && target.contains(savedRange.startContainer) ? savedRange : null;
  if (!r) {
    // No caret yet: put it at the end of the last text (Chrome can move a caret
    // placed "after the contents" of an inline element back to the start).
    r = document.createRange();
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    let lastText = null;
    while (walker.nextNode()) lastText = walker.currentNode;
    if (lastText) r.setStart(lastText, lastText.length); else r.selectNodeContents(target);
    r.collapse(!lastText ? false : true);
  }
  sel.removeAllRanges();
  sel.addRange(r);
  const node = r.startContainer;
  const isText = node.nodeType === 3;
  const pad = spacing(isText ? node.textContent.slice(0, r.startOffset) : '', isText && r.collapsed ? node.textContent.slice(r.startOffset) : '');
  document.execCommand('insertText', false, pad.before + text + pad.after); // fires "input", so editors save it
}

/** Keeps a space on each side of the tag when it lands against a word. */
function spacing(before, after) {
  return {
    before: before && !/[\s(["'“‘]$/.test(before) ? ' ' : '',
    after: after && !/^[\s.,!?;:)\]"'”’]/.test(after) ? ' ' : '',
  };
}
