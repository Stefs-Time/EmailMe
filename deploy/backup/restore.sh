#!/bin/sh
# Restores a backup into the running stack. DESTRUCTIVE: replaces all data.
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

printf 'This will REPLACE all MailHarbor and listmonk data with %s.\nType RESTORE to continue: ' "$file"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }

echo "Stopping application services..."
docker compose stop portal listmonk

echo "Restoring..."
docker compose exec -T db sh -c 'pg_restore --clean --if-exists --no-owner --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"' < "$file"

# Re-apply portal role grants (restoring with --no-owner assigns objects to the restoring user).
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v pw="$PORTAL_DB_PASSWORD" -v owner="$POSTGRES_USER" -f /docker-entrypoint-initdb.d/portal-role.sql.inc \
  && psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "GRANT ALL ON ALL TABLES IN SCHEMA portal TO mailharbor; GRANT ALL ON ALL SEQUENCES IN SCHEMA portal TO mailharbor;"'

echo "Starting services..."
docker compose start listmonk portal
echo "Restore complete. Check System health in MailHarbor."
