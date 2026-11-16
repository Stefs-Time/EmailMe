#!/bin/sh
# Installs the schema on an empty database (idempotent), applies upgrades after
# an image bump, then starts listmonk. All settings come from LISTMONK_* vars.
set -e
export LISTMONK_app__address="0.0.0.0:${PORT:-9000}"
./listmonk --install --idempotent --yes --config ''
./listmonk --upgrade --yes --config ''
exec ./listmonk --config ''
