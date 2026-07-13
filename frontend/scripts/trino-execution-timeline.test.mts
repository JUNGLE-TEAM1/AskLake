import assert from "node:assert/strict";
import test from "node:test";

import type { TrinoQueryRun } from "../src/types/sql.ts";
import {
  buildTrinoExecutionTimelineModel,
  PROGRESS_VISIBILITY_DELAY_MS,
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

test("Trino submission timeline is isolated from compatibility and mock execution", () => {
  assert.equal(shouldShowTrinoSubmissionTimeline(true, false), true);
  assert.equal(shouldShowTrinoSubmissionTimeline(false, false), false);
  assert.equal(shouldShowTrinoSubmissionTimeline(true, true), false);
});

test("queue states stay inside the single query execution stage", async (t) => {
  for (const queryState of ["QUEUED", "WAITING", "PLANNING", "STARTING"]) {
    await t.test(queryState, () => {
      const model = buildTrinoExecutionTimelineModel(makeRun({
        stats: { queryState },
        status: "queued",
      }));
      assert.equal(model.queryStageStatus, "active");
      assert.equal(model.queryPhaseLabel, "Trino 대기 중");
      assert.equal(model.queryElapsedMs, null);
      assert.equal(model.firstResultStageVisible, false);
      assert.equal(model.collectionStageVisible, false);
    });
  }
});

test("terminal runs without completed query execution stop at the query stage", async (t) => {
  for (const status of ["failed", "cancelled"] as const) {
    await t.test(status, () => {
      const model = buildTrinoExecutionTimelineModel(makeRun({ status }));
      assert.equal(model.queryStageStatus, status === "failed" ? "failed" : "cancelled");
      assert.equal(model.firstResultStageVisible, false);
      assert.equal(model.collectionStageVisible, false);
    });
  }
});

test("query progress appears only after two seconds with real Trino progress", () => {
  const short = buildTrinoExecutionTimelineModel(makeRun({
    startedAt: "2026-07-12T00:00:01Z",
    stats: { elapsedMs: 100, progressPercentage: 24.1, queryState: "RUNNING" },
  }), null, Date.parse("2026-07-12T00:00:02.999Z"));
  const long = buildTrinoExecutionTimelineModel(makeRun({
    startedAt: "2026-07-12T00:00:01Z",
    stats: { elapsedMs: 100, progressPercentage: 24.1, queryState: "RUNNING" },
  }), null, Date.parse("2026-07-12T00:00:03Z"));

  assert.equal(short.queryProgressVisible, false);
  assert.equal(short.queryElapsedMs, PROGRESS_VISIBILITY_DELAY_MS - 1);
  assert.equal(long.queryProgressVisible, true);
  assert.equal(long.queryElapsedMs, PROGRESS_VISIBILITY_DELAY_MS);
  assert.equal(long.runProgressPercentage, 24.1);
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

test("first-result stage is shown only after query execution and never owns a percent", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    result: {
      collectionStartedAt: "2026-07-12T00:00:02Z",
      columns: ["event_id"],
      storageStatus: "collecting",
    },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:05Z"));

  assert.equal(model.queryStageStatus, "completed");
  assert.equal(model.firstResultStageVisible, true);
  assert.equal(model.firstResultStageStatus, "active");
  assert.equal(model.firstResultReady, false);
  assert.equal(model.collectionStageVisible, false);
});

test("first page reveals the full-result collection stage", () => {
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
  assert.equal(model.firstResultElapsedMs, 5_000);
  assert.equal(model.collectionStageVisible, true);
  assert.equal(model.collectionStageStatus, "active");
  assert.equal(model.collectionProgressPercentage, 25);
  assert.equal(model.collectionProgressVisible, true);
  assert.equal(model.collectionRemainingMs, 9_000);
});

test("collection percent waits two seconds and requires collected and expected rows", () => {
  const commonResult = {
    availablePageCount: 1,
    collectedRowCount: 250,
    collectionStartedAt: "2026-07-12T00:00:02Z",
    columns: ["event_id"],
    expectedRowCount: 1_000,
    firstPageAvailableAt: "2026-07-12T00:00:02Z",
    storageStatus: "collecting" as const,
  };
  const short = buildTrinoExecutionTimelineModel(makeRun({
    result: commonResult,
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:03.999Z"));
  const long = buildTrinoExecutionTimelineModel(makeRun({
    result: commonResult,
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:04Z"));
  const unknown = buildTrinoExecutionTimelineModel(makeRun({
    result: {
      ...commonResult,
      collectionProgressPercentage: 80,
      expectedRowCount: undefined,
    },
    stats: { outputRows: undefined },
    status: "succeeded",
  }), null, Date.parse("2026-07-12T00:00:10Z"));

  assert.equal(short.collectionProgressVisible, false);
  assert.equal(long.collectionProgressVisible, true);
  assert.equal(unknown.collectionProgressPercentage, null);
  assert.equal(unknown.collectionProgressVisible, false);
});

test("100 percent row collection remains an active finalizing state until storage is available", () => {
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
  assert.equal(model.collectionProgressVisible, true);
  assert.equal(model.collectionFinalizing, true);
  assert.equal(model.collectionStageStatus, "active");
  assert.equal(model.collectionRemainingMs, null);
});

test("available, unavailable, and expired storage produce distinct terminal states", async (t) => {
  await t.test("available", () => {
    const model = buildTrinoExecutionTimelineModel(makeRun({
      result: { columns: ["event_id"], rowCount: 20, storageStatus: "available" },
      status: "succeeded",
    }));
    assert.equal(model.firstResultStageStatus, "completed");
    assert.equal(model.collectionStageStatus, "completed");
    assert.equal(model.collectionProgressVisible, false);
  });

  await t.test("unavailable before any page", () => {
    const model = buildTrinoExecutionTimelineModel(makeRun({
      result: { columns: ["event_id"], storageStatus: "unavailable" },
      status: "succeeded",
    }));
    assert.equal(model.firstResultStageStatus, "failed");
    assert.equal(model.collectionStageVisible, false);
    assert.equal(model.storageFailed, true);
  });

  await t.test("unavailable after a page", () => {
    const model = buildTrinoExecutionTimelineModel(makeRun({
      result: { availablePageCount: 1, columns: ["event_id"], storageStatus: "unavailable" },
      status: "succeeded",
    }));
    assert.equal(model.firstResultStageStatus, "completed");
    assert.equal(model.collectionStageStatus, "failed");
  });

  await t.test("expired", () => {
    const model = buildTrinoExecutionTimelineModel(makeRun({
      result: { columns: ["event_id"], rowCount: 20, storageStatus: "expired" },
      status: "succeeded",
    }));
    assert.equal(model.firstResultStageStatus, "completed");
    assert.equal(model.collectionStageStatus, "completed");
  });
});

test("legacy timestamps backfill milestone durations", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    completedAt: "2026-07-12T00:00:12Z",
    result: {
      collectionCompletedAt: "2026-07-12T00:00:12Z",
      collectionStartedAt: "2026-07-12T00:00:02Z",
      columns: ["event_id"],
      firstPageAvailableAt: "2026-07-12T00:00:05Z",
      storageStatus: "available",
    },
    status: "succeeded",
  }));

  assert.equal(model.firstResultElapsedMs, 5_000);
  assert.equal(model.collectionElapsedMs, 10_000);
  assert.equal(model.totalReadyMs, 12_000);
});

test("expired results retain their completed milestone timing", () => {
  const model = buildTrinoExecutionTimelineModel(makeRun({
    completedAt: "2026-07-12T00:00:12Z",
    result: {
      collectionCompletedAt: "2026-07-12T00:00:12Z",
      columns: ["event_id"],
      storageStatus: "expired",
    },
    status: "succeeded",
  }));

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
