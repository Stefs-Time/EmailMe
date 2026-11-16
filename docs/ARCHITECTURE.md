# Architecture

## Principles

1. **listmonk is the core and is not forked** (scope §15). It owns subscribers, lists, campaigns, templates, sending and
   raw bounce capture. Upgrades stay simple.
2. **All writes to listmonk data go through its REST API**, so listmonk's validation and side effects apply.
3. **Reads use SQL against listmonk's tables in READ ONLY transactions**, through a role that only has `SELECT` on them.
   Contact search, sorting, status derivation and reports need joins that the API cannot express efficiently. The
   alternative, listmonk's `query` parameter, would mean giving the portal permission to send raw SQL fragments.
4. **Supplementary data lives in a separate `portal` schema** (scope §4.1): suppression, consent, events, bounce
   classification, imports, review queue, audit log, alerts, sessions.
5. **Modular monolith:** one Node.js service, no queues or extra infrastructure. The sync worker runs in-process,
   guarded by a PostgreSQL advisory lock so extra replicas are safe.

## Components

| Module (`portal/src/modules`) | Responsibility |
|---|---|
| `auth`, `users` | Sessions, login throttling and lockout, password changes, portal user management |
| `contacts` | Read model (`repo.js`), contact operations (`service.js`), consent schema |
| `imports` | CSV parsing/mapping (`mapping.js`, pure), preview/commit pipeline (`service.js`) |
| `suppression` | Suppression register and the admin-only reactivation flow |
| `lists` | List CRUD through listmonk, with eligibility counts |
| `exports` | Streaming CSV exports (keyset-paginated, formula-injection safe) |
| `reports` | Overview, campaign, audience and bounce analytics |
| `sync` | Worker (`worker.js`) and bounce classification rules (`bounceRules.js`) |
| `system` | Health, go-live checks, alerts, audit log, review queue listing |

## Recipient status (scope §3.3)

One status per contact, derived in SQL (`contacts/repo.js`) in this priority order:

| # | Condition | Status | Campaign eligible |
|---|---|---|---|
| 1 | Active suppression reason = complaint (or blocklisted with a complaint bounce) | `complaint` | No |
| 2 | Suppression reason = hard_bounce | `hard_bounced` | No |
| 3 | Suppression reason = unsubscribe | `unsubscribed` | No |
| 4 | Any other active suppression | `blocklisted` | No |
| 5 | Open review item | `pending_review` | No |
| 6 | listmonk `blocklisted` (not yet synced) | `hard_bounced` / `blocklisted` | No |
| 7 | listmonk `disabled` | `inactive` | (listmonk still sends to disabled; kept for visibility) |
| 8 | No subscriptions | `no_lists` | No |
| 9 | Every subscription unsubscribed | `unsubscribed` | No |
| 10 | Has soft bounces | `soft_bounced` | Yes, until the soft-bounce threshold blocklists |
| 11 | Only unconfirmed double opt-in subscriptions | `unconfirmed` | No |
| 12 | Otherwise | `active` | Yes |

listmonk excludes only `blocklisted` subscribers and `unsubscribed` subscriptions (and unconfirmed subscriptions on
double opt-in lists) from campaigns. MailHarbor therefore **enforces every non-eligible state by blocklisting in listmonk**.
That includes review holds.

## Suppression guarantees (scope §4)

| Rule | Mechanism |
|---|---|
| Hard bounce → excluded | Sync classifies → suppression row → blocklist via API |
| Unsubscribe stays suppressed | Unsubscribes captured from `subscriber_lists` → suppression (global mode) → blocklist |
| Complaint → immediate suppression | listmonk complaint action + sync suppression |
| Soft bounces tracked | Classified and recorded; listmonk soft threshold blocklists |
| No duplicate records | listmonk's unique email index; import matches case-insensitively |
| Import cannot override suppression | Preview and commit both check suppressions and blocklist status; new rows only via listmonk importer with `overwrite=false`; existing contacts only get **new** list rows |
| "Add to list" cannot resubscribe | listmonk's add action overwrites `unsubscribed`, so MailHarbor only adds lists with no existing row; "remove" never deletes `unsubscribed` rows |
| Re-enable in listmonk is undone | Every cycle, any suppressed or held contact that is not blocklisted is blocklisted again, and an alert is raised |
| Reactivation is authorised | Admin role + reason + new consent basis; audited; runs under the sync lock to avoid races |
| All status changes logged | `portal.recipient_events` + `portal.audit_log` |
| Survives restart / re-import | State lives in PostgreSQL; checks run on every import |

## Sync worker cycle

```
every SYNC_INTERVAL_SECONDS (advisory lock 74219032):
  1. bounces       id > cursor  → classify → suppress | hold for review | record soft
  2. unsubscribes  updated_at > cursor, not already suppressed/held → event + consent withdrawn (+ suppression if global)
  3. blocklisted in listmonk without suppression or hold → suppression (reason from bounce history)
  4. suppressed or held but not blocklisted → blocklist via API (+ alert if re-enabled outside the portal)
  5. health: listmonk /api/health, scan /api/logs for bounce-mailbox and SMTP errors, settings check every ~10 cycles
  6. housekeeping (hourly): purge staged import rows older than 30 days
  heartbeat → portal.sync_state
```

## Import pipeline

```
upload (multer, memory, size-limited) → parse (csv-parse: BOM, delimiter detection) → stage rows (portal.import_rows)
preview → map columns → validate syntax → in-file duplicates → suppression (hash) → existing match → consent required
commit (background) → re-check suppression → new rows: listmonk bulk importer (overwrite=false)
                   → existing rows: add only lists never joined → consent records + events → summary
```

Staged rows hold personal data and are purged after 30 days. Imports interrupted by a restart are marked failed.
Re-running is safe because already-created rows are then classified as existing.

## Data model (`portal` schema)

| Table | Purpose |
|---|---|
| `users`, `sessions` | Portal operators and server-side sessions |
| `suppressions` | Permanent register; `email_hash` (SHA-256 of the lower-cased address) is unique while active; `email` is cleared on erasure |
| `recipient_events` | Status and activity history (scope `recipient_events`) |
| `bounce_events` | Classified copy of each listmonk bounce: code, reason, action taken (scope `bounce_events`) |
| `consent_records` | Consent granted, withdrawn or reconfirmed, with method, purpose, date and evidence (scope `consent_records`) |
| `imports`, `import_rows` | Import history and staged rows (scope `import_history`) |
| `review_queue` | Pending-review holds |
| `audit_log` | Administrative actions (scope `campaign_audit` + admin actions) |
| `alerts`, `sync_state` | Operational alerts, worker cursors and heartbeat |

Contact profile fields are stored on the listmonk subscriber: `name`, and `attribs.first_name`, `last_name`, `company`,
`source`, `consent{status,method,purpose,date,source}` and any custom attributes, which are usable in templates.

## Coupling to listmonk

The read model depends on these listmonk tables: `subscribers`, `subscriber_lists`, `lists`, `bounces`, `campaigns`,
`campaign_lists`, `campaign_views`, `link_clicks`, `links`. It was tested with **listmonk v6.2.0**. Before a major listmonk
upgrade, run `npm run test:integration` against a staging copy.
