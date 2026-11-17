# MailHarbor

**Your contacts, safely in harbour.** MailHarbor is a self-contained email-marketing and contact-management portal for
a South African organisation. It handles the whole job in one application: contacts, lists, imports and exports,
campaigns, sending, open and click tracking, unsubscribes, bounce processing, suppression, POPIA consent evidence and reports.

It needs only two things from outside: a **PostgreSQL database** and an **SMTP server**. Every other setting is managed
in the app.

---

## Features

- **Dashboard:** recipient status breakdown (active, unconfirmed, soft/hard bounced, complaint, unsubscribed,
  blocklisted, pending review), recent campaigns, emails sent, bounce activity, 30-day growth and live alerts.
- **Contacts:** search by email/name/company; filter by status, list, source or consent; sortable columns; bulk
  add/remove from lists, unsubscribe, suppress; a contact page with every email sent, opens, clicks, bounces, consent
  evidence and status history.
- **Lists:** single or double opt-in (confirmation email with a one-click confirm page).
- **Import wizard:** CSV (comma, semicolon or tab), automatic column matching, custom attributes, validation, duplicate
  detection, matching against existing contacts, suppression check, a required consent basis and a
  **preview before anything is saved**. After the import you get a downloadable row-by-row report.
- **Campaigns:**
  - a **drag-and-drop email builder**: headings, text, buttons, images, two-column layouts, dividers, spacers and HTML
    blocks, edited directly on a WYSIWYG canvas, with undo/redo, colour-contrast warnings and phone-friendly output
    (columns stack). The server validates the design and renders email-safe HTML;
  - a visual editor or raw HTML as alternatives, plus a plain-text part;
  - templates (the frame: header, colours, width, font, footer) designed in the same drag-and-drop builder or in HTML,
    with a default template;
  - personalisation `{{ first_name | "there" }}` and a preheader;
  - preview as a sample contact, test sends;
  - a readiness checklist;
  - send now or schedule; pause, resume and cancel.
- **Sending engine:**
  - pooled SMTP with a per-second rate and an optional hourly cap;
  - temporary failures retried at 5, 30 and 120 minutes;
  - an SMTP outage auto-pauses the campaign and raises an alert;
  - every recipient is re-checked against the suppression list immediately before their email is sent;
  - a restart never sends an email twice.
- **Compliance built in:**
  - every email carries an unsubscribe link and RFC 8058 one-click `List-Unsubscribe` headers (required by Gmail and Yahoo for bulk senders);
  - the organisation's postal address goes in the footer;
  - an unsubscribe from any list suppresses the person globally (default).
- **Bounce handling** from three sources:
  - SMTP rejections at send time;
  - an IMAP bounce mailbox, with DSN and ARF complaint parsing;
  - a provider webhook.

  Classification follows the scope (§3.6.2):

  | Signal | Action |
  |---|---|
  | 5.1.1 / 550 | hard bounce → suppressed |
  | 4.x.x | soft bounce, counted; suppressed at the limit (default 3) |
  | **5.7.x policy/spam rejection** | **held for review**, not wrongly suppressed |
  | Complaint | suppressed immediately |
- **Suppression that cannot be bypassed:** imports, list changes and manual adds never reactivate an unsubscribed,
  bounced, complained or blocklisted address. Reactivation is admin-only and needs a documented new permission basis.
- **Reports:**
  - per campaign: recipients, sent, failed, hard and soft bounces, complaints, unsubscribes, unique opens and clicks, top links, a timeline;
  - audience by source, consent and domain;
  - bounce trends.
- **Exports (CSV, Excel-safe):** contacts for any filter, eligible contacts, suppression list, consent and unsubscribe
  history, status history, bounces, campaigns and the audit log. Per-contact JSON export for POPIA access requests.
- **POPIA erasure:** deletes the contact and keeps only a SHA-256 hash on the suppression list.
- **Operations:** a System health page with a go-live checklist (SMTP connection, sender, public URL, postal
  address, bounce processing, SPF/DMARC/MX DNS checks, worker heartbeat, queue, backups) and alerts.
- **Security:**
  - roles (viewer / manager / admin) and Argon2id passwords;
  - account lockout after repeated failed sign-ins;
  - server-side sessions, CSRF tokens, a strict CSP, rate limiting and a full audit log;
  - the bounce-mailbox password is encrypted (AES-256-GCM) at rest.
- **In-app guides** for non-technical staff.

## Architecture

```
          Internet (HTTPS)
                │
       ┌────────▼─────────┐  web UI + public pages (unsubscribe, confirm, view online, tracking, bounce webhook)
       │    MailHarbor    │
       │  Node.js/Express │──► your SMTP server (587 STARTTLS / 465 TLS)
       │  + worker loops  │◄── IMAP bounce mailbox (993), optional
       └────────┬─────────┘
                │
       ┌────────▼─────────┐
       │    PostgreSQL    │  schema "portal": contacts, lists, campaigns, messages, tracking,
       │                  │  bounces, suppressions, consent, audit, settings, sessions
       └──────────────────┘
```

A single Node.js process serves the web app and runs the background worker:

| Worker loop | Interval | Job |
|---|---|---|
| sender | 1 s | Claims queued messages with `FOR UPDATE SKIP LOCKED`; rate-limited |
| scheduler | 15 s | Starts scheduled campaigns that are due |
| bounce mailbox | configurable, default 5 min | Polls the IMAP mailbox |
| upkeep | 60 s | Heartbeat, configuration alerts, backup freshness |

Each campaign recipient is a row in `portal.messages` with a random token. That token drives the unsubscribe,
tracking and view-online links and bounce matching, so links never expose an email address or a database ID.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

```
portal/                    the application source
  src/
    server.js              startup: migrations → secrets → settings → admin → worker → HTTP
    config.js              environment variables (validated at startup)
    engine/                sender, renderer, SMTP, bounce parsing/rules, IMAP mailbox, worker
    modules/               REST API by feature (contacts, lists, imports, campaigns, templates,
                           settings, reports, exports, suppression, users, system, public pages)
    db/migrations/         SQL schema
  public/                  single-page web app (Bootstrap 5, no build step)
  scripts/                 backup.js, create-admin.js
  test/                    unit + end-to-end acceptance tests (with a local SMTP test server)
Dockerfile, railway.json   image + Railway config (built from the repo root)
docker-compose.yml         self-hosted stack: Caddy + MailHarbor + PostgreSQL + backups
deploy/                    Caddyfile, restore script
docs/                      guides (see below)
```

## Deploy on Railway (recommended hosted option)

Two services, plus an optional backup cron:

1. **New Project → Deploy PostgreSQL.**
2. **+ New → GitHub Repo →** this repository. Leave *Root Directory* empty: Railway uses the root `Dockerfile` and
   `railway.json`. Then generate a public domain.
3. Set these variables on the MailHarbor service:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `SMTP_HOST` | your SMTP server |
   | `SMTP_PORT` | `587` (or `465`) |
   | `SMTP_USER` / `SMTP_PASSWORD` | SMTP credentials |
   | `SMTP_FROM` | optional default sender, e.g. `"Example News <news@example.co.za>"` |

4. Deploy. In **Deploy Logs**, find `FIRST-RUN SETUP: … enter setup code XXXXXXXXXX`. Open the public domain, enter
   the code and create the first administrator.
5. Work through **Settings**: organisation and postal address, sender, bounce handling. Then fix anything red on
   **System health**.

> **Railway plan:** Railway allows outbound SMTP only on the **Pro plan and above**. Free, Trial and Hobby plans block
> SMTP ports. MailHarbor sends over SMTP, so use a Pro workspace. Then redeploy the service after upgrading.

Full guide with backups, custom domain and troubleshooting: **[docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md)**.

## Self-hosted (Ubuntu Server + Docker Compose)

Requirements:
- a server with Docker and the Compose plugin;
- a DNS name pointing at the server, with ports 80 and 443 open;
- SMTP credentials.

```bash
git clone <this-repo> mailharbor && cd mailharbor
cp .env.example .env && nano .env      # DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD, SMTP_*
docker compose up -d --build
docker compose logs portal | grep "setup code"
```

Open `https://<DOMAIN>`, enter the setup code and continue as in steps 4–5 above. Caddy obtains the HTTPS certificate
automatically. Backups are written nightly to `./backups`; restore with `deploy/backup/restore.sh`. See
[docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).

## Local development

```bash
# PostgreSQL 14+ (example)
docker run -d --name mh-db -p 5432:5432 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=mailharbor postgres:17-alpine

cd portal
npm ci
npm run smtp-sink &                 # local SMTP test server on port 2525 (accepts everything, prints messages)
cat > .env <<'EOF'
DATABASE_URL=postgres://postgres:dev@localhost:5432/mailharbor
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_REQUIRE_TLS=false
NODE_ENV=development
PUBLIC_URL=http://localhost:3000
EOF
npm run dev                         # http://localhost:3000, setup code in the console
```

The SMTP sink simulates failures by address prefix:
- `hard-…@` is rejected with 550 5.1.1;
- `soft-…@` with 452 4.2.2;
- `policy-…@` with 550 5.7.1.

| Command (in `portal/`) | Purpose |
|---|---|
| `npm start` | Start (runs migrations automatically) |
| `npm run dev` | Start with auto-reload, reading `.env` if present |
| `npm run migrate` | Apply migrations only (needs `DATABASE_URL`) |
| `npm run create-admin -- email "Name"` | Create an admin or reset an admin password from the command line |
| `npm run backup` | One backup run (see `scripts/backup.js`) |
| `npm run test:unit` | Unit tests (no database) |
| `TEST_DATABASE_URL=… npm run test:integration` | End-to-end acceptance tests. **Drops the `portal` schema** of that database, and refuses to run unless the database name contains `test` |

## Environment variables

Only the first two are required. Everything else, including organisation details, sender, reply-to, bounce mailbox,
sending speed, tracking and soft-bounce limit, is set in **Settings** and stored in the database.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | | PostgreSQL connection URL |
| `SMTP_HOST` | **yes** | | SMTP server host |
| `SMTP_PORT` | | `587` | `465` turns on implicit TLS automatically |
| `SMTP_USER`, `SMTP_PASSWORD` | | | Both or neither |
| `SMTP_FROM` | | | Default sender, e.g. `"Name <news@example.co.za>"` (overridden by Settings) |
| `SMTP_SECURE` | | auto | Force implicit TLS on/off |
| `SMTP_REQUIRE_TLS` | | `true` | Refuse to send credentials without STARTTLS. Set `false` only for a local test server |
| `SMTP_POOL_MAX` | | `3` | Concurrent SMTP connections |
| `PORT` | | `3000` | Railway sets this |
| `PUBLIC_URL` | | | Base URL for links in emails. On Railway the public domain is detected; otherwise set it here or in Settings |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | | | Optional break-glass admin, created or repaired on every start (password min. 12 chars) |
| `NODE_ENV` | | `production` | `development` allows non-secure cookies over plain http |
| `DATABASE_SSL`, `DATABASE_SSL_VERIFY` | | `false`, `true` | TLS to PostgreSQL (not needed on Railway's private network) |
| `DATABASE_POOL_MAX` | | `10` | |
| `SESSION_SECRET` | | generated | Generated and stored in the database if unset |
| `WORKERS` | | `true` | `false` runs the web app without the sending/bounce worker |
| `IMPORT_MAX_ROWS`, `IMPORT_MAX_MB` | | `100000`, `25` | Import limits |
| `TRUST_PROXY` | | `1` | Proxy hops in front of the app |
| `LOG_LEVEL` | | `info` | |

The session secret and the settings encryption key are generated on first start and stored in `portal.app_secrets`.
Back up the database, and you back up both.

## Testing status

Verified in the build environment:
- **Unit tests:** config, secrets encryption, rendering and personalisation, DSN/ARF bounce parsing, bounce rules and
  SMTP error classification.
- **Acceptance tests** (`test/integration`), against real PostgreSQL 16 and a local SMTP server. They cover:
  - first-run setup with the log code;
  - import, then a personalised send;
  - hard bounce → suppressed;
  - 5.7.1 → review queue;
  - soft-bounce retries and the soft-bounce limit;
  - open/click tracking and one-click unsubscribe attributed to the campaign;
  - complaint via webhook;
  - re-import that keeps suppressed contacts suppressed, and exclusion from the next campaign;
  - double opt-in;
  - reactivation and POPIA erasure;
  - SMTP outage → auto-pause → resume.
- **Browser walkthrough (Playwright):** setup, settings, lists, contacts, the campaign editor, test send, send, report,
  templates, system health. An axe accessibility scan found no violations on those pages.
- **Drag-and-drop builder (Playwright):** 15-step walkthrough with the CSP enforced, covering palette drags, nested
  columns, handle reordering, in-place editing, undo, test send, HTML conversion and phone width. It passed with no
  console errors and no axe violations.

**Not verified here:**
- the IMAP connection against a real mailbox (only the parser is tested);
- real SMTP providers and DNS checks against a real domain;
- a live Railway deployment.

The Docker image was built and smoke-tested. The build needed only the sandbox's proxy certificate added; the
Dockerfile is unchanged. In the container:
- it runs as the non-root user;
- `/healthz` returns 200;
- the SMTP connection is verified;
- `scripts/backup.js` produces a verified dump with pg_dump 18.

Do the [UAT checklist](docs/ACCEPTANCE_TESTS.md) on staging before go-live.

## Known limitations

- One application instance. The sender is safe with more than one (it uses row locks), but scheduling and alerting
  are designed for one; keep Railway replicas at 1.
- No built-in DKIM signing. Use an SMTP provider that signs with DKIM for your domain.
- Images are linked by URL; there is no media library or upload.
- Open tracking is approximate. Apple Mail Privacy Protection pre-loads images, and many clients block them. Treat clicks
  as the reliable engagement signal.
- No A/B testing, automations or drip sequences.

## Documentation

| Guide | For |
|---|---|
| [USER_GUIDE](docs/USER_GUIDE.md) | Staff: contacts, imports, campaigns, reports |
| [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | Administrators: setup, settings, deliverability, backups, operations |
| [DEPLOY_RAILWAY](docs/DEPLOY_RAILWAY.md) | Railway deployment |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Developers: design, data model, engine |
| [SECURITY](docs/SECURITY.md) | Security controls and POPIA |
| [ACCEPTANCE_TESTS](docs/ACCEPTANCE_TESTS.md) | UAT checklist mapped to the scope |
| [UAT_AUDIT](docs/UAT_AUDIT.md) | UI/UX/UAT audit findings and fixes |

The same how-to content is in the app under **Guides**.

## Licence

Proprietary to the commissioning organisation unless agreed otherwise. Third-party packages keep their own licences
(see `portal/package.json`).
