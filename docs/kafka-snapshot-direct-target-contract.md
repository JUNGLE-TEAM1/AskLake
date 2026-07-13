# Kafka Snapshot Direct Target Contract

Issue: #455

## 1. Status

Phase 0 defined the target contract. Phase 1 implemented partition offset snapshots and post-write offset commit. Phase 2 writes the fixed snapshot range directly to the selected target and removes the default intermediate RAW landing output. Phase 3 executes the configured supported transform and quality rules before that direct write. Phase 4 persists failed Kafka Job runs with their captured snapshot and verifies offset-safe retry behavior. Phase 5 verifies independent multi-partition snapshot ranges and offset commits. Phase 6 verifies target-write retry idempotency when Catalog publication fails after the target object exists. Issue #678 writer Phase 3 replaces the Job final JSONL object with an Iceberg append table while preserving those offset and Rule semantics. The hardening pass persists snapshot ranges before consume, quarantines malformed messages, and keeps target layer selection independent from transform and quality execution.

## 2. Objective

Kafka Job runs must process a deterministic, bounded Kafka range and write the normalized review result directly to the selected target dataset. The default path must not create an intermediate RAW landing dataset or `kafka-landing/...` object.

```text
Kafka topic
  -> capture partition offset snapshot
  -> consume the fixed range
  -> normalize review event shape and apply configured rules
  -> append selected RAW/Bronze/Silver Iceberg target once
  -> verify with Trino and register Catalog run
  -> commit Kafka offsets
```

The offset snapshot is metadata, not a copied message payload.

Current Job behavior writes Parquet data files and Iceberg metadata to the configured warehouse through a backend-owned `icebergTarget`. It persists the captured range before consume, reuses a failed range on retry, and commits the configured consumer group only after Iceberg physical verification and Catalog registration succeed. Snapshot metadata and optional quarantine JSONL remain under the target metadata prefix; they are not the target Dataset data. The Job-less direct ingest endpoint retains the old JSONL path only for fixture/debug compatibility.

## 3. Snapshot Boundary

A snapshot is created at the beginning of each Kafka Job run.

| Field | Definition |
| --- | --- |
| `snapshotId` | Stable identifier for one topic/range processing attempt. |
| `capturedAt` | ISO 8601 time at which end offsets were captured. |
| `topic` | Kafka topic name. |
| `consumerGroupId` | Group whose successful cursor defines the next start offset. |
| `partitions` | Per-partition `startOffset`, captured `highWatermark`, and exclusive `endOffset`. |
| `offsetPolicy` | `earliest` or `latest`, used only when the group has no committed cursor. |

For each partition:

```text
startOffset = committed group offset, or offset policy initial position
highWatermark = partition end offset at capturedAt
endOffset = min(highWatermark, startOffset + snapshotMaxMessagesPerPartition)
```

`endOffset` is exclusive. A run must process offsets `startOffset <= offset < endOffset`. Messages appended after `capturedAt` are outside the current snapshot and belong to a later run.

`snapshotMaxMessagesPerPartition` replaces the ambiguous global meaning of the current `Batch Max Messages` field. New Kafka source drafts display this as `Batch Max Messages (per partition)`; the legacy label remains accepted for existing Jobs.

## 4. Direct Target Write

The selected target dataset is the only Lake data output for the default path.

- `RAW`, `BRONZE`, and `SILVER`: target layer is selected target metadata. Supported Job transform and quality rules run before the single Iceberg append regardless of this label.
- `GOLD`: out of scope until join/aggregation execution semantics are implemented.

The target physical table identity is derived from the Dataset ID and backend Iceberg catalog/namespace, rather than the removed `kafka-landing/<topic>/<runId>` convention. The Catalog materialization run must expose the warehouse location, target layer, `sourceKind: "kafka"`, `queryEngineTable`, Iceberg snapshot ID, and Kafka snapshot metadata.

Supported transform operations follow the existing pipeline rule semantics: copy/rename, trim/lowercase, numeric and timestamp casts, JSONPath extraction, default/null guard, and phone masking. Quality rule `params` stores Regex `pattern`, Accepted Values `values`, and Range `min`/`max`/`inclusive`; compiler validation rejects missing or invalid values before execution. Unsupported expression-style transforms are rejected before Job creation. `Fail Run` stops before target write and offset commit. `Warn` retains the row, `Set Null` clears the invalid target field, `Drop Row` excludes it, and `Quarantine` writes the rejected row to `snapshots/{snapshotId}/quarantine.jsonl` beside the snapshot metadata. Successful records are projected to the configured included target columns and compiled Rule output schema before Iceberg/Catalog publication, so rename source fields and excluded fields are not retained. Malformed Kafka payloads are also quarantined with their raw payload and Kafka context; their offset is committed only after this object is stored.

## 5. Completion and Failure Semantics

Kafka, Iceberg, object storage, Catalog, and the metadata database do not share a distributed transaction. The required guarantee is at-least-once consumption with idempotent Iceberg/Catalog publication.

```text
1. Persist snapshot run as running before consume.
2. Consume the fixed ranges with Kafka auto-commit disabled.
3. Append the Iceberg target with snapshotId/range in `sourceBoundary` and the internal snapshot marker.
4. Verify the exact table snapshot, schema/fingerprints, warehouse location and data files through Trino.
5. Persist the successful Catalog materialization run and snapshot metadata.
6. Commit each partition offset to endOffset.
7. Best-effort update the snapshot metadata object from `offsetCommit=pending` to `success`.
8. Mark the snapshot run successful.
```

If Iceberg writing, Trino verification, or Catalog registration fails, offsets must not be committed. A retry reuses the persisted snapshot range and idempotent target identity even when newer Kafka messages arrived after capture. A failure after Iceberg/Catalog publication but before offset commit may re-read the same range; the writer detects the same `_asklake_kafka_snapshot_id` and returns `reuse`, while Catalog history deduplicates `kafkaSnapshot.snapshotId`. It must not duplicate target records or Catalog runs.

Kafka group offset와 PostgreSQL snapshot/Run/Catalog row가 진행 상태의 source of truth다. Offset 확정 뒤 진단용 metadata object 갱신이 실패하면 Run을 되돌리거나 이미 확정한 offset을 실패로 취급하지 않고 `metadataUpdate.status=warning`을 남긴다.

For a Job command failure, AskLake persists a failed Run with `KafkaSnapshot`, `failedStage`, commit/Catalog evidence and the bridge error summary. Its DAG reports Iceberg commit, Trino/Catalog, and Kafka offset confirmation as distinct stages. An offset failure therefore keeps the first two stages successful and only the final stage failed. A direct ingest endpoint call still returns an error response, including the bridge snapshot diagnostics, for fixture and debug callers.

Empty snapshots are valid successful runs. They create no Iceberg snapshot or data file, preserve the existing Catalog mapping, and record `rowCount: 0` with the captured partition ranges.

## 6. Compatibility and Excluded Scope

- Existing Kafka RAW landing runs remain readable historical data; they are not migrated or deleted by this feature.
- The existing landing-only endpoint is replaced or deprecated only after direct target verification passes. Its public compatibility decision is tracked in #455.
- Kafka Connect, Flink, long-term raw archive mode, and Gold join/aggregation execution are excluded.
- This contract applies only to Snapshot Job runs. Spark Structured Streaming and an always-on consumer are defined separately as planned work in [Kafka Continuous Ingestion Contract](kafka-continuous-ingestion-contract.md); they do not change this Snapshot contract until implemented.

## 7. Verification Contract

1. A 100-message topic produces a snapshot range and one Iceberg append commit.
2. Messages appended after `capturedAt` are absent from that run and present in the next run.
3. A forced target/Catalog failure leaves group offsets unchanged.
4. Retrying the same snapshot does not duplicate target rows or Catalog materialization history.
5. Multi-partition topics record and commit each partition range independently.
6. A forced post-Iceberg/Catalog failure leaves offsets unchanged; retrying the same snapshot reuses the existing Iceberg append and leaves one Catalog materialization entry.
