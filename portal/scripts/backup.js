#!/usr/bin/env node
'use strict';

/**
 * PostgreSQL backup for MailHarbor + listmonk (one database, both schemas).
 *
 *   node scripts/backup.js           run one backup and exit   (Railway cron service)
 *   node scripts/backup.js --loop    run daily at BACKUP_HOUR   (Docker Compose service)
 *
 * Destination (one or both):
 *   BACKUP_DIR=/backups                       local directory (Docker volume)
 *   BACKUP_S3_BUCKET + BACKUP_S3_ACCESS_KEY_ID + BACKUP_S3_SECRET_ACCESS_KEY
 *   [BACKUP_S3_ENDPOINT] [BACKUP_S3_REGION=auto] [BACKUP_S3_PREFIX=mailharbor/]
 *                                             any S3-compatible store (R2, S3, B2, MinIO…)
 * Database:
 *   BACKUP_DATABASE_URL (defaults to DATABASE_URL). Must be the database owner /
 *   superuser: the portal's read-only role cannot dump listmonk's sequences.
 * Retention: BACKUP_RETENTION_DAYS (default 14).
 *
 * Every run records a heartbeat (portal.sync_state 'backup_heartbeat') that the
 * portal shows on System health and alerts on when stale.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
const DB_URL = env.BACKUP_DATABASE_URL || env.DATABASE_URL;
const RETENTION_DAYS = Math.max(1, Number(env.BACKUP_RETENTION_DAYS || 14));
const PREFIX = (env.BACKUP_S3_PREFIX ?? 'mailharbor/').replace(/^\/+/, '');
const useS3 = Boolean(env.BACKUP_S3_BUCKET);
const log = (msg, extra) => console.log(JSON.stringify({ time: new Date().toISOString(), component: 'backup', msg, ...extra }));

/** libpq environment from the URL, so the password never appears in process arguments. */
function pgEnv(url) {
  const u = new URL(url);
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGSSLMODE: u.searchParams.get('sslmode') || (env.DATABASE_SSL === 'true' ? 'require' : 'prefer'),
  };
}

function run(cmd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: extraEnv || process.env });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim().slice(-500)}`))));
  });
}

function s3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: env.BACKUP_S3_REGION || 'auto',
    endpoint: env.BACKUP_S3_ENDPOINT,
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY },
  });
}

async function uploadS3(file, key) {
  const { Upload } = require('@aws-sdk/lib-storage');
  await new Upload({
    client: s3Client(),
    params: { Bucket: env.BACKUP_S3_BUCKET, Key: key, Body: fs.createReadStream(file), ContentType: 'application/octet-stream' },
  }).done();
}

async function pruneS3(keep) {
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  const client = s3Client();
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let token;
  const old = [];
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: env.BACKUP_S3_BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      if (o.Key !== keep && /mailharbor-\d{8}-\d{6}\.dump$/.test(o.Key) && new Date(o.LastModified).getTime() < cutoff) old.push({ Key: o.Key });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  for (let i = 0; i < old.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({ Bucket: env.BACKUP_S3_BUCKET, Delete: { Objects: old.slice(i, i + 1000) } }));
  }
  return old.length;
}

async function pruneDir(dir, keep) {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  let n = 0;
  for (const f of await fsp.readdir(dir)) {
    if (f === keep || !/^mailharbor-\d{8}-\d{6}\.dump$/.test(f)) continue;
    const st = await fsp.stat(path.join(dir, f));
    if (st.mtimeMs < cutoff) { await fsp.unlink(path.join(dir, f)); n += 1; }
  }
  return n;
}

async function heartbeat(value) {
  const pool = new Pool({ connectionString: DB_URL, max: 1, connectionTimeoutMillis: 10000,
    ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: env.DATABASE_SSL_VERIFY !== 'false' } : undefined });
  try {
    await pool.query(
      `INSERT INTO portal.sync_state (key, value, updated_at) VALUES ('backup_heartbeat', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify(value)]);
  } catch (err) {
    log('could not record heartbeat (has the portal run its migrations?)', { error: err.message });
  } finally {
    await pool.end();
  }
}

async function backupOnce() {
  if (!DB_URL) throw new Error('Set BACKUP_DATABASE_URL or DATABASE_URL');
  if (!useS3 && !env.BACKUP_DIR) throw new Error('Set BACKUP_DIR and/or BACKUP_S3_BUCKET (+ credentials)');
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `mailharbor-${ts}.dump`;
  const tmp = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'mh-backup-')), name);
  const started = Date.now();
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${tmp}`], pgEnv(DB_URL));
    await run('pg_restore', ['--list', tmp]); // archive is readable
    const size = (await fsp.stat(tmp)).size;
    const locations = [];
    let pruned = 0;
    if (env.BACKUP_DIR) {
      await fsp.mkdir(env.BACKUP_DIR, { recursive: true });
      await fsp.copyFile(tmp, path.join(env.BACKUP_DIR, name));
      locations.push(path.join(env.BACKUP_DIR, name));
      pruned += await pruneDir(env.BACKUP_DIR, name);
    }
    if (useS3) {
      await uploadS3(tmp, PREFIX + name);
      locations.push(`s3://${env.BACKUP_S3_BUCKET}/${PREFIX}${name}`);
      pruned += await pruneS3(PREFIX + name);
    }
    const result = { at: new Date().toISOString(), ok: true, file: name, size, locations, pruned, seconds: Math.round((Date.now() - started) / 1000) };
    await heartbeat(result);
    log('backup complete', result);
    return result;
  } catch (err) {
    await heartbeat({ at: new Date().toISOString(), ok: false, error: err.message.slice(0, 500) });
    throw err;
  } finally {
    await fsp.rm(path.dirname(tmp), { recursive: true, force: true });
  }
}

async function loop() {
  const hour = Number(env.BACKUP_HOUR ?? 2);
  log('scheduler started', { hour, retentionDays: RETENTION_DAYS });
  let last = '';
  for (;;) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getHours() === hour && last !== today) {
      last = today;
      await backupOnce().catch((err) => log('backup FAILED', { error: err.message }));
    }
    await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
  }
}

if (process.argv.includes('--loop')) {
  process.on('SIGTERM', () => process.exit(0));
  loop();
} else {
  backupOnce().then(() => process.exit(0)).catch((err) => {
    log('backup FAILED', { error: err.message });
    process.exit(1);
  });
}
