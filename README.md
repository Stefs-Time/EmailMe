# MailHarbor

**Your contacts, safely in harbour.** MailHarbor is a contact-management, compliance and reporting portal built on top of
[listmonk](https://listmonk.app) (v6.2.0), the open-source, self-hosted newsletter and mailing-list manager.

listmonk already does campaign sending well, so MailHarbor reuses it rather than rebuilding it. MailHarbor adds what this
organisation needs around listmonk: simple contact management, safe CSV imports, exports, permanent suppression, consent
evidence, bounce classification and clear reports. It also includes in-app guides for non-technical staff.

| Need | Where it happens |
|---|---|
| Import, search, sort, edit contacts; manage lists | **MailHarbor** |
| Suppression list, consent records, POPIA access/erasure requests | **MailHarbor** |
| Bounce classification, review queue, health alerts | **MailHarbor** (reading listmonk's bounce data) |
| Campaign, audience and bounce reports; CSV exports | **MailHarbor** |
| Templates, writing and sending campaigns, SMTP and bounce-mailbox settings | **listmonk** (unmodified, not forked) |

---

## Features

- **Dashboard:** recipient status breakdown (active, unconfirmed, soft/hard bounced, unsubscribed, complaint,
  blocklisted, pending review), campaigns, emails sent, bounce activity, 30-day growth and live operational alerts.
- **Contacts:** search by email/name/company; filter by status, list, source or consent; sortable columns; bulk
  add/remove from lists, unsubscribe, suppress; a full contact page with consent evidence, bounces and status history.
- **Import wizard:** CSV upload (comma, semicolon or tab), automatic column matching, custom attributes, syntax
  validation, in-file duplicate detection, matching against existing contacts, suppression check, a required
  consent basis, a **preview before anything is saved**, then a downloadable row-by-row report.
- **Suppression that cannot be bypassed:** imports, list changes and manual adds never reactivate an
  unsubscribed, bounced, complained or blocklisted address. If someone re-enables a suppressed contact directly in
  listmonk, MailHarbor blocks it again within a minute and raises an alert. Reactivation is admin-only and needs a
  documented new permission basis.
- **Bounce rules (scope §3.6.2):** 5.1.1 and 550 → hard (suppressed); 4.x.x and mailbox full → soft; **5.7.x policy and
  spam rejections → review queue** (held from sending, not wrongly suppressed); complaints → suppressed at once.
- **Global unsubscribe:** an unsubscribe from any list suppresses the person from all marketing by default.
- **Reports:** per-campaign targeted, sent, failures, hard/soft bounces, complaints, unsubscribes, opens and clicks,
  plus top links and an activity timeline; audience by source, consent and domain; bounce trends.
- **Exports (CSV, Excel-safe):** contacts (any filter), eligible contacts, suppression list, consent and unsubscribe
  history, status history, bounces, campaigns, audit log. Per-contact JSON export for POPIA access requests.
- **POPIA erasure:** deletes the contact and keeps only a SHA-256 hash on the suppression list.
- **Operations:** a system-health page with a go-live checklist (SMTP, TLS, bounce processing, bounce actions,
  List-Unsubscribe header, HTTPS root URL), alerts for bounce-mailbox errors, SMTP errors, sync failures and listmonk
  downtime; nightly verified backups.
- **Security:** roles (viewer / manager / admin), Argon2id passwords, account lockout, server-side sessions, CSRF
  tokens, strict CSP, rate limiting, full audit log. Database access is least-privilege and **read-only on listmonk's tables**.

## Architecture

```
                 Internet (443)
                      │
                ┌─────▼─────┐   automatic HTTPS (Let's Encrypt)
                │   Caddy   │
                └──┬─────┬──┘
   mail.example    │     │   lists.example  (admin UI + unsubscribe/tracking links)
           ┌───────▼─┐ ┌─▼────────┐
           │MailHarbor│ │ listmonk │──► your SMTP server (587/465)
           │  portal  │ │  v6.2.0  │◄── POP3 bounce mailbox (995) / provider webhooks
           └──┬────▲──┘ └────┬─────┘
   writes via │    │ reads   │
  listmonk API└────┼─────────┘
                   │ (SELECT only)
             ┌─────▼──────────────────────────┐
             │ PostgreSQL                      │
             │  public.*  listmonk (unchanged) │
             │  portal.*  suppression, consent,│
             │            events, imports,     │
             │            audit, alerts        │
             └─────────────────────────────────┘
```

- **Writes** to subscribers and lists always go through the **listmonk API**, so listmonk's own rules apply.
- **Reads** for fast search, sorting and reporting query listmonk's tables in `READ ONLY` transactions using a
  database role that only has `SELECT` on them.
- A **sync worker** inside the portal runs every 60 s. It classifies new bounces, captures unsubscribes, records
  blocklists made in listmonk, enforces suppressions and checks health.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```
├── docker-compose.yml        Full stack: caddy, portal, listmonk, postgres, backup
├── setup.sh                  One-command first-time setup
├── .env.example              Stack configuration template
├── deploy/
│   ├── caddy/Caddyfile       Reverse proxy + HTTPS
│   ├── postgres/             Least-privilege portal role (init + manual SQL)
│   └── backup/               Nightly backup loop and restore script
├── portal/                   MailHarbor (Node.js 22, Express 5, PostgreSQL)
│   ├── src/
│   │   ├── server.js         Startup, migrations, graceful shutdown
│   │   ├── app.js            Express app, security middleware, routes
│   │   ├── config.js         Validated environment configuration
│   │   ├── db/               Pool, migration runner, SQL migrations
│   │   ├── lib/              listmonk client, CSV, email, audit helpers
│   │   └── modules/          auth, users, contacts, imports, exports, lists,
│   │                         suppression, reports, sync (worker + bounce rules), system
│   ├── public/               Single-page UI (Bootstrap 5, Chart.js, no build step)
│   ├── scripts/              bootstrap-listmonk.js, create-admin.js
│   ├── test/                 Unit + integration (acceptance) tests
│   ├── Dockerfile, railway.json, .env.example
└── docs/                     Admin, user, architecture, Railway, security, acceptance tests
```

## Quick start: self-hosted (Ubuntu Server + Docker)

**Prerequisites:** Ubuntu 22.04/24.04 with Docker Engine and the Compose plugin; two DNS names pointing at the server
(e.g. `mail.example.co.za` for MailHarbor, `lists.example.co.za` for listmonk); ports 80 and 443 open; an SMTP account for
sending; a **dedicated** POP3 mailbox for bounces.

```bash
git clone <this-repo> mailharbor && cd mailharbor
cp .env.example .env
nano .env                 # replace every value; generate secrets with: openssl rand -base64 36
./setup.sh                # builds, starts listmonk, creates the API user, starts everything
```

Then:

1. Remove `PORTAL_ADMIN_PASSWORD` from `.env` (the account now exists).
2. Sign in to **listmonk** (`https://lists…/admin`) → **Settings**:
   - **SMTP:** host, port 587 (STARTTLS) or 465 (TLS), credentials → *Test connection*.
   - **Bounces:** enable, add the POP3 bounce mailbox (port 995, TLS), set the Return-Path to that mailbox.
     `setup.sh` has already applied the recommended actions (hard 1→blocklist, complaint 1→blocklist, soft 3→blocklist).
   - **General:** default *From* address.
3. Sign in to **MailHarbor** (`https://mail…`) → **System health**. Fix anything red on the go-live checklist.
4. Configure SPF, DKIM, DMARC and reverse DNS for your sending domain ([admin guide](docs/ADMIN_GUIDE.md#5-dns-and-deliverability)).
5. Create lists, import contacts, send a test campaign to yourself.

Full walkthrough, upgrades, backups and monitoring: **[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md)**.
Railway deployment: **[docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md)**.

## Local development

```bash
# 1. PostgreSQL 13+ and listmonk v6.2.0 running locally, e.g.:
docker run -d --name lm -p 9000:9000 -e LISTMONK_db__host=host.docker.internal \
  -e LISTMONK_db__user=listmonk -e LISTMONK_db__password=listmonk -e LISTMONK_db__database=listmonk \
  -e LISTMONK_ADMIN_USER=admin -e LISTMONK_ADMIN_PASSWORD=adminpass123 \
  listmonk/listmonk:v6.2.0 sh -c "./listmonk --install --idempotent --yes --config '' && ./listmonk --config ''"

# 2. Portal
cd portal
npm ci
LISTMONK_URL=http://localhost:9000 LISTMONK_ADMIN_USER=admin LISTMONK_ADMIN_PASSWORD=adminpass123 \
  npm run bootstrap-listmonk -- --recommended-settings      # prints LISTMONK_API_USER / TOKEN
cp .env.example .env                                         # fill in DATABASE_URL, token, secrets
npm run dev                                                  # http://localhost:3000
```

| Command (in `portal/`) | Purpose |
|---|---|
| `npm start` | Start the portal (runs migrations automatically) |
| `npm run dev` | Start with auto-reload |
| `npm run migrate` | Apply database migrations only (needs `DATABASE_URL`) |
| `npm run create-admin -- you@co.za "Your Name"` | Create an admin or reset an admin's password |
| `npm run bootstrap-listmonk -- [--recommended-settings]` | Create the least-privilege listmonk API user |
| `npm run test:unit` | Unit tests (no services needed) |
| `npm run test:integration` | Acceptance tests against a **non-production** listmonk + PostgreSQL |

## Environment variables (portal)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | PostgreSQL shared with listmonk (use the `mailharbor` role) |
| `SESSION_SECRET` | yes | – | ≥ 32 random characters for signing session cookies |
| `LISTMONK_URL` | yes | – | Internal listmonk URL for API calls, e.g. `http://listmonk:9000` |
| `LISTMONK_PUBLIC_URL` | no | `LISTMONK_URL` | Public listmonk URL for links in the UI |
| `LISTMONK_API_USER` / `LISTMONK_API_TOKEN` | yes | – | From `bootstrap-listmonk.js` |
| `PORT` / `HOST` | no | `3000` / `0.0.0.0` | Listen address (Railway sets `PORT`) |
| `NODE_ENV` | no | `development` | `production` enables secure cookies and HSTS |
| `GLOBAL_UNSUBSCRIBE` | no | `true` | Unsubscribe from any list = suppressed from all |
| `SYNC_INTERVAL_SECONDS` | no | `60` | Sync worker interval |
| `SYNC_STALE_MINUTES` | no | `15` | Dashboard alert if the sync has not run for this long |
| `IMPORT_MAX_ROWS` / `IMPORT_MAX_MB` | no | `100000` / `25` | Import limits |
| `DATABASE_SSL`, `DATABASE_SSL_VERIFY` | no | `false`, `true` | TLS to PostgreSQL |
| `DATABASE_POOL_MAX` | no | `10` | Connection pool size |
| `SESSION_MAX_AGE_HOURS` | no | `8` | Idle session lifetime (rolling) |
| `COOKIE_SECURE` | no | `auto` | `auto` = secure in production |
| `TRUST_PROXY` | no | `1` | Number of reverse-proxy hops |
| `ORG_NAME` | no | `MailHarbor` | Shown in the UI |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | no | – | Creates the first admin when no users exist |
| `LOG_LEVEL` | no | `info` | pino log level |

## Testing status

| Suite | Result | Notes |
|---|---|---|
| Unit (`test/unit`) | 8/8 pass | Bounce rules, email validation, CSV formula-injection guard, CSV parsing/mapping, dates, config |
| Integration (`test/integration`) | 19/19 pass | Run against real listmonk v6.2.0 + PostgreSQL 16, **including as the least-privilege role**. Covers TC02, 03, 05, 06, 08, 09, 10, 11, 12, 13, 14, CSRF, RBAC, review hold, reactivation and erasure |
| UI smoke | All 18 screens render with no console errors | Headless Chromium |
| Backup / restore | Verified at database level | `pg_dump` → `pg_restore` into a fresh database |

Not verified in the build environment: the Docker image build (Docker Hub rate limit; the identical `npm ci --omit=dev` +
boot was verified), real SMTP delivery (TC01, TC04), POP3 bounce-mailbox scanning (TC05 was verified through listmonk's
bounce API instead), Caddy certificate issuance and a Railway deployment. See [docs/ACCEPTANCE_TESTS.md](docs/ACCEPTANCE_TESTS.md)
for the go-live test plan.

## Known limitations

- listmonk does not log individual sends, so a contact's "last campaign" is an estimate based on list membership.
- listmonk does not link unsubscribes to campaigns. Campaign unsubscribes count list unsubscribes within 7 days of the send.
- Opens are indicative (privacy proxies, image blocking, scanners). Per-contact opens and clicks need listmonk's
  *individual tracking* setting, which is off by default for privacy.
- listmonk reads bounces over POP3 only. An IMAP-only mailbox needs a provider webhook or an adapter.
- A contact held for review is blocklisted in listmonk while held, because that is the only state listmonk excludes from sends.
  Releasing the hold restores the lists it removed.
- Search and filtering compute statuses on the fly. This is fast for typical SME databases (≈100k contacts). Much larger
  databases may need a materialised status table.
- The portal and listmonk have separate logins (listmonk is used for writing campaigns).

## Documentation

- [Administrator guide](docs/ADMIN_GUIDE.md): install, listmonk configuration, DNS, users, backups, upgrades, monitoring
- [User guide](docs/USER_GUIDE.md): day-to-day use (also available in the app under **Guides**)
- [Architecture](docs/ARCHITECTURE.md): design decisions, data model, status logic, sync and enforcement
- [Deploying on Railway](docs/DEPLOY_RAILWAY.md)
- [Security & POPIA](docs/SECURITY.md)
- [Acceptance tests](docs/ACCEPTANCE_TESTS.md): TC01–TC16 status and the go-live test script

## Licence

The portal code is proprietary to its owner unless stated otherwise. listmonk is AGPL-3.0 and runs unmodified as a
separate service.
