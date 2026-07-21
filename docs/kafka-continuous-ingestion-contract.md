# Kafka Continuous Ingestion Contract

Issue: #500

## 1. Status

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
  triggerIntervalSeconds: number; // default 10
  maxOffsetsPerTrigger: number; // default 100, total across partitions
  checkpointPath: string; // generated from immutable job/target identity
};
```

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

type ContinuousDesiredState = "running" | "paused" | "stopped";
type ContinuousObservedState =
  | "unknown"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

type ContinuousRuntimeErrorDetail = {
  stage:
    | "validation"
    | "runtime_storage"
    | "submission"
    | "execution"
    | "report"
    | "checkpoint"
    | "materialization"
    | "catalog"
    | "dashboard_publication"
    | "reconciliation";
  code: string;
  message: string;
  retryable: boolean;
  context?: Record<string, unknown>;
};

type KafkaContinuousRuntime = {
  status: ContinuousRuntimeStatus;
  desiredState: ContinuousDesiredState;
  observedState: ContinuousObservedState;
  stateRevision: number;
  fencingToken: string | null;
  checkpointPath: string;
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
  errorDetail: ContinuousRuntimeErrorDetail | null;
};
```

`status`는 기존 client용 호환 projection이고, command intent는 `desiredState`, 현재 worker 증거는 `observedState`가 각각 소유한다. `stateRevision`은 command commit 때만 증가하며 frontend는 더 작은 revision의 polling 응답을 버린다. `fencingToken`과 worker report attempt가 모두 있으면 반드시 일치해야 한다. `errorDetail`은 단계별 진단을 제공하고 `lastError` 문자열은 기존 client를 위해 유지한다. canonical writer, 전이표, fencing과 rollback 규칙은 [Continuous runtime 상태·오류 소유권](refactor-2026/contracts/runtime-state-ownership.md)을 따른다.

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

## 6. Mutual Exclusion and Backfill

- A broker/topic/consumer group has at most one active Continuous consumer. Independent fan-out targets must use distinct consumer groups.
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
- Runtime summary exposes `lag`, `maxPartitionLag`, `laggingPartitionCount`, `lastBatchDurationMs`, `lastBatchInputRows`, `throughputRowsPerSecond`, cumulative `replayedCount`, Rule fingerprints, `ruleMetrics`, and `lastRuleResult`.
- Kafka latest-offset lookup failure does not stop a healthy stream. The report marks lag availability and preserves the previous processed offset.
- Worker logs are read through `GET /api/etl/jobs/{jobId}/continuous/logs`. The response is bounded, strips ANSI control sequences, masks common credential/token forms, and requires Job `view` permission.
- A stream start/resume creates one durable session row. Pause, stop, or failure closes that row; a later restart creates a new session while reusing the same checkpoint.
- Session counters are deltas from the cumulative runtime baseline captured at session start. Worker `publishedBatches` become idempotent child records keyed by session and Spark batch ID, while the main execution history remains one row per session.
- Session and micro-batch rows persist a seven-stage Streaming DAG: Source, Schema, Transform, Quality, Target, Manifest/Checkpoint, and Catalog. A successful manifest keeps Catalog pending until the control plane cursor acknowledges that batch. A pre-manifest Rule failure persists `lastBatchEvidence` with the failed stage and blocks downstream stages without advancing the checkpoint. Empty Transform/Quality rule sets are recorded as successful pass-through stages.
- Catalog ACK handling is incremental: the worker removes acknowledged entries from its bounded in-memory publication window and bulk-loads only the missing next window when durable backlog remains. It must not rescan every historical manifest on each heartbeat or ACK. Startup recovery may bulk-read committed manifests once to restore counters, cursors, and the first report window.
- Continuous Spark jobs use `ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS` (default `4`) independently from the general batch shuffle width, and default driver logging to `ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL=WARN`. The worker reapplies the Continuous shuffle width at each `foreachBatch` entry because an existing Structured Streaming checkpoint can restore its historical SQL settings.
- The execution-history UI polls session and selected batch APIs every three seconds only while a session is active. It prevents overlapping/stale responses, backs off on errors without clearing the last good state, defers polling for hidden tabs, and stops after terminal state or unmount. Manual refresh calls the same live APIs.

## 10. Schema Evolution Contract

- Continuous configuration stores `schemaEvolutionPolicy` with `additiveNullable`, `missingRequired`, `incompatibleType`, and `unknownField` actions.
- The default policy allows additive nullable fields for observation, quarantines missing required fields and incompatible values, and keeps unknown-field rows in the fixed target projection while writing their raw payload and unknown-key list to `_schema-evidence`.
- `missingRequired`, `incompatibleType`, and `unknownField` can select `pause` where supported. A pause-policy violation fails before target publication so the same checkpoint range can be retried after an operator changes the policy. `unknownField=ignore` accepts the fixed projection without sidecar evidence, while `quarantine` excludes the row from the target.
- Each batch reports a deterministic `schemaFingerprint`, `schemaVersion`, `schemaStatus`, and detected changes. Destructive changes are never auto-applied.
- V1 keeps schema, canonical Rules, and physical target identity immutable after checkpoint contract initialization. Active changes return `CONTINUOUS_IMMUTABLE_CONFIG_ACTIVE`; initialized-checkpoint changes return `CONTINUOUS_CHECKPOINT_CONTRACT_IMMUTABLE`. Applying a new contract requires Job copy and a new checkpoint.

## 11. Quarantine Replay Contract

- Quarantine records retain `topic`, `partition`, `offset`, raw payload, failure reason, observed schema/rule fingerprints, Rule ID, stage, target column, and quarantine timestamp.
- `topic + partition + offset` is the replay idempotency key. A replay anti-joins offsets already present in the Iceberg table and previous successful replay output.
- Replay is a finite Spark batch operation over completed Lake quarantine Parquet, not a Kafka offset rewind. It reapplies the current schema evolution policy and canonical Rule set before the compiled output projection. A Rule-rejected row remains rejected and increments `ruleRejectedCount`; maintenance never bypasses Transform/Quality. `approveUnknownFields: true` is a narrow `manage`-permission exception for schema unknown fields only, records an audit event, and exposes `policyOverride` in the result.
- Replay runs expose queued/running/success/failed state and input/stored/skipped/failed counts.
- `quarantinedCount` remains the historical quarantine count, while `replayedCount` records recovered rows also included in `storedCount`. Counter reconciliation is `storedCount + quarantinedCount - replayedCount = consumedCount`.
- V1 requires the Continuous worker to be paused or stopped before quarantine inspection, replay, or compaction. Worker start/resume and maintenance acquisition use the same Job row -> runtime row lock order, so only one side may launch an external runner. Replay appends to the same Iceberg table with deterministic `_asklake_run_id`, stores commit/source-boundary evidence, and exposes `catalogApplied`; pending Catalog verification is retried from the successful maintenance result and counters advance only after Catalog succeeds. If the local worker result is lost, the backend recovers the completed S3 replay manifest by `runId`; only a confirmed object 404 is treated as missing, while access, parsing, and identity failures remain pending. Start/resume reconciles this state first and returns `409` while any replay publication is still unapplied, preventing later stream snapshots from exposing those rows before the replay revision. A run handles at most `ASKLAKE_MAINTENANCE_REPLAY_MAX_ROWS` rows (default 1,000, hard maximum 10,000) and exposes `deferredCount` for the remainder. A persisted maintenance run has a 900-second default lease. If the lease expires while the durable REST runner heartbeat is fresh, the backend renews it; only an absent/stale non-terminal runner is failed and cleaned up once, and an observed terminal runner is never killed.

## 12. Compaction Contract

- `POST /continuous/compactions` is retained as the simple optimization API, but its implementation is Iceberg-native `rewrite_data_files` with a 128~512 MiB target. It never reads or rewrites the former `_batches` Parquet output.
- `POST /continuous/iceberg-maintenance` combines optional `rewrite_data_files`, `expire_snapshots`, and `remove_orphan_files`. Cleanup defaults off; snapshot retention is at least 24 hours, orphan retention at least 72 hours, and at least one snapshot is always retained.
- Maintenance requires a paused/stopped worker and is serialized by the Job/runtime row locks and persisted maintenance lease. Rewrite-only requires `run`; snapshot expiration or orphan cleanup requires `manage`. It does not mutate checkpoint progress or create a logical Catalog materialization. Success requires `$refs` main-current validation, exact `$snapshots` lookup and snapshot-summary file/byte verification through Trino; current `$files` is only a supplemental check. Before/after metrics remain in maintenance history.

## 13. Load And Fault Verification

- The replay harness supports generated events or streaming `.jsonl`/`.jsonl.gz` input, count/rate/batch-size, malformed ratio, schema-change injection, and optional worker termination.
- Fault scenarios cover worker termination, backend restart, Kafka unavailability, and MinIO unavailability.
- Verification reconciles produced, consumed, stored, quarantined, replayed, duplicate, missing, and Catalog materialization counts, plus peak lag, throughput, recovery time, file count, and average file size.
