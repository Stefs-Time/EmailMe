# Deploying on Railway

Railway runs three services in one project: **Postgres**, **listmonk** (Docker image) and **MailHarbor** (this repo,
`portal/` directory). Railway terminates HTTPS, so Caddy is not used. Railway also has no persistent local disk, so the
compose `backup` service is replaced by Railway's database backups (see below).

> **Status:** these steps follow Railway's documented model (Docker image services, monorepo root directory, private
> networking, reference variables) but have **not been executed** in a live Railway project from this build environment.
> Check them against Railway's current docs as you go.

## 1. Postgres
New project → **Add → Database → PostgreSQL**. Railway provides `DATABASE_URL`, `PGHOST`, `PGUSER`, `PGPASSWORD` and related variables.

## 2. listmonk service
**Add → Docker Image →** `listmonk/listmonk:v6.2.0`

Variables:

```
LISTMONK_app__address=0.0.0.0:9000
LISTMONK_db__host=${{Postgres.PGHOST}}
LISTMONK_db__port=${{Postgres.PGPORT}}
LISTMONK_db__user=${{Postgres.PGUSER}}
LISTMONK_db__password=${{Postgres.PGPASSWORD}}
LISTMONK_db__database=${{Postgres.PGDATABASE}}
LISTMONK_db__ssl_mode=disable
LISTMONK_ADMIN_USER=admin
LISTMONK_ADMIN_PASSWORD=<strong password>
PORT=9000
```

Custom start command:

```
sh -c "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"
```

Networking: generate a public domain (or attach `lists.example.co.za`). This public URL is used in every unsubscribe link.
Media uploads: attach a **Volume** at `/listmonk/uploads`, or configure S3 media storage in listmonk settings.

## 3. Database role for the portal (recommended)
From your machine, using the Postgres service's public connection URL:

```bash
psql "<postgres public url>" -v pw='<strong password>' -v owner=postgres -f deploy/postgres/portal-role.sql
```

`owner` must be the role that owns listmonk's tables (`PGUSER`, usually `postgres`). The portal's `DATABASE_URL` becomes
`postgresql://mailharbor:<password>@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`.
If you skip this step, use `${{Postgres.DATABASE_URL}}`: the portal still opens listmonk tables only in READ ONLY
transactions, but the database itself no longer enforces it.

## 4. listmonk API user
From your machine, with Node 22 installed:

```bash
cd portal && npm ci
LISTMONK_URL=https://<listmonk public domain> LISTMONK_ADMIN_USER=admin LISTMONK_ADMIN_PASSWORD=<…> \
LISTMONK_ROOT_URL=https://<listmonk public domain> \
  node scripts/bootstrap-listmonk.js --recommended-settings
```

Copy the printed `LISTMONK_API_USER` and `LISTMONK_API_TOKEN`.

## 5. MailHarbor service
**Add → GitHub Repo →** this repository. Settings → **Root Directory: `portal`**. Railway then picks up
`portal/railway.json` (Dockerfile build, health check `/healthz`).

Variables:

```
NODE_ENV=production
DATABASE_URL=<from step 3>
SESSION_SECRET=<openssl rand -base64 36>
LISTMONK_URL=http://${{listmonk.RAILWAY_PRIVATE_DOMAIN}}:9000
LISTMONK_PUBLIC_URL=https://<listmonk public domain>
LISTMONK_API_USER=mailharbor
LISTMONK_API_TOKEN=<from step 4>
ORG_NAME=<your organisation>
ADMIN_EMAIL=<you@company>
ADMIN_PASSWORD=<temporary strong password>
DATABASE_POOL_MAX=5
```

Railway sets `PORT`. Generate a public domain (or attach `mail.example.co.za`). After the first successful deploy,
**delete `ADMIN_PASSWORD`**.

## 6. Finish
Continue with steps 2–5 of the README *Quick start* (listmonk SMTP and bounce settings, System health checklist, DNS).

## Operations on Railway
- **Backups:** enable Railway's Postgres backups, **and** schedule your own off-site `pg_dump` (e.g. a GitHub Action or a
  small cron service running `deploy/backup/backup-loop.sh now` that uploads to object storage). Test restores.
- **Connections:** listmonk defaults to 25 connections and the portal to 5. Keep the total within your Postgres plan's limit.
- **Replicas:** the portal is safe to scale (the sync worker uses an advisory lock). An import commit runs on whichever
  replica received it.
- **Outbound mail ports:** confirm your Railway plan allows outbound SMTP (587/465) and POP3 (995) to your providers.
  If it does not, use an HTTP-API relay with a webhook for bounces, or host listmonk elsewhere.
