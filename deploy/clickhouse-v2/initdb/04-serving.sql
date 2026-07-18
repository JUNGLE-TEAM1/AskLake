CREATE TABLE IF NOT EXISTS asklake_realtime_v2.serving_events_v2
(
    scope_id LowCardinality(String) DEFAULT 'deployment',
    serving_dataset_id String,
    pipeline_version_id String,
    serving_key FixedString(64),
    event_time Nullable(DateTime64(3, 'UTC')),
    payload String,
    kafka_topic String,
    kafka_partition Int32,
    kafka_offset Int64,
    materialization_id String,
    source_fingerprint FixedString(64),
    dimension_version_ids Map(String, String),
    correction_generation UInt32,
    is_deleted UInt8 DEFAULT 0,
    materialized_at DateTime64(6, 'UTC'),
    row_version UInt64,
    CONSTRAINT deployment_scope CHECK scope_id = 'deployment',
    CONSTRAINT serving_key_sha256 CHECK length(serving_key) = 64,
    CONSTRAINT source_fingerprint_sha256 CHECK length(source_fingerprint) = 64
)
ENGINE = ReplicatedReplacingMergeTree('/asklake/realtime-v2/serving/{shard}', '{replica}', row_version)
PARTITION BY toYYYYMM(materialized_at)
ORDER BY (scope_id, serving_dataset_id, pipeline_version_id, serving_key)
TTL materialized_at + INTERVAL 30 DAY DELETE;

CREATE VIEW IF NOT EXISTS asklake_realtime_v2.serving_current_v2 AS
SELECT
    scope_id,
    serving_dataset_id,
    pipeline_version_id,
    serving_key,
    event_time,
    payload,
    kafka_topic,
    kafka_partition,
    kafka_offset,
    materialization_id,
    source_fingerprint,
    dimension_version_ids,
    correction_generation,
    materialized_at,
    row_version
FROM asklake_realtime_v2.serving_events_v2 FINAL
WHERE is_deleted = 0;
