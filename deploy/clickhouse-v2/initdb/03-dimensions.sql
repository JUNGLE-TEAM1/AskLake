CREATE TABLE IF NOT EXISTS asklake_realtime_v2.dimension_current_v2
(
    scope_id LowCardinality(String) DEFAULT 'deployment',
    dimension_dataset_id String,
    dimension_version_id String,
    dimension_key String,
    payload String,
    row_version UInt64,
    published_at DateTime64(6, 'UTC') DEFAULT now64(6),
    CONSTRAINT deployment_scope CHECK scope_id = 'deployment'
)
ENGINE = ReplicatedReplacingMergeTree('/asklake/realtime-v2/dimension-current/{shard}', '{replica}', row_version)
ORDER BY (scope_id, dimension_dataset_id, dimension_version_id, dimension_key);

CREATE VIEW IF NOT EXISTS asklake_realtime_v2.dimension_current_v2_latest AS
SELECT
    d.scope_id,
    d.dimension_dataset_id,
    d.dimension_version_id,
    d.dimension_key,
    argMax(d.payload, tuple(d.row_version, d.published_at)) AS payload,
    max(d.row_version) AS row_version
FROM asklake_realtime_v2.dimension_current_v2 AS d
GROUP BY d.scope_id, d.dimension_dataset_id, d.dimension_version_id, d.dimension_key;

CREATE TABLE IF NOT EXISTS asklake_realtime_v2.dimension_temporal_v2
(
    scope_id LowCardinality(String) DEFAULT 'deployment',
    dimension_dataset_id String,
    dimension_version_id String,
    dimension_key String,
    payload String,
    valid_from DateTime64(6, 'UTC'),
    valid_to Nullable(DateTime64(6, 'UTC')),
    row_version UInt64,
    published_at DateTime64(6, 'UTC') DEFAULT now64(6),
    CONSTRAINT deployment_scope CHECK scope_id = 'deployment',
    CONSTRAINT valid_temporal_interval CHECK isNull(valid_to) OR valid_to > valid_from
)
ENGINE = ReplicatedReplacingMergeTree('/asklake/realtime-v2/dimension-temporal/{shard}', '{replica}', row_version)
ORDER BY (scope_id, dimension_dataset_id, dimension_version_id, dimension_key, valid_from);

CREATE VIEW IF NOT EXISTS asklake_realtime_v2.dimension_temporal_v2_latest AS
SELECT
    d.scope_id,
    d.dimension_dataset_id,
    d.dimension_version_id,
    d.dimension_key,
    d.valid_from,
    argMax(d.payload, tuple(d.row_version, d.published_at)) AS payload,
    argMax(d.valid_to, tuple(d.row_version, d.published_at)) AS valid_to,
    max(d.row_version) AS row_version
FROM asklake_realtime_v2.dimension_temporal_v2 AS d
GROUP BY d.scope_id, d.dimension_dataset_id, d.dimension_version_id, d.dimension_key, d.valid_from;
