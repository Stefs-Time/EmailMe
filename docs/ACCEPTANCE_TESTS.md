# Acceptance tests (scope §10)

Automated tests: `portal/test/integration/acceptance.test.js`, run against listmonk **v6.2.0** and PostgreSQL 16 on
16 Nov 2026. All 19 pass, both with the database owner role and with the least-privilege `mailharbor` role.

| ID | Scenario | Expected | Status | Evidence / how to verify |
|---|---|---|---|---|
| TC01 | Configure SMTP | Successful connection | **Manual** | listmonk → Settings → SMTP → *Test connection*; System health shows "Outgoing SMTP server configured" |
| TC02 | Import CSV | Imported correctly | **Automated ✔** | 6 valid rows imported with attributes and consent; invalid, duplicate and no-consent rows excluded |
| TC03 | Import duplicate email | No duplicate record | **Automated ✔** | In-file duplicate (case-insensitive) excluded; re-import of an existing contact creates nothing |
| TC04 | Send personalised campaign | Individual personalised messages | **Manual** | Create a campaign with `{{ .Subscriber.FirstName }}` to a 2–3 person test list; confirm each person receives their own message and no other recipients are visible |
| TC05 | Invalid address | Hard bounce → suppressed | **Automated ✔** (via bounce API) / **Manual** (via mailbox) | Live: send to `nonexistent-<random>@<your-domain>`; within the POP scan interval plus 1 min the contact shows *Hard bounced* |
| TC06 | Temporary failure | Soft bounce recorded | **Automated ✔** | 4.2.2 recorded; contact stays eligible |
| TC07 | Repeated soft bounce | Policy applied | **Configured** | listmonk soft action (recommended 3 → blocklist) applied by setup; MailHarbor then records the suppression |
| TC08 | Unsubscribe | Immediately suppressed | **Automated ✔** | Portal unsubscribe and listmonk list-unsubscribe both become global suppressions |
| TC09 | Re-import unsubscribed | Remains suppressed | **Automated ✔** | Classified *Suppressed – excluded*; still blocklisted |
| TC10 | Re-import hard bounce | Remains suppressed | **Automated ✔** | As TC09 |
| TC11 | Complaint | Blocklisted | **Automated ✔** | Complaint → *Complaint* status, blocklisted |
| TC12 | Campaign exclusion | Suppressed excluded | **Automated ✔** (state) / **Manual** (send) | All suppressed contacts are blocklisted in listmonk, which listmonk excludes from sends; re-enabling in listmonk is reverted within one sync cycle. Live: target a list containing a suppressed contact and check the campaign's *to send* count |
| TC13 | Campaign reporting | Correct statistics | **Automated ✔** (API) / **Manual** (numbers) | After TC04/TC05, compare MailHarbor's campaign report with listmonk's analytics |
| TC14 | Bounce mailbox unavailable | Admin alert | **Automated ✔** (listmonk down) / **Manual** (mailbox) | Live: set a wrong bounce-mailbox password; within one scan interval a critical *Bounce mailbox error* alert appears |
| TC15 | Application restart | Data/config retained | **Manual** | `docker compose restart`; contacts, suppressions, settings and sessions are unchanged |
| TC16 | Backup restoration | Restored | **Verified at DB level** / **Manual** | `pg_dump` → `pg_restore` into a fresh database reproduced all data; on the server, run `deploy/backup/restore.sh` on a staging host |

Additional automated checks: CSRF rejection, viewer read-only access, 5.7.1 → review hold → release with list
restoration, list add never resubscribes an unsubscribed person, manual add of a suppressed address refused,
reactivation requires reason and consent evidence, POPIA erasure keeps only a hash, exports filter correctly.

## Go-live sign-off script (≈ 45 minutes)

1. System health: all critical checks green. Note the listmonk version.
2. TC01: SMTP test connection succeeds.
3. Create list "UAT", import a CSV of 3 staff addresses plus 1 `nonexistent-<random>@<domain>`.
4. TC04: send a personalised campaign to "UAT". Each recipient gets one personalised email with a working unsubscribe link.
5. TC05: within ~20 minutes the bad address shows *Hard bounced* and appears on the suppression list.
6. TC08: one staff member clicks *Unsubscribe* (or uses the Gmail/Outlook unsubscribe button) and shows *Unsubscribed* within 1 minute.
7. TC09/TC10: re-import the same CSV. The preview shows those 2 as *Suppressed – excluded*.
8. TC12: send a second campaign to "UAT". Only the 2 remaining staff receive it.
9. TC13: campaign report shows sent 4, hard bounce 1, unsubscribes 1.
10. TC14: break the bounce mailbox password → critical alert; restore it → alert clears within an hour or dismiss it.
11. TC15: `docker compose restart` and confirm nothing changed.
12. TC16: restore last night's backup on a staging server.

**Go-live acceptance:** steps 5, 7 and 8 together prove that an invalid recipient is suppressed automatically after a
hard bounce, cannot receive later campaigns, and stays suppressed across re-imports and restarts.
