#!/bin/sh
set -eu

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
trino_user="${TRINO_ICEBERG_JDBC_USER:?TRINO_ICEBERG_JDBC_USER is required}"
: "${TRINO_ICEBERG_JDBC_PASSWORD:?TRINO_ICEBERG_JDBC_PASSWORD is required}"
if [ "$trino_user" = "${POSTGRES_USER:?POSTGRES_USER is required}" ] \
  && [ "${TRINO_ICEBERG_ALLOW_POSTGRES_USER:-false}" != "true" ]; then
  echo "TRINO_ICEBERG_JDBC_USER must be a dedicated PostgreSQL role" >&2
  exit 1
fi

psql \
  -h postgres \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB:?POSTGRES_DB is required}" \
  -v ON_ERROR_STOP=1 <<'SQL'
\getenv trino_user TRINO_ICEBERG_JDBC_USER
\getenv trino_password TRINO_ICEBERG_JDBC_PASSWORD

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'trino_user', :'trino_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'trino_user')
\gexec

SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'trino_user', :'trino_password')
\gexec

CREATE TABLE IF NOT EXISTS iceberg_tables (
  catalog_name VARCHAR(255) NOT NULL,
  table_namespace VARCHAR(255) NOT NULL,
  table_name VARCHAR(255) NOT NULL,
  metadata_location VARCHAR(1000),
  previous_metadata_location VARCHAR(1000),
  record_type VARCHAR(5),
  PRIMARY KEY (catalog_name, table_namespace, table_name)
);

ALTER TABLE iceberg_tables
  ADD COLUMN IF NOT EXISTS record_type VARCHAR(5);

CREATE TABLE IF NOT EXISTS iceberg_namespace_properties (
  catalog_name VARCHAR(255) NOT NULL,
  namespace VARCHAR(255) NOT NULL,
  property_key VARCHAR(255),
  property_value VARCHAR(1000),
  PRIMARY KEY (catalog_name, namespace, property_key)
);

SELECT format('ALTER TABLE iceberg_tables OWNER TO %I', :'trino_user')
\gexec
SELECT format('ALTER TABLE iceberg_namespace_properties OWNER TO %I', :'trino_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'trino_user')
\gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE iceberg_tables, iceberg_namespace_properties TO %I', :'trino_user')
\gexec
SQL
