# UI / UX / UAT audit

**Date:** 16 Nov 2026 · **Build:** branch `ccr-65691816-bwuwkk` · **Stack under test:** listmonk v6.2.0, PostgreSQL 16, Chromium (Playwright)

## 1. Method

| Pass | What was done |
|---|---|
| Role crawl | Signed in as **admin**, **manager** and **viewer**. Opened all 17 screens and recorded the navigation, every visible action and every failed API call. Any control a role can see but not use counts as a defect. |
| Accessibility | axe-core 4.14 (WCAG 2 A/AA + best practice) on every screen for every role, and on each modal while open. |
| Visual review | Desktop (1366 px) and phone (390 px) screenshots: layout, hierarchy, truncation, focus states. |
| Scripted UAT | End-to-end browser workflows per role: import, filter, select all matching, bulk list change, unsubscribe, export, keyboard use, read-only checks (§4). |
| Functional regression | 33 automated tests: 10 unit, 23 integration against real listmonk, run as the least-privilege database role. |

## 2. Findings and fixes

Severity: **High** means a function is broken or blocked, or the data or compliance outcome is wrong. **Medium** means
a role or allocation error, an accessibility failure, or a misleading UI. **Low** is polish.

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| F1 | Sign-in | **High** | A wrong password returned **HTTP 500** instead of "Incorrect email or password". The failed-login query had ambiguous parameter types. | Typed parameters; regression test added | Fixed, tested |
| F2 | Sign-in | **High** | Account lockout **never triggered**: the counter reset to 0 before the lock check. | Lock decided in code before the reset; test "10 failures lock the account" | Fixed, tested |
| F3 | Import | **High** | With no list selected, the preview said "ready to import" but listmonk refused the commit, so the import failed only after confirmation. | Preview requires at least one list and says so; field marked required | Fixed, tested in UAT |
| F4 | Alerts | Medium | False "re-enabled in listmonk" alert when an unsubscribe from listmonk's own page was suppressed and blocked in the same cycle. | Alert only when the suppression was already confirmed as blocked (`enforced_at`) | Fixed, tested |
| F5 | Role allocation | Medium | **Viewers** saw "New campaign in listmonk" and "Open in listmonk", but campaign writing belongs to managers and admins. | New `campaigns:compose` permission (manager, admin) gates those links | Fixed, verified by crawl |
| F6 | Role allocation | Medium | **Viewers** could read Import history but had no route to it (the Import menu item is for writers). | "Import history" menu item for roles without import rights | Fixed, verified |
| F7 | Env admin | Medium | New requirement: an administrator defined by environment variables. | `ADMIN_EMAIL` / `ADMIN_PASSWORD` enforced on every start; account badged *Environment-managed*; role, status and password locked in the UI and API, with an explanation | Done, tested |
| F8 | Accessibility | Medium | Contrast below 4.5:1 on menu section labels (3.0), teal buttons (4.0), table headers (4.3), "No lists" badge, danger text, pager label and `<code>` text. | Darker tokens; all now ≥ 4.5:1 | Fixed: **0 violations** |
| F9 | Accessibility | Medium | Modal form labels were not linked to their inputs, so screen readers did not announce field names. | Labels linked automatically to the following control on every render | Fixed |
| F10 | Accessibility | Medium | Dialogs had no accessible name. | `aria-labelledby` points at the modal title | Fixed |
| F11 | Accessibility | Medium | The whole app was an `aria-live` region, so every re-render would be read aloud. | Removed; toasts keep their own status/alert roles | Fixed |
| F12 | Navigation | Medium | "Skip to content" changed the URL hash, which the router treated as an unknown page. | Skip link moves focus without changing the hash | Fixed |
| F13 | Keyboard | Medium | Contact rows could only be opened with a mouse. Scrollable tables could not be reached by keyboard. | Email is a real link; scrollable tables are focusable and labelled | Fixed, tested in UAT |
| F14 | Bulk work | Medium | Bulk actions only covered the visible page, which is impractical for sorting large databases. | "Select all N matching contacts" (up to 5,000) and a rows-per-page selector (25–200) | Added, tested |
| F15 | Layout | Low | The top bar repeated each page's title. | Replaced by a global quick search (email, name or company) | Done |
| F16 | Mobile | Low | Menu drawer had no backdrop and could not be closed by tapping outside or pressing Esc. | Backdrop + Esc close | Fixed, tested |
| F17 | System health | Low | Open alerts were buried under resolved history. | Open alerts first; resolved ones collapsed | Fixed |
| F18 | System health | Low | No backup status (scope §8 "backup execution status"). | Backup card + alerts for failed or overdue backups | Added |
| F19 | Focus | Low | A dark outline framed the main area after every navigation (programmatic focus). | Outline removed for the programmatic focus target only | Fixed |
| F20 | Permission page | Low | "No permission" pages had no heading. | Page title as `<h1>` with a clear message | Fixed |
| F22 | Feedback | Medium | Error toasts appeared bottom-right **on top of the page's primary button** (found in UAT: after the "choose a list" error, "Check my data" could not be clicked until the toast closed). Messages also repeated themselves ("…to — lists: Choose at least one list"). | Toasts moved top-right under the top bar; repeated details removed; the import form highlights and focuses the missing field | Fixed, UAT re-run |
| F21 | Soft bounces | Low | Docs promised soft 3 → blocklist, but a fresh listmonk keeps "2 → none". | Recommended settings now set 3 → blocklist unless someone already chose a policy | Fixed, verified |

Railway-specific findings (setup, not UI):

| # | Finding | Fix |
|---|---|---|
| R1 | First deploy needed a locally run script to create the listmonk token. | Portal creates and renews its own least-privilege API user (token stored AES-GCM encrypted). |
| R2 | The Compose backup container has no equivalent on Railway. | `scripts/backup.js` (pg_dump → verify → S3-compatible upload → retention → heartbeat) as a Railway cron service. |
| R3 | listmonk needs to listen on Railway's `$PORT` and be configured from variables. | `deploy/railway/listmonk` image (tested against an empty database). |
| R4 | Railway can define empty variables. | Empty values are treated as unset. |
| R5 | The health check could fail while listmonk boots. | HTTP server starts first; listmonk connection retries in the background. |

## 3. Allocation matrix: scope requirement → screen → role

✔ = can do · 👁 = read only · – = hidden

| Scope § | Requirement | Where | Viewer | Manager | Admin |
|---|---|---|---|---|---|
| 3.1 | SMTP configuration, test, rate | listmonk → Settings (checked on **System health**) | – | 👁 health | 👁 health |
| 3.2 | Central recipient record (all fields) | **Contacts** list + **Contact** page | 👁 | ✔ | ✔ |
| 3.2 | Sort and filter recipients | **Contacts**: search, status/list/source/consent filters, sortable columns, quick search | ✔ | ✔ | ✔ |
| 3.3 | Recipient status model | Status badges everywhere; dashboard tiles; *Eligible to receive* filter | 👁 | 👁 | 👁 |
| 3.4 | CSV import with validation, dedupe, suppression, preview, report | **Import** (4-step wizard) + **Import history** | 👁 history | ✔ | ✔ |
| 3.5 | Campaign creation, templates, test, schedule, pause | listmonk (link in menu footer and campaign reports) | – | ✔ link | ✔ link |
| 3.6 | Bounce processing and classification | Automatic (sync); **Review queue** for 5.7.x; contact bounce table | 👁 | ✔ resolve | ✔ resolve |
| 3.7 | Unsubscribe and global suppression | listmonk links + **Contact → Unsubscribe**; **Suppression list** | 👁 | ✔ add | ✔ add / lift |
| 3.8 | Campaign reporting (all 9 metrics) | **Campaign reports** + campaign page | 👁 | 👁 + export | 👁 + export |
| 4 | Suppression rules, history | **Suppression list**, contact **History** timeline | 👁 | ✔ | ✔ |
| 4 | Reactivation only with authorisation and permission basis | **Suppression list → Lift…** | – | – | ✔ |
| 5 | Consent date, method, purpose, evidence | Add contact, import, **Record consent**, contact **Consent** card | 👁 | ✔ | ✔ |
| 5 | Export consent and unsubscribe history | **Exports** | – | ✔ | ✔ |
| 5 | Access request (s23) | **Contact → Data export** | – | ✔ | ✔ |
| 5 | Erasure / anonymisation | **Contact → Erase** | – | – | ✔ |
| 5 | Restrict access to personal information | Roles; exports manager+; audit | – | – | ✔ users |
| 7 | Admin authentication, RBAC, audit trail | Sign-in, **Users**, **Audit log**, env-managed admin | – | – | ✔ |
| 8 | Overview totals (all 9 items) | **Dashboard** | 👁 | 👁 | 👁 |
| 8 | Monitoring (SMTP, bounce mailbox, sync, availability, backups) | Dashboard alerts + **System health** | – | ✔ | ✔ |
| 10 | Acceptance tests | `docs/ACCEPTANCE_TESTS.md`, automated suite | – | – | – |

Each role's menu after the audit:
- **Viewer:** Dashboard · Contacts · Import history · Lists · Review queue · Suppression list · Campaign reports · Audience & bounces · Guides
- **Manager:** + Import · Exports · System health · *New campaign in listmonk*. Minus Import history (reached from Import).
- **Admin:** + Users · Audit log

## 4. Scripted UAT results

See §5 for the run log. Each step is an end-to-end browser workflow.

| ID | Role | Scenario | Result |
|---|---|---|---|
| M1 | Manager | Import 30 contacts with consent from file; no list chosen → clear message; then imported | **PASS** |
| M2 | Manager | Filter by source, "Select all 30 matching" across pages | **PASS** |
| M3 | Manager | Bulk add the selection to a double opt-in list | **PASS** |
| M4 | Manager | Open a contact from the list, Actions → Unsubscribe → status *Unsubscribed* | **PASS** |
| M5 | Manager | "Export view" downloads a CSV with every filtered row | **PASS** |
| M6 | Manager | No Users, Audit log, Lift or Erase controls | **PASS** |
| M7 | Manager | Keyboard: focus a contact link, Enter opens it | **PASS** |
| V1 | Viewer | Contacts visible; no add, export, selection or contact actions | **PASS** |
| V2 | Viewer | Import history reachable from the menu | **PASS** |

## 5. UAT run log

Final run, 16 Nov 2026: **9/9 PASS, no page errors.**

The first two runs failed at M1, and M2–M5, M7 and V1 then failed because they depend on M1's data. Those runs found
F3 (import with no list failed only at commit) and F22 (toast covering the retry button). Both were fixed before the final run.

```
PASS M1 import 30 contacts (no list → clear error; then imported)
PASS M2 filter by source and select all matching (beyond one page)
PASS M3 bulk add selection to a list
PASS M4 unsubscribe one contact from its page (status becomes Unsubscribed)
PASS M5 export current view downloads a CSV
PASS M6 manager cannot see Users / Audit / Lift / Erase
PASS M7 keyboard: Tab reaches a contact link and Enter opens it
PASS V1 viewer sees contacts but no write controls
PASS V2 viewer reaches Import history from the menu
PASS no page errors
```

Accessibility (axe-core, all roles, all screens and modals): **0 violations** after fixes, down from 9 distinct
contrast failures plus unlabelled dialogs, labels not linked to inputs and empty table headers.

## 6. Recommendations (not done: need a decision or external access)

1. **Run the go-live script** in `ACCEPTANCE_TESTS.md` on the real infrastructure: SMTP, POP3 bounce mailbox, DNS and
   Railway. Those parts could not be exercised from the build environment.
2. **Accessibility sign-off:** automated checks catch roughly a third of WCAG issues. A 30-minute screen-reader
   pass (NVDA or VoiceOver) through Import and Contact is worthwhile before go-live.
3. **listmonk UI:** campaign writers still use listmonk's own interface and logins. Single sign-on would mean modifying
   listmonk, which the scope rules out.
4. **Very large databases** (≫ 100k contacts): consider a materialised status table if contact search slows down.
