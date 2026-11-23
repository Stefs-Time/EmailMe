# MailHarbor 0.9 beta: notes for test customers

Thank you for testing MailHarbor. This version is complete enough for real campaigns. We are releasing it to a few
organisations first so that we can find what still needs work before the general release.

## What's in this version

- **Contacts and lists:** import spreadsheets (with a preview before anything is saved), saved segments, sign-up forms
  for your website, consent records for POPIA, and a suppression list that nothing can bypass.
- **Campaigns** in three steps: choose the audience, write the email in the drag-and-drop builder (or start from one of
  nine sample designs), review and send. Your logo, colours and footer are added to every email from
  Settings → Email design.
- **Inbox:** replies to your campaigns arrive in MailHarbor, linked to the contact and the campaign. Read them, answer
  them, add notes for your team, and act on unsubscribe requests.
- **Reports:** every number opens the people behind it: who clicked, who bounced and why, who unsubscribed.
- **Deliverability and compliance:** bounce handling, complaint handling, one-click unsubscribe, a preference centre,
  and System health with a go-live checklist.

New? Start with [Getting started](GETTING_STARTED.md). Full guides: [user guide](USER_GUIDE.md),
[administrator guide](ADMIN_GUIDE.md), [security and POPIA](SECURITY.md), and **Guides** in the app.

## Please test especially

1. **Your first campaign end to end:** import a small list, send a test to yourself, send to a small group, then check
   the report. Click the numbers and check they match what you expect.
2. **Replies:** reply to a campaign from your own mailbox, answer the reply from the Inbox, and check it arrives
   threaded in your mail client. Try an out-of-office reply and a "please remove me" reply.
3. **Email design:** your logo and colours on a phone and on a computer, in Gmail and Outlook if you can.
4. **Bounces:** include one address you know doesn't exist; it should show as *Hard bounced* within about ten minutes.

## Known limitations in this version

- **Answers from the Inbox** are plain text and can't include attachments yet. Images embedded inside a reply are not
  shown (attachments are).
- **Unsubscribe requests by email** are flagged for you, not acted on automatically. Check *Inbox → Unsubscribe
  requests* daily: POPIA requires you to honour them.
- **Permission requests:** POPIA lets you ask someone who isn't a customer for permission only once. MailHarbor shows
  a reminder but doesn't yet stop you sending the request twice.
- **Conversations are kept** until the contact is erased; there is no automatic retention period yet.
- **Replies arrive every few minutes** (the mailbox is checked on a schedule), not instantly.
- **Opens are approximate:** some email apps open images automatically, others block them. Clicks are more reliable.
- **No A/B tests, automations or drip sequences** yet (see the roadmap in the product overview).
- The campaign editor works on a phone but is designed for a computer.

## Reporting a problem

Contact MailHarbor support and include:
- what you were doing and what you expected;
- the time it happened;
- the page's web address (it identifies the campaign, contact or conversation);
- the version (bottom of your user menu, or System health): **0.9.0**.

Screenshots help. Please don't send passwords or full contact lists by email.

## Your data during the beta

Your MailHarbor has its own private database, backed up daily. Everything you create in the beta carries over to the
general release. If you decide not to continue, we export your contacts, consent and unsubscribe history for you and
then delete your service and backups.
