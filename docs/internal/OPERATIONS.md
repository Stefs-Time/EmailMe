# MailHarbor operations guide (internal)

> **Internal.** For the MailHarbor operations team. Customers never see hosting, environment variables, logs or
> backups. Customer-facing documentation is in [`docs/`](../): the user guide, administrator guide, getting-started
> guide, security overview and brochure.

MailHarbor is sold as a **hosted, single-tenant service**. Every customer company gets:
- its own MailHarbor instance;
- its own PostgreSQL database;
- its own web address;
- its own backups;
- its own SMTP connection (their mail server).

No database, process or secret is shared between customers. To set up a new customer, follow
[PROVISIONING.md](PROVISIONING.md). Platform-specific steps for Railway, the current hosting platform, are in
[DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md). This guide covers running instances.

## 1. Platform options

| Option | Use when | Notes |
|---|---|---|
| **Railway** (current) | Default for customer instances | One Railway project per customer: Postgres + MailHarbor service + backup cron. **Pro plan required**: outbound SMTP is blocked on Free/Trial/Hobby |
| Ubuntu Server + Docker Compose | A customer needs a dedicated VM or in-country hosting | `docker-compose.yml` in the repository: Caddy (HTTPS) + MailHarbor + PostgreSQL + nightly backups. 2 vCPU / 2–4 GB RAM / 40 GB disk is ample for ~250k contacts |

### Environment variables (per instance)

Required: `DATABASE_URL`, `SMTP_HOST`. Usual: `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`.

Recommended for the hosted service:

| Variable | Why |
|---|---|
| `SUPPORT_EMAIL` | Shown to the customer wherever they need us (setup code, mail server changes) |
| `PUBLIC_URL` | Locks the customer's web address (e.g. `https://mail.customer.co.za`), so the customer can't change it by mistake |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The **MailHarbor support and recovery account** (see §3) |

All variables are listed in the [README](../../README.md#environment-variables).

## 2. Install with Docker Compose

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

The setup code is printed on every start until the first administrator exists, and stops working afterwards. Send it
to the customer through a secure channel (see [PROVISIONING.md](PROVISIONING.md)).

### Firewall

Inbound, only 80/tcp, 443/tcp (and 443/udp for HTTP/3). PostgreSQL and the app sit on an internal Docker network and are
never published.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

Outbound, the instance must reach the customer's SMTP host (587/465) and IMAP bounce mailbox (993).

## 3. Support and recovery account

Add it **after** the customer has completed first-run setup: an existing administrator, including this one, disables
the setup screen (see PROVISIONING.md, step 4).

With `ADMIN_EMAIL` and `ADMIN_PASSWORD` set, that administrator is re-applied on **every** start:
- it always exists;
- it is active and an administrator;
- it has exactly that password.

In the customer's app it shows as **Managed by MailHarbor**, and its role, status and password can't be changed there.

Use it to:
- restore access when the customer locks themselves out: sign in, then reset their account under Users;
- carry out support work the customer has asked for.

**Rules:**
- **One per customer:** use a unique address and password per customer, e.g. `support+customer@…`. Keep them in the
  password manager, never in tickets or chat.
- **Customer approval:** only sign in when the customer asks you to. Every action is in the customer's **audit log**
  under that account.
- **Rotation:** change the password variable and restart. Rotate when staff leave.
- **Not using it:** omit the variables. The customer's first administrator is created with the setup code, and access
  recovery then uses `node scripts/create-admin.js` (§9).

## 4. Backups and restore

Every customer instance **must** have the daily backup job; the customer documentation says their service is backed up
daily.

- **Railway:** a cron service per customer project runs `node scripts/backup.js` to S3-compatible storage. See
  [DEPLOY_RAILWAY.md §6](DEPLOY_RAILWAY.md#6-backups-cron-service). Use a separate bucket prefix per customer:
  `BACKUP_S3_PREFIX=mailharbor/<customer>/`.
- **Docker Compose:** the `backup` service runs daily at `BACKUP_HOUR` and writes
  `backups/mailharbor-YYYYmmdd-HHMMSS.dump`. It verifies each archive with `pg_restore --list` and keeps
  `BACKUP_RETENTION_DAYS` days. Add the `BACKUP_S3_*` variables for an off-site copy; a backup on the same disk is not
  a backup.
- Run a backup now: `docker compose run --rm backup node scripts/backup.js`.
- Restore (destructive, asks for confirmation): `./deploy/backup/restore.sh backups/<file>.dump`.
- Set **Settings → Compliance & backups → Alert when no successful backup in** to `26` on every instance, so a missed
  run shows on the customer's System health and dashboard.

A dump contains everything, including the generated secrets, so existing unsubscribe links and the encrypted
bounce-mailbox password keep working after a restore. Treat backups as the customer's personal data: encrypted bucket,
restricted keys, and deletion at offboarding (see PROVISIONING.md).

Test a restore at least quarterly, on a separate environment.

## 5. Upgrades (whole fleet)

- **Railway:** every customer service tracks the release branch, so a push deploys to all of them. Roll out to an
  internal staging instance first, then to customers. Migrations run automatically on start.
- **Docker Compose:** `git pull && docker compose up -d --build portal backup`.

Upgrades are safe while a campaign is sending:
- on shutdown, the worker finishes the email in progress and stops;
- after the restart, sending continues where it stopped;
- an email interrupted by a hard crash is marked *unknown* instead of being sent twice.

Also keep these current:
- **Host OS / Docker:** `sudo apt upgrade` monthly; `docker compose pull caddy db && docker compose up -d` for patches.
- **Dependencies:** run `npm audit --omit=dev` monthly and before each release.
- **PostgreSQL:** don't jump major versions without a dump/restore.

## 6. Monitoring

- **Uptime:** probe `https://<customer address>/healthz` for each instance. It returns 200 when the app and database
  are up.
- **Customer-visible alerts:**
  - SMTP unavailable (campaigns auto-paused);
  - bounce mailbox error;
  - public URL missing;
  - backup failed or stale.

  Customers see these on their dashboard and System health. A backup alert is always ours to fix; SMTP and mailbox
  alerts usually need the customer's mail-server details.
- **Logs:** JSON (pino) with no cookies, passwords or tokens. On Railway: Deploy Logs. On Compose:
  `docker compose logs -f portal`.

## 7. Customer requests that need us

| Request | How |
|---|---|
| New mail server or SMTP password | Update `SMTP_*` on that instance and restart. Then check *System health → SMTP* and ask the customer to send a test |
| Change of web address | Add the new domain (CNAME), set `PUBLIC_URL`, restart. Keep the old address working for a few months (links in sent emails) |
| Lost setup code | Restart the instance (it is printed again while no administrator exists), or provide it from the deploy log |
| Locked out | Sign in with the support account (§3), unlock or reset the customer's administrator |
| Data export at contract end | See PROVISIONING.md → Offboarding |

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| App restarts in a loop | Logs: usually a missing or invalid variable, which is named in the error |
| SMTP check: timeout | Outbound SMTP blocked (Railway plan below Pro, or a VM provider's block) or wrong host/port |
| SMTP check: authentication failed | Customer's SMTP username/password; some providers need an SMTP-specific credential |
| Certificates not issued | DNS not pointing at the instance yet, or port 80 blocked (Compose) |
| No bounces recorded | Bounce address and mailbox in the customer's Settings; providers that rewrite the Return-Path need their webhook |
| Backup job fails: `pg_dump … server version mismatch` | Build with a matching `PG_CLIENT_VERSION` in `Dockerfile` |

## 9. Recovery commands

```bash
# Create an administrator or reset a password from the command line (instance's DATABASE_URL)
DATABASE_URL=... node scripts/create-admin.js admin@customer.co.za "Full Name"

# Apply migrations only
DATABASE_URL=... node src/db/migrate.js
```
