# MailHarbor administrator guide

This guide covers installing, configuring and operating MailHarbor. For Railway, follow
[DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md) for the install, then use sections 3–9 here.

## 1. Before you start

| Decision (scope §15) | What you need |
|---|---|
| Hosting | Railway (Pro plan, because SMTP is blocked on lower plans) **or** an Ubuntu Server 22.04/24.04 with Docker. 2 vCPU, 2–4 GB RAM and 40 GB disk is ample for ~250k contacts |
| SMTP | A sending service or relay that permits marketing email: host, port (587 or 465), username, password |
| Sending domain | A domain you control, to set SPF, DKIM and DMARC |
| Bounces | A **dedicated** mailbox with IMAP over TLS (port 993), e.g. `bounces@example.co.za`, **or** provider bounce webhooks |
| Users | Who needs access, and in which role (viewer / manager / admin) |

> Use a dedicated bounce mailbox. MailHarbor moves every processed message to a `MailHarbor-Processed` folder (or
> deletes it, if you choose that), so it must not be anyone's normal inbox.

## 2. Install (self-hosted)

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine + Compose plugin
sudo usermod -aG docker $USER && newgrp docker

git clone <repo-url> mailharbor && cd mailharbor
cp .env.example .env
nano .env                  # DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD (openssl rand -base64 30), SMTP_*
docker compose up -d --build
docker compose logs portal | grep "setup code"
```

Open `https://<DOMAIN>`, enter the setup code and create the first administrator. The code is printed on every start
until an administrator exists, and stops working afterwards.

### Optional: environment-managed administrator

If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set in `.env`, that account is re-applied on **every** start:
- it always exists;
- it is an active administrator;
- it has exactly that password.

This gives you break-glass access: to recover a lost login, change the password and run `docker compose up -d portal`.
In the app it is marked *Managed by environment*, and its role, status and password cannot be changed there. Create
personal accounts for staff under **Users**.

### Firewall

Only 80/tcp, 443/tcp (and 443/udp for HTTP/3) need to be open inbound. PostgreSQL and the app are on an internal Docker
network and are never published.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

Outbound, the server must reach your SMTP host (587/465) and IMAP host (993). Some hosting providers block outbound
SMTP by default; ask them to open it if *System health → SMTP* shows a timeout.

## 3. Configure (Settings, admin only)

### General
- **Organisation name:** shown in the app, on public pages and in email footers.
- **Postal address** (required): included in every email footer to identify the sender.
- **Public web address:** the `https://` address of MailHarbor. All unsubscribe, tracking and view-online links use it.
  - On Railway the generated domain is used until you enter a custom one.
  - With Docker Compose it comes from `DOMAIN`.

### Sending
- **From name / From address:** use an address on your authenticated sending domain. Campaigns can override it.
- **Reply-to:** optional; where replies go.
- **Emails per second / Maximum per hour:** stay within your provider's limits. On a new domain start at 2–5 per second
  and increase gradually over a few weeks (warm-up).
- **Tracking defaults:** opens and clicks; each campaign can switch them off.
- **Send test email** verifies the SMTP settings from the environment end to end.

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

### Compliance & backups
- **Unsubscribe scope:** *all marketing* (global, the POPIA-safe default) or *only that list*. Choose per-list only if
  you deliberately run preference-based lists and have documented that.
- **Backup alert:** hours without a successful backup before a warning (0 = off). Set 26 for daily backups.

Then open **System health**. Everything marked critical must be green before the first campaign:
- SMTP reachable;
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
| Manager | Everything a viewer can, plus: contacts, lists, imports, exports, campaigns (write, test, send), templates, suppress, review queue, System health |
| Administrator | Everything a manager can, plus: Settings, users, reactivation, erasure, list deletion, audit log |

Accounts lock for 15 minutes after 10 failed sign-ins. Administrators reset passwords under Users → Edit.

## 5. DNS and deliverability

| Record | Example | Notes |
|---|---|---|
| SPF | `v=spf1 include:<your-smtp-provider> -all` | One SPF record per domain; checked on System health |
| DKIM | `selector._domainkey` TXT/CNAME from your provider | MailHarbor does not sign. Your SMTP provider must sign with **your** domain |
| DMARC | `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@example.co.za` | Required by Gmail/Yahoo for bulk senders. Move to `quarantine`/`reject` once reports are clean |
| MX | Normal mail routing for the bounce address's domain | Checked on System health |
| PTR | Sending IP → hostname | Set by whoever owns the sending IP (your provider) |

Good practice:
- Keep complaints under 0.1% and bounces under 2%.
- Never import bought or scraped lists.
- Remove long-term non-engagers periodically.

SMTP acceptance is not mailbox verification. The delivery outcome is the source of truth for whether an address is
valid, and MailHarbor records exactly that.

## 6. Backups and restore (TC16)

### Docker Compose
- The `backup` service runs `scripts/backup.js` daily at `BACKUP_HOUR` and writes `backups/mailharbor-YYYYmmdd-HHMMSS.dump`.
  It:
  - verifies each archive with `pg_restore --list`;
  - keeps `BACKUP_RETENTION_DAYS` days;
  - reports on **System health → Backups**.
- A failure raises a critical alert.
- **Off-site copy:** set the `BACKUP_S3_*` variables (Cloudflare R2, AWS S3, Backblaze B2, MinIO…). A backup on the same
  disk is not a backup.
- Run a backup now: `docker compose run --rm backup node scripts/backup.js`
- Restore (destructive, asks for confirmation): `./deploy/backup/restore.sh backups/<file>.dump`

### Railway
See [DEPLOY_RAILWAY.md §6](DEPLOY_RAILWAY.md#6-backups-cron-service).

The dump contains everything: contacts, campaigns, suppressions, settings and the generated secrets. Existing
unsubscribe links and the encrypted bounce-mailbox password therefore keep working after a restore. Treat backups as
sensitive.

Test a restore at least quarterly on a separate machine or Railway environment.

## 7. Upgrades

- **MailHarbor (self-hosted):** `git pull && docker compose up -d --build portal backup`. Migrations run automatically on start.
- **MailHarbor (Railway):** push to the watched branch.

Upgrades are safe while a campaign is sending:
- on shutdown, the worker finishes the email in progress and stops;
- after the restart, sending continues where it stopped;
- an email interrupted by a hard crash is marked *unknown* instead of being sent twice.

**OS / Docker:**
- `sudo apt upgrade` monthly;
- `docker compose pull caddy db && docker compose up -d` for patch updates;
- do not jump PostgreSQL major versions without a dump/restore.

## 8. Monitoring (scope §8)

Dashboard and System health alerts:

| Alert | Trigger |
|---|---|
| Emails cannot be sent (critical) | SMTP connection or authentication failure during sending; campaigns auto-paused |
| Bounce mailbox error (critical) | IMAP connection, login or folder error, or incomplete settings (TC14) |
| Bounce processing off (warning) | No bounce mailbox enabled |
| Public URL missing (critical) | No public address, so emails cannot contain working unsubscribe links |
| Backup failed (critical) / stale (warning) | Backup job error / no success within the configured hours |

System health also shows:
- worker heartbeat;
- queue size;
- last mailbox check;
- SMTP status (re-checked every 5 minutes, or on demand);
- DNS checks.

For external monitoring, probe `https://<domain>/healthz` with an uptime checker. It returns 200 when the app and
database are up.

Logs: `docker compose logs -f portal`, or Railway → Deploy Logs. Logs are JSON (pino) and omit cookies, passwords
and tokens.

## 9. Common tasks

| Task | How |
|---|---|
| Recover admin access | Set `ADMIN_EMAIL`/`ADMIN_PASSWORD` and restart (§2), or `node scripts/create-admin.js you@co.za "Name"` with `DATABASE_URL` set |
| Reset a user's password | Users → Edit |
| Resume a paused campaign | Fix the cause (System health), then campaign → **Resume** |
| Reactivate a suppressed contact | Suppression → find the address → *Lift* (admin; needs a reason and the new permission basis). The contact page links there |
| POPIA access / erasure | Contact → *Data export* / *Erase* |
| See who did what | Audit log (admin) |
| Rotate the webhook token | Settings → Bounces → *New token*; update the URL at your provider |

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| App restarts in a loop | `docker compose logs portal`: usually a missing or invalid variable, which is named in the error |
| SMTP check: timeout | Outbound SMTP blocked (hosting provider / Railway plan) or wrong host/port |
| SMTP check: authentication failed | Username/password; some providers need an SMTP-specific credential |
| Certificates not issued | DNS not pointing at the server yet, or port 80 blocked |
| No bounces recorded | Bounce address set? Bounce mailbox green? Some providers rewrite the Return-Path, so use their webhook |
| Many contacts in the review queue at one domain | Your domain or IP is being blocked there: check SPF/DKIM/DMARC, complaint rate and the provider's postmaster tools before releasing them |
| Contacts imported but not on a list | Row report: suppressed, previously unsubscribed, or no consent basis |
| Opens look unrealistically high | Apple Mail Privacy Protection and security scanners pre-load images. Rely on clicks |
