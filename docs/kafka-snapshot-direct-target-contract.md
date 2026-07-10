# Kafka Snapshot Direct Target Contract

Issue: #455

## 1. Status

Phase 0 defined the target contract. Phase 1 implemented partition offset snapshots and post-write offset commit. Phase 2 writes the fixed snapshot range directly to the selected target and removes the default intermediate RAW landing output.

## 2. Objective

Kafka Job runs must process a deterministic, bounded Kafka range and write the normalized review result directly to the selected target dataset. The default path must not create an intermediate RAW landing dataset or `kafka-landing/...` object.

```text
Kafka topic
  -> capture partition offset snapshot
  -> consume the fixed range
  -> normalize review event shape
  -> write selected Bronze/Silver/Gold target once
  -> register Catalog run
  -> commit Kafka offsets
```

The offset snapshot is metadata, not a copied message payload.

Current Phase 2 behavior writes JSONL directly to `s3://{targetBucket}/{targetPrefix}/snapshots/{snapshotId}/`. It uses the same snapshot metadata and commits the configured consumer group only after target storage and Catalog registration succeed. User-configured transform/quality rule execution is a later phase.

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

`snapshotMaxMessagesPerPartition` replaces the ambiguous global meaning of the current `Batch Max Messages` field. The UI/API migration must either rename the field or explicitly display its per-partition semantics.

## 4. Direct Target Write

The selected target dataset is the only Lake data output for the default path.

- `BRONZE`: snapshot records are written without business transformation.
- `SILVER`: target layer metadata is supported; user-configured field transforms and quality rules are a later execution phase.
- `GOLD`: out of scope until join/aggregation execution semantics are implemented.

The target physical path must be derived from the target dataset and `snapshotId`, rather than the removed `kafka-landing/<topic>/<runId>` convention. The Catalog materialization run must expose the target path, target layer, `sourceKind: "kafka"`, and snapshot metadata.

## 5. Completion and Failure Semantics

Kafka, object storage, Catalog, and the metadata database do not share a distributed transaction. The required guarantee is at-least-once consumption with idempotent target publication.

```text
1. Persist snapshot run as running.
2. Consume the fixed ranges with Kafka auto-commit disabled.
3. Write the direct target using snapshotId/range as an idempotency key.
4. Persist the successful Catalog materialization run and snapshot metadata.
5. Commit each partition offset to endOffset.
6. Mark the snapshot run successful.
```

If target writing or Catalog registration fails, offsets must not be committed. A retry must reuse the same snapshot range and idempotent target identity. A failure after target publication but before offset commit may re-read the same range; it must not duplicate target records or Catalog runs.

Empty snapshots are valid successful runs. They create no target data file and record `rowCount: 0` with the captured partition ranges.

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
