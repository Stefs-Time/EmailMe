#!/usr/bin/env bash
# MailHarbor first-time setup (Docker Compose on Ubuntu).
#   1. cp .env.example .env && nano .env     (fill in every value)
#   2. ./setup.sh
# The portal creates its own listmonk API user and applies the recommended
# listmonk settings on first start, so there is nothing else to run.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Create .env first:  cp .env.example .env  (then edit it)"; exit 1; }
if grep -q 'change-me' .env; then
  echo "Your .env still contains 'change-me' placeholder values. Replace them first."; exit 1
fi
set -a; . ./.env; set +a
mkdir -p backups

echo "==> Building the portal image"
docker compose build portal

echo "==> Starting MailHarbor, listmonk, PostgreSQL, Caddy and backups"
docker compose up -d

echo "==> Waiting for the portal to connect to listmonk"
for i in $(seq 1 60); do
  if docker compose logs portal 2>/dev/null | grep -q 'connected to listmonk API'; then ok=1; break; fi
  sleep 3
done
if [ "${ok:-}" != 1 ]; then
  echo "The portal has not connected to listmonk yet. Check:  docker compose logs portal listmonk"
  exit 1
fi

echo
echo "Done. Once HTTPS certificates are issued (a minute or two):"
echo "  MailHarbor:  https://$PORTAL_DOMAIN          sign in as $PORTAL_ADMIN_EMAIL"
echo "  listmonk:    https://$LISTMONK_DOMAIN/admin  sign in as ${LISTMONK_ADMIN_USER:-admin}"
echo
echo "Next: MailHarbor → System health → work through the go-live checklist"
echo "(SMTP and the bounce mailbox are entered in listmonk → Settings)."
