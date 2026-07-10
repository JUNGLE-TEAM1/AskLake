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

BROKER="${ASKLAKE_KAFKA_DEMO_BROKER:-redpanda:9092}"
TOPIC="${ASKLAKE_KAFKA_DEMO_TOPIC:-reviews.raw}"
LIMIT="${ASKLAKE_KAFKA_DEMO_LIMIT:-100}"
RATE="${ASKLAKE_KAFKA_DEMO_RATE:-100}"
BATCH_SIZE="${ASKLAKE_KAFKA_DEMO_BATCH_SIZE:-10}"
PROGRESS_EVERY="${ASKLAKE_KAFKA_DEMO_PROGRESS_EVERY:-100}"
INPUT="${ASKLAKE_KAFKA_DEMO_INPUT:-}"
DRY_RUN="${ASKLAKE_KAFKA_DEMO_DRY_RUN:-false}"
RECREATE_TOPIC="${ASKLAKE_KAFKA_DEMO_RECREATE_TOPIC:-true}"

ARGS=(
  "--broker" "$BROKER"
  "--topic" "$TOPIC"
  "--limit" "$LIMIT"
  "--rate" "$RATE"
  "--batch-size" "$BATCH_SIZE"
  "--progress-every" "$PROGRESS_EVERY"
)

if [[ -n "$INPUT" ]]; then
  ARGS+=("--input" "$INPUT")
fi

if [[ "$DRY_RUN" == "true" ]]; then
  ARGS+=("--dry-run")
fi

if [[ "$RECREATE_TOPIC" == "false" ]]; then
  ARGS+=("--no-recreate-topic")
fi

echo "Seeding Kafka review demo data..."
echo "Broker: $BROKER"
echo "Topic: $TOPIC"
echo "Limit: $LIMIT"
echo "Rate: $RATE messages/sec"
echo "Batch size: $BATCH_SIZE"

"${COMPOSE[@]}" up -d redpanda
"${COMPOSE[@]}" exec -T backend npm run kafka:reviews-replay -- "${ARGS[@]}" </dev/null

echo "Kafka review demo seed complete."
