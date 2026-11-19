# MailHarbor administrator guide

This guide is for the administrators of your organisation's MailHarbor. It covers settings, users, DNS, bounces and
monitoring. For day-to-day use (contacts, campaigns, reports), see the [user guide](USER_GUIDE.md). If you're new, start
with [Getting started](GETTING_STARTED.md).

## 1. Your service

MailHarbor is a **hosted service**. Your organisation has its own private MailHarbor, with its own database and web
address, that no other customer shares. Emails go out through **your own mail server** (SMTP), so your sending
reputation and provider agreements stay yours.

| Managed by MailHarbor | Managed by you (in the app) |
|---|---|
| Hosting, security updates and new versions | Organisation details, sender, sending speed |
| Your database and daily backups | Users and roles |
| Monitoring and uptime | Bounce mailbox and webhook |
| Your web address (e.g. `https://mail.yourcompany.co.za`) | Email design (logo, colours, footer), sign-up forms, images, Google Analytics tags |
| The connection to your mail server (SMTP) | Compliance options, contacts, lists and campaigns |

Contact MailHarbor support to:
- connect a different mail server, or update its password;
- change your web address;
- restore access if every administrator is locked out;
- get your setup code again before your first sign-in;
- request a restore from backup, or a full data export.

## 2. What you need

| Item | Details |
|---|---|
| Mail server (SMTP) | A sending service or relay that permits marketing email: host, port (587 or 465), username, password. MailHarbor support connects it for you |
| Sending domain | A domain you control, to set SPF, DKIM and DMARC (§5) |
| Bounce mailbox | A **dedicated** mailbox with IMAP over TLS (port 993), e.g. `bounces@yourcompany.co.za`, **or** your provider's bounce webhooks |
| Users | Who needs access, and in which role (viewer / manager / administrator) |

> Use a dedicated bounce mailbox. MailHarbor moves every processed message to a `MailHarbor-Processed` folder (or
> deletes it, if you choose that), so it must not be anyone's normal inbox.

## 3. Configure (Settings, administrators only)

### General
- **Organisation name:** shown in the app, on public pages and in email footers.
- **Postal address** (required): included in every email footer to identify the sender.
- **Public web address:** the `https://` address of your MailHarbor. All unsubscribe, tracking and view-online links
  use it. MailHarbor usually sets it for you; contact support to change it.

### Email design
Every email uses one layout: header (your logo, or your organisation name), the campaign's content in a white card, and
a footer with your organisation name and postal address, an optional footer line, and the Unsubscribe, Manage
preferences and View in browser links. There are no per-campaign templates.
- **Logo**, its width and position; **brand colour** (buttons and links), **heading colour**, **background** and
  **font**; the **footer line**; whether to show *Manage preferences*.
- Content blocks follow these colours unless someone picks a colour for a block.
- The preview updates as you type; changes apply when you press **Save settings**.
- Campaigns already sent keep the design they were sent with, including on their *View in browser* page.

### Sending
- **From name / From address:** use an address on your authenticated sending domain. New campaigns use it unless
  someone sets a different sender in the campaign.
- **Reply-to:** optional; where replies go.
- **Emails per second / Maximum per hour:** stay within your provider's limits. On a new domain start at 2–5 per second
  and increase gradually over a few weeks (warm-up).
- **Tracking defaults:** opens and clicks; each campaign can switch them off.
- **Send test email** checks your mail server connection end to end.
- **Google Analytics (UTM) tags:** on by default.
  - **Values:** `utm_source` (default `mailharbor`), `utm_medium` (default `email`); `utm_campaign` is the campaign's
    name, or the name set on the campaign.
  - **Only for these websites:** limits tagging to your own domains. Leave it empty to tag every web link.
  - **Frozen at send:** tags are fixed when a campaign starts sending, so changing these settings never breaks the
    tracked links of a campaign in progress.

### Sign-up forms on your website
*Sign-up forms* gives each form a link and an embed code: an iframe pointing to `https://<your address>/f/<id>?embed=1`.
- **Embedding:** form pages may be embedded on any website. Every other MailHarbor page refuses to be framed.
- **Spam protection:**
  - a hidden spam-trap field;
  - a signed token that rejects submissions made under 2.5 seconds after the page loaded, or without a token;
  - a limit of 20 sign-ups per 10 minutes per network.
- **Rejected submissions** are counted on the form ("blocked as spam") and store no personal data.
- **Unsubscribed or bounced addresses** are never re-subscribed through a form. Reactivation stays an administrator
  action with recorded consent.

### Image storage
Images uploaded to **Images** are compressed (usually 50–300 KB each) and stored in your database, so they're included
in every backup. They're served publicly at `/img/<random id>.jpg`, because inboxes must be able to load them. Don't
upload anything confidential.

### Bounces
- **Bounce address (Return-Path):** the dedicated bounce mailbox address. Delivery failures that occur after sending
  are returned there.
- **Soft-bounce limit:** after this many soft bounces (default 3) the contact is suppressed with reason *soft limit*.
- **Bounce mailbox:** IMAP host, port 993 with TLS, username, password (stored encrypted), folder, check interval and
  what to do after processing. **Test connection** reports the exact IMAP error. **Check now** polls immediately.
- **Provider webhook:** copy the URL into your provider's bounce/complaint notifications. Expected JSON (one object or an array):
  ```json
  {"email":"x@example.com","type":"hard|soft|complaint","reason":"550 5.1.1 user unknown","message_id":"<X-MailHarbor-ID>","id":"provider-event-id"}
  ```
  `id` de-duplicates retries. Map your provider's event fields to this shape (most providers allow a transform, or a
  small relay function). Rotate the token if it leaks.

### Compliance
- **Unsubscribe scope:** *all marketing* (global, the POPIA-safe default) or *only that list*. Choose per-list only if
  you deliberately run preference-based lists and have documented that.

Then open **System health**. Everything marked critical must be green before the first campaign:
- mail server reachable;
- sender set;
- HTTPS public URL;
- postal address;
- bounce mailbox;
- SPF;
- DMARC.

## 4. Users and roles

**Users → Add user.** Give each person the least role they need:

| Role | Can |
|---|---|
| Viewer | Read dashboards, contacts, lists, campaigns, reports. No exports |
| Manager | Everything a viewer can, plus: contacts, lists, imports, exports, campaigns (write, test, send), images, suppress, review queue, System health |
| Administrator | Everything a manager can, plus: Settings, users, reactivation, erasure, list deletion, audit log |

- Accounts lock for 15 minutes after 10 failed sign-ins. Administrators reset passwords under **Users → Edit**.
- Keep **at least two administrators**, so one can always help the other.
- An account marked **Managed by MailHarbor** is MailHarbor's support and recovery account. It's used only to restore
  access or for support work you've asked for, and every action it takes appears in your **Audit log**.

## 5. DNS and deliverability

| Record | Example | Notes |
|---|---|---|
| SPF | `v=spf1 include:<your-smtp-provider> -all` | One SPF record per domain; checked on System health |
| DKIM | `selector._domainkey` TXT/CNAME from your provider | MailHarbor does not sign. Your SMTP provider must sign with **your** domain |
| DMARC | `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@yourcompany.co.za` | Required by Gmail/Yahoo for bulk senders. Move to `quarantine`/`reject` once reports are clean |
| MX | Normal mail routing for the bounce address's domain | Checked on System health |
| PTR | Sending IP → hostname | Set by whoever owns the sending IP (your provider) |

Good practice:
- Keep complaints under 0.1% and bounces under 2%.
- Never import bought or scraped lists.
- Remove long-term non-engagers periodically.

SMTP acceptance is not mailbox verification. The delivery outcome is the source of truth for whether an address is
valid, and MailHarbor records exactly that.

## 6. Backups, updates and availability

- **Backups:** your database is backed up daily by MailHarbor. A backup includes contacts, campaigns, suppressions,
  settings, images and the history needed to keep existing unsubscribe links working. To request a restore, contact
  MailHarbor support.
- **Updates:** MailHarbor installs security updates and new versions for you. Updates are safe while a campaign is
  sending:
  - the email in progress is finished;
  - sending continues where it stopped;
  - an email whose outcome can't be confirmed is marked *unknown* instead of being sent twice.
- **Your data:** at any time you can export contacts (Contacts → Export) and per-contact data (POPIA access requests).
  A full export is available from MailHarbor support, for example at the end of your contract.

## 7. Monitoring

Dashboard and System health alerts:

| Alert | Trigger | What to do |
|---|---|---|
| Emails cannot be sent (critical) | Mail server connection or sign-in failed during sending; campaigns auto-paused | If your mail server's password or details changed, send the new details to MailHarbor support. Then **Resume** |
| Bounce mailbox error (critical) | IMAP connection, login or folder error, or incomplete settings | Settings → Bounces → **Test connection** |
| Bounce processing off (warning) | No bounce mailbox enabled | Set up a bounce mailbox (§3) |
| Public URL missing (critical) | No public address, so emails cannot contain working unsubscribe links | Contact MailHarbor support |
| Backup failed / stale | The daily backup didn't complete | MailHarbor is alerted too and will fix it; no action needed |

System health also shows:
- worker heartbeat;
- queue size;
- last mailbox check;
- mail server status (re-checked every 5 minutes, or on demand);
- DNS checks.

## 8. Common tasks

| Task | How |
|---|---|
| Reset a user's password | Users → Edit |
| Every administrator locked out | Contact MailHarbor support |
| Resume a paused campaign | Fix the cause (System health), then campaign → **Resume** |
| Reactivate a suppressed contact | Suppression → find the address → *Lift* (admin; needs a reason and the new permission basis). The contact page links there |
| POPIA access / erasure | Contact → *Data export* / *Erase* |
| See who did what | Audit log (admin) |
| Rotate the webhook token | Settings → Bounces → *New token*; update the URL at your provider |
| Change mail server or web address | Contact MailHarbor support |

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Mail server check: timeout or authentication failed | Has your mail server's password or address changed? Send the new details to MailHarbor support. Some providers need an SMTP-specific password |
| No bounces recorded | Bounce address set? Bounce mailbox green? Some providers rewrite the Return-Path, so use their webhook |
| Many contacts in the review queue at one domain | Your domain or IP is being blocked there: check SPF/DKIM/DMARC, complaint rate and the provider's postmaster tools before releasing them |
| Contacts imported but not on a list | Row report: suppressed, previously unsubscribed, or no consent basis |
| Opens look unrealistically high | Apple Mail Privacy Protection and security scanners pre-load images. Rely on clicks |
| Anything else | Contact MailHarbor support, with the time it happened and what you saw |
