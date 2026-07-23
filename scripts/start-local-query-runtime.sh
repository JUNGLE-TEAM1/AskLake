#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
MODE="${1:-run}"

case "$MODE" in
  run|--prepare-only|--check) ;;
  *)
    echo "Usage: $0 [run|--prepare-only|--check]" >&2
    exit 2
    ;;
esac

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is missing: $1" >&2
    exit 1
  }
}

require_command curl
require_command docker

PYTHON_BIN="${ASKLAKE_FASTAPI_PYTHON:-$BACKEND_DIR/.venv/bin/python}"
if [ ! -x "$PYTHON_BIN" ]; then
  echo "Backend Python runtime is missing: $PYTHON_BIN" >&2
  exit 1
fi

existing_project=""
if docker inspect m3-minio >/dev/null 2>&1; then
  existing_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' m3-minio 2>/dev/null || true)"
fi
COMPOSE_PROJECT_NAME="${ASKLAKE_COMPOSE_PROJECT_NAME:-${existing_project:-asklake}}"

detect_runtime_network() {
  local container networks preferred
  for container in asklake-spark-master m3-minio asklake-postgres; do
    if ! docker inspect "$container" >/dev/null 2>&1; then
      continue
    fi
    networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")"
    preferred="$(printf '%s\n' "$networks" | tr ' ' '\n' | awk '/^asklake_default$/{print; exit}')"
    if [ -n "$preferred" ]; then
      printf '%s' "$preferred"
      return
    fi
    preferred="$(printf '%s\n' "$networks" | tr ' ' '\n' | awk -v project="$COMPOSE_PROJECT_NAME" '$0 == project "_default" {print; exit}')"
    if [ -n "$preferred" ]; then
      printf '%s' "$preferred"
      return
    fi
  done
  printf '%s_default' "$COMPOSE_PROJECT_NAME"
}

ensure_runtime_network_attachment() {
  local container="$1"
  shift
  local networks
  networks="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$container")"
  if printf '%s\n' "$networks" | grep -Fxq "$ASKLAKE_DOCKER_NETWORK"; then
    return
  fi
  docker network inspect "$ASKLAKE_DOCKER_NETWORK" >/dev/null
  docker network connect "$@" "$ASKLAKE_DOCKER_NETWORK" "$container"
}

export APP_ENV="${APP_ENV:-local}"
export DATABASE_URL="${DATABASE_URL:-postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake}"
export ASKLAKE_FASTAPI_PYTHON="$PYTHON_BIN"
export PYTHONPATH="$BACKEND_DIR${PYTHONPATH:+:$PYTHONPATH}"
export ASKLAKE_DOCKER_NETWORK="${ASKLAKE_DOCKER_NETWORK:-$(detect_runtime_network)}"
export ASKLAKE_OBJECT_STORAGE_PROVIDER="${ASKLAKE_OBJECT_STORAGE_PROVIDER:-minio}"
export ASKLAKE_SPARK_OUTPUT_MODE="${ASKLAKE_SPARK_OUTPUT_MODE:-s3a}"
export ASKLAKE_SPARK_RUNNER="${ASKLAKE_SPARK_RUNNER:-docker}"
export ASKLAKE_KAFKA_BROKER_IN_DOCKER="${ASKLAKE_KAFKA_BROKER_IN_DOCKER:-asklake-redpanda:9092}"
export MINIO_ENDPOINT="${MINIO_ENDPOINT:-http://127.0.0.1:9000}"
export MINIO_ENDPOINT_IN_DOCKER="${MINIO_ENDPOINT_IN_DOCKER:-http://m3-minio:9000}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-m3admin}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-wishuponastar}"
export MINIO_BUCKET="${MINIO_BUCKET:-asklake-output}"
export MINIO_REGION="${MINIO_REGION:-us-east-1}"
export AIRFLOW_API_BASE_URL="${AIRFLOW_API_BASE_URL:-http://127.0.0.1:8081}"
export AIRFLOW_DAG_ID="${AIRFLOW_DAG_ID:-asklake_etl_job}"
export AIRFLOW_UI_BASE_URL="${AIRFLOW_UI_BASE_URL:-http://127.0.0.1:8081}"
export AIRFLOW_USERNAME="${AIRFLOW_USERNAME:-airflow}"
export AIRFLOW_PASSWORD="${AIRFLOW_PASSWORD:-airflow}"
export AIRFLOW_EXECUTION_API_TOKEN="${AIRFLOW_EXECUTION_API_TOKEN:-asklake-local-airflow-execution}"
export AIRFLOW_INTERNAL_TOKEN="${AIRFLOW_INTERNAL_TOKEN:-asklake-local-airflow-token}"
export TRINO_ENABLED="${TRINO_ENABLED:-true}"
export TRINO_BASE_URL="${TRINO_BASE_URL:-http://127.0.0.1:8088}"
export TRINO_CATALOG="${TRINO_CATALOG:-iceberg}"
export TRINO_SCHEMA="${TRINO_SCHEMA:-asklake}"
export TRINO_USER="${TRINO_USER:-asklake-api}"
export TRINO_RESULT_STORAGE_BUCKET="${TRINO_RESULT_STORAGE_BUCKET:-asklake-query-results}"
export TRINO_RESULT_STORAGE_PREFIX="${TRINO_RESULT_STORAGE_PREFIX:-query-results}"
export TRINO_RESULT_STORAGE_AUTO_CREATE_BUCKET="${TRINO_RESULT_STORAGE_AUTO_CREATE_BUCKET:-true}"
export TRINO_RESULT_STORAGE_ACCESS_KEY="${TRINO_RESULT_STORAGE_ACCESS_KEY:-asklake-query-results}"
export TRINO_RESULT_STORAGE_SECRET_KEY="${TRINO_RESULT_STORAGE_SECRET_KEY:-asklake-query-results-local-secret}"
export TRINO_ICEBERG_CATALOG_NAME="${TRINO_ICEBERG_CATALOG_NAME:-asklake}"
export TRINO_ICEBERG_JDBC_DATABASE="${TRINO_ICEBERG_JDBC_DATABASE:-asklake}"
export TRINO_ICEBERG_JDBC_USER="${TRINO_ICEBERG_JDBC_USER:-asklake}"
export TRINO_ICEBERG_JDBC_PASSWORD="${TRINO_ICEBERG_JDBC_PASSWORD:-asklake_dev}"
export TRINO_ICEBERG_WAREHOUSE_BUCKET="${TRINO_ICEBERG_WAREHOUSE_BUCKET:-asklake-warehouse}"
export TRINO_ICEBERG_WAREHOUSE_PREFIX="${TRINO_ICEBERG_WAREHOUSE_PREFIX:-warehouse}"
export ASKLAKE_SPARK_ICEBERG_JDBC_URL="${ASKLAKE_SPARK_ICEBERG_JDBC_URL:-jdbc:postgresql://asklake-postgres:5432/asklake}"
export ASKLAKE_SPARK_ICEBERG_JDBC_USER="${ASKLAKE_SPARK_ICEBERG_JDBC_USER:-asklake}"
export ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD="${ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD:-asklake_dev}"
export ASKLAKE_SPARK_ICEBERG_WAREHOUSE="${ASKLAKE_SPARK_ICEBERG_WAREHOUSE:-s3a://asklake-warehouse/warehouse}"

echo "Compose project: $COMPOSE_PROJECT_NAME"
echo "Docker runtime network: $ASKLAKE_DOCKER_NETWORK"
echo "Metadata database: ${DATABASE_URL##*/}"

if [ "$MODE" = "--check" ]; then
  curl -fsS "$MINIO_ENDPOINT/minio/health/live" >/dev/null
  curl -fsS "$TRINO_BASE_URL/v1/info" >/dev/null
  echo "Local query runtime dependencies are reachable."
  exit 0
fi

if [ "$MODE" = "run" ]; then
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 8080 is already in use. Stop the existing backend before running this script." >&2
    exit 1
  fi
  if command -v pgrep >/dev/null 2>&1 && pgrep -f "$BACKEND_DIR/scripts/collect-trino-results.py" >/dev/null 2>&1; then
    echo "A Trino result collector for this repository is already running. Stop it before running this script." >&2
    exit 1
  fi
fi

docker compose -p "$COMPOSE_PROJECT_NAME" up -d postgres minio
ensure_runtime_network_attachment m3-minio --alias m3-minio --alias minio
ensure_runtime_network_attachment asklake-postgres --alias asklake-postgres --alias postgres

for _ in $(seq 1 60); do
  if curl -fsS "$MINIO_ENDPOINT/minio/health/live" >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "$MINIO_ENDPOINT/minio/health/live" >/dev/null

docker compose -p "$COMPOSE_PROJECT_NAME" run -T --rm --no-deps trino-storage-bootstrap
docker compose -p "$COMPOSE_PROJECT_NAME" run -T --rm --no-deps trino-postgres-bootstrap
docker compose -p "$COMPOSE_PROJECT_NAME" up -d --no-deps trino

for _ in $(seq 1 60); do
  if curl -fsS "$MINIO_ENDPOINT/minio/health/live" >/dev/null \
    && curl -fsS "$TRINO_BASE_URL/v1/info" >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS "$MINIO_ENDPOINT/minio/health/live" >/dev/null
curl -fsS "$TRINO_BASE_URL/v1/info" >/dev/null

if [ "$MODE" = "--prepare-only" ]; then
  echo "Local query runtime infrastructure and storage bootstrap are ready."
  exit 0
fi

cd "$BACKEND_DIR"
backend_pid=""
collector_pid=""

shutdown() {
  trap - INT TERM EXIT
  [ -z "$collector_pid" ] || kill -TERM "$collector_pid" >/dev/null 2>&1 || true
  [ -z "$backend_pid" ] || kill -TERM "$backend_pid" >/dev/null 2>&1 || true
  [ -z "$collector_pid" ] || wait "$collector_pid" 2>/dev/null || true
  [ -z "$backend_pid" ] || wait "$backend_pid" 2>/dev/null || true
}
trap shutdown INT TERM EXIT

"$PYTHON_BIN" -m uvicorn app.main:app --host 127.0.0.1 --port 8080 &
backend_pid=$!
"$PYTHON_BIN" "$BACKEND_DIR/scripts/collect-trino-results.py" &
collector_pid=$!

echo "Backend PID: $backend_pid"
echo "Trino collector PID: $collector_pid"

while kill -0 "$backend_pid" >/dev/null 2>&1 && kill -0 "$collector_pid" >/dev/null 2>&1; do
  sleep 1
done

if ! kill -0 "$backend_pid" >/dev/null 2>&1; then
  wait "$backend_pid"
else
  wait "$collector_pid"
fi
