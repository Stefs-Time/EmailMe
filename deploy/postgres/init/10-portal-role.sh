#!/bin/sh
# Runs once, when the PostgreSQL volume is first initialised.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$PORTAL_DB_PASSWORD" -v owner="$POSTGRES_USER" \
  -f /docker-entrypoint-initdb.d/portal-role.sql.inc
