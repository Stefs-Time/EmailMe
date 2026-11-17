# Deploying on Railway

MailHarbor runs on Railway as **one application service plus a PostgreSQL database**. An optional cron service adds
off-site backups. You only set variables; there is nothing to run on your own machine.

```
Railway project
├── Postgres          Railway database template
├── MailHarbor        this repo, root directory: portal   → public domain, e.g. mail.example.co.za
└── Backups (cron)    this repo, root directory: portal, start: node scripts/backup.js   (optional, recommended)
```

> **Plan requirement: Railway Pro.** According to Railway's
> [outbound networking documentation](https://docs.railway.com/networking/outbound-networking), outbound SMTP is
> available only on the **Pro plan and above**. Free, Trial and Hobby plans block SMTP ports. MailHarbor sends over
> SMTP, so deploy in a Pro workspace. If you upgrade an existing project, **redeploy** the service afterwards.
>
> **Verification status:** these steps follow Railway's documented model:
> - monorepo root directories;
> - config-as-code (`portal/railway.json`: Dockerfile build, `/healthz` health check, 1 replica);
> - `${{Service.VAR}}` references;
> - `RAILWAY_PUBLIC_DOMAIN`;
> - cron schedules.
>
> The application was tested locally against PostgreSQL 16 and a test SMTP server, and the Docker image was built and
> smoke-tested (health check, SMTP verify, backup). A live Railway deployment has
> **not** been performed from the build environment, and Railway's UI labels may differ slightly.

---

## Before you start

You need:

- **A Railway Pro workspace** (see above).
- **SMTP credentials** for a sending service that allows bulk or marketing mail. Examples: Amazon SES, Mailgun, SendGrid,
  Brevo, Postmark (broadcast stream), SMTP2GO, or your own mail server. Check the provider's acceptable-use policy and
  sending limits. A normal Microsoft 365 or Google Workspace mailbox is **not** suitable for bulk sending.
- **A sending domain you control**, to set SPF, DKIM and DMARC records.
- **Optional but strongly recommended:** a dedicated mailbox for bounces (for example `bounces@example.co.za`) with IMAP
  access, or a provider that can send bounce webhooks.

## 1. Database

Railway → **New Project** → **Deploy PostgreSQL**. Keep the service name `Postgres`, which the reference below uses.

## 2. MailHarbor service

1. **+ New → GitHub Repo →** this repository. Name the service **MailHarbor**.
2. *Settings → Source → Root Directory:* `portal`. Railway uses `portal/Dockerfile` and `portal/railway.json`.
3. *Settings → Networking:* **Generate Domain** (or add your custom domain, see §5).
4. *Variables:*

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `SMTP_HOST` | e.g. `email-smtp.af-south-1.amazonaws.com` |
   | `SMTP_PORT` | `587` (STARTTLS) or `465` (TLS) |
   | `SMTP_USER` | SMTP username |
   | `SMTP_PASSWORD` | SMTP password |
   | `SMTP_FROM` | optional, e.g. `"Example News <news@example.co.za>"` |

   That is the whole configuration:
   - Railway sets `PORT` and `RAILWAY_PUBLIC_DOMAIN`, and MailHarbor uses the latter for links in emails;
   - the session secret and encryption key are generated and stored in the database;
   - every other setting lives in the app.

5. Deploy. Startup:
   - applies database migrations;
   - generates its secrets;
   - creates the default email template;
   - starts the sending and bounce worker;
   - passes the `/healthz` health check.

### Optional: administrator from variables

To have an administrator account that always exists (break-glass access), also set the following:

| Variable | Value |
|---|---|
| `ADMIN_EMAIL` | administrator email |
| `ADMIN_PASSWORD` | at least 12 characters, letters and a number |
| `ADMIN_NAME` | optional display name |

On every start, MailHarbor creates this account if it is missing. Otherwise it resets the account's password to the
variable, unlocks it and restores the admin role. In the app the account is marked *managed by environment*: it cannot be
edited, disabled or deleted there. To rotate the password, change the variable and redeploy. To retire the account,
remove both variables. The account then becomes an ordinary user that an administrator can disable.

## 3. First sign-in

If you did **not** set `ADMIN_EMAIL`/`ADMIN_PASSWORD`:

1. Open the service's **Deploy Logs** and find:
   `FIRST-RUN SETUP: open MailHarbor in your browser and enter setup code XXXXXXXXXX`
2. Open the public domain. MailHarbor shows the setup screen. Enter the code, then your organisation name, your name,
   email and a password. You are signed in as the first administrator. The code then stops working.

The code is required so that nobody who finds the URL before you can claim the installation. It is printed again on every
restart until the first administrator exists.

## 4. Configure in the app

Work through **Settings**, then **System health**. Every red item there names the setting that fixes it.

| Settings tab | Set |
|---|---|
| **General** | Organisation name; **postal address** (in every email footer); public web address (detected on Railway; set your custom domain here once you add one) |
| **Sending** | From name and address (on your verified sending domain); reply-to; **emails per second** (start at 2–5 on a new domain, within your provider's limits); optional hourly cap; open/click tracking defaults. **Send test email** checks SMTP end to end |
| **Bounces** | Bounce address (Return-Path); soft-bounce limit (default 3); **bounce mailbox** (IMAP host, port 993, username, password, folder): use **Test connection**; or copy the **webhook URL** into your provider's bounce/complaint notifications |
| **Compliance & backups** | Unsubscribe scope (global by default); backup alert threshold (set after §6) |

Then:
1. Add DNS records for your sending domain: SPF and DKIM as your SMTP provider instructs, plus a DMARC record.
   System health checks SPF, DMARC and MX.
2. **Users:** create accounts for staff (viewer / manager / admin).
3. **Lists → Import → Campaigns:** send a test to yourself before the first real campaign.

> **Return-Path note:** MailHarbor sets the envelope sender to the bounce address. Some providers (for example Amazon
> SES and SendGrid) replace it with their own domain and report bounces through their own notifications. With those
> providers, use the **webhook** for bounces. SMTP rejections at send time are always recorded either way.

## 5. Custom domain

*MailHarbor → Settings → Networking → Custom Domain*, add for example `mail.example.co.za`, and create the CNAME record
Railway shows. Once the certificate is active, set **Settings → General → Public web address** in MailHarbor to
`https://mail.example.co.za`. You can instead set the `PUBLIC_URL` variable, which then locks the field.

Links in emails already sent keep the address they were sent with, so keep the old Railway domain working for a few months.

## 6. Backups (cron service)

Railway's own Postgres backups are a useful first line, but keep an **off-site** copy too.

1. Create a bucket on any S3-compatible store (Cloudflare R2, AWS S3, Backblaze B2, Railway storage buckets) and an
   access key limited to that bucket.
2. **+ New → GitHub Repo →** this repository. Name it **Backups** and set *Root Directory* to `portal`.
3. *Settings → Deploy:* set **Custom Start Command** to `node scripts/backup.js` and **Cron Schedule** to `0 0 * * *`.
   Cron runs in UTC, so this is 02:00 in South Africa. Remove the HTTP health check for this service, because it
   inherits `railway.json`.
4. *Variables:*

   | Variable | Value |
   |---|---|
   | `BACKUP_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `BACKUP_S3_BUCKET` | bucket name |
   | `BACKUP_S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` (omit for AWS S3) |
   | `BACKUP_S3_REGION` | `auto` (R2) or the AWS region |
   | `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | the bucket key |
   | `BACKUP_S3_PREFIX` | `mailharbor/` (optional) |
   | `BACKUP_RETENTION_DAYS` | `30` |

5. Run it once (*Deploy*). Then check MailHarbor → System health → **Backups**. Each run checks that the archive is
   readable before uploading, and a failed run raises a critical alert. Set **Settings → Compliance & backups → Alert
   when no successful backup in** to `26` hours so that a missed run also raises an alert.

### Restore

1. Download the `.dump` from the bucket.
2. From any machine with PostgreSQL client tools of the server's major version or newer, run:

   ```bash
   pg_restore --clean --if-exists --no-owner --dbname "<Postgres public connection URL>" mailharbor-YYYYMMDD-HHMMSS.dump
   ```

3. Redeploy MailHarbor.

Practise this on a separate Railway environment first. The backup includes the generated secrets, so the encrypted
bounce-mailbox password and the existing unsubscribe links keep working after a restore.

## 7. Upgrades

Push to the branch Railway watches. Migrations run automatically on start.

Railway runs the new deployment before stopping the old one. When the old one stops:
- it receives `SIGTERM`;
- it finishes the email in flight and stops claiming new ones;
- campaigns continue in the new deployment.

A message that was mid-send during a hard crash is marked **unknown** rather than sent twice. It is listed on the
campaign report.

Keep **replicas at 1** (set in `railway.json`).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deploy log: `Invalid configuration` | The message names each missing or invalid variable |
| System health: SMTP *connection timeout* | Workspace is not on Pro (SMTP blocked), or wrong host/port. Redeploy after upgrading |
| SMTP *authentication failed* | Check `SMTP_USER`/`SMTP_PASSWORD`. Some providers need an app-specific or SMTP-specific password |
| *Greeting never received* on port 465/587 | Port and TLS mode mismatch: 465 is implicit TLS, 587 is STARTTLS (set automatically from the port; override with `SMTP_SECURE`) |
| Campaign **paused** with "SMTP connection failed" | MailHarbor paused it during an SMTP outage. Fix the cause (System health → SMTP *Re-check*), then **Resume** |
| Lost the setup code | Redeploy or restart. It is printed on every start until the first administrator exists |
| Can't sign in / locked out | Set `ADMIN_EMAIL` + `ADMIN_PASSWORD` and redeploy (see §2) |
| Unsubscribe links point to the wrong address | Settings → General → Public web address (or `PUBLIC_URL`) |
| Backup job fails: `pg_dump … server version mismatch` | The image ships a recent pg_dump. For a newer server, set build arg `PG_CLIENT_VERSION` in `portal/Dockerfile` |
| Bounce mailbox alert | Settings → Bounces → *Test connection* shows the IMAP error (wrong password, IMAP disabled, app password needed) |
