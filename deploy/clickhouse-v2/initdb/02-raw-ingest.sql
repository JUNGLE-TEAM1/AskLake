CREATE TABLE IF NOT EXISTS asklake_realtime_v2.raw_events_v2
(
    scope_id LowCardinality(String) DEFAULT 'deployment',
    kafka_topic String,
    kafka_partition Int32,
    kafka_offset Int64,
    kafka_timestamp Nullable(DateTime64(3, 'UTC')),
    payload String,
    payload_hash FixedString(64) MATERIALIZED lower(hex(SHA256(payload))),
    event_key FixedString(64) MATERIALIZED lower(hex(SHA256(concat(scope_id, '|', kafka_topic, '|', toString(kafka_partition), '|', toString(kafka_offset))))),
    ingested_at DateTime64(6, 'UTC') DEFAULT now64(6)
)
ENGINE = ReplicatedReplacingMergeTree('/asklake/realtime-v2/raw/{shard}', '{replica}', ingested_at)
PARTITION BY toYYYYMM(ingested_at)
ORDER BY (scope_id, kafka_topic, kafka_partition, kafka_offset)
TTL ingested_at + INTERVAL 7 DAY DELETE;

CREATE VIEW IF NOT EXISTS asklake_realtime_v2.raw_events_v2_current AS
SELECT
    scope_id,
    kafka_topic,
    kafka_partition,
    kafka_offset,
    argMax(r.kafka_timestamp, tuple(r.ingested_at, r.payload_hash)) AS kafka_timestamp,
    argMax(r.payload, tuple(r.ingested_at, r.payload_hash)) AS payload,
    argMax(r.payload_hash, tuple(r.ingested_at, r.payload_hash)) AS payload_hash,
    argMax(r.event_key, tuple(r.ingested_at, r.payload_hash)) AS event_key,
    max(r.ingested_at) AS ingested_at
FROM asklake_realtime_v2.raw_events_v2 AS r
GROUP BY r.scope_id, r.kafka_topic, r.kafka_partition, r.kafka_offset;
