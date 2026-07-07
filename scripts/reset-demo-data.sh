#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: scripts/reset-demo-data.sh [--dry-run]" >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ ! -f "$COMPOSE_ENV_FILE" ]]; then
  echo "error: missing compose env file: $COMPOSE_ENV_FILE" >&2
  echo "copy deploy/.env.example to deploy/.env and fill secrets first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$COMPOSE_ENV_FILE"
set +a

COMPOSE=(docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
RESET_ARGS=()
if [[ "$DRY_RUN" == "true" ]]; then
  RESET_ARGS+=(--dry-run)
fi

"${COMPOSE[@]}" exec -T backend python -m app.seed.reset_demo_data "${RESET_ARGS[@]}" </dev/null

if [[ "$DRY_RUN" == "false" && "${ASKLAKE_RESET_MONGO_FIXTURES:-false}" == "true" ]]; then
  echo "Deleting MongoDB base fixture documents because ASKLAKE_RESET_MONGO_FIXTURES=true..."
  "${COMPOSE[@]}" exec -T \
    -e ASKLAKE_MONGO_HOST="${ASKLAKE_MONGO_HOST:-mongo}" \
    -e ASKLAKE_MONGO_PORT="${ASKLAKE_MONGO_PORT:-27017}" \
    -e ASKLAKE_MONGO_DATABASE="${MONGO_INITDB_DATABASE:-asklake_sources}" \
    -e ASKLAKE_MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-}" \
    -e ASKLAKE_MONGO_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD:-}" \
    backend node scripts/seed-demo-mongo.mjs --delete </dev/null
fi

echo "Demo reset command complete."
