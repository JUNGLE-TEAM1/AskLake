#!/usr/bin/env bash
set -euo pipefail

database="${CLICKHOUSE_DB:-asklake_realtime_v2}"
case "${database}" in
  ""|[0-9]*|*[!A-Za-z0-9_]*)
    echo "CLICKHOUSE_DB must be a safe ClickHouse identifier" >&2
    exit 1
    ;;
esac
database_normalized="$(printf '%s' "${database}" | tr '[:upper:]' '[:lower:]')"
case "${database_normalized}" in
  default|information_schema|system)
    echo "CLICKHOUSE_DB must not use a built-in or reserved database name" >&2
    exit 1
    ;;
esac

admin_user="${CLICKHOUSE_USER:-}"
case "${admin_user}" in
  ""|[0-9]*|*[!A-Za-z0-9_]*)
    echo "CLICKHOUSE_USER must be a safe ClickHouse identifier" >&2
    exit 1
    ;;
esac
admin_user_normalized="$(printf '%s' "${admin_user}" | tr '[:upper:]' '[:lower:]')"
case "${admin_user_normalized}" in
  asklake_v2_ingest|asklake_v2_materializer|asklake_v2_reader|asklake_v2_migration|asklake_v2_observer|\
  asklake_v2_ingest_role|asklake_v2_materializer_role|asklake_v2_reader_role|asklake_v2_migration_role|asklake_v2_observer_role)
    echo "CLICKHOUSE_USER must be distinct from fixed runtime users and roles" >&2
    exit 1
    ;;
esac

require_secret() {
  local name="$1"
  local value="$2"
  if [[ ${#value} -lt 16 || "${value}" == *replace-with-* ]]; then
    echo "${name} must be a non-placeholder secret with at least 16 characters" >&2
    exit 1
  fi
}

require_secret CLICKHOUSE_V2_INGEST_PASSWORD "${CLICKHOUSE_V2_INGEST_PASSWORD:-}"
require_secret CLICKHOUSE_V2_MATERIALIZER_PASSWORD "${CLICKHOUSE_V2_MATERIALIZER_PASSWORD:-}"
require_secret CLICKHOUSE_V2_READER_PASSWORD "${CLICKHOUSE_V2_READER_PASSWORD:-}"
require_secret CLICKHOUSE_V2_MIGRATION_PASSWORD "${CLICKHOUSE_V2_MIGRATION_PASSWORD:-}"
require_secret CLICKHOUSE_V2_OBSERVER_PASSWORD "${CLICKHOUSE_V2_OBSERVER_PASSWORD:-}"
require_secret CLICKHOUSE_PASSWORD "${CLICKHOUSE_PASSWORD:-}"

secret_values=(
  "${CLICKHOUSE_PASSWORD}"
  "${CLICKHOUSE_V2_INGEST_PASSWORD}"
  "${CLICKHOUSE_V2_MATERIALIZER_PASSWORD}"
  "${CLICKHOUSE_V2_READER_PASSWORD}"
  "${CLICKHOUSE_V2_MIGRATION_PASSWORD}"
  "${CLICKHOUSE_V2_OBSERVER_PASSWORD}"
)
for left_index in "${!secret_values[@]}"; do
  for right_index in "${!secret_values[@]}"; do
    if (( left_index < right_index )) \
      && [[ "${secret_values[$left_index]}" == "${secret_values[$right_index]}" ]]; then
      echo "ClickHouse V2 account passwords must be pairwise distinct" >&2
      exit 1
    fi
  done
done

hash_secret() {
  printf '%s' "$1" | sha256sum | awk '{print $1}'
}

ingest_hash="$(hash_secret "${CLICKHOUSE_V2_INGEST_PASSWORD}")"
materializer_hash="$(hash_secret "${CLICKHOUSE_V2_MATERIALIZER_PASSWORD}")"
reader_hash="$(hash_secret "${CLICKHOUSE_V2_READER_PASSWORD}")"
migration_hash="$(hash_secret "${CLICKHOUSE_V2_MIGRATION_PASSWORD}")"
observer_hash="$(hash_secret "${CLICKHOUSE_V2_OBSERVER_PASSWORD}")"

client_args=(
  --user "${admin_user}"
  --password "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"
)
client_args+=(--host 127.0.0.1 --port 9000)

clickhouse-client "${client_args[@]}" \
  --multiquery <<SQL
CREATE ROLE IF NOT EXISTS asklake_v2_ingest_role;
CREATE ROLE IF NOT EXISTS asklake_v2_materializer_role;
CREATE ROLE IF NOT EXISTS asklake_v2_reader_role;
CREATE ROLE IF NOT EXISTS asklake_v2_migration_role;
CREATE ROLE IF NOT EXISTS asklake_v2_observer_role;

REVOKE ALL ON *.* FROM asklake_v2_ingest_role;
REVOKE ALL ON *.* FROM asklake_v2_materializer_role;
REVOKE ALL ON *.* FROM asklake_v2_reader_role;
REVOKE ALL ON *.* FROM asklake_v2_migration_role;
REVOKE ALL ON *.* FROM asklake_v2_observer_role;

GRANT SELECT, INSERT ON \`${database}\`.* TO asklake_v2_ingest_role;
GRANT SELECT, INSERT ON \`${database}\`.* TO asklake_v2_materializer_role;
GRANT SELECT ON \`${database}\`.* TO asklake_v2_reader_role;
GRANT SELECT, INSERT, CREATE TABLE, CREATE VIEW, ALTER TABLE, DROP TABLE, DROP VIEW, TRUNCATE ON \`${database}\`.* TO asklake_v2_migration_role;
GRANT SELECT ON system.metrics TO asklake_v2_observer_role;
GRANT SELECT ON system.events TO asklake_v2_observer_role;
GRANT SELECT ON system.asynchronous_metrics TO asklake_v2_observer_role;
GRANT SELECT ON system.parts TO asklake_v2_observer_role;
GRANT SELECT ON system.merges TO asklake_v2_observer_role;
GRANT SELECT ON system.replicas TO asklake_v2_observer_role;

ALTER ROLE asklake_v2_ingest_role SETTINGS max_execution_time = 300, max_memory_usage = 4000000000;
ALTER ROLE asklake_v2_materializer_role SETTINGS max_execution_time = 900, max_memory_usage = 8000000000;
ALTER ROLE asklake_v2_reader_role SETTINGS readonly = 1, max_execution_time = 60, max_result_rows = 100000, max_rows_to_read = 10000000;
ALTER ROLE asklake_v2_migration_role SETTINGS max_execution_time = 900, max_memory_usage = 8000000000;
ALTER ROLE asklake_v2_observer_role SETTINGS readonly = 1, max_execution_time = 15, max_result_rows = 10000, max_rows_to_read = 1000000, max_threads = 2;

CREATE USER IF NOT EXISTS asklake_v2_ingest IDENTIFIED WITH sha256_hash BY '${ingest_hash}';
CREATE USER IF NOT EXISTS asklake_v2_materializer IDENTIFIED WITH sha256_hash BY '${materializer_hash}';
CREATE USER IF NOT EXISTS asklake_v2_reader IDENTIFIED WITH sha256_hash BY '${reader_hash}';
CREATE USER IF NOT EXISTS asklake_v2_migration IDENTIFIED WITH sha256_hash BY '${migration_hash}';
CREATE USER IF NOT EXISTS asklake_v2_observer IDENTIFIED WITH sha256_hash BY '${observer_hash}';

ALTER USER asklake_v2_ingest IDENTIFIED WITH sha256_hash BY '${ingest_hash}';
ALTER USER asklake_v2_materializer IDENTIFIED WITH sha256_hash BY '${materializer_hash}';
ALTER USER asklake_v2_reader IDENTIFIED WITH sha256_hash BY '${reader_hash}';
ALTER USER asklake_v2_migration IDENTIFIED WITH sha256_hash BY '${migration_hash}';
ALTER USER asklake_v2_observer IDENTIFIED WITH sha256_hash BY '${observer_hash}';

GRANT asklake_v2_ingest_role TO asklake_v2_ingest;
GRANT asklake_v2_materializer_role TO asklake_v2_materializer;
GRANT asklake_v2_reader_role TO asklake_v2_reader;
GRANT asklake_v2_migration_role TO asklake_v2_migration;
GRANT asklake_v2_observer_role TO asklake_v2_observer;

ALTER USER asklake_v2_ingest DEFAULT ROLE asklake_v2_ingest_role;
ALTER USER asklake_v2_materializer DEFAULT ROLE asklake_v2_materializer_role;
ALTER USER asklake_v2_reader DEFAULT ROLE asklake_v2_reader_role;
ALTER USER asklake_v2_migration DEFAULT ROLE asklake_v2_migration_role;
ALTER USER asklake_v2_observer DEFAULT ROLE asklake_v2_observer_role;
SQL
