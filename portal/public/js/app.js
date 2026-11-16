import { api, setCsrf, setUnauthorizedHandler } from './api.js';
import { html, raw, mount, $, $$, errorBox, toast, errorToast } from './ui.js';
import { renderLogin } from './views/login.js';

const ROUTES = [
  { path: /^\/?$/, view: 'dashboard', title: 'Dashboard' },
  { path: /^\/contacts\/?$/, view: 'contacts', title: 'Contacts' },
  { path: /^\/contacts\/(\d+)$/, view: 'contact', title: 'Contact' },
  { path: /^\/import\/?$/, view: 'import', title: 'Import contacts', perm: 'imports:write' },
  { path: /^\/import\/([0-9a-f-]{36})$/, view: 'import', title: 'Import contacts', perm: 'imports:write' },
  { path: /^\/imports\/?$/, view: 'imports', title: 'Import history' },
  { path: /^\/lists\/?$/, view: 'lists', title: 'Lists' },
  { path: /^\/campaigns\/?$/, view: 'campaigns', title: 'Campaign reports' },
  { path: /^\/campaigns\/(\d+)$/, view: 'campaign', title: 'Campaign report' },
  { path: /^\/reports\/?$/, view: 'reports', title: 'Audience & deliverability' },
  { path: /^\/suppression\/?$/, view: 'suppression', title: 'Suppression list' },
  { path: /^\/review\/?$/, view: 'review', title: 'Review queue' },
  { path: /^\/exports\/?$/, view: 'exports', title: 'Exports', perm: 'exports:read' },
  { path: /^\/guides\/?([a-z-]*)$/, view: 'guides', title: 'Guides' },
  { path: /^\/system\/?$/, view: 'system', title: 'System health', perm: 'system:read' },
  { path: /^\/users\/?$/, view: 'users', title: 'Users', perm: 'users:manage' },
  { path: /^\/audit\/?$/, view: 'audit', title: 'Audit log', perm: 'audit:read' },
  { path: /^\/account\/?$/, view: 'account', title: 'My account' },
];

const NAV = [
  { section: 'Overview' },
  { href: '#/', icon: 'speedometer2', label: 'Dashboard', match: 'dashboard' },
  { section: 'Contacts' },
  { href: '#/contacts', icon: 'people', label: 'Contacts', match: 'contact' },
  { href: '#/import', icon: 'cloud-arrow-up', label: 'Import', match: 'import', perm: 'imports:write' },
  { href: '#/lists', icon: 'card-list', label: 'Lists', match: 'lists' },
  { href: '#/review', icon: 'hourglass-split', label: 'Review queue', match: 'review', badge: 'review' },
  { href: '#/suppression', icon: 'slash-circle', label: 'Suppression list', match: 'suppression' },
  { section: 'Insights' },
  { href: '#/campaigns', icon: 'envelope-paper', label: 'Campaign reports', match: 'campaign' },
  { href: '#/reports', icon: 'bar-chart-line', label: 'Audience & bounces', match: 'reports' },
  { href: '#/exports', icon: 'download', label: 'Exports', match: 'exports', perm: 'exports:read' },
  { section: 'Help & admin' },
  { href: '#/guides', icon: 'journal-text', label: 'Guides', match: 'guides' },
  { href: '#/system', icon: 'heart-pulse', label: 'System health', match: 'system', perm: 'system:read' },
  { href: '#/users', icon: 'person-gear', label: 'Users', match: 'users', perm: 'users:manage' },
  { href: '#/audit', icon: 'shield-check', label: 'Audit log', match: 'audit', perm: 'audit:read' },
];

const state = { session: null, cleanup: null };

export const ctx = {
  get user() { return state.session?.user; },
  get session() { return state.session; },
  can(p) { return Boolean(state.session?.user?.permissions?.includes(p)); },
  navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; },
  query() { return new URLSearchParams(location.hash.split('?')[1] || ''); },
  /** Updates the query string without re-rendering the view. */
  setQuery(params) {
    const base = location.hash.split('?')[0];
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null) q.set(k, v);
    const s = q.toString();
    history.replaceState(null, '', `${base}${s ? `?${s}` : ''}`);
  },
  refreshBadges,
};

async function loadSession() {
  const r = await api('GET', '/auth/session');
  state.session = r.data;
  setCsrf(r.data.csrfToken);
}

function renderShell() {
  const u = state.session.user;
  mount($('#root'), html`<div class="app-shell">
    <nav class="sidebar" id="sidebar" aria-label="Main">
      <div class="brand"><a href="#/"><img src="/img/logo.svg" alt="MailHarbor"></a>
        <div class="org">${state.session.orgName}</div></div>
      <div class="side-nav flex-grow-1 pb-3">
        ${NAV.filter((n) => !n.perm || ctx.can(n.perm)).map((n) => (n.section
          ? html`<div class="nav-section">${n.section}</div>`
          : html`<a href="${n.href}" data-match="${n.match}"><i class="bi bi-${n.icon}"></i><span>${n.label}</span>${n.badge ? html`<span class="badge rounded-pill text-bg-warning d-none" data-badge="${n.badge}"></span>` : ''}</a>`))}
      </div>
      <div class="sidebar-footer">
        <a class="btn btn-sm btn-outline-primary w-100 mb-2" href="${state.session.listmonkUrl}/admin/campaigns/new" target="_blank" rel="noopener">
          <i class="bi bi-send me-1"></i>New campaign in listmonk</a>
        <div class="text-muted-2">Campaigns are written and sent in listmonk. <a href="#/guides/campaigns">How?</a></div>
      </div>
    </nav>
    <div class="main">
      <header class="topbar">
        <button class="btn btn-light d-lg-none" id="menu-btn" aria-label="Open menu"><i class="bi bi-list"></i></button>
        <h1 class="page-title" id="page-title"></h1>
        <div class="ms-auto dropdown">
          <button class="btn btn-light dropdown-toggle d-flex align-items-center gap-2" data-bs-toggle="dropdown" aria-expanded="false">
            <span class="rounded-circle bg-primary text-white d-inline-flex align-items-center justify-content-center fw-semibold" aria-hidden="true" id="avatar"></span>
            <span class="d-none d-sm-inline">${u.name}</span></button>
          <ul class="dropdown-menu dropdown-menu-end">
            <li><span class="dropdown-item-text small text-muted-2">${u.email}<br>Role: <strong>${u.role}</strong></span></li>
            <li><hr class="dropdown-divider"></li>
            <li><a class="dropdown-item" href="#/account"><i class="bi bi-person me-2"></i>My account</a></li>
            <li><a class="dropdown-item" href="#/guides"><i class="bi bi-journal-text me-2"></i>Guides</a></li>
            <li><button class="dropdown-item" id="logout"><i class="bi bi-box-arrow-right me-2"></i>Sign out</button></li>
          </ul>
        </div>
      </header>
      <main class="content" id="main" tabindex="-1"></main>
    </div>
  </div>`);
  const av = $('#avatar');
  av.textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
  av.style.width = '2rem'; av.style.height = '2rem';
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#logout').addEventListener('click', async () => {
    await api('POST', '/auth/logout').catch(() => {});
    location.hash = '#/';
    location.reload();
  });
}

async function refreshBadges() {
  try {
    const r = await api('GET', '/system/review');
    const b = $('[data-badge="review"]');
    if (b) { b.textContent = r.data.length; b.classList.toggle('d-none', !r.data.length); }
  } catch { /* non-critical */ }
}

const viewCache = {};
async function route() {
  if (!state.session?.user) return;
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  let match;
  const r = ROUTES.find((x) => (match = x.path.exec(path)));
  const main = $('#main');
  if (typeof state.cleanup === 'function') { try { state.cleanup(); } catch { /* ignore */ } }
  state.cleanup = null;
  $('#sidebar')?.classList.remove('open');
  if (!r) { mount(main, html`<div class="empty"><i class="bi bi-signpost"></i>Page not found. <a href="#/">Go to the dashboard</a></div>`); return; }
  if (r.perm && !ctx.can(r.perm)) { mount(main, errorBox({ message: 'You do not have permission to view this page.' })); return; }
  $('#page-title').textContent = r.title;
  document.title = `${r.title} · MailHarbor`;
  $$('.side-nav a').forEach((a) => a.classList.toggle('active', r.view.startsWith(a.dataset.match) || (a.dataset.match === 'contact' && r.view === 'contact')));
  try {
    const mod = viewCache[r.view] || (viewCache[r.view] = await import(`./views/${r.view}.js`));
    state.cleanup = await mod.render(main, ctx, match.slice(1));
  } catch (err) {
    console.error(err);
    if (err.status === 401) return;
    mount(main, errorBox(err));
  }
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function start() {
  setUnauthorizedHandler(() => {
    if (state.session?.user) { toast('Your session has ended. Please sign in again.', 'warning'); }
    state.session = { ...(state.session || {}), user: null };
    boot();
  });
  window.addEventListener('hashchange', route);
  window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status) errorToast(e.reason); });
  await boot();
}

async function boot() {
  try {
    await loadSession();
  } catch (err) {
    mount($('#root'), html`<div class="container py-5">${errorBox(err)}<button class="btn btn-primary" id="retry">Retry</button></div>`);
    $('#retry').addEventListener('click', boot);
    return;
  }
  if (!state.session.user) {
    renderLogin($('#root'), state.session, async (session) => {
      state.session = { ...state.session, ...session };
      setCsrf(session.csrfToken);
      renderShell();
      await route();
      refreshBadges();
    });
    return;
  }
  renderShell();
  await route();
  refreshBadges();
}

export { raw };
start();
