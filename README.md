# MailHarbor

**Your contacts, safely in harbour.** MailHarbor is a self-contained email-marketing and contact-management portal for
a South African organisation. It handles the whole job in one application: contacts, lists, imports and exports,
campaigns, sending, open and click tracking, unsubscribes, bounce processing, suppression, POPIA consent evidence and reports.

It needs only two things from outside: a **PostgreSQL database** and an **SMTP server**. Every other setting is managed
in the app.

> **This README is for the MailHarbor development and operations team.** Customers get the documentation listed under
> [Customer-facing](#customer-facing), which never mentions the hosting platform, environment variables or servers.

## Service model

MailHarbor is sold as a **hosted, single-tenant service**. Each customer company gets its own instance, its own
PostgreSQL database, its own web address and its own backups, and sends through its **own** SMTP server. Nothing is
shared between customers. The application is deliberately single-organisation, so isolation comes from separate
instances, not from tenant IDs in a shared database.

- **Onboarding a customer:** [docs/internal/PROVISIONING.md](docs/internal/PROVISIONING.md)
- **Running the fleet** (backups, upgrades, monitoring, support account): [docs/internal/OPERATIONS.md](docs/internal/OPERATIONS.md)
- **Platform steps** (Railway, current host): [docs/internal/DEPLOY_RAILWAY.md](docs/internal/DEPLOY_RAILWAY.md)

---

## Features

- **Dashboard:** recipient status breakdown (active, unconfirmed, soft/hard bounced, complaint, unsubscribed,
  blocklisted, pending review), recent campaigns, emails sent, bounce activity, 30-day growth and live alerts.
- **Contacts:** search by email/name/company; filter by status, list, source or consent; sortable columns; bulk
  add/remove from lists, unsubscribe, suppress; a contact page with every email sent, opens, clicks, bounces, consent
  evidence and status history.
- **Lists:** single or double opt-in (confirmation email with a one-click confirm page).
- **Sign-up forms:**
  - **Pages:** each form has its own hosted page and embed code for your website, with your heading, fields, consent
    statement, button colour and thank-you message or page.
  - **Consent:** evidence (statement, form, IP address, time) is recorded for POPIA, and double opt-in lists send a
    confirmation email first.
  - **Protection:** a hidden spam trap, a signed minimum fill time and rate limits keep bots out. Suppressed addresses
    are never re-subscribed, and the reply never reveals whether an address is already known.
- **Saved segments:** audiences built from rules, matched on all or any of them. For example: last opened in the last
  90 days, source, email domain, any imported column such as city, list membership, status, or date added. Each shows
  a live count and preview, can filter the contact list and exports, and can narrow a campaign. List membership still
  carries consent.
- **Image library:**
  - **Compression:** uploads are resized for email (max 1200px wide), rotated upright, stripped of metadata (GPS,
    camera) and compressed to JPEG, or PNG when transparent. Animated GIFs are kept.
  - **Storage:** images are stored in PostgreSQL (so they're in every backup) and served from a permanent link.
  - **Use:** pick or upload from the builder's image block or as the logo. Images used by a campaign or the logo can't be deleted.
- **Import wizard:** CSV (comma, semicolon or tab), automatic column matching, custom attributes, validation, duplicate
  detection, matching against existing contacts, suppression check, a required consent basis and a
  **preview before anything is saved**. After the import you get a downloadable row-by-row report.
- **Email design (Settings):** one fixed, compliant structure for every email. A header (logo or organisation name),
  the campaign's content in a white card, and a footer with organisation name, postal address, a footer line and the
  Unsubscribe / Manage preferences / View in browser links. Logo, brand and heading colours, background, font and
  footer line are settings with a live preview. There are no per-campaign templates.
- **Campaigns** in three steps (Audience → Email → Review & send):
  - a **drag-and-drop email builder**: headings, text, buttons, images, two-column layouts, dividers, spacers and HTML
    blocks, edited directly on a WYSIWYG canvas, with undo/redo, colour-contrast warnings and phone-friendly output
    (columns stack). The server validates the design and renders email-safe HTML. Headings, buttons and links follow
    the brand colours unless set per block;
  - the sender comes from Settings unless a campaign overrides it; the plain-text part is generated;
  - **frozen at send:** a campaign's content and design are stored when it starts, so later design changes never
    alter what was sent or its "view in browser" page;
  - **9 sample designs** to start from: simple message, marketing promotion, new product release, "Are you still
    interested?", introduction & permission request, "Want to find out more?", monthly newsletter, event invitation, welcome;
  - **one-click personalisation**: field buttons (First name, Full name, Company… plus imported columns) insert
    `{{ first_name | "there" }}`-style tags at the cursor in the subject, preview text or any block;
  - a preheader (inbox preview text);
  - **Google Analytics (UTM) tags** on web links (`utm_source`, `utm_medium`, `utm_campaign`), with defaults and an
    optional website list in Settings. Each campaign can rename or switch them off. Tags are frozen when sending starts;
    MailHarbor's own links are never tagged;
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
  - an unsubscribe from any list suppresses the person globally (default);
  - **recipient pages run by MailHarbor**: unsubscribe, a **preference centre** (opt out of individual lists or
    everything), **stay subscribed** (re-engagement), **give permission** (records POPIA consent with campaign, time and IP) and view in
    browser. Any button or text link can point to them, and
    each recipient's personal link is created automatically at send time. No URLs to manage.
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
- **Reports, with every number clickable:** each count opens the recipients, emails, bounces or contacts behind it
  (`#/details`), with search, paging, a link to each contact and CSV download for managers and administrators.
  - per campaign: recipients, sent, failed, hard and soft bounces, complaints, unsubscribes, unique opens and clicks,
    stayed subscribed, preference changes, top links, a timeline;
  - **mail usage** through your SMTP server: sent today / this month / last hour (against the hourly limit), the queue,
    emails per day by kind (campaign, opt-in, test), SMTP rejections, recipient actions and campaigns sent;
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

Details: [docs/internal/ARCHITECTURE.md](docs/internal/ARCHITECTURE.md).

## Repository layout

```
portal/                    the application source
  src/
    server.js              startup: migrations → secrets → settings → admin → worker → HTTP
    config.js              environment variables (validated at startup)
    engine/                sender, renderer, SMTP, bounce parsing/rules, IMAP mailbox, worker
    modules/               REST API by feature (contacts, lists, imports, campaigns, images, forms, segments,
                           settings, reports, exports, suppression, users, system, public pages)
    db/migrations/         SQL schema
  public/                  single-page web app (Bootstrap 5, no build step)
  scripts/                 backup.js, create-admin.js
  test/                    unit + end-to-end acceptance tests (with a local SMTP test server)
Dockerfile, railway.json   image + Railway config (built from the repo root)
docker-compose.yml         self-hosted stack: Caddy + MailHarbor + PostgreSQL + backups
deploy/                    Caddyfile, restore script
docs/                      customer-facing guides + brochure source (see below)
docs/internal/             operations, provisioning, deployment, architecture, UAT (internal only)
```

## Deploy an instance on Railway (current hosting platform)

Per customer: one Railway project with two services plus the backup cron (required for customers). For customer
instances, follow the full [provisioning checklist](docs/internal/PROVISIONING.md); this is the short version:

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
   | `SUPPORT_EMAIL` | our support address, shown to the customer |

4. Deploy. In **Deploy Logs**, find `FIRST-RUN SETUP: … enter setup code XXXXXXXXXX`. Open the public domain, enter
   the code and create the first administrator.
5. Work through **Settings**: organisation and postal address, sender, bounce handling. Then fix anything red on
   **System health**.

> **Railway plan:** Railway allows outbound SMTP only on the **Pro plan and above**. Free, Trial and Hobby plans block
> SMTP ports. MailHarbor sends over SMTP, so use a Pro workspace. Then redeploy the service after upgrading.

Full guide with backups, custom domain and troubleshooting: **[docs/internal/DEPLOY_RAILWAY.md](docs/internal/DEPLOY_RAILWAY.md)**.

## Dedicated VM (Ubuntu Server + Docker Compose)

For a customer that needs a dedicated VM or in-country hosting.


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
[docs/internal/OPERATIONS.md](docs/internal/OPERATIONS.md).

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
| `npm run brochure` | Rebuild the product overview PDF and page previews from `docs/brochure/mailharbor-overview.html` (needs Playwright; development only) |
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
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | | | MailHarbor support and recovery account, created or repaired on every start (password min. 12 chars); shown to the customer as *Managed by MailHarbor*. Set it **after** first-run setup |
| `SUPPORT_EMAIL` | | | Support address shown to the customer on the setup screen and in error messages |
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
- **Browser walkthrough (Playwright):** setup, settings (including Email design), lists, contacts, the campaign editor,
  test send, send, report drill-downs, usage, system health. An axe accessibility scan found no violations on those pages.
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

Do the [UAT checklist](docs/internal/ACCEPTANCE_TESTS.md) on staging before go-live.

## Known limitations

- One application instance. The sender is safe with more than one (it uses row locks), but scheduling and alerting
  are designed for one; keep Railway replicas at 1.
- No built-in DKIM signing. Use an SMTP provider that signs with DKIM for your domain.
- Open tracking is approximate. Apple Mail Privacy Protection pre-loads images, and many clients block them. Treat clicks
  as the reliable engagement signal.
- No A/B testing, automations or drip sequences.

## Documentation

### Customer-facing

These describe MailHarbor as a hosted service. Keep hosting platforms, environment variables, servers and logs out of
them, and route anything platform-related to "contact MailHarbor support".

| Guide | For |
|---|---|
| [GETTING_STARTED](docs/GETTING_STARTED.md) | New customers: what we need, first sign-in, first campaign |
| [USER_GUIDE](docs/USER_GUIDE.md) | Staff: contacts, imports, campaigns, email design, reports |
| [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | Customer administrators: settings, users, DNS, bounces, monitoring |
| [SECURITY](docs/SECURITY.md) | Security controls, hosting model and POPIA |
| [Product overview](docs/brochure/mailharbor-overview.html) | Marketing brochure (features + roadmap), source of the PDF |

### Internal

| Guide | For |
|---|---|
| [PROVISIONING](docs/internal/PROVISIONING.md) | Onboarding and offboarding a customer instance |
| [OPERATIONS](docs/internal/OPERATIONS.md) | Backups, upgrades, monitoring, support account, troubleshooting |
| [DEPLOY_RAILWAY](docs/internal/DEPLOY_RAILWAY.md) | Railway steps per customer project |
| [SALES_INTRO_EMAIL](docs/internal/SALES_INTRO_EMAIL.md) | Our own MailHarbor introduction & permission email copy |
| [ARCHITECTURE](docs/internal/ARCHITECTURE.md) | Developers: design, data model, engine |
| [ACCEPTANCE_TESTS](docs/internal/ACCEPTANCE_TESTS.md) | UAT checklist mapped to the scope |
| [UAT_AUDIT](docs/internal/UAT_AUDIT.md) | UI/UX/UAT audit findings and fixes |

The same how-to content is in the app under **Guides**. The product overview brochure is in the app under
**Product overview**, where it can be viewed and downloaded as a PDF. After changing features, update the brochure
source and run `npm run brochure` so the PDF stays accurate.

## Licence

Proprietary to the commissioning organisation unless agreed otherwise. Third-party packages keep their own licences
(see `portal/package.json`).
