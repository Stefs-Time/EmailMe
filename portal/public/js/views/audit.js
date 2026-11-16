import { get, download } from '../api.js';
import { html, mount, $, datetime, loading, empty, pager } from '../ui.js';

export async function render(el) {
  const state = { page: 1, action: '' };
  mount(el, html`<div class="page-head"><div><h1>Audit log</h1><p>Who did what, and when. Kept for accountability and POPIA compliance.</p></div>
    <button class="btn btn-outline-primary" id="csv"><i class="bi bi-download me-1"></i>Export</button></div>
    <div class="card"><div class="card-body border-bottom"><select class="form-select w-auto" id="action" aria-label="Filter by area">
      <option value="">All actions</option><option value="auth.">Sign-ins</option><option value="contact.">Contacts</option><option value="import.">Imports</option>
      <option value="export.">Exports</option><option value="suppression.">Suppression</option><option value="list.">Lists</option><option value="user.">Users</option><option value="system.">System</option></select></div>
    <div id="t">${loading()}</div></div>`);
  async function load() {
    const r = await get(`/system/audit?page=${state.page}${state.action ? `&action=${encodeURIComponent(state.action)}` : ''}`);
    if (!r.data.length) { mount($('#t', el), empty('shield-check', 'No entries')); return; }
    mount($('#t', el), html`<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody>
      ${r.data.map((a) => html`<tr><td class="small text-nowrap">${datetime(a.created_at)}</td><td class="small">${a.actor_email || 'system'}</td><td class="mono">${a.action}</td>
        <td class="small">${a.target_type ? `${a.target_type} ${a.target_id || ''}` : '–'}</td>
        <td class="small mono text-truncate" title="${JSON.stringify(a.details)}">${Object.keys(a.details || {}).length ? JSON.stringify(a.details).slice(0, 120) : ''}</td><td class="small">${a.ip || ''}</td></tr>`)}
      </tbody></table></div>${pager(r.meta, (p) => { state.page = p; load(); })}`);
  }
  $('#action', el).addEventListener('change', (e) => { state.action = e.target.value; state.page = 1; load(); });
  $('#csv', el).addEventListener('click', () => download('/exports/audit.csv'));
  await load();
}
