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

database_count="$(psql -X --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) FROM pg_database WHERE datname IN ('asklake_app','airflow_metadata','iceberg_catalog');")"

if [[ "$database_count" != "3" ]]; then
  echo "error: expected exactly three isolated application databases" >&2
  exit 1
fi

unsafe_role_count="$(psql -X --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="SELECT count(*) FROM pg_roles WHERE rolname IN ('asklake_app','airflow_app','iceberg_catalog') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);")"

if [[ "$unsafe_role_count" != "0" ]]; then
  echo "error: application roles received administrative PostgreSQL privileges" >&2
  exit 1
fi

connect_contract="$(psql -X --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="SELECT has_database_privilege('asklake_app','asklake_app','CONNECT') AND NOT has_database_privilege('asklake_app','airflow_metadata','CONNECT') AND NOT has_database_privilege('asklake_app','iceberg_catalog','CONNECT') AND has_database_privilege('airflow_app','airflow_metadata','CONNECT') AND NOT has_database_privilege('airflow_app','asklake_app','CONNECT') AND NOT has_database_privilege('airflow_app','iceberg_catalog','CONNECT') AND has_database_privilege('iceberg_catalog','iceberg_catalog','CONNECT') AND NOT has_database_privilege('iceberg_catalog','asklake_app','CONNECT') AND NOT has_database_privilege('iceberg_catalog','airflow_metadata','CONNECT');")"

if [[ "$connect_contract" != "t" ]]; then
  echo "error: application database CONNECT isolation is invalid" >&2
  exit 1
fi

verify_login() {
  local role="$1"
  local password="$2"
  local database="$3"

  PGUSER="$role" PGPASSWORD="$password" PGDATABASE="$database" \
    psql -X --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --command="SELECT 1;" >/dev/null
}

reject_cross_database_login() {
  local role="$1"
  local password="$2"
  local database="$3"

  if PGUSER="$role" PGPASSWORD="$password" PGDATABASE="$database" \
    psql -X --no-psqlrc --set=ON_ERROR_STOP=1 --command="SELECT 1;" \
    >/dev/null 2>&1; then
    printf 'error: role %s unexpectedly connected to database %s\n' "$role" "$database" >&2
    exit 1
  fi
}

verify_login asklake_app "$ASKLAKE_APP_DB_PASSWORD" asklake_app
verify_login airflow_app "$AIRFLOW_APP_DB_PASSWORD" airflow_metadata
verify_login iceberg_catalog "$ICEBERG_CATALOG_DB_PASSWORD" iceberg_catalog

reject_cross_database_login asklake_app "$ASKLAKE_APP_DB_PASSWORD" airflow_metadata
reject_cross_database_login airflow_app "$AIRFLOW_APP_DB_PASSWORD" iceberg_catalog
reject_cross_database_login iceberg_catalog "$ICEBERG_CATALOG_DB_PASSWORD" asklake_app

printf '%s\n' \
  'RDS bootstrap completed:' \
  '- asklake_app / asklake_app' \
  '- airflow_metadata / airflow_app' \
  '- iceberg_catalog / iceberg_catalog'
