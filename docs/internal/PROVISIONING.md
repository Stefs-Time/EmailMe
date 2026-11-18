# Customer provisioning checklist (internal)

> **Internal.** One checklist per customer company. Every customer gets a **dedicated instance and database**. Nothing
> is shared between customers: not the database, the service, the backups, the secrets or the domain.
> Platform steps: [DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md). Running instances: [OPERATIONS.md](OPERATIONS.md).

Copy this list into the customer's onboarding ticket and tick it off.

## 0. Collect from the customer

Send them [Getting started](../GETTING_STARTED.md), which lists what we need:

- [ ] Organisation name, postal address, first administrator's name and email
- [ ] Web address they want, e.g. `mail.customer.co.za`, and who manages their DNS
- [ ] Mail server (SMTP): host, port, username, password, permitted From addresses, sending limits.
  **Get the password through the password manager's secure share, never email or chat**
- [ ] Sending domain, so they can set SPF / DKIM / DMARC
- [ ] Bounce mailbox (IMAP) or provider webhook (they enter the mailbox password themselves in Settings)
- [ ] Signed agreement, including the POPIA operator agreement (we process personal information on their behalf)

Check the SMTP provider allows marketing/bulk email. A normal Microsoft 365 or Google Workspace mailbox is **not**
suitable, so stop and advise the customer.

## 1. Create the instance

On Railway (Pro workspace; SMTP is blocked on lower plans):

- [ ] New project named `mh-<customer>`. Use one project per customer, never a shared one
- [ ] **Postgres** service
- [ ] **MailHarbor** service from the release branch, root directory empty
- [ ] Variables:

  | Variable | Value |
  |---|---|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
  | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | the customer's mail server |
  | `SMTP_FROM` | optional default sender |
  | `SUPPORT_EMAIL` | our support address |

  **Don't set `ADMIN_EMAIL`/`ADMIN_PASSWORD` yet.** While an administrator exists the setup screen doesn't appear,
  and the support account counts as one (step 4).
- [ ] Deploy; `/healthz` returns 200 on the generated domain
- [ ] **Backups** cron service with `BACKUP_S3_PREFIX=mailharbor/<customer>/` ([DEPLOY_RAILWAY.md §6](DEPLOY_RAILWAY.md#6-backups-cron-service)).
  Run it once and confirm the dump in the bucket. **Mandatory:** the customer documentation promises daily backups

## 2. Domain

- [ ] Add the custom domain to the MailHarbor service; give the customer the CNAME record
- [ ] Certificate active and `https://mail.customer.co.za/healthz` returns 200
- [ ] Set `PUBLIC_URL=https://mail.customer.co.za` and redeploy (this locks the field for the customer)

## 3. Hand over the setup code

- [ ] Take the code from Deploy Logs: `FIRST-RUN SETUP: … enter setup code XXXXXXXXXX`
- [ ] Send the web address in one message (email is fine). Send the setup code **separately**, by phone, SMS or the
  password manager's share
- [ ] Customer opens the address, enters the code and creates their administrator. The code then stops working
- [ ] Confirm they can sign in

## 4. Support and recovery account

- [ ] Create `support+<customer>@…` with a unique generated password in the password manager
- [ ] Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (optionally `ADMIN_NAME=MailHarbor Support`) and redeploy
- [ ] Customer's Users page shows the account as **Managed by MailHarbor**
- [ ] Tell the customer it exists, and that it's used only for recovery or on request (it's in their audit log)

## 5. Verify with the customer

- [ ] Settings → General: postal address. Settings → Sending: From address on their domain, speed set to their
  provider's limit (2–5/s on a new domain)
- [ ] **Send test email** arrives; check the headers for SPF/DKIM pass
- [ ] Settings → Bounces: mailbox **Test connection** green, or webhook URL configured at the provider
- [ ] Settings → Compliance & backups → backup alert = `26` hours
- [ ] **System health:** every critical item green (mail server, sender, HTTPS URL, postal address, bounce mailbox,
  SPF, DMARC, backups)
- [ ] Add the instance to uptime monitoring (`/healthz`) and the fleet register (customer, project, domain, bucket
  prefix, go-live date)

## 6. Onboarding

- [ ] Walkthrough: import, consent fields, a test campaign to their own team, reports
- [ ] Point them to the in-app **Guides**, the [user guide](../USER_GUIDE.md) and the [administrator guide](../ADMIN_GUIDE.md)
- [ ] First real campaign: check for bounces and complaints in the first 24 hours

## Offboarding (end of contract)

1. [ ] Confirm in writing the end date and what the customer wants returned
2. [ ] Final full backup. Give the customer:
   - the contacts export, consent and unsubscribe history (from the app);
   - on request, the database dump.

   Share them through an expiring secure link
3. [ ] Keep the suppression list in the export, so they can keep honouring opt-outs on their next platform
4. [ ] Delete the Railway project (database, service and cron) and the customer's backup prefix after the agreed
   retention period. Record the deletion date (POPIA: no longer than necessary)
5. [ ] Remove the support account's password from the password manager, the uptime check and the fleet register
6. [ ] Ask the customer to remove the CNAME record

## Cost and capacity notes

- Each instance is small: one service, 1 replica (required, set in `railway.json`), plus Postgres and a daily cron.
  ~250k contacts fit comfortably in 2 vCPU / 2–4 GB.
- Sending speed is limited by the customer's mail server, not by MailHarbor.
- Fleet upgrades: see [OPERATIONS.md §5](OPERATIONS.md#5-upgrades-whole-fleet). Upgrade a staging instance first.
