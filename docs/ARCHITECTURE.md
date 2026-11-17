# Architecture

## Principles

- **One deployable, one database.** MailHarbor is a modular monolith: Node.js 22, Express 5 and PostgreSQL. The web app
  and the background worker run in the same process. There is no queue server, cache or second service: PostgreSQL is
  the queue (`FOR UPDATE SKIP LOCKED`), and advisory locks coordinate the worker loops.
- **Environment holds only infrastructure.** `DATABASE_URL` and `SMTP_*` are environment variables. Everything an
  administrator might change is stored in `portal.settings`. Generated secrets are stored in `portal.app_secrets`.
- **Suppression is a register, not a flag.** `portal.suppressions` is keyed on the SHA-256 of the lower-cased email. It
  survives erasure, re-import and list changes, and it is checked twice: when a campaign takes its recipient snapshot,
  and again just before each individual send.
- **Every recipient email is a row.** `portal.messages` holds one row per recipient per campaign, with a random UUID
  token. Unsubscribe, view-online, tracking and bounce matching all use that token, so public URLs never contain an
  email address or a sequential ID.
- **Evidence over inference.** Status changes are written to `recipient_events` (who, what, from → to, which campaign).
  Administrative actions are written to `audit_log`.

## Components

| Path | Responsibility |
|---|---|
| `src/server.js` | Startup order: config → migrations → secrets → settings → env admin → default template → recover interrupted sends → setup code → SMTP transport → worker → HTTP. Graceful shutdown on SIGTERM/SIGINT |
| `src/config.js` | Validates environment variables (zod); fails fast with a list of problems |
| `src/lib/settings.js` | Typed settings with defaults, 5 s cache, partial updates, encrypted bounce-mailbox password |
| `src/lib/secrets.js` | Generated secrets; AES-256-GCM encrypt/decrypt with an HKDF-derived key |
| `src/engine/render.js` | Template + content merge, personalisation tags (HTML-escaped, no logic), link rewriting, open pixel, compliance footer, `List-Unsubscribe` headers, plain-text part, HTML sanitising |
| `src/engine/sender.js` | Campaign start (recipient snapshot + link table), rate-limited sending, retries, error handling, completion, opt-in confirmation emails |
| `src/engine/mailer.js` | Pooled nodemailer transport (TLS 1.2+), SMTP error classification |
| `src/engine/bounces.js`, `bounceRules.js` | DSN/ARF parsing, classification, bounce processing and suppression |
| `src/engine/mailbox.js` | IMAP bounce mailbox polling (imapflow) |
| `src/engine/worker.js` | Worker loops and health/upkeep |
| `src/modules/*` | REST API per feature; `public/` holds the recipient-facing pages and webhook |
| `public/` | Single-page app: Bootstrap 5, ES modules, no build step, no inline script (strict CSP) |

## Worker loops

| Loop | Interval | Work |
|---|---|---|
| sender | 1 s | Token bucket at *emails per second*, plus the optional *maximum per hour*. Claims due `queued` messages with `FOR UPDATE SKIP LOCKED`, renders and sends them, records the result |
| scheduler | 15 s | `scheduled` campaigns whose `send_at` has passed → start |
| mailbox | 30 s check, runs every *N* minutes | IMAP poll under an advisory lock; at most 200 messages per run; processed mail moved to `MailHarbor-Processed` or deleted |
| upkeep | 60 s | Worker heartbeat, completes finished campaigns, configuration alerts (public URL, bounce mailbox), backup freshness |

### Message lifecycle

```
queued ──claim──► sending ──250 OK──────────────► sent
   ▲                 ├─4xx──► queued again after 5 / 30 / 120 min; 4th failure ──► failed + soft bounce
   │                 ├─5xx──► failed + bounce_event (source=smtp) → classification (hard / policy)
   └─────────────────┼─connection error──► queued, campaign auto-paused, critical alert
                     └─suppressed or unsubscribed since snapshot──► skipped
   restart while "sending" ──► unknown   (never re-sent automatically: avoids duplicates)
   campaign cancelled ──► cancelled
```

## Bounce processing

There are three sources, and all of them go through `processBounce()`:

| Source | How the message is identified | Dedupe key |
|---|---|---|
| SMTP rejection at send time | The message row being sent | `msg:<message id>` |
| IMAP mailbox | `X-MailHarbor-ID` header in the returned original, else the `Final-Recipient` email | DSN `Message-ID`, or the mailbox UID |
| Webhook `POST /webhooks/bounce?token=…` | `message_id` (the X-MailHarbor-ID), else `email` | provider event `id` |

The parser reads:
- **ARF** (`message/feedback-report`) as a complaint;
- **DSN** (`message/delivery-status`) per recipient, using Action, Status and Diagnostic-Code;
- anything else with a heuristic, which ignores auto-replies, and also ignores DSNs whose recipients were all delivered.

Classification (`bounceRules.js`, scope §3.6.2):

| Signal | Class | Action |
|---|---|---|
| Complaint / ARF | complaint | Suppress (reason `complaint`) |
| 5.7.x, or policy/spam/blocked wording | policy | **Review queue**; no suppression |
| 5.1.x, 550/551/553, "user unknown", "no such user" | hard | Suppress (`hard_bounce`) |
| 4.x.x, mailbox full, greylisting, timeouts | soft | `contacts.soft_bounces += 1`; at the *soft-bounce limit* → suppress (`soft_limit`) |
| Unrecognised | unknown | Recorded, no action |

## Recipient status

Each contact has one status, derived in SQL (`contacts/repo.js`) in this priority order:

| # | Condition | Status | Eligible |
|---|---|---|---|
| 1 | Active suppression, reason complaint | `complaint` | No |
| 2 | Active suppression, reason hard_bounce / soft_limit | `hard_bounced` | No |
| 3 | Active suppression, reason unsubscribe | `unsubscribed` | No |
| 4 | Any other active suppression | `blocklisted` | No |
| 5 | Open review item | `pending_review` | No |
| 6 | No list memberships | `no_lists` | No |
| 7 | Every membership unsubscribed | `unsubscribed` | No |
| 8 | No confirmed membership | `unconfirmed` | No |
| 9 | Soft bounces > 0 | `soft_bounced` | Yes |
| 10 | Otherwise | `active` | Yes |

Eligibility for a campaign (`engine/audience.js`) requires all of the following:
- a `subscribed` membership in one of the campaign's lists;
- no active suppression for the contact's email hash;
- no open review item.

## Suppression guarantees (scope §4)

| Rule | Mechanism |
|---|---|
| Hard bounce → excluded | Suppression row; excluded at snapshot and re-checked before send |
| Unsubscribe stays suppressed | Global by default (Settings → Compliance): suppression row plus all memberships set to `unsubscribed` |
| Complaint → immediate suppression | ARF / webhook → suppression |
| Soft bounces tracked | Counter plus a configurable limit |
| No duplicate records | Unique index on `LOWER(email)`; imports match case-insensitively |
| Import cannot override suppression | Preview and commit both check `suppressions`; memberships are only inserted (`ON CONFLICT DO NOTHING`), never flipped from `unsubscribed` |
| "Add to list" cannot resubscribe | Same insert-only rule |
| Late suppression respected | `stillEligible()` is evaluated for each message immediately before it is handed to SMTP |
| Reactivation is authorised | Admin role + reason + new consent basis; restores memberships; audited |
| Erasure | Contact and personal rows deleted; suppression kept as hash only (reason `erased`) |

## Public endpoints

| Route | Purpose |
|---|---|
| `GET /u/:token` | Unsubscribe confirmation page (GET never changes state, so link scanners are harmless) |
| `POST /u/:token` | Unsubscribe. Also serves as the RFC 8058 one-click target (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) |
| `GET /v/:token` | View in browser (sandboxed CSP) |
| `GET /t/o/:token.gif` | Open pixel |
| `GET /t/c/:token/:linkId` | Click redirect, **only** to URLs stored for that campaign (no open redirect) |
| `GET`/`POST /s/confirm/:token` | Double opt-in confirm page / confirm |
| `POST /webhooks/bounce` | Provider bounce/complaint events (token, constant-time compare) |

All public routes are rate-limited (300/min per IP).

## Data model (`portal` schema)

| Table | Purpose |
|---|---|
| `settings`, `app_secrets`, `sync_state` | Configuration, generated secrets, worker state and heartbeats |
| `users`, `sessions` | Portal accounts (Argon2id), server-side sessions |
| `contacts` | Email, hash, names, company, source, attributes (jsonb), consent (jsonb), soft-bounce count, last sent/open/click/bounce |
| `lists`, `list_members` | Lists (single/double opt-in) and memberships (`subscribed`/`unconfirmed`/`unsubscribed`) |
| `templates`, `campaigns`, `campaign_lists` | Content and targeting; campaign status `draft → scheduled → sending ⇄ paused → sent` or `cancelled` |
| `messages` | One row per recipient email (campaign, opt-in, test); token, status, attempts, timestamps, error |
| `links`, `tracking_events` | Campaign links; opens and clicks |
| `bounce_events` | Every bounce with source, codes, classification, action taken |
| `suppressions` | The suppression register (email hash, reason, evidence, lifted by/at) |
| `review_queue` | Policy rejections awaiting a decision |
| `consent_records`, `recipient_events` | Consent evidence and status history |
| `imports`, `import_rows` | Import jobs and the per-row outcome |
| `audit_log`, `alerts` | Administrative audit trail and operational alerts |

Migrations are plain SQL in `src/db/migrations`. They are applied in order on startup inside a transaction, and recorded
in `portal.schema_migrations`.

## Scaling notes

- **Throughput:** sending is bounded by the configured rate and by the SMTP provider, not by MailHarbor. At 5 emails per
  second a 10 000-contact campaign takes about 35 minutes. Raise the rate only within the provider's limits and once the
  domain has a sending reputation.
- **Size:** the contact list, reports and exports stream or paginate. Indexes cover status filtering, list membership,
  email hash and message tokens. The design comfortably targets hundreds of thousands of contacts on a small Postgres
  instance. Measure before tuning.
- **Replicas:** keep one. The sender would be safe with more (row locks), but alerting, scheduling and the IMAP poll
  are designed around one instance and add nothing at this scale.
