# Kafka Continuous Ingestion Contract

Issue: #500

## 1. Status

Phase 0 defines the product and interface boundary. Phase 1 persists `executionMode`, continuous configuration, and a durable runtime control record; it also adds the lifecycle command contract. The current production data path remains the bounded Kafka snapshot direct-target bridge defined in `kafka-snapshot-direct-target-contract.md`. No continuous worker, Spark Structured Streaming query, automatic target append, or target format change is implemented yet.

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
- `RAW`, `BRONZE`, and `SILVER` remain valid target layer choices. Target layer is Catalog/target metadata and does not independently enable or disable configured transform or quality rules. `GOLD` streaming join/aggregation remains excluded.

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
  heartbeatAt: string | null;
  lastFlushAt: string | null;
  lastBatchId: string | null;
  lag: number | null;
  consumedCount: number;
  storedCount: number;
  quarantinedCount: number;
  failedCount: number;
  lastError: string | null;
};
```

- A continuous query runs as a long-lived Spark Structured Streaming application. It processes Kafka as micro-batches; it does not write a Lake object per source event.
- Each successful micro-batch applies supported transform and quality rules, appends the selected target dataset, records a Catalog materialization run, and advances the checkpoint.
- Target write, Catalog publication, or checkpoint failure leaves the previous successful checkpoint authoritative. Restart resumes from that point; output publication must be idempotent for the streaming batch identity.
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

- `startContinuous`: persists a long-running stream start request.
- `pauseContinuous`: persists a request to stop source consumption after the current committed micro-batch.
- `resumeContinuous`: persists a resume request for the durable checkpoint.
- `stopContinuous`: persists a stop request while leaving checkpoint state available for a later explicit resume or Job copy policy.
- `run` and `retry` remain Snapshot-only commands. A continuous Job never creates a one-time snapshot run through those commands.
- `GET /api/etl/jobs/{jobId}` includes `executionMode`, `continuousConfig`, and `continuousRuntime` after implementation.
- Phase 1 command responses identify `controlPlaneOnly: true` and `worker: "not_connected"`. Phase 2 connects these requests to an actual streaming worker; until then a `starting`, `pausing`, or `stopping` runtime state is not evidence that Kafka is being consumed.

## 6. Mutual Exclusion and Backfill

- A broker/topic/consumer group has at most one active Continuous consumer. Independent fan-out targets must use distinct consumer groups.
- Snapshot and Continuous Jobs cannot run concurrently when they share the same broker/topic/consumer group.
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
