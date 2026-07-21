#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="asklake-rds-bootstrap-test-$$"
SERVER="asklake-rds-bootstrap-postgres-$$"
POSTGRES_IMAGE="${ASKLAKE_RDS_TEST_IMAGE:-postgres:16-bookworm}"

cleanup() {
  docker rm -f "$SERVER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "error: Docker is required for the isolated RDS bootstrap verification" >&2
  exit 1
fi

expect_failure() {
  local expected_message="$1"
  shift
  local output

  if output="$("$@" 2>&1)"; then
    echo "error: expected bootstrap preflight failure: $expected_message" >&2
    exit 1
  fi

  if [[ "$output" != *"$expected_message"* ]]; then
    printf 'error: bootstrap failed for an unexpected reason: %s\n' "$output" >&2
    exit 1
  fi
}

common_preflight_environment=(
  PGUSER=bootstrap_admin
  PGPASSWORD=local-admin-password
  ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST=expected.local
  ASKLAKE_APP_DB_PASSWORD=local-asklake-password
  AIRFLOW_APP_DB_PASSWORD=local-airflow-password
  ICEBERG_CATALOG_DB_PASSWORD=local-iceberg-password
  ASKLAKE_RDS_BOOTSTRAP_CONFIRM=create-three-isolated-databases
)

expect_failure \
  "PGHOST does not match ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST" \
  env "${common_preflight_environment[@]}" \
  PGHOST=wrong.local \
  PGSSLMODE=disable \
  ASKLAKE_RDS_BOOTSTRAP_ALLOW_INSECURE_LOCAL=true \
  bash "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh"

expect_failure \
  "PGSSLMODE=verify-full requires an existing PGSSLROOTCERT file" \
  env "${common_preflight_environment[@]}" \
  PGHOST=expected.local \
  PGSSLMODE=verify-full \
  PGSSLROOTCERT="$ROOT_DIR/.missing-rds-ca.pem" \
  bash "$ROOT_DIR/scripts/bootstrap-eks-rds-databases.sh"

docker network create "$NETWORK" >/dev/null
docker run -d \
  --name "$SERVER" \
  --network "$NETWORK" \
  -e POSTGRES_PASSWORD=local-admin-password \
  "$POSTGRES_IMAGE" >/dev/null

ready=false
for _ in $(seq 1 30); do
  if docker exec "$SERVER" pg_isready -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != "true" ]]; then
  echo "error: isolated PostgreSQL did not become ready" >&2
  exit 1
fi

for _ in 1 2; do
  docker run --rm \
    --network "$NETWORK" \
    -v "$ROOT_DIR:/workspace" \
    -w /workspace \
    -e PGHOST="$SERVER" \
    -e PGUSER=postgres \
    -e PGPASSWORD=local-admin-password \
    -e ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST="$SERVER" \
    -e ASKLAKE_APP_DB_PASSWORD=local-asklake-password \
    -e AIRFLOW_APP_DB_PASSWORD=local-airflow-password \
    -e ICEBERG_CATALOG_DB_PASSWORD=local-iceberg-password \
    -e ASKLAKE_RDS_BOOTSTRAP_CONFIRM=create-three-isolated-databases \
    -e PGSSLMODE=disable \
    -e ASKLAKE_RDS_BOOTSTRAP_ALLOW_INSECURE_LOCAL=true \
    "$POSTGRES_IMAGE" \
    bash scripts/bootstrap-eks-rds-databases.sh >/dev/null
done

database_count="$(docker exec -e PGPASSWORD=local-admin-password "$SERVER" \
  psql -U postgres -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname IN ('asklake_app','airflow_metadata','iceberg_catalog');")"

if [[ "$database_count" != "3" ]]; then
  echo "error: expected exactly three application databases" >&2
  exit 1
fi

unsafe_role_count="$(docker exec -e PGPASSWORD=local-admin-password "$SERVER" \
  psql -U postgres -d postgres -Atc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('asklake_app','airflow_app','iceberg_catalog') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);")"

if [[ "$unsafe_role_count" != "0" ]]; then
  echo "error: application roles received administrative PostgreSQL privileges" >&2
  exit 1
fi

connect_contract="$(docker exec -e PGPASSWORD=local-admin-password "$SERVER" \
  psql -U postgres -d postgres -Atc \
  "SELECT has_database_privilege('asklake_app','asklake_app','CONNECT') AND NOT has_database_privilege('asklake_app','airflow_metadata','CONNECT') AND NOT has_database_privilege('asklake_app','iceberg_catalog','CONNECT') AND has_database_privilege('airflow_app','airflow_metadata','CONNECT') AND NOT has_database_privilege('airflow_app','asklake_app','CONNECT') AND NOT has_database_privilege('airflow_app','iceberg_catalog','CONNECT') AND has_database_privilege('iceberg_catalog','iceberg_catalog','CONNECT') AND NOT has_database_privilege('iceberg_catalog','asklake_app','CONNECT') AND NOT has_database_privilege('iceberg_catalog','airflow_metadata','CONNECT');")"

if [[ "$connect_contract" != "t" ]]; then
  echo "error: application database CONNECT isolation is invalid" >&2
  exit 1
fi

echo "EKS RDS bootstrap verification passed."
