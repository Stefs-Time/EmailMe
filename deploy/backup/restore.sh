#!/bin/sh
# Restores a backup into the running Docker Compose stack. DESTRUCTIVE.
#
#   ./deploy/backup/restore.sh backups/mailharbor-20261116-020000.dump
#
# Run from the repository root on the Docker host.
set -eu

file="${1:-}"
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo "Usage: $0 <path-to-backup.dump>" >&2
  exit 1
fi

printf 'This will REPLACE all MailHarbor data with %s.\nType RESTORE to continue: ' "$file"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }

echo "Stopping MailHarbor..."
docker compose stop portal backup

echo "Restoring..."
docker compose exec -T db sh -c 'pg_restore --clean --if-exists --no-owner --role=mailharbor -U mailharbor -d mailharbor' < "$file"

echo "Starting MailHarbor..."
docker compose start portal backup
echo "Restore complete. Check System health in MailHarbor."
