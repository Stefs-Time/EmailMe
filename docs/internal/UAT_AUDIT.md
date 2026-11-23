# UI / UX / UAT audit

**Latest run:** 23 Nov 2026 · **Build:** 0.9.0 (soft release), branch `ccr-65691816-bwuwkk`
**Stack under test:** PostgreSQL 16, local SMTP test server, Chromium (Playwright), axe-core 4.x (WCAG 2 A/AA)

There have been three rounds:
- **Round 3 (current, 0.9.0):** after templates were replaced by Settings → Email design, the campaign editor was
  simplified, every report number became clickable, and the Inbox for replies was added. Full role crawl of every
  screen, plus the findings fixed while building those features.
- **Round 2:** after MailHarbor was rebuilt with its own campaign, sending, tracking and bounce engine.
- **Round 1:** the earlier listmonk-based build. Findings that only concerned listmonk no longer apply.

## 1. Method

| Pass | What was done |
|---|---|
| Browser walkthrough | Fresh database → first-run setup with the log code → settings (address, SMTP test, bounce tab) → list + contact → campaign editor (subject, preheader, personalisation tag, button, autosave, readiness) → test send → send now → report → templates → system health |
| Role crawl | Signed in as **viewer** and **manager**, opened all 21 routes (including deep links to admin-only and edit screens), recorded the menu, every visible action, failed API calls and page errors |
| Accessibility | axe-core (WCAG 2 A/AA) on every screen in the walkthrough and the role crawl |
| Functional regression | 26 unit tests + 33 end-to-end acceptance tests against PostgreSQL and the SMTP test server ([ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md)); ESLint clean |
| Round 3 role crawl | Viewer, manager and admin each opened **36 screens** (every menu item, every Settings tab, report details, a conversation, a draft editor, segment and form editors); refused routes checked; page errors, API errors and axe recorded |
| Round 3 walkthroughs | Email design (live preview, brand colour in builder and email), simplified campaign editor, campaign report tiles each matching their detail list, mail usage and audience drill-downs, Inbox (read, original formatting, attachment, reply, note, assign, close, unsubscribe request) on desktop and iPhone 13 |

## 2. Round 3 findings and fixes (0.9.0)

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| R3-1 | Inbox | **High** | Emails from people that reached the bounce mailbox were moved to "processed" and silently discarded. | The mailbox reader puts every non-bounce email in the Inbox | Fixed, tested |
| R3-2 | Rate limiting | **High** | The recipient pages' limiter (300/min) counted every staff API request, because its router is mounted at the root; a busy team could be throttled. | Limited to the recipient pages and the webhook | Fixed, regression covered by the suite |
| R3-3 | Settings | Medium | Saving an invalid setting returned HTTP 500 instead of a validation error naming the field. | Settings use the shared validator (422 with field details) | Fixed, tested |
| R3-4 | Dashboard / Suppression | Medium | "Recent bounce activity" rows linked to `#/contacts/undefined`, and the suppression list never showed its "view contact" links (both read a field the API doesn't return). | Use `contact_id` | Fixed, re-tested |
| R3-5 | POPIA | Medium | The erase screen's reason was validated and then dropped, so the audit log didn't record why a contact was erased. | Reason stored with the audit entry | Fixed |
| R3-6 | Inbox | Medium | A list view filter bound a parameter it didn't use, so the Inbox list failed (500). | Lazy view filters | Fixed, tested |
| R3-7 | Inbox | Low | Remote images in a reply were blocked by the CSP but still attempted (console errors, tracking pixels requested). | Removed from the HTML unless the reader loads images | Fixed |
| R3-8 | Accessibility | Low | The unread dot used `aria-label` without a role. | Hidden text for screen readers | Fixed: 0 violations |
| R3-9 | Inbox | Low | Message order followed the sender's `Date` header (whole seconds, sender clocks). | Ordered by arrival | Fixed, tested |
| R3-10 | Reports | Low | Mail usage tiles and the audience "Suppressed" column didn't match the lists they could open (approximate status groups). | Counts use the same filters as the lists they open | Fixed, tested |
| R3-11 | Code | Low | Dead code from the removed template builder and editors; unused imports; a duplicate object key. | Removed; ESLint added (dev only) and clean | Done |

## 3. Round 2 findings and fixes

Severity:
- **High:** a function is broken, or the data or compliance outcome is wrong.
- **Medium:** a role or allocation error, an accessibility failure, or a misleading UI.
- **Low:** polish.

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| N1 | Settings | **High** | Saving one tab reset the other tabs' settings to defaults (a schema library filled defaults for omitted keys on partial updates). | Only keys actually sent are written | Fixed, tested |
| N2 | Bounces | **High** | A delivery-status notification reporting *successful* delivery was treated as a bounce by the fallback heuristic. | DSNs where every recipient was delivered are ignored | Fixed, unit test |
| N3 | Navigation | **High** | Clicking quickly between pages could show the previous page's content under the new URL (a slow module load overwrote the newer page). | Navigation counter; stale renders are discarded; each page renders into a fresh container | Fixed, re-tested |
| N4 | Templates | **High** | Template *Preview* failed: a form POST into a new tab had no CSRF token. | Draft sent with fetch (CSRF), then shown from a one-time sandboxed GET | Fixed, re-tested |
| N5 | Editor | Medium | Some elements used inline `style=` attributes, which the strict CSP blocks, so alignment and spacing did not apply. | Replaced with classes; email output is inlined server-side | Fixed |
| N6 | Settings | Medium | Bounce-mailbox fields (port 993, folder INBOX, interval) showed empty on a new installation. | Defaults parsed explicitly | Fixed, verified in UI |
| N7 | Hosting | Medium | On Railway the detected domain **locked** the Public web address, so a custom domain could only be set through a variable. | The detected domain is now a fallback; `PUBLIC_URL` alone locks the field; the help text explains which applies | Fixed, unit test |
| N8 | Accessibility | Medium | The editor's Visual/HTML/Plain-text switch used tab roles without tab panels. | A labelled button group with `aria-pressed` | Fixed: 0 violations |
| N9 | Accessibility | Medium | The red outline *Delete* button was below 4.5:1 contrast. | Neutral outline button; the confirmation dialog carries the danger colour | Fixed |
| N10 | Feedback | Medium | Toasts appeared over the top-right primary actions (Send, Save) on campaign and template screens. | Toasts moved bottom-left | Fixed, re-tested |
| N11 | Setup | Low | After first-run setup the sidebar showed the default organisation name until the page was reloaded. | Session reloaded after setup | Fixed, verified |
| N12 | Testing | Low | Scope TC14 (bounce mailbox unavailable → alert) was only a manual check. | Automated test against an unreachable IMAP server; also checks the password is encrypted at rest and never returned | Added, passing |
| N13 | Deployment | **High** (docs) | Railway allows outbound SMTP only on the Pro plan and above. A Hobby deployment would start but could never send. | Stated prominently in README and DEPLOY_RAILWAY; System health shows an SMTP timeout with that hint | Documented |

### Drag-and-drop builder (added 17 Nov 2026)

How it was tested:
- **Browser walkthrough with the real CSP enforced, 15 steps:**
  - a new campaign opens in the builder;
  - a real mouse drag from the palette;
  - editing the heading in place, with a personalisation tag and alignment;
  - bold text;
  - the button link and colour, with the contrast warning;
  - Two columns, with blocks dropped into each column;
  - reordering by the drag handle;
  - delete, then undo;
  - autosave and the server render;
  - the preview;
  - the keyboard/touch "press to add" path;
  - a test send;
  - converting to HTML and back;
  - phone width.
- **Phone check:** iPhone 13 emulation with tap-to-add.
- **Accessibility:** axe scan of the builder with a block selected.

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| B1 | Security | **High** | (Design review) The stored design kept rich text exactly as submitted; only the rendered email was cleaned. Another user's editor would then load raw HTML into the page (stored XSS). | The server cleans text and HTML blocks before storing the design; unit + integration tests | Fixed, tested |
| B2 | Canvas | Medium | Each block's wrapper had the class `bb-<type>`, which collided with the inner element styles. The button row was padded and centred like a button. | Wrapper class renamed `bb-type-<type>` | Fixed, verified by screenshot |
| B3 | Canvas | Medium | The button's colour was also painted as the background of its whole row. | Row background (`bg_row`) kept separate from the button colour | Fixed, verified |
| B4 | Drag and drop | Medium | Dropping at the very top edge was ignored: the marker's margin collapsed outside the list. | The drop uses the marker's position; the whole canvas area accepts drops | Fixed, tested |
| B5 | Drag and drop | Medium | Drag targets far down a long email needed scrolling while dragging. | Palette and settings panel stay pinned on screen (desktop) | Fixed |
| B6 | CSP | Medium | Builder HTML (inline styles) was loaded into the hidden Visual editor, causing CSP violations. Converting a design to Visual displayed it wrongly. | Builder content is never loaded there; converting lands in the HTML editor | Fixed: 0 console errors |
| B7 | Accessibility | Low | A user-chosen button colour (white on teal) fell below 4.5:1 contrast. | Live contrast warning for button, heading and text colours | Added |
| B8 | Touch | Low | HTML5 drag and drop does not work on phones, and Firefox can't drag a `<button>`. | Tiles are focusable elements; tap or Enter adds below the selected block | Added, tested (phone emulation) |

Result: 15/15 pass, 0 console errors with the CSP enforced, axe 0 violations, no horizontal scroll at 390px.

### Image library, sign-up forms, saved segments, UTM tagging (added 17 Nov 2026)

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| I1 | Security | **High** | The first image library version (sharp 0.34) failed `npm audit`: high-severity CVEs in its bundled libvips, libheif and librsvg. | Upgraded to sharp 0.35.5; audit reports 0 vulnerabilities | Fixed |
| I2 | Images | Medium | The public `/img/<id>` route also caught the app's own `/img/logo.svg`, so the sidebar logo broke. | Non-library paths fall through to static files | Fixed, verified |
| I3 | Tracking | Medium | (Found while building I1) The open pixel was served with `Cross-Origin-Resource-Policy: same-origin`, so webmail running in a browser on another origin would refuse to load it and under-count opens. | Pixel and library images are sent `cross-origin` | Fixed |
| S1 | Segments | **High** | A unit test found that date conditions bound unused parameters, which PostgreSQL rejects: every segment with a date rule would have failed. | Only the chosen operator is compiled; all 16 field/operator pairs verified against PostgreSQL | Fixed, tested |
| T1 | Feedback | Medium | The "Settings saved" toast covered the Save button on long pages (bottom-left). | Toasts moved bottom-right | Fixed; all browser suites re-run |

The browser test passed all 8 steps:
- an upload is compressed and listed;
- the builder picks an image from the library;
- the segment rule builder shows a live preview and saves;
- contacts can be filtered by the segment;
- a campaign can be narrowed to the segment, with its UTM controls;
- the UTM settings save;
- a sign-up form can be created, shared and previewed;
- a visitor signs up on a phone and appears under recent sign-ups.

axe found no violations on the image, segment, form and public form pages. All previous browser suites still pass.

### Ready-made templates (added 17 Nov 2026, from UAT feedback)

| # | Area | Sev. | Request | Change | Status |
|---|---|---|---|---|---|
| R1 | Templates | Medium | Templates to match the campaign samples (clean, promotion, new release). | Clean, Promotion and New release builder templates are installed once (a deleted preset is not re-added). Campaign samples use the matching template, and the gallery shows which. *New template* opens a gallery of all four designs. List badge "Ready-made" | Done, tested |

Browser test (7 steps):
- the 3 ready-made templates are listed;
- a server preview of each;
- the gallery offers 4 designs;
- Promotion saves as "my copy";
- the campaign gallery shows "Uses the Promotion template", and the campaign gets it;
- the preview shows the banner;
- axe: 0 violations.

The previous builder, template and sample suites still pass.

### Platform-managed recipient links and mail usage (added 17 Nov 2026, from UAT feedback)

Feedback: "Unsubscribe etc should be managed in the platform. If those buttons are used it should auto-create the link."

| # | Area | Sev. | Finding / request | Change | Status |
|---|---|---|---|---|---|
| L1 | Builder | Medium | Buttons for unsubscribe, "keep me subscribed" and so on needed a typed URL, and there was no built-in page for them. | Buttons and text links choose a destination: web address, Unsubscribe, Manage preferences, Stay subscribed or View in browser. MailHarbor creates each recipient's link at send time, and the checklist only asks for a URL for web-address buttons | Done, tested |
| L2 | Compliance | Medium | No way for recipients to opt out of individual lists. | Preference centre (`/p/…`): untick lists or unsubscribe from everything. It can only opt out (a forged form can't re-subscribe); the template footer links to it (switchable) | Done, tested |
| L3 | Re-engagement | Medium | "Are you still interested?" had nowhere to send people. | Stay-subscribed page (`/s/stay/…`): the GET shows a page, the POST records it; it never re-activates suppressed addresses. Counted per campaign; the sample uses it by default | Done, tested |
| U1 | Reports | Medium | No view of overall sending volume through the SMTP server. | Mail usage page: today, month, last hour against the hourly limit, queue, daily volume by kind, SMTP rejections, recipient actions, campaigns sent | Done, tested |

Browser test (8 steps):
- a button set to "Unsubscribe page" needs no URL;
- a text link to "Manage preferences";
- links in a test send;
- a real send;
- the preference and stay pages on a phone (axe: 0 violations);
- the Mail usage page (axe: 0 violations);
- the "Are you still interested?" sample is ready to send without a link.

### Personalisation chips and sample designs (added 17 Nov 2026, from UAT feedback)

| # | Area | Sev. | Finding / request | Change | Status |
|---|---|---|---|---|---|
| P1 | Personalisation | Medium | Tags had to be typed or picked from a dropdown in the settings panel. | One-click field chips (First name, Full name, Last name, Company, Email, Your organisation, plus imported columns such as City). They insert at the cursor in the subject, preview text, any heading/text/button, and the Visual/HTML/Plain-text editors | Done, tested |
| P2 | Personalisation | Low | A tag inserted against a word ran into it ("{{ first_name }}Find"). | A space is kept on either side when needed | Fixed, tested |
| S1 | Campaigns | Medium | No starting points beyond a blank message. | Gallery of 8 sample designs on *New campaign* and via *Samples* in the editor (undoable); buttons start without a link so the checklist prompts for one | Done, tested |

Browser tests passed:
- **Personalisation chips:** 7 steps:
  - custom column chip;
  - subject;
  - heading at the caret;
  - text block mid-sentence;
  - preview shows real names;
  - fallback to the selected block, and the hint when nothing is chosen;
  - HTML editor;
  - template header.
- **Samples:** 7 steps:
  - the gallery shows 8 designs;
  - create from "Are you still interested?";
  - the preview is personalised;
  - replace the design, then undo;
  - the sidebar entry opens the gallery;
  - every sample passes server validation;
  - axe on the gallery.

There were no console errors, and axe found no violations.

### Template builder (added 17 Nov 2026, from UAT feedback: "no drag and drop on the New template page")

| # | Area | Sev. | Finding | Fix | Status |
|---|---|---|---|---|---|
| T1 | Templates | Medium | Templates could only be edited as raw HTML, unlike campaigns. | Template mode of the builder: Campaign content and Footer blocks, page settings (colours, width, font, corners, padding), live preview, Builder/HTML switch; the built-in template is now a builder design | Done, tested |
| T2 | Builder | Medium | Clicking empty space beside the email did not deselect the block, so template Page settings were unreachable. | The whole canvas area deselects | Fixed, tested |
| T3 | Email output | Low | The sanitiser dropped `<!doctype html>`, so some clients render in quirks mode. | The doctype is kept when the source had one | Fixed, unit test |

The browser test passed all 10 steps:
- a new template opens in the builder;
- dragging a logo above the header;
- page colour, width and font;
- the content block cannot be deleted or added twice;
- editing the footer and saving;
- the server stored the design and rendered the HTML;
- the preview shows the frame;
- a campaign using the template is wrapped by it;
- the list shows a Builder badge;
- axe found no violations with page settings, the footer or the content block selected.

There were no console errors with the CSP enforced.

## 4. Allocation matrix: scope requirement → screen → role

✔ = can do · 👁 = read only · – = hidden (direct link shows "no permission")

| Scope § | Requirement | Where | Viewer | Manager | Admin |
|---|---|---|---|---|---|
| 3.1 | SMTP configuration, test, rate | Variables (host/credentials) + **Settings → Sending** (test, rate, hourly cap) + **System health** | – | 👁 health | ✔ |
| 3.2 | Central recipient record | **Contacts** + **Contact** page (details, lists, consent, emails sent, bounces, history) | 👁 | ✔ | ✔ |
| 3.2 | Sort and filter recipients | **Contacts**: search, status/list/source/consent filters, sortable columns, quick search | ✔ | ✔ | ✔ |
| 3.3 | Recipient status model | Status badges; dashboard tiles; *Eligible to receive* filter | 👁 | 👁 | 👁 |
| 3.4 | CSV import: validation, dedupe, suppression, preview, report | **Import** wizard + **Import history** | 👁 history | ✔ | ✔ |
| 3.5 | Campaigns: create, personalise, test, schedule, pause/resume/cancel | **Campaigns**: Audience → Email → Review & send, drag-and-drop builder | 👁 | ✔ | ✔ |
| 3.5 | Email look (logo, colours, footer) | **Settings → Email design** | – | – | ✔ |
| – | Replies to campaigns | **Inbox** (read, answer, notes, assign, unsubscribe requests); **Settings → Replies** | 👁 | ✔ | ✔ + configure |
| 3.6 | Bounce processing and classification | Automatic (SMTP, IMAP mailbox, webhook); **Settings → Bounces**; **Review queue**; contact bounce table | 👁 | ✔ resolve | ✔ + configure |
| 3.7 | Unsubscribe and global suppression | Link + one-click header in every email; **Contact → Unsubscribe**; **Suppression list**; Settings → Compliance | 👁 | ✔ add | ✔ add / lift / configure |
| 3.8 | Campaign reporting | Campaign page (metrics, top links, timeline, failures), every number clickable to its recipients (**Details**) + CSV | 👁 | 👁 + export | 👁 + export |
| 4 | Suppression rules, history | **Suppression list**, contact **History** | 👁 | ✔ | ✔ |
| 4 | Reactivation only with authorisation and permission basis | **Suppression list → Lift** | – | – | ✔ |
| 5 | Consent date, method, purpose, evidence | Add contact, import, **Record consent**, contact **Consent** card | 👁 | ✔ | ✔ |
| 5 | Double opt-in | List setting; confirmation email and confirm page | 👁 | ✔ | ✔ |
| 5 | Export consent and unsubscribe history | **Exports** | – | ✔ | ✔ |
| 5 | Access request (s23) | **Contact → Data export** | – | ✔ | ✔ |
| 5 | Erasure / anonymisation | **Contact → Erase** | – | – | ✔ |
| 7 | Admin authentication, RBAC, audit trail | Setup code, sign-in, **Users**, **Audit log**, environment-managed admin | – | – | ✔ |
| 8 | Overview totals | **Dashboard** | 👁 | 👁 | 👁 |
| 8 | Monitoring (SMTP, bounce mailbox, worker, queue, DNS, backups) | Dashboard alerts + **System health** | – | ✔ | ✔ |
| 10 | Acceptance tests | `docs/ACCEPTANCE_TESTS.md`, automated suite | – | – | – |

Menus observed in the role crawl:
- **Viewer:** Dashboard · Contacts · Import history · Lists · Segments · Sign-up forms · Review queue · Suppression list · Inbox · Campaigns · Images · Audience & bounces · Mail usage · Guides · Product overview
- **Manager:** as the viewer, with Import instead of Import history, plus Exports · System health
- **Admin:** everything a manager has, plus Settings · Users · Audit log

## 5. Run log

### 23 Nov 2026 (0.9.0)

Role crawl, 36 screens per role:

| Role | Refused as expected | Page errors | API errors | axe violations |
|---|---|---|---|---|
| Viewer | Import, campaign editor, segment editor, Exports, System health, all 6 Settings tabs, Users, Audit log | 0 | 0 | 0 |
| Manager | All 6 Settings tabs, Users, Audit log | 0 | 0 | 0 |
| Admin | – | 0 | 0 | 0 |

Walkthroughs: Email design and simplified editor 25/25 checks; Inbox 25/25 checks (desktop and iPhone 13, no
horizontal scroll); report drill-downs (10 campaign tiles each equal to their detail lists). Unit 26/26, integration
33/33, `npm audit` 0 vulnerabilities, ESLint clean. Settings → Sending (customer mail server) 9/9 checks; role crawl
re-run after it: unchanged (no refusal, page, API or axe failures).

### 17 Nov 2026 (round 2)

Browser walkthrough on a fresh database:

```
PASS setup screen                       (setup code from server log; first admin created)
PASS settings: address + SMTP test      (test email delivered to the SMTP test server)
PASS list + contact
PASS campaign editor                    (personalisation tag, button, autosave, "Ready to send")
PASS test send + send now               (report shows the send)
PASS campaign list + templates + system
ERRORS: none            axe: 0 violations on every screen
```

Role crawl (viewer, manager × 21 routes):
- **Viewer:** no write controls on any screen; the admin-only and edit routes show the permission page; 0 API errors, 0 page errors, 0 axe violations.
- **Manager:** campaign, template, import, list, contact, suppression and export actions present. Settings, Users, Audit and Lift are absent. 0 API errors, 0 page errors, 0 axe violations.

Acceptance suite: 29/29 pass. Unit tests: 25/25 pass.

## 6. Round 1 (listmonk-based build): findings still relevant

These fixes live in code the current build kept:

| # | Finding | Fix |
|---|---|---|
| F1 | A wrong password returned HTTP 500 | Typed query parameters; regression test |
| F2 | Account lockout never triggered | Lock decided before the counter reset; test "10 failures lock" |
| F3 | An import with no list failed only at commit | Preview requires a list |
| F8–F13 | Contrast, unlabelled modal fields, unnamed dialogs, app-wide live region, skip link, keyboard access to contact rows | Fixed; carried forward |
| F14 | Bulk actions only covered the visible page | "Select all N matching" (up to 5,000) and page-size selector |
| F16 | Mobile menu could not be closed by tapping outside or pressing Esc | Backdrop + Esc |
| F18 | No backup status | Backup card and alerts |

Obsolete with the rebuild (listmonk-specific): F4, F5, F21 and R1–R5 (listmonk sync alerts, listmonk links, listmonk
bounce-action defaults, listmonk API user, listmonk Railway image).

## 7. Recommendations (not done: need a decision or external access)

1. **Run the go-live script** in [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) on the real infrastructure: your SMTP
   provider, the IMAP bounce and replies mailboxes, DNS and Railway (Pro). None of these could be reached from the
   build environment. Steps 13–14 cover the Inbox and drill-downs.
2. **Warm up the sending domain:** start at 2–5 emails per second and small campaigns, and watch bounces and
   complaints in Reports.
3. **Accessibility sign-off:** automated checks catch roughly a third of WCAG issues. A 30-minute screen-reader
   pass (NVDA or VoiceOver) through Import, Contact and the campaign editor is worthwhile before go-live.
4. **Phone-width check of the campaign editor:** it works on narrow screens but is designed for desktop use. Confirm
   that this matches how staff will work.
5. **Very large databases** (≫ 100k contacts): measure contact search and report times. Consider a materialised
   status table only if they slow down.
