# Kafka Snapshot Direct Target Contract

Issue: #455

## 1. Status

Phase 0 defined the target contract. Phase 1 implemented partition offset snapshots and post-write offset commit. Phase 2 writes the fixed snapshot range directly to the selected target and removes the default intermediate RAW landing output. Phase 3 executes the configured supported transform and quality rules before that direct write. Phase 4 persists failed Kafka Job runs with their captured snapshot and verifies offset-safe retry behavior. Phase 5 verifies independent multi-partition snapshot ranges and offset commits. Phase 6 verifies target-write retry idempotency when Catalog publication fails after the target object exists. The hardening pass persists snapshot ranges before consume, quarantines malformed messages, and restricts business mutation to SILVER.

## 2. Objective

Kafka Job runs must process a deterministic, bounded Kafka range and write the normalized review result directly to the selected target dataset. The default path must not create an intermediate RAW landing dataset or `kafka-landing/...` object.

```text
Kafka topic
  -> capture partition offset snapshot
  -> consume the fixed range
  -> normalize review event shape and apply configured rules
  -> write selected Bronze/Silver/Gold target once
  -> register Catalog run
  -> commit Kafka offsets
```

The offset snapshot is metadata, not a copied message payload.

Current behavior writes JSONL directly to `s3://{targetBucket}/{targetPrefix}/snapshots/{snapshotId}/`. It persists the captured range before consume, reuses a failed range on retry, and commits the configured consumer group only after target storage and Catalog registration succeed.

The FastAPI execution path uses the Python `confluent-kafka` client. It explicitly assigns each captured partition at `startOffset`, stops at the exclusive `endOffset`, and synchronously commits that end offset only after target and Catalog success. The former Node/KafkaJS `admin.setOffsets` implementation remains a comparison fixture and is not the FastAPI runtime.

Successful direct-ingest metadata additionally records a `timing` object for stage-boundary observation: optional `producerAckAt`, then `snapshotCapturedAt`, `consumeEndedAt`, `transformEndedAt`, `minioWriteEndedAt`, `catalogPublishedAt`, and `offsetCommittedAt`. These are ordered wall-clock boundaries, not distributed-tracing spans; in particular, snapshot-to-consume includes bridge handoff and consumer setup.

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

- `RAW`, `BRONZE`, and `SILVER`: target layer is selected target metadata. Supported Job transform and quality rules run before the single target write regardless of this label.
- `GOLD`: out of scope until join/aggregation execution semantics are implemented.

The target physical path must be derived from the target dataset and `snapshotId`, rather than the removed `kafka-landing/<topic>/<runId>` convention. The Catalog materialization run must expose the target path, target layer, `sourceKind: "kafka"`, and snapshot metadata.

Supported transform operations follow the existing pipeline rule semantics: copy/rename, trim/lowercase, numeric and timestamp casts, JSONPath extraction, default/null guard, and phone masking. Quality rule `params` stores Regex `pattern`, Accepted Values `values`, Range `min`/`max`/`inclusive`, and unique scope. Unsupported expression-style transforms preserve the input value until an expression runtime is added. `Fail Run` stops before target write and offset commit. `Warn` retains the row, `Set Null` clears the invalid target field, `Drop Row` excludes it, and `Quarantine` writes the rejected row to `snapshots/{snapshotId}/quarantine.jsonl` beside the direct target object. Malformed Kafka payloads are also quarantined with their raw payload and Kafka context; their offset is committed only after this object is stored.

## 5. Completion and Failure Semantics

Kafka, object storage, Catalog, and the metadata database do not share a distributed transaction. The required guarantee is at-least-once consumption with idempotent target publication.

```text
1. Persist snapshot run as running before consume.
2. Consume the fixed ranges with Kafka auto-commit disabled.
3. Write the direct target using snapshotId/range as an idempotency key.
4. Persist the successful Catalog materialization run and snapshot metadata.
5. Commit each partition offset to endOffset.
6. Mark the snapshot run successful.
```

If target writing or Catalog registration fails, offsets must not be committed. A retry reuses the persisted snapshot range and idempotent target identity even when newer Kafka messages arrived after capture. A failure after target publication but before offset commit may re-read the same range; it must not duplicate target records or Catalog runs.

For a Job command failure, AskLake persists a failed Run with `KafkaSnapshot`, `failedStage`, and the bridge error summary. Its DAG marks the failing transform or quality stage as failed and downstream target/Catalog stages as blocked. A direct ingest endpoint call still returns an error response, including the bridge snapshot diagnostics, for fixture and debug callers.

Empty snapshots are valid successful runs. They create no target data file and record `rowCount: 0` with the captured partition ranges. The zero-row materialization remains in history, but it must not replace the parent Catalog dataset's representative `storageLocation` or compatible sample rows from the last non-empty run.

## 6. Compatibility and Excluded Scope

- Existing Kafka RAW landing runs remain readable historical data; they are not migrated or deleted by this feature.
- The existing landing-only endpoint is replaced or deprecated only after direct target verification passes. Its public compatibility decision is tracked in #455.
- Kafka Connect, Flink, Spark Structured Streaming, long-term raw archive mode, and Gold join/aggregation execution are excluded.
- A continuous always-on consumer is also excluded. The contract applies to manual and scheduler-triggered micro-batch Job runs.

## 7. Verification Contract

1. A 100-message topic produces a snapshot range and one direct target dataset write.
2. Messages appended after `capturedAt` are absent from that run and present in the next run.
3. A forced target/Catalog failure leaves group offsets unchanged.
4. Retrying the same snapshot does not duplicate target rows or Catalog materialization history.
5. Multi-partition topics record and commit each partition range independently.
6. A forced post-target-write Catalog failure leaves offsets unchanged; retrying the same snapshot overwrites the target object and creates one Catalog materialization entry.
7. A zero-row snapshot creates no `data.jsonl` object and does not replace the Catalog dataset's last non-empty representative location or compatible samples.
