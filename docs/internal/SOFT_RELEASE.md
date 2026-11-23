# Soft release 0.9.0: runbook (internal)

> **Internal.** How to put 0.9.0 in front of the first test customers, watch it, and decide on the general release.
> Customer-facing: [docs/BETA_NOTES.md](../BETA_NOTES.md). Changes: [CHANGELOG.md](../../CHANGELOG.md).

## 1. Scope

- **Who:** 2–3 test organisations, each on its own instance and database ([PROVISIONING.md](PROVISIONING.md)), plus
  our own internal staging instance.
- **How long:** at least 4 weeks, covering at least 2 real campaigns per customer.
- **Support:** one named contact on our side; `SUPPORT_EMAIL` set on every instance.

## 2. Before the first customer

- [ ] Staging instance on the release commit; **every step** of the go-live script in
  [ACCEPTANCE_TESTS.md](ACCEPTANCE_TESTS.md) passed against a real SMTP provider, a real IMAP bounce mailbox and a real
  replies mailbox (steps 13–14 cover the Inbox and report drill-downs). Record the results in the ticket.
- [ ] Reply threading checked in **Gmail and Outlook**: answer a reply from the Inbox; it must appear in the same
  thread.
- [ ] Restore test: restore last night's staging backup to a scratch database and open a campaign report.
- [ ] `npm run lint`, `npm test` (unit + integration) and `npm audit --omit=dev` clean on the release commit.
- [ ] Uptime check on `/healthz` for every instance.

## 3. New customer

Follow [PROVISIONING.md](PROVISIONING.md). For the beta, also:
- [ ] replies mailbox and Reply-To configured (Settings → Replies) and *Test connection* green;
- [ ] Email design: their logo and brand colour, checked in a test email on a phone;
- [ ] send them [BETA_NOTES.md](../BETA_NOTES.md) and agree how they report problems;
- [ ] first campaign to a small, engaged list (≤ 500) at 2–5 emails per second.

## 4. Upgrading an existing instance to 0.9.0

0.9.0 adds migrations 007 (email design) and 008 (Inbox), both additive, and a one-time data step on first start
(see CHANGELOG "Upgrade notes").

1. **Backup first:** run the backup job now and confirm the dump in the bucket.
2. Make sure no campaign is mid-send (or accept a short pause: sending resumes after the restart).
3. Deploy. In the logs, confirm `upgraded templates to Settings → Email design` with the counts
   (`frozenCampaigns`, `designKeys`, `convertedDrafts`).
4. Check with the customer:
   - a sent campaign's *View email* looks as before;
   - Settings → Email design shows their look (only the **default** template carried over: recreate others there);
   - an old draft opens in the builder.
5. Set up the replies mailbox (Settings → Replies) or note that replies stay outside MailHarbor for now.

## 5. Rollback

Prefer fixing forward: the release is additive, and most problems will be in one screen.

If a rollback is unavoidable:
- **Code only** (redeploy the previous commit, keep the database): works for everything sent and for old drafts.
  Drafts **created or edited in 0.9** use "brand colour" values that the previous editor rejects. They still send,
  but can't be edited until 0.9 is back. The Inbox and email design are simply unused.
- **Code and database** (restore the backup from step 4.1): exact previous state, but everything since the upgrade is
  lost, including unsubscribes and bounces. Only in the first hours, and re-apply any unsubscribes from the logs or the
  suppression export.

## 6. Watch during the beta (weekly, per instance)

| What | Where | Act when |
|---|---|---|
| Uptime | `/healthz` monitor | Any downtime |
| Alerts | System health, logs | Any critical alert older than 1 hour |
| Bounce and complaint rates | Campaign reports | Bounces > 5%, complaints > 0.1% |
| Inbox mailbox | System health → *Replies mailbox connected* | Not green |
| Unsubscribe requests waiting | Inbox → *Unsubscribe requests* | Older than 2 working days: remind the customer (POPIA) |
| Backups | System health → Backups | Older than 26 hours |
| Errors | Logs, `level: 50` | Any new error message |

## 7. Triage

| Severity | Examples | Response |
|---|---|---|
| **S1** | Emails to suppressed people; unsubscribe not working; data visible to the wrong person; service down | Same day. Pause sending on the instance if needed. Hotfix, tested, deployed fleet-wide |
| **S2** | A feature broken with no workaround (Inbox not collecting, report wrong) | Within 2 working days |
| **S3** | Workaround exists; wording, layout | Batch into the next release |

Record every report in the tracker with the version, instance, time and URL from the customer.

## 8. Go / no-go for the general release

- [ ] No open S1/S2 issues.
- [ ] Every test customer has sent at least 2 real campaigns, with bounce and complaint rates within the limits above.
- [ ] Replies reached the Inbox and answers threaded in the customers' real mail clients.
- [ ] A restore has been tested on a customer-sized database.
- [ ] Decisions taken on the open items in BETA_NOTES "Known limitations": attachments in answers, automatic handling
  of unsubscribe requests, enforcing "ask once" for permission requests, conversation retention.
- [ ] Dropping the unused `portal.templates` table scheduled for a later migration (after the rollback window).
- [ ] Version set to 1.0.0; CHANGELOG updated.
