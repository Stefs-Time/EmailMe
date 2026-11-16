'use strict';

/**
 * listmonk administration through an admin login session. Used once to create
 * the portal's least-privilege API user (by the server at startup and by
 * scripts/bootstrap-listmonk.js). Admin credentials are never used for normal
 * portal traffic.
 */

const PORTAL_PERMISSIONS = [
  'subscribers:get_all', 'subscribers:get', 'subscribers:manage', 'subscribers:import',
  'lists:get_all', 'lists:manage_all', 'bounces:get', 'bounces:manage',
  'campaigns:get_all', 'campaigns:get', 'campaigns:get_analytics', 'settings:get',
];
const ROLE_NAME = 'MailHarbor portal';

async function loginSession(baseUrl, username, password, timeoutMs = 15000) {
  const url = baseUrl.replace(/\/+$/, '');
  const signal = () => AbortSignal.timeout(timeoutMs);
  const page = await fetch(`${url}/admin/login`, { signal: signal() });
  const pre = page.headers.getSetCookie().map((c) => c.split(';')[0]);
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!nonce) throw new Error(`Could not read the listmonk login page at ${url}`);
  const res = await fetch(`${url}/admin/login`, {
    method: 'POST', redirect: 'manual', signal: signal(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: pre.join('; ') },
    body: new URLSearchParams({ username, password, nonce }),
  });
  const cookie = [...pre, ...res.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
  const api = async (method, path, body) => {
    const r = await fetch(`${url}${path}`, {
      method, signal: signal(),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`listmonk ${method} ${path}: ${r.status} ${j.message || ''}`.trim());
    return j.data;
  };
  try {
    await api('GET', '/api/profile');
  } catch {
    throw new Error('listmonk admin login failed: check LISTMONK_ADMIN_USER and LISTMONK_ADMIN_PASSWORD');
  }
  return api;
}

async function ensurePortalRole(api) {
  const roles = await api('GET', '/api/roles/users');
  const role = roles.find((r) => r.name === ROLE_NAME);
  if (role) return api('PUT', `/api/roles/users/${role.id}`, { name: ROLE_NAME, permissions: PORTAL_PERMISSIONS });
  return api('POST', '/api/roles/users', { name: ROLE_NAME, permissions: PORTAL_PERMISSIONS });
}

/**
 * Creates the API user and returns its token. listmonk only reveals a token
 * at creation, so with `replace` an existing user of that name is deleted first.
 */
async function createApiUser(api, username, { replace = false } = {}) {
  const role = await ensurePortalRole(api);
  const users = await api('GET', '/api/users');
  const existing = users.find((u) => u.username === username);
  if (existing) {
    if (!replace) {
      const err = new Error(`API user "${username}" already exists`);
      err.code = 'EXISTS';
      throw err;
    }
    await api('DELETE', `/api/users/${existing.id}`);
  }
  const created = await api('POST', '/api/users', {
    username, name: 'MailHarbor portal', type: 'api', status: 'enabled', user_role_id: role.id,
  });
  return created.password;
}

/** Applies the scope's recommended settings. Returns a list of what changed. */
async function applyRecommended(api, { rootUrl } = {}) {
  const changed = [];
  const s = await api('GET', '/api/settings');
  const actions = s['bounce.actions'] || {};
  const want = { hard: { count: 1, action: 'blocklist' }, complaint: { count: 1, action: 'blocklist' }, soft: { count: 3, action: 'blocklist' } };
  // Keep a soft-bounce policy someone already chose; replace listmonk's
  // out-of-box "do nothing" default with 3 → blocklist.
  const soft = actions.soft?.action && actions.soft.action !== 'none' ? actions.soft : want.soft;
  const next = { hard: want.hard, complaint: want.complaint, soft };
  if (JSON.stringify(next) !== JSON.stringify({ hard: actions.hard, complaint: actions.complaint, soft: actions.soft })) {
    await api('PUT', '/api/settings/bounce.actions', next);
    changed.push('bounce actions');
  }
  if (!s['privacy.unsubscribe_header']) {
    await api('PUT', '/api/settings/privacy.unsubscribe_header', true);
    changed.push('List-Unsubscribe header');
  }
  if (rootUrl && s['app.root_url'] !== rootUrl) {
    await api('PUT', '/api/settings/app.root_url', rootUrl);
    changed.push('root URL');
  }
  return changed;
}

module.exports = { PORTAL_PERMISSIONS, ROLE_NAME, loginSession, ensurePortalRole, createApiUser, applyRecommended };
