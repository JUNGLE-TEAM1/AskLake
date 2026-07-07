SELECT 'CREATE DATABASE asklake_sources'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'asklake_sources'
)\gexec
