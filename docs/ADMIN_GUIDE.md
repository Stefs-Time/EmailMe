# MailHarbor administrator guide

This guide covers installing, configuring and operating MailHarbor with listmonk on your own server.
For Railway, see [DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md).

## 1. Before you start

| Decision (scope §15) | What you need |
|---|---|
| Hosting | Ubuntu Server 22.04/24.04, 2 vCPU / 4 GB RAM / 40 GB disk is ample for ~250k contacts |
| SMTP | Your business SMTP server or a relay (host, port, username, password) |
| Bounce mailbox | A **dedicated** mailbox with POP3 over TLS (port 995), e.g. `bounces@example.co.za` |
| DNS | Two names pointing at the server: portal (`mail.…`) and listmonk (`lists.…`) |
| Users | Who needs MailHarbor access (viewer/manager/admin), and who writes campaigns in listmonk |

> The bounce mailbox must not be anyone's normal inbox: listmonk **deletes** messages after processing them.

## 2. Install

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine + Compose plugin
sudo usermod -aG docker $USER && newgrp docker

git clone <repo-url> mailharbor && cd mailharbor
cp .env.example .env
nano .env
./setup.sh
```

`setup.sh` builds the portal image and starts everything. On its first start the portal:
1. creates the **environment-managed administrator** from `PORTAL_ADMIN_EMAIL` / `PORTAL_ADMIN_PASSWORD`;
2. creates its own least-privilege **listmonk API user** (with the listmonk admin credentials) and stores the token encrypted;
3. sets listmonk's public root URL and applies the recommended bounce actions and the List-Unsubscribe header.

### The environment-managed administrator
`PORTAL_ADMIN_EMAIL` / `PORTAL_ADMIN_PASSWORD` (`ADMIN_EMAIL` / `ADMIN_PASSWORD` on Railway) are re-applied on **every**
start: the account always exists, is an active administrator and has exactly that password. Keep the password in
`.env`; to rotate it or recover a lost login, change it and run `docker compose up -d portal`. In the app it is marked
*Environment-managed*, and its role, status and password cannot be changed there. Create personal accounts for staff
under **Users** and keep this one for emergencies.

### Firewall

Only 80/tcp, 443/tcp (and 443/udp for HTTP/3) need to be open inbound. PostgreSQL, listmonk (9000) and the
portal (3000) are on an internal Docker network and are never published.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

## 3. Configure listmonk

Sign in at `https://lists.example.co.za/admin` with `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD`.

### 3.1 General
- **Root URL:** `https://lists.example.co.za` (setup.sh sets this; every unsubscribe and tracking link uses it).
- **Default "from" email:** e.g. `Example News <news@example.co.za>`.

### 3.2 SMTP (scope §3.1)
Settings → SMTP: host, port **587 + STARTTLS** or **465 + TLS**, auth `login` or `plain`, username, password.
Set *max connections* to what your provider allows. Click **Test connection** before saving. Credentials are stored only
in listmonk. listmonk masks them in its API, and MailHarbor never sees or displays them.

Custom headers (e.g. `X-Mailer`) can be added per SMTP server. listmonk sets the Return-Path from the bounce settings.

### 3.3 Sending rate (scope §6)
Settings → Performance: *Concurrency*, *Message rate* (per second) and *Batch size*. For a new domain, start around
**5–10 messages/second** and increase gradually. Enable the *sliding window* to cap messages per hour if your provider limits them.

### 3.4 Bounces (scope §3.6)
Settings → Bounces:
1. **Enable bounce processing.**
2. **Mailbox:** type POP, host, port 995, TLS on, username/password, scan interval 15 min, and
   **Return-Path = the bounce mailbox address**.
3. **Actions** (setup.sh applied these): Hard 1 → blocklist; Complaint 1 → blocklist; Soft 3 → blocklist.
4. If your provider offers bounce webhooks (Amazon SES, SendGrid, Postmark, Azure, ForwardEmail, Lettermint), enable
   the relevant one as well or instead. **IMAP-only mailboxes are not supported by listmonk**; use a webhook or an adapter.

MailHarbor adds a classification layer on top. It reads each bounce's SMTP status code and:
- keeps 5.1.1 / 550 / 5.4.4 as hard bounces (suppressed);
- moves **5.7.x policy and spam rejections** to the **Review queue**. listmonk itself would blocklist them as hard bounces,
  but they usually mean a sending-configuration problem, not a dead mailbox;
- sends listmonk "hard" bounces that are really temporary (e.g. 5.2.2 mailbox full) to review.

### 3.5 Privacy (scope §3.7, §5)
- **Include List-Unsubscribe header:** on (setup.sh enables it). This provides one-click unsubscribe (RFC 8058).
- **Individual subscriber tracking:** off by default. Turn it on only if your privacy notice covers per-person open/click
  tracking. It enables per-contact engagement in MailHarbor.
- **Allow blocklisting / preferences / data export / wipe** on the public subscription page: recommended on.
- **Double opt-in:** set per list (Lists → opt-in = double). The opt-in email template can be edited in listmonk.

### 3.6 listmonk users
listmonk has its own users and roles (Users → Roles). Give campaign writers a role with campaigns, templates and lists
access. Do **not** give them `subscribers:manage` unless needed: contact changes should go through MailHarbor so they are
audited. Anything they do change is still policed by MailHarbor's enforcement.

## 4. MailHarbor configuration

- **System health** (admin/manager) shows the database, listmonk and sync status plus the **go-live checklist**.
  Everything marked critical must be green before the first campaign.
- **Users:** create accounts with the least role needed (see the in-app guide *Users & roles*).
- **Global unsubscribe** (`GLOBAL_UNSUBSCRIBE=true`) is the POPIA-safe default: any unsubscribe suppresses the person
  from all marketing. Set it to `false` only if you deliberately run per-list preferences and have documented that.

## 5. DNS and deliverability

| Record | Example | Notes |
|---|---|---|
| SPF | `v=spf1 include:<your-smtp-provider> -all` | One SPF record per domain |
| DKIM | `selector._domainkey` TXT from your provider | Sign with your own domain |
| DMARC | `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@example.co.za` | Move to `quarantine`/`reject` once reports are clean |
| MX | Normal mail routing | Needed for the bounce mailbox domain |
| Return-Path | Bounce mailbox on a domain aligned with the From domain | Captures delivery failures |
| PTR | Sending IP → hostname | Set by whoever owns the sending IP |

SMTP acceptance is not mailbox verification. The delivery outcome is the source of truth for whether an address is
valid, and MailHarbor records exactly that.

## 6. Backups and restore (TC16)

- The `backup` service runs `portal/scripts/backup.js` daily at `BACKUP_HOUR`. It writes
  `backups/mailharbor-YYYYmmdd-HHMMSS.dump`, verifies each archive with `pg_restore --list`, keeps
  `BACKUP_RETENTION_DAYS` days, and reports the result on **System health → Backups**. A failure raises a critical alert;
  no successful backup within 26 h raises a warning.
- One dump covers **both** listmonk's data and MailHarbor's `portal` schema.
- **Off-site copy:** set the `BACKUP_S3_*` variables in `.env` (Cloudflare R2, AWS S3, Backblaze B2, MinIO…), and each
  backup is also uploaded there with the same retention. A backup on the same disk is not a backup.
- Run a backup now: `docker compose run --rm backup node scripts/backup.js`
- Restore (destructive): `./deploy/backup/restore.sh backups/<file>.dump`
- Also keep a copy of `.env` in your password manager: it holds the secrets needed to rebuild.

Test a restore at least quarterly on a separate machine.

## 7. Upgrades

**listmonk:** read the [release notes](https://github.com/knadh/listmonk/releases), back up, change the image tag in
`docker-compose.yml`, then `docker compose up -d listmonk`. The container runs `--upgrade` on start. MailHarbor reads
listmonk's tables, so run the integration tests against a staging copy before upgrading production to a new **major** version.

**MailHarbor:** `git pull && docker compose build portal && docker compose up -d portal`. Migrations run automatically on start.

**OS / Docker:** `sudo apt upgrade` monthly. `docker compose pull caddy db backup && docker compose up -d` for patch
updates of those images. Do not jump PostgreSQL major versions without a dump/restore.

## 8. Monitoring (scope §8)

MailHarbor raises dashboard alerts for:

| Alert | Trigger |
|---|---|
| listmonk unreachable (critical) | Health check fails |
| Bounce mailbox error (critical) | listmonk log shows POP3/bounce errors (TC14) |
| Bounce processing disabled (warning) | Bounces off, or no mailbox/webhook configured |
| SMTP errors (warning) | listmonk log shows sending errors |
| Sync failing / stale (critical) | Worker errors, or no successful run within `SYNC_STALE_MINUTES` |
| Suppression re-enforced (warning) | A suppressed contact was re-enabled directly in listmonk |

For external monitoring, probe `https://mail…/healthz` (portal + database) and `https://lists…/health` (listmonk) with
an uptime checker, and watch `backups/LAST_BACKUP`.

Logs: `docker compose logs -f portal listmonk`. Portal logs are JSON (pino) and omit cookies and credentials.

## 9. Common tasks

| Task | How |
|---|---|
| Reset the environment-managed admin password | Change `PORTAL_ADMIN_PASSWORD` in `.env`, then `docker compose up -d portal` |
| Reset another admin's password | Users → Edit, or `docker compose exec portal node scripts/create-admin.js admin@co.za` |
| Rotate the listmonk API token | Delete user `mailharbor` in listmonk → Users. The portal creates a new one automatically within a minute |
| Force a sync | MailHarbor → System health → *Run sync now* |
| Rotate `SESSION_SECRET` | Change in `.env`, `docker compose up -d portal` (signs everyone out) |

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Portal restarts in a loop | `docker compose logs portal`: usually a missing variable, which is named in the error |
| "listmonk rejected the portal API credentials" | With listmonk admin credentials set, the portal renews its token itself; otherwise update `LISTMONK_API_TOKEN` |
| Certificates not issued | DNS not pointing at the server yet, or port 80 blocked |
| No bounces recorded | Bounce mailbox settings, Return-Path, and the *Bounce mailbox error* alert |
| Contacts imported but not on a list | Row report: suppressed, previously unsubscribed, or no consent basis |
