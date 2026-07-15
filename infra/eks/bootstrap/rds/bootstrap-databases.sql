\set ON_ERROR_STOP on

-- Passwords are read from the process environment and never passed as command
-- arguments or committed values.
\getenv asklake_app_password ASKLAKE_APP_DB_PASSWORD
\getenv airflow_app_password AIRFLOW_APP_DB_PASSWORD
\getenv iceberg_catalog_password ICEBERG_CATALOG_DB_PASSWORD

SELECT format('CREATE ROLE asklake_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'asklake_app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asklake_app')
\gexec

SELECT format('ALTER ROLE asklake_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'asklake_app_password')
\gexec

SELECT format('CREATE ROLE airflow_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'airflow_app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airflow_app')
\gexec

SELECT format('ALTER ROLE airflow_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'airflow_app_password')
\gexec

SELECT format('CREATE ROLE iceberg_catalog WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'iceberg_catalog_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iceberg_catalog')
\gexec

SELECT format('ALTER ROLE iceberg_catalog WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'iceberg_catalog_password')
\gexec

SELECT 'CREATE DATABASE asklake_app OWNER asklake_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'asklake_app')
\gexec

SELECT 'CREATE DATABASE airflow_metadata OWNER airflow_app'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'airflow_metadata')
\gexec

SELECT 'CREATE DATABASE iceberg_catalog OWNER iceberg_catalog'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'iceberg_catalog')
\gexec

ALTER DATABASE asklake_app OWNER TO asklake_app;
ALTER DATABASE airflow_metadata OWNER TO airflow_app;
ALTER DATABASE iceberg_catalog OWNER TO iceberg_catalog;

REVOKE CONNECT, TEMPORARY ON DATABASE asklake_app FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE airflow_metadata FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE iceberg_catalog FROM PUBLIC;

GRANT CONNECT, TEMPORARY ON DATABASE asklake_app TO asklake_app;
GRANT CONNECT, TEMPORARY ON DATABASE airflow_metadata TO airflow_app;
GRANT CONNECT, TEMPORARY ON DATABASE iceberg_catalog TO iceberg_catalog;
