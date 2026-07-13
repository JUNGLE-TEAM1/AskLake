# Kafka Continuous Ingestion Contract

Issue: #500

## 1. Status

The implemented V1 persists `executionMode`, continuous configuration, durable runtime state, lifecycle commands, and a versioned canonical Rule contract; prod-like Compose provides the shared Redpanda endpoint. An isolated Spark Structured Streaming container reads Kafka with a durable checkpoint, applies schema policy plus streaming-safe Transform/Quality Rules, publishes completed Parquet micro-batches and manifests, and writes rejected payloads to target-adjacent quarantine. The control plane provides lag/log/schema/Rule observability, Catalog recovery, policy-aware replay, and non-destructive compaction. The bounded Snapshot bridge remains unchanged.

## 2. Objective

AskLake supports two mutually exclusive execution modes for a Kafka source Job.

```text
Snapshot Job
  -> capture a bounded partition range
  -> write one target result
  -> commit successful offsets
  -> stop

Continuous Job
  -> start a long-running Spark Structured Streaming query
  -> repeatedly process bounded micro-batches
  -> append the same target dataset
  -> persist checkpoint progress
  -> continue until paused or stopped
```

Snapshot remains the path for manual execution, scheduler-triggered increment, controlled backfill, and deterministic retry. Continuous provides near-real-time ingestion, not one-object-per-event storage or a general EDA/serving runtime.

## 3. Job Creation Contract

Kafka Job creation adds the following persisted configuration.

```ts
type KafkaExecutionMode = "snapshot" | "continuous";

type KafkaContinuousConfig = {
  initialOffsetPolicy: "earliest" | "latest";
  triggerIntervalSeconds: number; // default 30
  maxOffsetsPerTrigger: number; // default 10000, total across partitions
  checkpointPath: string; // generated from immutable job/target identity
};
```

- Existing Kafka Jobs hydrate as `executionMode: "snapshot"`.
- `executionMode` is selected on creation and becomes immutable after creation. Changing the mode, source identity, consumer group, target identity, or checkpoint identity requires Job copy and new Job creation.
- A fresh continuous Job with `initialOffsetPolicy: "earliest"` first consumes retained Kafka backlog and then tails new messages. `latest` processes only messages available after the streaming query begins.
- Continuous Job source progress is owned by the durable Spark checkpoint. `consumerGroupId` remains source identity metadata and must not be shared with another active Snapshot or Continuous Job.
- Target layer selection remains independent from Rule presence. `RAW`, `BRONZE`, `SILVER`, and `GOLD` labels may be selected, while GOLD streaming join/aggregation semantics remain excluded. V1 accepts only the stateless canonical operations proven by Snapshot conformance and rejects arbitrary SQL, joins, aggregations, and other stateful/engine-specific Rules before creation.

## 4. Continuous Runtime Contract

```ts
type ContinuousRuntimeStatus =
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "stopped"
  | "failed";

type KafkaContinuousRuntime = {
  status: ContinuousRuntimeStatus;
  checkpointPath: string;
  runtimeProvider: string | null;
  runtimeApplicationId: string | null;
  runtimeJobId: string | null;
  runtimeAttempt: number | null;
  runtimeState: string | null;
  runtimeLogReference: Record<string, unknown> | null;
  runtimeRequestedAction: string | null;
  runtimeCancelRequestState: "requested" | "accepted" | "completed" | "failed" | null;
  runtimeCancelRequestedAt: string | null;
  runtimeCancelAcceptedAt: string | null;
  runtimeCancelCompletedAt: string | null;
  runtimeCancelFailedAt: string | null;
  runtimeCancelError: string | null;
  lastCatalogAckError: string | null;
  lastSuccessfulCheckpoint: string | null;
  heartbeatAt: string | null;
  lastFlushAt: string | null;
  lastBatchId: string | null;
  lag: number | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  ruleContractVersion: string;
  ruleFingerprint: string | null;
  runtimeFingerprint: string | null;
  ruleMetrics: Record<string, number>;
  lastRuleResult: Record<string, unknown>;
  failedCount: number;
  lastError: string | null;
};
```

- A continuous query runs as a long-lived Spark Structured Streaming application. It processes Kafka as micro-batches; it does not write a Lake object per source event.
- Docker and Spark REST keep the local/prod-like execution paths. The opt-in EMR Serverless path requires Amazon MSK IAM, AWS S3 and a SPARK application on EMR 7.9.0+, submits `mode=STREAMING` without an execution timeout, and exposes Job Run/attempt/log/cancellation identity through the nullable remote runtime fields above. EMR retries the same Job Run from the S3 checkpoint until its configured hourly failure threshold is reached.
- Each successful micro-batch applies the compiled canonical Rule set before appending the selected target dataset and advancing the checkpoint. The supported Transform operations are `cast`, `copy`, `default_value`, `json_extract`, `lowercase_trim`, `mask`, `null_guard`, `parse_timestamp`, and `rename`; Quality supports `accepted_values`, `not_null`, `range`, and `regex`.
- `Fail Batch` aborts the current `foreachBatch` invocation before manifest/checkpoint completion. `Quarantine` stores raw payload, Kafka identity, Rule/stage/column identity, and schema/rule fingerprints. Warn, drop-row, set-null, invalid, quarantine, and failed-batch counters are persisted in the worker report and per-batch manifest.
- `_asklake_contract` under the checkpoint records schema, Rule, source/target, output schema, and a combined runtime fingerprint. A mismatched runtime cannot reuse that checkpoint. Once this contract is initialized, schema, Rule, or physical target changes require a copied Job and new checkpoint.
- Storage Layout V1 keeps output and checkpoint under one root. For a legacy Job without `storagePath`, the backend derives that root from the persisted `checkpointPath` before considering legacy `_batches` target evidence; a root mismatch fails with `STORAGE_LAYOUT_INVALID` instead of starting against a new checkpoint.
- Target write or checkpoint failure leaves the previous successful checkpoint authoritative. A batch path is complete only when `_SUCCESS` and its hidden publication signature exist. Before the final manifest, a retry reuses data/quarantine only when the signature's count and partial topic/partition ranges match; otherwise it rewrites that uncommitted path. After all outputs complete, the worker publishes an immutable manifest with full-batch counts and `[startOffset, endOffset)` ranges. Backend reconciles every reported manifest into an idempotent Catalog run before evaluating worker liveness, then acknowledges the highest contiguous Catalog batch so the report can discard old entries without losing recovery evidence.
- Malformed payloads and `Quarantine` quality results preserve raw payload plus Kafka context in a target-adjacent quarantine output. A quarantined micro-batch must not silently drop source progress.
- Continuous writes use append-oriented Parquet output in V1. Compaction is a separate maintenance operation; JSONL snapshot direct targets remain supported for Snapshot Jobs.

## 5. Command and API Contract

The existing `POST /api/etl/jobs/{jobId}/commands` endpoint gains these planned commands only for `executionMode: "continuous"` Kafka Jobs.

```ts
type JobCommand =
  | "run"
  | "retry"
  | "pause"
  | "cancelRun"
  | "stopSchedule"
  | "startContinuous"
  | "pauseContinuous"
  | "resumeContinuous"
  | "stopContinuous";
```

- `startContinuous`: starts a long-running stream worker.
- `pauseContinuous`: records pause intent and signals the worker to stop after its current checkpointed micro-batch.
- `resumeContinuous`: persists a resume request for the durable checkpoint.
- `stopContinuous`: persists a stop request while leaving checkpoint state available for a later explicit resume or Job copy policy.
- `run` and `retry` remain Snapshot-only commands. A continuous Job never creates a one-time snapshot run through those commands.
- `GET /api/etl/jobs/{jobId}` includes `executionMode`, `continuousConfig`, and `continuousRuntime` after implementation.
- Command responses identify `controlPlaneOnly: false` and `worker: "spark_structured_streaming"`. Worker heartbeats and counters are written to a local report volume for Docker/REST or a deterministic S3 report for EMR, then hydrated with the selected runtime liveness. An exited, missing, or stale active worker transitions to `failed`. Failure accounting is keyed by worker attempt and reason, so polling the same terminal attempt does not repeatedly increment `failedCount`. Heartbeat cleanup uses an internal terminate/cancel signal and cannot be mistaken for an operator stop.
- EMR cancellation records `requested -> accepted -> completed|failed`; only accepted cancellation followed by remote `CANCELLED` becomes `paused`/`stopped`. Graceful cancellation uses 15~1800 seconds and forced cleanup uses 0. A rejected Cancel API or remote `FAILED` remains failed even if an operator action was requested.

## 6. Mutual Exclusion and Backfill

- A broker/topic/consumer group has at most one active Continuous consumer. Independent fan-out targets must use distinct consumer groups. PostgreSQL advisory transaction locking serializes the canonical identity before either Snapshot capture or Continuous StartJobRun, including the no-existing-row race.
- Snapshot and Continuous Jobs cannot run concurrently when they share the same broker/topic/consumer group. Both start paths reject the conflict with `409`.
- Backfill is normally handled by first starting a continuous Job with `earliest`, which drains retained backlog before tailing new events. Snapshot Jobs remain available for controlled historical replay, deterministic range retry, and manual/scheduled ingestion.
- The system must reject a conflicting command with `409` and identify the active Job/runtime in the error details.

## 7. Non-Goals

- Sub-second per-event serving latency
- General event-driven workflows such as notification, search-index, or fraud-detection consumers
- GOLD streaming joins, aggregations, or stream-stream stateful joins
- Deleting or migrating existing Snapshot target objects
- Replacing the existing Snapshot direct-target and offset-safe retry contract

## 8. Acceptance Criteria For Implementation

1. A Kafka Job can be created as Snapshot or Continuous, and existing Jobs remain Snapshot.
2. A Continuous Job automatically materializes Kafka events within the configured micro-batch interval without a manual Job run or scheduler tick.
3. A fresh `earliest` Continuous Job drains retained topic data then processes newly appended records.
4. Pause, resume, stop, and worker restart preserve checkpoint progress without target duplicates or skipped committed ranges.
5. The Job detail/list shows runtime status, heartbeat, lag, last flush, and processed counters.
6. Existing Snapshot execution, schedule tick, direct target retry, Catalog materialization, and RAW/BRONZE/SILVER target selection remain valid.

## 9. Runtime Observability Contract

- Every worker report includes `partitionProgress`, keyed by Kafka partition, with `processedOffset`, `latestOffset`, and non-negative `lag`.
- Runtime summary exposes `lag`, `maxPartitionLag`, `laggingPartitionCount`, `lastBatchDurationMs`, `lastBatchInputRows`, `throughputRowsPerSecond`, optional `endToEndLatency`, cumulative `replayedCount`, Rule fingerprints, `ruleMetrics`, and `lastRuleResult`. Each batch manifest records that batch's Kafka record timestamp→target commit approximate P50/P95/P99. The checkpoint-recoverable runtime summary uses `aggregation=worst-successful-batch-percentile`: it exposes the maximum of each successful batch percentile plus cumulative batch/sample/missing-timestamp counts and the latest batch value. This is a conservative worst-batch indicator, not a mathematically merged global record percentile.
- Kafka latest-offset lookup failure does not stop a healthy stream. The report marks lag availability and preserves the previous processed offset.
- Worker logs are read through `GET /api/etl/jobs/{jobId}/continuous/logs`. The response is bounded, strips ANSI control sequences, masks common credential/token forms, and requires Job `view` permission.
- A stream start/resume creates one durable session row. Pause, stop, or failure closes that row; a later restart creates a new session while reusing the same checkpoint.
- Session counters are deltas from the cumulative runtime baseline captured at session start. Worker `publishedBatches` become idempotent child records keyed by session and Spark batch ID, while the main execution history remains one row per session.
- Session and micro-batch rows persist a seven-stage Streaming DAG: Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, and Catalog. A successful manifest keeps Catalog pending until the control plane cursor acknowledges that batch. A pre-manifest Rule failure persists `lastBatchEvidence` with the failed stage and blocks downstream stages without advancing the checkpoint. Empty Transform/Quality rule sets are recorded as successful pass-through stages.
- The execution-history UI polls session and selected batch APIs every three seconds only while a session is active. It prevents overlapping/stale responses, backs off on errors without clearing the last good state, defers polling for hidden tabs, and stops after terminal state or unmount. Manual refresh calls the same live APIs.

## 10. Schema Evolution Contract

- Continuous configuration stores `schemaEvolutionPolicy` with `additiveNullable`, `missingRequired`, `incompatibleType`, and `unknownField` actions.
- The default policy allows additive nullable fields for observation, quarantines missing required fields and incompatible values, and keeps unknown-field rows in the fixed target projection while writing their raw payload and unknown-key list to `_schema-evidence`.
- `missingRequired`, `incompatibleType`, and `unknownField` can select `pause` where supported. A pause-policy violation fails before target publication so the same checkpoint range can be retried after an operator changes the policy. `unknownField=ignore` accepts the fixed projection without sidecar evidence, while `quarantine` excludes the row from the target.
- Each batch reports a deterministic `schemaFingerprint`, `schemaVersion`, `schemaStatus`, and detected changes. Destructive changes are never auto-applied.
- V1 keeps schema, canonical Rules, and physical target identity immutable after checkpoint contract initialization. Active changes return `CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`; initialized-checkpoint changes return `CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`. Applying a new contract requires Job copy and a new checkpoint.

## 11. Quarantine Replay Contract

- Quarantine records retain `topic`, `partition`, `offset`, raw payload, failure reason, observed schema/rule fingerprints, Rule ID, stage, target column, and quarantine timestamp.
- `topic + partition + offset` is the replay idempotency key. A replay anti-joins offsets already present in target data and previous successful replay output.
- Replay is a finite Spark batch operation over completed Lake quarantine Parquet, not a Kafka offset rewind. It reapplies the current schema evolution policy and canonical Rule set before the compiled output projection. A Rule-rejected row remains rejected and increments `ruleRejectedCount`; maintenance never bypasses Transform/Quality. `approveUnknownFields: true` is a narrow `manage`-permission exception for schema unknown fields only, records an audit event, and exposes `policyOverride` in the result.
- Replay runs expose queued/running/success/failed state and input/stored/skipped/failed counts.
- `quarantinedCount` remains the historical quarantine count, while `replayedCount` records recovered rows also included in `storedCount`. Counter reconciliation is `storedCount + quarantinedCount - replayedCount = consumedCount`.
- V1 requires the Continuous worker to be paused or stopped before quarantine inspection, replay, or compaction. Runtime row locking serializes inspection and persisted maintenance. Replay uses `batch_id=replay_<runId>`, the same partition key as stream batches, and readers select only child paths with `_SUCCESS`. A persisted maintenance run has a 900-second default lease; expiry marks it failed and removes its named Docker container.

## 12. Compaction Contract

- Compaction reads only completed batch outputs and never mutates checkpoints or an active batch directory.
- Output is staged under a run-specific path. Existing target data remains authoritative when compaction fails.
- V1 records compaction output and statistics without deleting source batches. Source deletion requires a later retention policy and an atomic reader-manifest switch.
- Target file size defaults to 256 MiB and is constrained to 128-512 MiB. Partition count is calculated from actual source Parquet bytes, and the result records input/output bytes, file counts, and average file sizes.

## 13. Load And Fault Verification

- The replay harness supports generated events or streaming `.jsonl`/`.jsonl.gz` input, count/rate/batch-size, malformed ratio, schema-change injection, optional worker termination, and optional staged compaction.
- Fault scenarios cover worker termination, backend restart, Kafka unavailability, and MinIO unavailability.
- Verification reconciles produced, consumed, stored, quarantined, replayed, duplicate, missing, and Catalog materialization counts, plus peak lag, throughput, recovery time, file count, and average file size.
