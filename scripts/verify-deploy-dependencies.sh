#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env.example}"
BACKEND_IMAGE="${ASKLAKE_VERIFY_BACKEND_IMAGE:-asklake-backend-deploy-check:local}"
FRONTEND_IMAGE="${ASKLAKE_VERIFY_FRONTEND_IMAGE:-asklake-frontend-deploy-check:local}"
SPARK_IMAGE="${ASKLAKE_SPARK_IMAGE:-apache/spark:4.0.1}"

cd "$ROOT_DIR"

need_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: missing command: $1" >&2
    exit 1
  }
}

need_command docker

echo "Checking production Compose dependency graph..."
docker compose --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null

echo "Building backend deploy image..."
docker build -t "$BACKEND_IMAGE" backend

echo "Checking backend Python runtime imports..."
docker run --rm "$BACKEND_IMAGE" python -c \
  "import duckdb, fastapi, psycopg, pydantic_settings, sqlalchemy, uvicorn"

echo "Checking backend Node connector imports..."
docker run --rm "$BACKEND_IMAGE" node --input-type=module -e \
  "await import('@aws-sdk/client-s3'); await import('kafkajs'); await import('mongodb'); await import('parquetjs-lite'); await import('pg');"

echo "Checking backend Docker CLI for Spark runner..."
docker run --rm "$BACKEND_IMAGE" docker --version >/dev/null

echo "Checking Spark runtime image availability..."
if ! docker image inspect "$SPARK_IMAGE" >/dev/null 2>&1; then
  docker pull "$SPARK_IMAGE"
fi

echo "Building frontend deploy image..."
docker build \
  --build-arg VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://localhost:8080}" \
  --build-arg VITE_USE_MOCK_API="${VITE_USE_MOCK_API:-false}" \
  --build-arg VITE_DASHBOARD_ASSISTANT_API_PATH="${VITE_DASHBOARD_ASSISTANT_API_PATH:-/api/dashboards/assistant}" \
  -t "$FRONTEND_IMAGE" frontend

echo "Deploy dependency verification passed."
