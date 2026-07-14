CREATE TABLE IF NOT EXISTS dataset_freshness (
  dataset_id VARCHAR(120) PRIMARY KEY,
  latest_revision BIGINT NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
  latest_run_id VARCHAR(160),
  next_check_after_ms INTEGER NOT NULL DEFAULT 5000 CHECK (next_check_after_ms BETWEEN 5000 AND 60000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dataset_revision_commits (
  dataset_id VARCHAR(120) NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  run_id VARCHAR(160) NOT NULL,
  storage_location VARCHAR(2048) NOT NULL,
  storage_format VARCHAR(32) NOT NULL DEFAULT 'parquet',
  materialization_mode VARCHAR(32) NOT NULL DEFAULT 'delta',
  commit_kind VARCHAR(32) NOT NULL DEFAULT 'legacy',
  row_count BIGINT NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  source_ranges JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_fingerprint VARCHAR(64),
  manifest_location VARCHAR(2048),
  committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_id, revision),
  CONSTRAINT dataset_revision_commits_run_id_uq UNIQUE (run_id)
);

CREATE INDEX IF NOT EXISTS dataset_revision_commits_dataset_revision_idx
  ON dataset_revision_commits (dataset_id, revision);

CREATE UNIQUE INDEX IF NOT EXISTS dataset_revision_commits_source_fingerprint_uq
  ON dataset_revision_commits (dataset_id, commit_kind, source_fingerprint)
  WHERE source_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS dataset_kafka_partition_cursors (
  dataset_id VARCHAR(120) NOT NULL,
  commit_kind VARCHAR(32) NOT NULL,
  topic VARCHAR(512) NOT NULL,
  partition INTEGER NOT NULL CHECK (partition >= 0),
  next_offset BIGINT NOT NULL CHECK (next_offset >= 0),
  updated_revision BIGINT NOT NULL CHECK (updated_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dataset_id, commit_kind, topic, partition)
);

CREATE TABLE IF NOT EXISTS dashboard_live_schema_migrations (
  version VARCHAR(96) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dashboard_live_schema_migrations (version)
VALUES ('20260714_kafka_partition_cursor_v1')
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS dashboard_widget_results (
  widget_id VARCHAR(64) NOT NULL,
  calculation_version VARCHAR(64) NOT NULL,
  dataset_id VARCHAR(120) NOT NULL,
  applied_revision BIGINT NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculation_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  calculation_mode VARCHAR(32) NOT NULL DEFAULT 'full',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (widget_id, calculation_version)
);

CREATE INDEX IF NOT EXISTS dashboard_widget_results_dataset_revision_idx
  ON dashboard_widget_results (dataset_id, applied_revision);
