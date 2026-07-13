import assert from "node:assert/strict";
import test from "node:test";

import type { TrinoQueryRun } from "../src/types/sql.ts";
import {
  buildTrinoExecutionTimelineModel,
  shouldShowTrinoSubmissionTimeline,
} from "../src/pages/sql/trinoExecutionTimeline.ts";

const SUBMITTED_AT = "2026-07-12T00:00:00Z";

function makeRun(overrides: Partial<TrinoQueryRun> = {}): TrinoQueryRun {
  return {
    baseDatasetId: "dataset-1",
    engine: "trino",
    query: "SELECT * FROM events",
    referenceDatasetIds: [],
    runId: "run-1",
    status: "running",
    submittedAt: SUBMITTED_AT,
    ...overrides,
  };
}

test("Trino timeline is isolated from compatibility and mock execution", () => {
  assert.equal(shouldShowTrinoSubmissionTimeline(true, false), true);
  assert.equal(shouldShowTrinoSubmissionTimeline(false, false), false);
  assert.equal(shouldShowTrinoSubmissionTimeline(true, true), false);
});

test("queued Trino work remains in the query execution stage", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    stats: { queryState: "QUEUED" },
    status: "queued",
  }));

  assert.equal(model.queryStageStatus, "active");
  assert.equal(model.queryPhaseLabel, "Trino 대기 중");
  assert.equal(model.firstResultStageVisible, false);
  assert.equal(model.collectionStageVisible, false);
});

test("real Trino progress appears immediately", () => {
  const run = makeRun({
    startedAt: "2026-07-12T00:00:01Z",
    stats: { progressPercentage: 24.1, queryState: "RUNNING" },
  });
  const model = buildTrinoExecutionTimelineModel(run, null, Date.parse("2026-07-12T00:00:01.001Z"));

  assert.equal(model.queryProgressVisible, true);
  assert.equal(model.queryElapsedMs, 1);
  assert.equal(model.runProgressPercentage, 24.1);
});

test("first page reveals result preparation and collection stages", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    result: {
      availablePageCount: 1,
      collectedRowCount: 250,
      collectionElapsedMs: 3_000,
      collectionStartedAt: "2026-07-12T00:00:02Z",
      columns: ["event_id"],
      expectedRowCount: 1_000,
      firstPageAvailableAt: "2026-07-12T00:00:05Z",
      firstPageElapsedMs: 5_000,
      storageStatus: "collecting",
    },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:05Z"));

  assert.equal(model.firstResultStageStatus, "completed");
  assert.equal(model.collectionStageVisible, true);
  assert.equal(model.collectionStageStatus, "active");
  assert.equal(model.collectionProgressPercentage, 25);
  assert.equal(model.collectionProgressVisible, true);
});

test("100 percent collection remains active until storage is available", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    result: {
      availablePageCount: 1,
      collectedRowCount: 1_000,
      collectionElapsedMs: 4_000,
      collectionStartedAt: "2026-07-12T00:00:02Z",
      columns: ["event_id"],
      expectedRowCount: 1_000,
      firstPageAvailableAt: "2026-07-12T00:00:03Z",
      storageStatus: "collecting",
    },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:06Z"));

  assert.equal(model.collectionProgressPercentage, 100);
  assert.equal(model.collectionFinalizing, true);
  assert.equal(model.collectionStageStatus, "active");
});

test("available and unavailable storage produce distinct terminal stages", () => {
  const available = buildTrinoExecutionTimelineModel(makeRun({
    result: { columns: ["event_id"], rowCount: 20, storageStatus: "available" },
    status: "succeeded",
  }));
  const unavailable = buildTrinoExecutionTimelineModel(makeRun({
    result: { columns: ["event_id"], storageStatus: "unavailable" },
    status: "succeeded",
  }));

  assert.equal(available.collectionStageStatus, "completed");
  assert.equal(unavailable.firstResultStageStatus, "failed");
  assert.equal(unavailable.storageFailed, true);
});

test("failed and cancelled runs do not reveal later stages", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const model = buildTrinoExecutionTimelineModel(makeRun({ status }));
    assert.equal(model.queryStageStatus, status);
    assert.equal(model.firstResultStageVisible, false);
    assert.equal(model.collectionStageVisible, false);
  }
});

test("long queries without a Trino numerator and denominator do not show fake progress", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    startedAt: "2026-07-12T00:00:01Z",
    stats: { elapsedMs: 8_000, queryState: "RUNNING" },
  }), 10, Date.parse("2026-07-12T00:00:09Z"));

  assert.equal(model.queryProgressVisible, false);
  assert.equal(model.runProgressPercentage, null);
  assert.deepEqual(model.estimatedRemaining, { kind: "remaining", milliseconds: 2_000 });
});

test("100 percent without final output confirmation remains in finalizing", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    startedAt: "2026-07-12T00:00:01Z",
    stats: { elapsedMs: 2_000, progressPercentage: 100, queryState: "RUNNING" },
  }), 1);

  assert.equal(model.queryExecutionComplete, false);
  assert.equal(model.queryStageStatus, "active");
  assert.deepEqual(model.estimatedRemaining, { kind: "finalizing" });
});

test("completed query duration keeps Trino elapsed time instead of browser wall time", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    completedAt: "2026-07-12T00:00:15Z",
    startedAt: "2026-07-12T00:00:01Z",
    stats: { elapsedMs: 2_100, queryCompletedAt: "2026-07-12T00:00:03.100Z", queryState: "FINISHED" },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:10:00Z"));

  assert.equal(model.queryElapsedMs, 2_100);
});

test("collection percent appears immediately and requires collected and expected rows", () => {
  const commonResult = {
    availablePageCount: 1,
    collectedRowCount: 250,
    collectionStartedAt: "2026-07-12T00:00:02Z",
    columns: ["event_id"],
    expectedRowCount: 1_000,
    firstPageAvailableAt: "2026-07-12T00:00:02Z",
    storageStatus: "collecting" as const,
  };
  const visible = buildTrinoExecutionTimelineModel(makeRun({ result: commonResult, status: "succeeded" }), null, Date.parse("2026-07-12T00:00:02.001Z"));
  const unknown = buildTrinoExecutionTimelineModel(makeRun({
    result: { ...commonResult, expectedRowCount: undefined },
    stats: { outputRows: undefined },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:10Z"));

  assert.equal(visible.collectionProgressVisible, true);
  assert.equal(unknown.collectionProgressPercentage, null);
  assert.equal(unknown.collectionProgressVisible, false);
});

test("expired results retain completed milestone timing", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    completedAt: "2026-07-12T00:00:12Z",
    result: {
      collectionCompletedAt: "2026-07-12T00:00:12Z",
      columns: ["event_id"],
      storageStatus: "expired",
    },
    status: "succeeded",
  }));

  assert.equal(model.collectionStageStatus, "completed");
  assert.equal(model.totalReadyMs, 12_000);
});

test("a result manifest cannot reveal later stages before query execution completes", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    result: {
      availablePageCount: 1,
      columns: ["event_id"],
      rowCount: 20,
      storageStatus: "available",
    },
    startedAt: "2026-07-12T00:00:01Z",
    stats: { progressPercentage: 50, queryState: "RUNNING" },
  }));

  assert.equal(model.queryExecutionComplete, false);
  assert.equal(model.firstResultStageVisible, false);
  assert.equal(model.collectionStageVisible, false);
});
