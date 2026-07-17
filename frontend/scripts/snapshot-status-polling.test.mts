import assert from "node:assert/strict";
import test from "node:test";

import type { JobRowData, JobStatusSnapshot, RunsByJobId } from "../src/types.ts";
import {
  activeSnapshotJobIds,
  mergeJobDetailWithCurrentStatus,
  mergeJobStatusSnapshot,
  shouldApplyJobStatusSnapshot,
  snapshotStatusPollDelayMs,
} from "../src/state/asklake/snapshotStatusState.ts";


function job(id: string, runStatus: "queued" | "running" | "success" = "running"): JobRowData {
  return {
    id,
    lastRun: "2026-07-17T00:00:00Z",
    lastState: "running",
    name: id,
    nextRun: "-",
    owner: "test",
    runHistory: [{
      duration: "-",
      endedAt: "-",
      errorSummary: "",
      failedStage: "-",
      inputRows: "-",
      outputRows: "-",
      runId: `run-${id}`,
      startedAt: "2026-07-17T00:00:00Z",
      status: runStatus,
    }],
    schedule: "manual",
    source: "fixture",
    status: runStatus === "success" ? "scheduled" : "running",
    tag: "test",
    target: "fixture",
    updatedAt: "2026-07-17T00:00:00Z",
  };
}


function snapshot(id: string, status: "running" | "success", updatedAt: string): JobStatusSnapshot {
  return {
    dagSteps: [],
    id,
    lastRun: updatedAt,
    lastState: status,
    latestRun: {
      duration: status === "success" ? "5초" : "-",
      endedAt: status === "success" ? updatedAt : "-",
      errorSummary: "",
      failedStage: "-",
      inputRows: "10",
      outputRows: status === "success" ? "10" : "-",
      runId: `run-${id}`,
      startedAt: "2026-07-17T00:00:00Z",
      status,
    },
    nextRun: "-",
    progress: status === "success" ? null : { label: "Spark ETL", value: 60 },
    status: status === "success" ? "scheduled" : "running",
    updatedAt,
  };
}


test("one active-id collection excludes terminal, optimistic, and Continuous runs", () => {
  const activeOne = job("one");
  const activeTwo = job("two", "queued");
  const terminal = job("done", "success");
  const optimistic = job("optimistic");
  optimistic.runHistory![0].runId = "client:optimistic:1";
  const continuous = { ...job("continuous"), executionMode: "continuous" as const };
  const runs: RunsByJobId = Object.fromEntries(
    [activeOne, activeTwo, terminal, optimistic, continuous].map((item) => [item.id, item.runHistory!]),
  );

  assert.deepEqual(
    activeSnapshotJobIds([activeTwo, terminal, continuous, activeOne, optimistic], runs),
    ["one", "two"],
  );
});


test("an old non-terminal run does not keep polling after the latest run is terminal", () => {
  const completed = job("completed", "success");
  const oldRunningRun = {
    ...completed.runHistory![0],
    runId: "run-old-running",
    status: "running" as const,
  };
  const runs: RunsByJobId = {
    completed: [completed.runHistory![0], oldRunningRun],
  };

  assert.deepEqual(activeSnapshotJobIds([completed], runs), []);
});


test("a status snapshot updates progress and the matching latest run without losing history", () => {
  const current = job("one");
  current.runHistory!.push({ ...current.runHistory![0], runId: "run-old", status: "success" });

  const merged = mergeJobStatusSnapshot(
    current,
    snapshot("one", "success", "2026-07-17T00:00:05Z"),
  );

  assert.equal(merged.status, "scheduled");
  assert.equal(merged.progress, undefined);
  assert.deepEqual(merged.runHistory!.map((run) => run.runId), ["run-one", "run-old"]);
  assert.equal(merged.runHistory![0].status, "success");
});


test("an older or regressing response cannot overwrite newer state", () => {
  const current = mergeJobStatusSnapshot(
    job("one"),
    snapshot("one", "success", "2026-07-17T00:00:05Z"),
  );
  const older = snapshot("one", "running", "2026-07-17T00:00:04Z");
  const sameVersionRegression = snapshot("one", "running", "2026-07-17T00:00:05Z");

  assert.equal(shouldApplyJobStatusSnapshot(current, older), false);
  assert.equal(shouldApplyJobStatusSnapshot(current, sameVersionRegression), false);
  assert.equal(mergeJobStatusSnapshot(current, older), current);
});


test("a late detail response adds full history without regressing newer status", () => {
  const current = mergeJobStatusSnapshot(
    job("one"),
    snapshot("one", "success", "2026-07-17T00:00:05Z"),
  );
  const olderDetail = job("one", "running");
  olderDetail.updatedAt = "2026-07-17T00:00:04Z";
  olderDetail.runHistory!.push({
    ...olderDetail.runHistory![0],
    runId: "run-previous",
    status: "success",
  });

  const merged = mergeJobDetailWithCurrentStatus(current, olderDetail);

  assert.equal(merged.status, "scheduled");
  assert.equal(merged.runHistory![0].status, "success");
  assert.deepEqual(merged.runHistory!.map((run) => run.runId), ["run-one", "run-previous"]);
});


test("temporary failures back off and recover to the normal interval", () => {
  assert.equal(snapshotStatusPollDelayMs(0), 5000);
  assert.equal(snapshotStatusPollDelayMs(1), 10000);
  assert.equal(snapshotStatusPollDelayMs(2), 20000);
  assert.equal(snapshotStatusPollDelayMs(3), 30000);
  assert.equal(snapshotStatusPollDelayMs(20), 30000);
});
