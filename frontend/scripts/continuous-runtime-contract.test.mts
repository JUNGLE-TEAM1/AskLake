import assert from "node:assert/strict";
import test from "node:test";

import {
  continuousRuntimeErrorMessage,
  isContinuousRuntimeTransition,
  shouldAcceptContinuousRuntimeUpdate,
} from "../src/services/continuousRuntimeContract.ts";
import type { JobRowData, KafkaContinuousRuntime } from "../src/types.ts";
import { retainedContinuousSessionId } from "../src/pages/ingest/jobs/continuousSessionSelection.ts";

function runtime(overrides: Partial<KafkaContinuousRuntime> = {}): KafkaContinuousRuntime {
  return {
    checkpointPath: "s3a://lake/checkpoints/job-1",
    consumedCount: 0,
    failedCount: 0,
    lagAvailable: false,
    laggingPartitionCount: 0,
    lastBatchInputRows: 0,
    lastRuleResult: {},
    partitionProgress: {},
    quarantinedCount: 0,
    replayedCount: 0,
    ruleContractVersion: "1.0",
    ruleMetrics: {},
    schemaChanges: [],
    schemaStatus: "stable",
    schemaVersion: 1,
    status: "running",
    storedCount: 0,
    ...overrides,
  };
}

function job(overrides: Partial<JobRowData> = {}): JobRowData {
  return {
    id: "job-1",
    lastRun: "-",
    lastState: "-",
    name: "Continuous Job",
    nextRun: "-",
    owner: "data-team-01",
    schedule: "실시간",
    source: "Kafka",
    status: "running",
    tag: "#stream",
    target: "clicks",
    executionMode: "continuous",
    continuousRuntime: runtime(),
    ...overrides,
  };
}

test("only server transitional statuses keep command polling active", () => {
  for (const status of ["starting", "pausing", "stopping"] as const) {
    assert.equal(isContinuousRuntimeTransition(job({ continuousRuntime: runtime({ status }) })), true);
  }
  for (const status of ["running", "paused", "stopped", "failed"] as const) {
    assert.equal(isContinuousRuntimeTransition(job({ continuousRuntime: runtime({ status }) })), false);
  }
});

test("an older command revision cannot overwrite the current runtime", () => {
  const current = job({
    updatedAt: "2026-07-16T05:00:02Z",
    continuousRuntime: runtime({ stateRevision: 4, status: "pausing" }),
  });
  const stale = job({
    updatedAt: "2026-07-16T05:00:03Z",
    continuousRuntime: runtime({ stateRevision: 3, status: "running" }),
  });
  assert.equal(shouldAcceptContinuousRuntimeUpdate(current, stale), false);
});

test("same-revision observations use server update time and legacy payloads remain compatible", () => {
  const current = job({
    updatedAt: "2026-07-16T05:00:02Z",
    continuousRuntime: runtime({ stateRevision: 4, storedCount: 10 }),
  });
  const stale = job({
    updatedAt: "2026-07-16T05:00:01Z",
    continuousRuntime: runtime({ stateRevision: 4, storedCount: 9 }),
  });
  const fresh = job({
    updatedAt: "2026-07-16T05:00:03Z",
    continuousRuntime: runtime({ stateRevision: 4, storedCount: 11 }),
  });
  assert.equal(shouldAcceptContinuousRuntimeUpdate(current, stale), false);
  assert.equal(shouldAcceptContinuousRuntimeUpdate(current, fresh), true);
  assert.equal(shouldAcceptContinuousRuntimeUpdate(
    job({ continuousRuntime: runtime({ stateRevision: undefined }) }),
    job({ continuousRuntime: runtime({ stateRevision: undefined }) }),
  ), true);
});

test("structured stage error wins while lastError remains a compatibility fallback", () => {
  assert.equal(continuousRuntimeErrorMessage(runtime({
    errorDetail: {
      stage: "catalog",
      code: "catalog_materialization_pending",
      message: "Catalog retry is pending.",
      retryable: true,
    },
    lastError: "legacy error",
  })), "Catalog retry is pending.");
  assert.equal(continuousRuntimeErrorMessage(runtime({ lastError: "legacy error" })), "legacy error");
});

test("continuous session polling retains an explicit user selection", () => {
  const sessions = [
    { sessionId: "session-current" },
    { sessionId: "session-failed" },
  ] as never[];

  assert.equal(retainedContinuousSessionId(sessions, "session-failed"), "session-failed");
  assert.equal(retainedContinuousSessionId(sessions, "session-missing"), "session-current");
  assert.equal(retainedContinuousSessionId([], "session-failed"), null);
});
