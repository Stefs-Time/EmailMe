# Acceptance tests (scope §10)

**Automated tests:** `portal/test/integration/acceptance.test.js` runs the real application against PostgreSQL 16 and a
local SMTP server (`test/helpers/smtpSink.js`). That server rejects addresses by prefix to simulate failures:

| Prefix | Rejection |
|---|---|
| `hard-` | 550 5.1.1 |
| `soft-` | 452 4.2.2 |
| `policy-` | 550 5.7.1 |

All 29 tests pass (17 Nov 2026).

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

Added for 0.9.0 (beyond the original scope):

| ID | Scenario | Expected | Status | Evidence / how to verify |
|---|---|---|---|---|
| TC17 | Email design | Every email uses the logo, colours, font and footer from Settings → Email design; sent campaigns keep the design they were sent with | **Automated ✔** | Delivered email has the logo, background, brand-coloured button and footer line; after changing the design, the sent campaign's "view in browser" is unchanged and a draft's preview uses the new design |
| TC18 | Upgrade from templates | Existing data keeps working after upgrading to 0.9 | **Automated ✔** / **Manual** (your data) | Started campaigns keep their template's HTML; the default template's look becomes the email design; old HTML drafts open in the builder as one HTML block; runs once |
| TC19 | Report drill-downs | Every number opens exactly the rows it counts | **Automated ✔** | Each campaign tile's count equals its detail list; link, bounce, event and message filters; search and paging; CSV only for managers/admins; invalid filters 422 |
| TC20 | Permission request | "Yes, you may contact me" records consent evidence once; suppressed people are never re-consented | **Automated ✔** | Consent record with campaign, time and IP; second click adds nothing; report and usage count it; segment on the consent method finds exactly those who said yes |
| TC21 | Reply collected | A reply to a campaign appears in the Inbox, linked to the contact and campaign | **Automated ✔** (ingestion) / **Manual** (your replies mailbox) | Threaded by In-Reply-To; quoted "unsubscribe" text does not trigger a request; same email twice stored once; delivery reports still become bounces |
| TC22 | Auto-reply and unsubscribe request | Out-of-office filed closed; "remove me" flagged; one click unsubscribes with the conversation as the reason | **Automated ✔** | Categories and states as described; contact unsubscribed; note added; conversation closed |
| TC23 | Answer a reply | The answer arrives threaded in the recipient's mail client; their next reply rejoins the conversation | **Automated ✔** (test server) / **Manual** (real mail client) | Subject "Re: …", In-Reply-To and References set, original quoted; viewers cannot answer (403) |
| TC24 | Roles across every screen | Each role sees only its screens; no errors | **Automated ✔** (role crawl, see UAT_AUDIT round 3) | Viewer, manager and admin over 36 screens: refused routes refused, no page or API errors, no axe violations |
| TC25 | Customer manages the mail server | The administrator sets their SMTP server in Settings → Sending; sending switches over; the password is never shown | **Automated ✔** (second test server) / **Manual** (your provider) | *Check connection* with wrong and right passwords; saved password encrypted and never returned; test email and a campaign go through the new server; clearing it returns to the default; internal addresses refused (SSRF unit test) |

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
- email design: invalid colours or logo addresses are refused (422); the preview uses unsaved values and stores
  nothing; campaigns use the sender from Settings unless they set their own; raw HTML sent to the API becomes one HTML
  block (scripts removed); the old templates API is gone (404);
- inbox: viewers can read but not answer; attachments download only (`application/octet-stream`); the original HTML is
  served sandboxed with remote images blocked; assignment to an unknown user is refused (409); erasing a contact
  deletes their conversations, and the data export includes them;
- samples and personalisation: every sample creates a valid builder campaign (subject and preview text included);
  unknown samples are rejected; web-address buttons in samples must be given a link before sending; imported columns
  are offered as personalisation fields;
- platform-managed links, through the real send path:
  - buttons going to "Stay subscribed" and "Manage preferences" need no URL;
  - the delivered email carries each recipient's own stay, preferences and unsubscribe links;
  - the stay page records nothing on GET and records on POST;
  - the preference centre unsubscribes from unticked lists only, cannot be used to re-subscribe, and "Unsubscribe from
    everything" suppresses;
  - the campaign report counts stayed subscribed, preference changes and unsubscribes;
  - the mail usage report returns daily volume, totals, recipient actions and campaigns;
- image library: a 2400px PNG photo is stored as a 1200px JPEG with no metadata; a broken file is rejected; served
  publicly with immutable caching and cross-origin loading; identical images are stored once; an image used by a
  campaign can't be deleted;
- UTM tagging: a delivered email's tracked click redirects to the URL with `utm_source/medium/campaign` (campaign
  slug); a campaign with tags switched off redirects to the plain URL; MailHarbor's own links are never tagged;
- saved segments:
  - rules on an imported column, status and dates match the right contact, and unknown fields or operators are
    rejected;
  - an SQL-injection string is treated as plain text, and the tables stay intact;
  - names are unique;
  - the contact filter works;
  - a campaign narrowed to the segment sends only to it and snapshots the segment name;
  - deletion is refused while a draft uses the segment;
- sign-up forms:
  - the page is embeddable;
  - missing token, honeypot or bot submissions get "thank you" and nothing is stored;
  - required fields and consent are enforced;
  - a real sign-up creates the contact, subscribes it to the single opt-in list, leaves the double opt-in list
    unconfirmed with one confirmation email, and records consent evidence;
  - an unsubscribed address gets the same reply and stays unsubscribed;
  - outcome totals are correct, and closed forms return 404.

**Integration tests** (`npm run test:integration`): 33 tests. **Lint** (`npm run lint`): clean.

**Unit tests** (`npm run test:unit`, 26 tests): configuration rules, mail-server address checks (SSRF), secret encryption, rendering and personalisation,
DSN/ARF/auto-reply parsing, bounce classification, SMTP error classification, and the builder renderer (defaults,
rejection of unsafe URLs, colours and block types, escaping, tag links, column stacking, image widths, click tracking) the email layout (logo, colours, font, escaped footer line, preferences link, invalid values never reach the HTML,
brand colours for headings, buttons and links, template-only blocks rejected), UTM tagging rules, segment rule validation and
compilation (bound parameters only), and image compression (resize, format choice, EXIF rotation, metadata stripping,
broken files).

**Not automated:**
- the IMAP layer against a real mailbox, for both the bounce and the replies mailbox (message processing is tested by
  feeding real RFC 822 emails through the same function the IMAP reader calls; the connection layer only for failure);
- delivery to real mailbox providers, and how real mail clients thread MailHarbor's answers.

Both are covered by the sign-off script below.

## Go-live sign-off script (≈ 60 minutes)

1. **System health:** all critical checks are green; the replies mailbox and Reply-To checks are green.
   **TC17:** Settings → Email design: add the logo and brand colour; the preview shows them.
2. **TC01 / TC25:** Settings → Sending → *Your mail server*: enter the provider's details, *Check connection*, save.
   *Send test email* arrives in your inbox. Check that it is not in spam and that SPF, DKIM
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
13. **TC21–TC23:** a staff member replies to the campaign from step 4 from their own mail client. Within the replies
    mailbox interval it appears in the **Inbox**, linked to the campaign. Answer it from the Inbox; the answer arrives in
    their mail client in the same thread. They reply "please remove me": the conversation shows **Unsubscribe
    request**; press **Unsubscribe** and confirm the contact shows *Unsubscribed*.
14. **TC19:** on the campaign report, click *Hard bounces* and *Unique clicks*: the lists show exactly the people from
    steps 5 and 9.

**Go-live acceptance:** steps 5, 7 and 8 together prove that an invalid recipient is suppressed automatically after a
hard bounce, cannot receive later campaigns, and stays suppressed across re-imports and restarts.
