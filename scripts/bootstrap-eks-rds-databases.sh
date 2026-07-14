#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SQL_FILE="$ROOT_DIR/infra/eks/bootstrap/rds/bootstrap-databases.sql"

required_environment=(
  PGHOST
  PGUSER
  PGPASSWORD
  ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST
  ASKLAKE_APP_DB_PASSWORD
  AIRFLOW_APP_DB_PASSWORD
  ICEBERG_CATALOG_DB_PASSWORD
)

for key in "${required_environment[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    printf 'error: required environment variable is empty: %s\n' "$key" >&2
    exit 1
  fi
done

if [[ "$PGHOST" != "$ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST" ]]; then
  echo "error: PGHOST does not match ASKLAKE_RDS_BOOTSTRAP_EXPECTED_HOST" >&2
  exit 1
fi

if [[ "${PGDATABASE:-postgres}" != "postgres" ]]; then
  echo "error: PGDATABASE must be postgres so CREATE DATABASE runs outside an application database" >&2
  exit 1
fi

if [[ "${ASKLAKE_RDS_BOOTSTRAP_CONFIRM:-}" != "create-three-isolated-databases" ]]; then
  echo "error: set ASKLAKE_RDS_BOOTSTRAP_CONFIRM=create-three-isolated-databases after reviewing the target RDS endpoint" >&2
  exit 1
fi

export PGDATABASE=postgres
export PGPORT="${PGPORT:-5432}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"

case "$PGSSLMODE" in
  verify-full)
    if [[ -z "${PGSSLROOTCERT:-}" || ! -f "$PGSSLROOTCERT" ]]; then
      echo "error: PGSSLMODE=verify-full requires an existing PGSSLROOTCERT file" >&2
      exit 1
    fi
    ;;
  disable)
    if [[ "${ASKLAKE_RDS_BOOTSTRAP_ALLOW_INSECURE_LOCAL:-}" != "true" ]]; then
      echo "error: PGSSLMODE=disable is allowed only with ASKLAKE_RDS_BOOTSTRAP_ALLOW_INSECURE_LOCAL=true" >&2
      exit 1
    fi
    ;;
  *)
    echo "error: PGSSLMODE must be verify-full, or disable for an explicit local-only test" >&2
    exit 1
    ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql is required" >&2
  exit 1
fi

psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --file="$SQL_FILE"

printf '%s\n' \
  'RDS bootstrap completed:' \
  '- asklake_app / asklake_app' \
  '- airflow_metadata / airflow_app' \
  '- iceberg_catalog / iceberg_catalog'
