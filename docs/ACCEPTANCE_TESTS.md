# Acceptance tests (scope §10)

**Automated tests:** `portal/test/integration/acceptance.test.js` runs the real application against PostgreSQL 16 and a
local SMTP server (`test/helpers/smtpSink.js`). That server rejects addresses by prefix to simulate failures:

| Prefix | Rejection |
|---|---|
| `hard-` | 550 5.1.1 |
| `soft-` | 452 4.2.2 |
| `policy-` | 550 5.7.1 |

All 23 tests pass (17 Nov 2026).

```bash
cd portal
TEST_DATABASE_URL=postgres://user:pw@localhost:5432/mailharbor_test npm run test:integration
```

| ID | Scenario | Expected | Status | Evidence / how to verify |
|---|---|---|---|---|
| TC01 | Configure SMTP | Successful connection | **Automated ✔** (test server) / **Manual** (your provider) | Settings → Sending → *Send test email*; System health → SMTP green |
| TC02 | Import CSV | Imported correctly | **Automated ✔** | Valid rows imported with attributes and consent; invalid, duplicate and no-consent rows excluded with reasons |
| TC03 | Import duplicate email | No duplicate record | **Automated ✔** | In-file duplicate (case-insensitive) excluded; re-importing an existing contact creates nothing new |
| TC04 | Send personalised campaign | Individual personalised messages | **Automated ✔** | Each recipient receives one message addressed only to them; `{{ first_name \| "…" }}` resolved per person; `List-Unsubscribe` + `List-Unsubscribe-Post` headers present |
| TC05 | Invalid address | Hard bounce → suppressed | **Automated ✔** (SMTP rejection, webhook) / **Manual** (bounce mailbox) | `hard-…` rejected 5.1.1 → *Hard bounced*, on the suppression list |
| TC06 | Temporary failure | Soft bounce recorded | **Automated ✔** | 4.2.2 retried; after the retries, counted as a soft bounce; contact stays eligible |
| TC07 | Repeated soft bounce | Policy applied | **Automated ✔** | At the soft-bounce limit the contact is suppressed (reason *soft limit*) |
| TC08 | Unsubscribe | Immediately suppressed | **Automated ✔** | One-click POST → suppressed at once, all lists unsubscribed (global mode), attributed to the campaign in its report |
| TC09 | Re-import unsubscribed | Remains suppressed | **Automated ✔** | Classified *Suppressed – excluded* |
| TC10 | Re-import hard bounce | Remains suppressed | **Automated ✔** | As TC09 |
| TC11 | Complaint | Suppressed | **Automated ✔** | Webhook complaint → *Complaint* status, suppressed; wrong webhook token → 401. ARF parsing covered by unit tests |
| TC12 | Campaign exclusion | Suppressed excluded | **Automated ✔** | The next campaign's recipients exclude every suppressed contact; a contact unsubscribed *during* a campaign is skipped at send time |
| TC13 | Campaign reporting | Correct statistics | **Automated ✔** | Report counts (recipients, sent, failed, hard/soft bounces, unsubscribes, opens, clicks) match the scenario exactly |
| TC14 | Bounce mailbox unavailable | Admin alert | **Automated ✔** | Unreachable IMAP server → critical *bounce mailbox* alert. Also: SMTP outage → campaign auto-paused, critical alert, nothing lost, resumes |
| TC15 | Application restart | Data/config retained | **Manual** | Restart the service; contacts, suppressions, settings, sessions and campaign progress are unchanged (all state is in PostgreSQL) |
| TC16 | Backup restoration | Restored | **Manual** | Restore last night's backup on staging (`deploy/backup/restore.sh`, or `pg_restore` on Railway) and spot-check contacts, suppressions and a campaign report |

Additional automated checks:
- first-run setup needs the log code;
- CSRF rejection;
- the viewer role is read-only;
- 10 failed logins lock the account;
- 5.7.1 → review hold, and releasing makes the contact eligible again;
- adding to a list never resubscribes an unsubscribed person;
- double opt-in: a GET does not confirm, a POST does;
- reactivation requires an admin, a reason and new consent;
- POPIA erasure keeps only a hash, and the erased address cannot be re-imported;
- open pixel and click redirect (stored URLs only);
- the bounce-mailbox password is encrypted at rest and never returned;
- exports and the campaign report download as CSV;
- the drag-and-drop builder: new campaigns start in the builder; unsafe designs are rejected (422) and rich text is
  cleaned before it is stored; a button without a link is flagged; the delivered email contains the rendered columns,
  personalisation and a click-tracked button; duplicating keeps the design;
- the template builder: the built-in template is a builder design; templates without exactly one Campaign content
  block are rejected; a designed template (logo, page colour, width, footer) wraps a delivered campaign, with exactly
  one unsubscribe link (the footer's);
- samples and personalisation: every sample creates a valid builder campaign (subject and preview text included);
  unknown samples are rejected; sample buttons must be given a link before sending; imported columns are offered as
  personalisation fields.

**Unit tests** (`npm run test:unit`, 21 tests): configuration rules, secret encryption, rendering and personalisation,
DSN/ARF/auto-reply parsing, bounce classification, SMTP error classification, and the builder renderer (defaults,
rejection of unsafe URLs, colours and block types, escaping, tag links, column stacking, image widths, click tracking) and the template renderer (complete document, doctype kept,
a single content slot, footer links, rules on template-only blocks).

**Not automated:**
- the IMAP layer against a real mailbox (the parser is tested; the connection layer only for failure);
- delivery to real mailbox providers.

Both are covered by the sign-off script below.

## Go-live sign-off script (≈ 45 minutes)

1. **System health:** all critical checks are green.
2. **TC01:** Settings → Sending → *Send test email* arrives in your inbox. Check that it is not in spam and that SPF, DKIM
   and DMARC show *pass* in the message headers.
3. Create the list "UAT". Import a CSV of 3 staff addresses plus 1 `nonexistent-<random>@<your-domain>`.
4. **TC04:** send a personalised campaign to "UAT". Each recipient gets one personalised email, and the unsubscribe link
   works.
5. **TC05:** within ~10 minutes (the bounce-mailbox interval), the bad address shows *Hard bounced* and is on the
   suppression list.
6. **TC08:** one staff member clicks *Unsubscribe*, or uses the Gmail/Outlook unsubscribe button, and shows
   *Unsubscribed* immediately.
7. **TC09/TC10:** re-import the same CSV. The preview shows those 2 as *Suppressed – excluded*.
8. **TC12:** create a second campaign to "UAT". *Will receive* shows 2, and only those 2 receive it.
9. **TC13:** the first campaign's report shows sent 4, hard bounce 1, unsubscribes 1, and the opens/clicks you made.
10. **TC14:** enter a wrong bounce-mailbox password and click *Check now*. A critical alert appears. Restore the password,
    click *Check now* again, and the alert clears.
11. **TC15:** restart the service (Railway → Restart, or `docker compose restart portal`). Confirm nothing changed.
12. **TC16:** restore last night's backup on a staging environment.

**Go-live acceptance:** steps 5, 7 and 8 together prove that an invalid recipient is suppressed automatically after a
hard bounce, cannot receive later campaigns, and stays suppressed across re-imports and restarts.
