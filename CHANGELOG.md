# Changelog

All notable changes to MailHarbor. Versions follow [semantic versioning](https://semver.org/); before 1.0, minor
versions may change behaviour.

## 0.9.0: soft release for testing (23 Nov 2026)

First version released to test customers. It replaces the internal development builds.

### Added
- **Customer-managed mail server:** the customer sets their SMTP server, port, security, username and password in
  Settings → Sending (password encrypted, write-only), checks the connection before saving, and switches sending
  instantly. The `SMTP_*` variables become an optional default. Mail servers typed in Settings (SMTP and IMAP) must be
  public addresses (SSRF protection).
- **Inbox:** replies to campaigns are collected from a replies mailbox (Settings → Replies), linked to the contact and
  the campaign, and read, answered, noted, assigned and closed inside MailHarbor. Out-of-office replies are filed
  separately; "please remove me" replies are flagged and turned into a recorded unsubscribe in one click.
- **Email design** (Settings → Email design): logo, brand and heading colours, background, font and footer line for
  every email, with a live preview.
- **Clickable reports:** every number on campaign reports, the dashboard, Mail usage and Audience & bounces opens the
  recipients, emails, bounces or contacts behind it, with search, paging and CSV download.
- **Introduction & permission request** sample and the *Give permission* page, recording consent evidence.
- Image library, sign-up forms, saved segments, Google Analytics (UTM) tags.
- Version shown on System health and in the user menu.

### Changed
- **Templates removed.** Campaigns contain only their content; the header and footer come from the email design.
  Campaigns already sent keep exactly what was sent.
- **Campaign editor** in three steps (Audience → Email → Review & send), one drag-and-drop builder (raw HTML through
  the HTML block); the sender comes from Settings unless a campaign sets its own; the plain-text part is generated.
- Reply-To moved from Settings → Sending to Settings → Replies.
- Customer documentation describes MailHarbor as a hosted service; operator material is in `docs/internal/`.

### Fixed
- Human emails that reached the bounce mailbox were discarded; they now reach the Inbox.
- The recipient pages' rate limit also counted staff API requests.
- Invalid settings returned a server error instead of naming the field.
- Broken contact links in "Recent bounce activity" and on the suppression list.
- The reason given when erasing a contact was not recorded in the audit log.

### Upgrade notes (operators)
- Migrations `007_email_design` and `008_inbox` run automatically on start. Both only add tables and columns.
- A one-time step on first start (recorded in `sync_state.email_design_upgrade`):
  - freezes the template of every campaign that already started;
  - copies the default template's look into the email design (settings not already set);
  - converts drafts written in the old visual/HTML editors into builder documents.
- `portal.templates` and `campaigns.template_id` stay in the database, unused, so the upgrade can be rolled back.
- **Take a backup before upgrading** (see `docs/internal/SOFT_RELEASE.md`).
- New optional variables `SUPPORT_EMAIL` and `MAIL_ALLOW_PRIVATE_HOSTS` (development only). `SMTP_HOST` is no longer
  required: existing instances keep using their `SMTP_*` values until the customer saves a server in Settings.
- Each customer needs a replies mailbox (IMAP) for the Inbox; without one, replies go to the Reply-To/From address
  as before and System health shows a warning.
