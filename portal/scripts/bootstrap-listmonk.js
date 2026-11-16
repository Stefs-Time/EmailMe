#!/usr/bin/env node
'use strict';

/**
 * One-time setup: creates a least-privilege listmonk role and API user for the
 * portal, and prints the LISTMONK_API_USER / LISTMONK_API_TOKEN values.
 *
 * Usage:
 *   LISTMONK_URL=http://localhost:9000 LISTMONK_ADMIN_USER=admin LISTMONK_ADMIN_PASSWORD=... \
 *     node scripts/bootstrap-listmonk.js [--recommended-settings]
 *
 * --recommended-settings also applies the scope's bounce policy
 * (hard: 1 → blocklist, complaint: 1 → blocklist, soft: 3 → blocklist)
 * and enables the one-click List-Unsubscribe header.
 *
 * The token is printed once; store it in your secret manager / Railway variables.
 */

const PERMISSIONS = [
  'subscribers:get_all', 'subscribers:get', 'subscribers:manage', 'subscribers:import',
  'lists:get_all', 'lists:manage_all', 'bounces:get', 'bounces:manage',
  'campaigns:get_all', 'campaigns:get', 'campaigns:get_analytics', 'settings:get',
];
const ROLE_NAME = 'MailHarbor portal';
const API_USER = process.env.PORTAL_API_USERNAME || 'mailharbor';

async function main() {
  const url = (process.env.LISTMONK_URL || '').replace(/\/+$/, '');
  const user = process.env.LISTMONK_ADMIN_USER;
  const pass = process.env.LISTMONK_ADMIN_PASSWORD;
  if (!url || !user || !pass) {
    console.error('Set LISTMONK_URL, LISTMONK_ADMIN_USER and LISTMONK_ADMIN_PASSWORD.');
    process.exit(1);
  }

  // Log in through the admin form to obtain a session cookie.
  const page = await fetch(`${url}/admin/login`);
  const pre = page.headers.getSetCookie().map((c) => c.split(';')[0]);
  const nonce = /name="nonce" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!nonce) throw new Error('Could not read the listmonk login form. Is LISTMONK_URL correct?');
  const res = await fetch(`${url}/admin/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: pre.join('; ') },
    body: new URLSearchParams({ username: user, password: pass, nonce }),
  });
  const cookie = [...pre, ...res.headers.getSetCookie().map((c) => c.split(';')[0])].join('; ');
  const api = async (method, path, body) => {
    const r = await fetch(`${url}${path}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${j.message || ''}`);
    return j.data;
  };
  await api('GET', '/api/profile').catch(() => { throw new Error('Login failed: check the listmonk admin username and password.'); });

  const roles = await api('GET', '/api/roles/users');
  let role = roles.find((r) => r.name === ROLE_NAME);
  if (role) {
    role = await api('PUT', `/api/roles/users/${role.id}`, { name: ROLE_NAME, permissions: PERMISSIONS });
    console.log(`Updated role "${ROLE_NAME}".`);
  } else {
    role = await api('POST', '/api/roles/users', { name: ROLE_NAME, permissions: PERMISSIONS });
    console.log(`Created role "${ROLE_NAME}".`);
  }

  const users = await api('GET', '/api/users');
  const existing = users.find((u) => u.username === API_USER);
  if (existing) {
    console.error(`API user "${API_USER}" already exists. Delete it in listmonk → Users to issue a new token, then re-run.`);
    process.exit(2);
  }
  const created = await api('POST', '/api/users', {
    username: API_USER, name: 'MailHarbor portal', type: 'api', status: 'enabled', user_role_id: role.id,
  });

  if (process.env.LISTMONK_ROOT_URL) {
    // Public base URL used in unsubscribe, opt-in and tracking links.
    await api('PUT', '/api/settings/app.root_url', process.env.LISTMONK_ROOT_URL.replace(/\/+$/, ''));
    console.log(`Set listmonk root URL to ${process.env.LISTMONK_ROOT_URL}.`);
  }

  if (process.argv.includes('--recommended-settings')) {
    await api('PUT', '/api/settings/bounce.actions', {
      hard: { count: 1, action: 'blocklist' }, complaint: { count: 1, action: 'blocklist' }, soft: { count: 3, action: 'blocklist' },
    });
    await api('PUT', '/api/settings/privacy.unsubscribe_header', true);
    console.log('Applied recommended bounce actions and List-Unsubscribe header.');
  }

  console.log('\nAdd these to the portal environment (keep the token secret):\n');
  console.log(`LISTMONK_API_USER=${API_USER}`);
  console.log(`LISTMONK_API_TOKEN=${created.password}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
