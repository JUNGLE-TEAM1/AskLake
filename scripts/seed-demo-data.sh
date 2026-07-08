#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env}"

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

echo "Seeding catalog metadata fixtures..."
"${COMPOSE[@]}" exec -T backend python -m app.seed.seed_pair2_demo </dev/null
"${COMPOSE[@]}" exec -T backend python -m app.seed.seed_mongo_demo </dev/null

echo "Seeding PostgreSQL source fixtures..."
"${COMPOSE[@]}" exec -T \
  -e ASKLAKE_SOURCE_POSTGRES_HOST="${ASKLAKE_SOURCE_POSTGRES_HOST:-postgres}" \
  -e ASKLAKE_SOURCE_POSTGRES_PORT="${ASKLAKE_SOURCE_POSTGRES_PORT:-5432}" \
  -e ASKLAKE_SOURCE_POSTGRES_DATABASE="${ASKLAKE_SOURCE_POSTGRES_DATABASE:-asklake_sources}" \
  -e ASKLAKE_SOURCE_POSTGRES_USER="${POSTGRES_USER:-}" \
  -e ASKLAKE_SOURCE_POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}" \
  backend node scripts/seed-demo-postgres.mjs </dev/null

if [[ "${ASKLAKE_SEED_DASHBOARD:-false}" == "true" ]]; then
  "${COMPOSE[@]}" exec -T backend python -m app.seed.seed_dashboard_demo </dev/null
fi

echo "Seeding MongoDB document fixtures..."
"${COMPOSE[@]}" exec -T \
  -e ASKLAKE_MONGO_HOST="${ASKLAKE_MONGO_HOST:-mongo}" \
  -e ASKLAKE_MONGO_PORT="${ASKLAKE_MONGO_PORT:-27017}" \
  -e ASKLAKE_MONGO_DATABASE="${MONGO_INITDB_DATABASE:-asklake_sources}" \
  -e ASKLAKE_MONGO_USER="${MONGO_INITDB_ROOT_USERNAME:-}" \
  -e ASKLAKE_MONGO_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD:-}" \
  backend node scripts/seed-demo-mongo.mjs </dev/null

echo "Demo seed complete."
