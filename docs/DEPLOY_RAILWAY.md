# Deploying on Railway

MailHarbor runs on Railway as **three services plus one optional cron job**, all from this repository. You only set
variables: there are no scripts to run on your own machine. The portal creates its own listmonk API user, applies the
recommended listmonk settings and creates your administrator on first start.

```
Railway project
├── Postgres            (Railway database template)
├── listmonk            repo, root directory: deploy/railway/listmonk   → public domain, e.g. lists.example.co.za
├── MailHarbor          repo, root directory: portal                    → public domain, e.g. mail.example.co.za
└── Backups (cron)      repo, root directory: portal, start: node scripts/backup.js   → daily, to S3-compatible storage
```

> **Verification status.** These steps follow Railway's documented model: monorepo root directories,
> config-as-code (`railway.json`), `${{Service.VAR}}` reference variables, private networking, cron schedules.
> Everything in this repo they rely on was tested locally:
> - the listmonk Railway image starting on `$PORT` against an empty database;
> - the portal configuring itself from variables only;
> - the backup job uploading to an S3-compatible server.
>
> A live Railway deployment has **not** been performed from the build environment. Railway's UI labels may differ slightly.

---

## 1. Create the project and database
1. Railway → **New Project** → **Deploy PostgreSQL**.
2. Rename the database service to `Postgres` if Railway named it differently. The reference variables below use that name.

## 2. listmonk service
1. **+ New → GitHub Repo →** this repository. Rename the service to **`listmonk`**.
2. *Settings → Source → Root Directory:* `deploy/railway/listmonk`. Railway uses that folder's `Dockerfile` and
   `railway.json` (health check `/health`).
3. *Variables:*

   | Variable | Value |
   |---|---|
   | `LISTMONK_db__host` | `${{Postgres.PGHOST}}` |
   | `LISTMONK_db__port` | `${{Postgres.PGPORT}}` |
   | `LISTMONK_db__user` | `${{Postgres.PGUSER}}` |
   | `LISTMONK_db__password` | `${{Postgres.PGPASSWORD}}` |
   | `LISTMONK_db__database` | `${{Postgres.PGDATABASE}}` |
   | `LISTMONK_db__ssl_mode` | `disable` (private network) |
   | `LISTMONK_db__max_open` | `20` |
   | `LISTMONK_ADMIN_USER` | `admin` |
   | `LISTMONK_ADMIN_PASSWORD` | a strong password (password manager) |

4. *Settings → Networking:* **Generate Domain**, or add your custom domain (`lists.example.co.za`). This public address
   appears in every unsubscribe and tracking link, so it must stay stable.
5. *Media uploads (images in emails):* add a **Volume** mounted at `/listmonk/uploads`, or configure S3 storage in
   listmonk → Settings → Media.

## 3. MailHarbor (portal) service
1. **+ New → GitHub Repo →** this repository again. Rename the service to **`MailHarbor`**.
2. *Settings → Source → Root Directory:* `portal`. This uses `portal/Dockerfile` and `portal/railway.json`
   (health check `/healthz`).
3. *Variables:*

   | Variable | Value | Notes |
   |---|---|---|
   | `NODE_ENV` | `production` | |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | See §6 to use a least-privilege role instead |
   | `SESSION_SECRET` | 48 random characters | `openssl rand -base64 36`. Also encrypts the stored listmonk token |
   | `LISTMONK_URL` | `http://${{listmonk.RAILWAY_PRIVATE_DOMAIN}}:${{listmonk.PORT}}` | Private network. If `PORT` isn't defined on listmonk, set `PORT=9000` there |
   | `LISTMONK_PUBLIC_URL` | `https://${{listmonk.RAILWAY_PUBLIC_DOMAIN}}` | Or your custom domain |
   | `LISTMONK_ADMIN_USER` | `${{listmonk.LISTMONK_ADMIN_USER}}` | Lets the portal create and renew its own API user |
   | `LISTMONK_ADMIN_PASSWORD` | `${{listmonk.LISTMONK_ADMIN_PASSWORD}}` | |
   | `ADMIN_EMAIL` | your email | **Environment-managed administrator** (below) |
   | `ADMIN_PASSWORD` | strong password | ≥ 12 characters, letters and a number |
   | `ADMIN_NAME` | e.g. `Thandi Nkosi` | optional |
   | `ORG_NAME` | your organisation | shown in the UI |
   | `DATABASE_POOL_MAX` | `5` | Keeps total connections within the Postgres plan |
   | `BACKUP_STALE_HOURS` | `26` | Alert if no successful backup for 26 h (set once §5 is done) |

4. *Settings → Networking:* **Generate Domain**, or add `mail.example.co.za`.
5. Deploy. In the deploy logs you should see, in order:
   `created administrator from ADMIN_EMAIL / ADMIN_PASSWORD` → `MailHarbor portal listening` →
   `creating listmonk API user for the portal` → `applied recommended listmonk settings` → `connected to listmonk API`.

> **Private networking and ports.** The portal reaches listmonk over Railway's private network, on the port listmonk
> listens on. Setting `PORT=9000` on the listmonk service makes this explicit and stable.

### The environment-managed administrator
`ADMIN_EMAIL` / `ADMIN_PASSWORD` define a break-glass administrator. On **every** start the portal makes sure this
account exists, is an **active administrator** and has **exactly this password**.
- **Locked out?** Change `ADMIN_PASSWORD` in Railway and redeploy.
- In the app the account is marked *Environment-managed*. Its role, status and password cannot be changed there,
  because the next restart would overwrite them.
- **Hand over ownership:** change `ADMIN_EMAIL`. The old account stays as a normal admin you can then disable.
- Remove both variables to stop managing an account this way. Existing accounts are kept.

## 4. Finish the setup in the apps
1. Sign in to **MailHarbor** with `ADMIN_EMAIL` / `ADMIN_PASSWORD` → **System health**.
2. Sign in to **listmonk** (`https://<listmonk domain>/admin`) → **Settings**:
   - **SMTP:** your mail server → *Test connection* (TC01).
   - **Bounces:** enable, and add the dedicated POP3 bounce mailbox (or a provider webhook).
   - **General:** default *From* address. (The root URL was already set by MailHarbor.)
3. Back in MailHarbor → System health: every **critical** check must be green.
4. Create personal accounts for your team under **Users**.
5. Set up DNS for your sending domain (SPF, DKIM, DMARC). See the [admin guide](ADMIN_GUIDE.md#5-dns-and-deliverability).

**Outbound mail ports:** confirm your Railway plan allows outbound SMTP (587/465) and POP3 (995) to your providers.
If it doesn't, use your mail provider's HTTP relay or bounce webhook.

## 5. Backups (cron service)
Railway's own Postgres backups are a useful first line, but keep an **off-site** copy too.

1. Create a bucket on any S3-compatible store. Cloudflare R2, AWS S3, Backblaze B2 and Railway storage buckets all work.
   Create an access key limited to that bucket.
2. **+ New → GitHub Repo →** this repository. Name it **`Backups`**. Root directory `portal`.
3. *Settings → Deploy:* **Custom Start Command** `node scripts/backup.js`, **Cron Schedule** `0 0 * * *`
   (cron runs in UTC; this is 02:00 in South Africa).
4. *Variables:*

   | Variable | Value |
   |---|---|
   | `BACKUP_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (must be the owner/superuser URL) |
   | `BACKUP_S3_BUCKET` | bucket name |
   | `BACKUP_S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` (omit for AWS S3) |
   | `BACKUP_S3_REGION` | `auto` (R2) or the AWS region |
   | `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | the bucket key |
   | `BACKUP_S3_PREFIX` | `mailharbor/` (optional) |
   | `BACKUP_RETENTION_DAYS` | `30` |

5. Trigger it once (*Deploy*) and check MailHarbor → System health → **Backups**: "Last backup … off-site (S3)".
   Each run verifies the archive is readable before uploading. A failed run raises a critical alert. With
   `BACKUP_STALE_HOURS` set on the portal, a missed run raises a warning.

> Because this service also has `railway.json` from the `portal` folder, disable its HTTP health check in the service settings.

### Restore (TC16)
Download the `.dump` from the bucket, then from any machine with PostgreSQL 18 client tools:
```bash
pg_restore --clean --if-exists --no-owner --dbname "<Postgres public connection URL>" mailharbor-YYYYMMDD-HHMMSS.dump
```
Then redeploy the listmonk and MailHarbor services. Practise on a separate Railway environment first.

## 6. Optional hardening: least-privilege database role
By default the portal uses the Postgres owner URL. It only ever reads listmonk's tables in `READ ONLY` transactions,
but the database itself does not enforce that. To have the database enforce it, run once using the Postgres public URL:

```bash
psql "<Postgres public URL>" -v pw='<strong password>' -v owner=postgres -f deploy/postgres/portal-role.sql
```

Then set the portal's `DATABASE_URL` to
`postgresql://mailharbor:<password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`.
The script also grants the role access to any portal tables created earlier, so it can be run before or after the first deploy.

## 7. Upgrades
- **listmonk:** change the tag in `deploy/railway/listmonk/Dockerfile`, then commit. Railway rebuilds, and the start script
  runs `--upgrade`. Read listmonk's release notes first, and test major versions on a staging environment.
- **MailHarbor:** push to the branch Railway watches. Migrations run automatically on start.

## Railway troubleshooting

| Symptom | Fix |
|---|---|
| Portal log: `Invalid configuration` | The message names each missing or invalid variable |
| `listmonk not ready; retrying` repeats | Check the listmonk service is healthy and `LISTMONK_URL` uses the private domain and the right port |
| `listmonk admin login failed` | `LISTMONK_ADMIN_USER` / `LISTMONK_ADMIN_PASSWORD` don't match the listmonk service |
| System health: *Recipient sync has not run* | The portal can't reach listmonk; see the two rows above |
| Can't sign in | Set or change `ADMIN_PASSWORD` and redeploy |
| Backup job fails: `pg_dump … server version mismatch` | The image ships pg_dump 18; for a newer server, set build arg `PG_CLIENT_VERSION` in the Dockerfile |
