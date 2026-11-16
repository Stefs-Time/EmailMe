#!/bin/sh
# Nightly PostgreSQL backup with retention. Runs inside the `backup` container.
# Writes /backups/mailharbor-YYYYmmdd-HHMMSS.dump (pg_dump custom format, which
# covers listmonk's tables AND the portal schema) and a heartbeat file.
set -eu

: "${BACKUP_RETENTION_DAYS:=14}"
: "${BACKUP_HOUR:=2}"

backup() {
  ts=$(date +%Y%m%d-%H%M%S)
  out="/backups/mailharbor-$ts.dump"
  echo "[backup] starting $out"
  if pg_dump --format=custom --no-owner --file="$out.partial"; then
    mv "$out.partial" "$out"
    # Verify the archive is readable before trusting it.
    pg_restore --list "$out" > /dev/null
    echo "$ts ok $(du -h "$out" | cut -f1)" > /backups/LAST_BACKUP
    echo "[backup] done $out"
  else
    rm -f "$out.partial"
    echo "$ts FAILED" > /backups/LAST_BACKUP
    echo "[backup] FAILED" >&2
  fi
  find /backups -name 'mailharbor-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -delete
}

if [ "${1:-}" = "now" ]; then
  backup
  exit 0
fi

echo "[backup] scheduler started; daily at ${BACKUP_HOUR}:00, keeping ${BACKUP_RETENTION_DAYS} days"
last=""
while true; do
  hour=$(date +%H | sed 's/^0//')
  today=$(date +%Y%m%d)
  if [ "$hour" = "$BACKUP_HOUR" ] && [ "$last" != "$today" ]; then
    backup || true
    last="$today"
  fi
  sleep 300
done
