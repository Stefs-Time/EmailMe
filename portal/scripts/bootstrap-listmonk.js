#!/usr/bin/env node
'use strict';

/**
 * Optional, manual alternative to the portal's automatic setup. Creates the
 * least-privilege listmonk API user and prints LISTMONK_API_USER/TOKEN.
 * (On Railway you normally skip this: give the portal LISTMONK_ADMIN_USER and
 * LISTMONK_ADMIN_PASSWORD and it does this itself at startup.)
 *
 *   LISTMONK_URL=http://localhost:9000 LISTMONK_ADMIN_USER=admin LISTMONK_ADMIN_PASSWORD=... \
 *   [LISTMONK_ROOT_URL=https://lists.example.co.za] [PORTAL_API_USERNAME=mailharbor] \
 *     node scripts/bootstrap-listmonk.js [--recommended-settings] [--replace]
 */
const { loginSession, createApiUser, applyRecommended } = require('../src/lib/listmonkAdmin');

async function main() {
  const url = process.env.LISTMONK_URL;
  const { LISTMONK_ADMIN_USER: user, LISTMONK_ADMIN_PASSWORD: pass } = process.env;
  if (!url || !user || !pass) {
    console.error('Set LISTMONK_URL, LISTMONK_ADMIN_USER and LISTMONK_ADMIN_PASSWORD.');
    process.exit(1);
  }
  const apiUser = process.env.PORTAL_API_USERNAME || 'mailharbor';
  const api = await loginSession(url, user, pass);
  let token;
  try {
    token = await createApiUser(api, apiUser, { replace: process.argv.includes('--replace') });
  } catch (err) {
    if (err.code === 'EXISTS') {
      console.error(`API user "${apiUser}" already exists. Re-run with --replace to issue a new token (the old one stops working).`);
      process.exit(2);
    }
    throw err;
  }
  if (process.argv.includes('--recommended-settings') || process.env.LISTMONK_ROOT_URL) {
    const changed = await applyRecommended(api, { rootUrl: process.env.LISTMONK_ROOT_URL?.replace(/\/+$/, '') });
    console.log(`Applied: ${changed.join(', ') || 'nothing (already configured)'}`);
  }
  console.log('\nAdd these to the portal environment (keep the token secret):\n');
  console.log(`LISTMONK_API_USER=${apiUser}`);
  console.log(`LISTMONK_API_TOKEN=${token}\n`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
