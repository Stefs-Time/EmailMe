#!/usr/bin/env bash
# MailHarbor first-time setup (Docker Compose on Ubuntu).
#   1. cp .env.example .env && nano .env     (fill in every value)
#   2. ./setup.sh
# Safe to re-run: steps already done are skipped.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Create .env first:  cp .env.example .env  (then edit it)"; exit 1; }
if grep -q 'change-me' .env; then
  echo "Your .env still contains 'change-me' placeholder values. Replace them first."; exit 1
fi
set -a; . ./.env; set +a

echo "==> Building the portal image"
docker compose build portal

echo "==> Starting database and listmonk"
docker compose up -d db listmonk
for i in $(seq 1 60); do
  if docker compose exec -T listmonk wget -qO- http://127.0.0.1:9000/health >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && { echo "listmonk did not start; see: docker compose logs listmonk"; exit 1; }
done

if [ -z "${LISTMONK_API_TOKEN:-}" ]; then
  echo "==> Creating the portal's listmonk API user and applying recommended settings"
  out=$(docker compose run --rm --no-deps \
    -e LISTMONK_URL=http://listmonk:9000 \
    -e LISTMONK_ADMIN_USER="$LISTMONK_ADMIN_USER" \
    -e LISTMONK_ADMIN_PASSWORD="$LISTMONK_ADMIN_PASSWORD" \
    -e LISTMONK_ROOT_URL="https://$LISTMONK_DOMAIN" \
    -e PORTAL_API_USERNAME="${LISTMONK_API_USER:-mailharbor}" \
    portal node scripts/bootstrap-listmonk.js --recommended-settings)
  echo "$out" | grep -v '^LISTMONK_API_TOKEN='
  token=$(echo "$out" | sed -n 's/^LISTMONK_API_TOKEN=//p')
  [ -n "$token" ] || { echo "Could not obtain an API token."; exit 1; }
  sed -i "s|^LISTMONK_API_TOKEN=.*|LISTMONK_API_TOKEN=$token|" .env
  echo "    Token saved to .env"
else
  echo "==> listmonk API token already set; skipping"
fi

echo "==> Starting everything"
docker compose up -d

echo
echo "Done. In a minute or two (once HTTPS certificates are issued):"
echo "  MailHarbor:  https://$PORTAL_DOMAIN   (sign in as $PORTAL_ADMIN_EMAIL)"
echo "  listmonk:    https://$LISTMONK_DOMAIN/admin   (sign in as $LISTMONK_ADMIN_USER)"
echo
echo "Next: remove PORTAL_ADMIN_PASSWORD from .env, then open MailHarbor → System health"
echo "and work through the go-live checklist (SMTP + bounce mailbox are set in listmonk)."
