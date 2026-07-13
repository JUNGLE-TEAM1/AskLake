#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ASKLAKE_COMPOSE_FILE:-deploy/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${ASKLAKE_COMPOSE_ENV_FILE:-deploy/.env.example}"
LOCAL_COMPOSE_FILE="${ASKLAKE_LOCAL_COMPOSE_FILE:-docker-compose.yml}"
BACKEND_IMAGE="${ASKLAKE_VERIFY_BACKEND_IMAGE:-asklake-backend-deploy-check:local}"
SPARK_RUNTIME_IMAGE="${ASKLAKE_VERIFY_SPARK_RUNTIME_IMAGE:-asklake-spark-deploy-check:local}"
FRONTEND_IMAGE="${ASKLAKE_VERIFY_FRONTEND_IMAGE:-asklake-frontend-deploy-check:local}"
SPARK_IMAGE="${ASKLAKE_SPARK_IMAGE:-apache/spark:4.0.1}"
AIRFLOW_IMAGE="${AIRFLOW_IMAGE_NAME:-apache/airflow:3.3.0}"
FRONTEND_API_BASE_URL="${VITE_API_BASE_URL:-https://${APP_DOMAIN:-asklake.example.com}}"

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

echo "Checking local Airflow orchestration Compose graph..."
docker compose -f "$LOCAL_COMPOSE_FILE" config >/dev/null

echo "Building backend deploy image..."
docker build -t "$BACKEND_IMAGE" backend

echo "Checking backend Python runtime imports..."
docker run --rm "$BACKEND_IMAGE" python -c \
  "import duckdb, fastapi, psycopg, pydantic_settings, sqlalchemy, uvicorn"

echo "Checking backend Node connector imports..."
docker run --rm "$BACKEND_IMAGE" npm run verify:node-dependencies

echo "Checking backend image excludes Docker CLI..."
if docker run --rm "$BACKEND_IMAGE" sh -c 'command -v docker' >/dev/null 2>&1; then
  echo "error: production backend image must not contain Docker CLI" >&2
  exit 1
fi

echo "Building Spark runtime image..."
docker build --target spark-runtime -t "$SPARK_RUNTIME_IMAGE" backend

echo "Checking Spark runtime UID and embedded scripts..."
docker run --rm "$SPARK_RUNTIME_IMAGE" sh -c \
  'test "$(id -u)" = 185 && test -r /opt/asklake/scripts/spark_job_run.py && test -r /opt/asklake/scripts/spark_source_inspect_rest.py'

echo "Checking Spark runtime image availability..."
if ! docker image inspect "$SPARK_IMAGE" >/dev/null 2>&1; then
  docker pull "$SPARK_IMAGE"
fi

echo "Checking Airflow runtime image availability..."
if ! docker image inspect "$AIRFLOW_IMAGE" >/dev/null 2>&1; then
  docker pull "$AIRFLOW_IMAGE"
fi

echo "Checking Airflow DAG import dependencies..."
DAG_SOURCE="$ROOT_DIR/airflow/dags"
if command -v cygpath >/dev/null 2>&1; then
  DAG_SOURCE="$(cygpath -m "$DAG_SOURCE")"
fi
MSYS_NO_PATHCONV=1 docker run --rm \
  --mount "type=bind,source=$DAG_SOURCE,target=/opt/airflow/dags,readonly" \
  "$AIRFLOW_IMAGE" \
  python -c "import importlib.util; spec = importlib.util.spec_from_file_location('asklake_etl_job', '/opt/airflow/dags/asklake_etl_job.py'); module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)"

echo "Building frontend deploy image..."
if [[ "$FRONTEND_API_BASE_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:|/|$) ]]; then
  echo "error: production frontend build API origin must not target localhost; set VITE_API_BASE_URL to https://APP_DOMAIN" >&2
  exit 1
fi
docker build \
  --build-arg VITE_API_BASE_URL="$FRONTEND_API_BASE_URL" \
  --build-arg VITE_USE_MOCK_API="${VITE_USE_MOCK_API:-false}" \
  --build-arg VITE_DASHBOARD_ASSISTANT_API_PATH="${VITE_DASHBOARD_ASSISTANT_API_PATH:-/api/dashboards/assistant}" \
  --build-arg VITE_OBJECT_STORAGE_PROVIDER="${VITE_OBJECT_STORAGE_PROVIDER:-aws}" \
  --build-arg VITE_S3_REGION="${VITE_S3_REGION:-ap-northeast-2}" \
  -t "$FRONTEND_IMAGE" frontend

echo "Deploy dependency verification passed."
