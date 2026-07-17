import assert from "node:assert/strict";
import test from "node:test";

import { buildFinalReceipt } from "./build-eks-day17-final-receipt.mjs";

const RUNS = [
  {
    alias: "Run A",
    run: "aaaaaaaaaaaa",
    job: "111111111111",
    dataset: "ddddddddddda",
  },
  {
    alias: "Run B",
    run: "bbbbbbbbbbbb",
    job: "222222222222",
    dataset: "dddddddddddb",
  },
  {
    alias: "Run C",
    run: "cccccccccccc",
    job: "333333333333",
    dataset: "dddddddddddc",
  },
];

function runEntries(status = "success") {
  return RUNS.map((run, index) => ({
    runHash: run.run,
    jobHash: run.job,
    rds: status,
    airflow: status,
    spark: status,
    catalog: status,
    uidHash: `uuuuuuuuuuu${index}`,
    snapshotHash: `sssssssssss${index}`,
    datasetHash: run.dataset,
    groupHash: `ggggggggggg${index}`,
    tableHash: `ttttttttttt${index}`,
    outputHash: `ooooooooooo${index}`,
    checkpointHash: `ccccccccccc${index}`,
  }));
}

function record(at, { driver = {}, executor = {}, sparkNodes = 0, success = false } = {}) {
  return {
    observedAt: at,
    runs: {
      entries: runEntries(success ? "success" : "running"),
      continuousSessionsStarted: 0,
    },
    pods: {
      totals: {
        driver: { Pending: 0, Running: 0, Completed: 0, ...driver },
        executor: { Pending: 0, Running: 0, Completed: 0, ...executor },
      },
    },
    nodeScale: { baselineSparkNodes: 0, sparkNodes },
    events: {
      items:
        sparkNodes === 0 && success
          ? [{ observedAt: at, reason: "RemovingNode", kind: "Node" }]
          : [],
    },
  };
}

function fixture() {
  const trueChecks = {
    raceStartedAtSixReplicas: true,
    rdsRunExactlyOne: true,
    externalExecutionExactlyOne: true,
  };
  const race = {
    status: "passed",
    checks: trueChecks,
    counts: {
      raceTargets: 6,
      externalExecutions: 1,
      sparkApplications: 1,
      newIcebergSnapshots: 1,
      catalogMaterializations: 1,
      continuousSessionsStarted: 0,
    },
    timeline: [
      { at: "2026-07-17T06:58:14Z", event: "race-run-created-at-six-replicas" },
      { at: "2026-07-17T07:31:56Z", event: "read-only-recovery-verification-passed" },
    ],
    redactedIdentity: {
      run: "rrrrrrrrrrrr",
      application: "aaaaaaaaaaap",
      snapshot: "ssssssssssss",
      dataset: "dddddddddddd",
      fixtureBatch: "ffffffffffff",
    },
    privateIdentity: { runId: "private-race-run", jobId: "private-race-job" },
  };
  const load = {
    observedAt: "2026-07-17T07:03:19Z",
    phase: "completed-200",
    targetRps: 200,
    totalRequests: 1000,
    non2xx: 0,
    serverErrors: 0,
  };
  const scaleRecords = [
    {
      observedAt: "2026-07-17T06:06:46Z",
      hpa: { currentReplicas: 2 },
      fastapi: { deployment: { ready: 2 } },
      load: { state: "connected" },
    },
    {
      observedAt: "2026-07-17T06:15:00Z",
      hpa: { currentReplicas: 6 },
      fastapi: { deployment: { ready: 6 } },
      load: { state: "connected" },
    },
  ];
  const campaign = {
    status: "submitted",
    createdAt: "2026-07-17T11:29:45Z",
    counts: { submittedRuns: 3 },
    redactedRuns: RUNS,
    privateIdentity: RUNS.map((run) => ({
      alias: run.alias,
      runId: `private-${run.alias}`,
      jobId: `private-job-${run.alias}`,
    })),
  };
  const multiRecords = [
    record("2026-07-17T11:30:19Z", { driver: { Pending: 2 } }),
    record("2026-07-17T11:30:25Z", { driver: { Pending: 2 }, sparkNodes: 1 }),
    record("2026-07-17T11:30:32Z", { driver: { Pending: 3 }, sparkNodes: 1 }),
    record("2026-07-17T11:31:01Z", { driver: { Running: 3 }, sparkNodes: 1 }),
    record("2026-07-17T11:31:08Z", {
      driver: { Running: 3 },
      executor: { Pending: 1 },
      sparkNodes: 1,
    }),
    record("2026-07-17T11:31:15Z", {
      driver: { Running: 3 },
      executor: { Pending: 3 },
      sparkNodes: 2,
    }),
    record("2026-07-17T11:31:58Z", {
      driver: { Running: 3 },
      executor: { Running: 3 },
      sparkNodes: 2,
    }),
    record("2026-07-17T11:33:10Z", { sparkNodes: 2, success: true }),
    record("2026-07-17T11:43:01Z", { sparkNodes: 0, success: true }),
  ];
  const multiChecks = {
    consumerGroupsUnique: true,
    icebergTablesUnique: true,
    outputsUnique: true,
    checkpointsUnique: true,
    snapshotsUnique: true,
    datasetsUnique: true,
    noResultSubstitution: true,
  };
  const multiResults = {
    status: "passed",
    checks: multiChecks,
    counts: {
      runs: 3,
      expectedRows: 300,
      sparkInputRows: 300,
      sparkOutputRows: 300,
      trinoVerifiedRows: 300,
      dataFiles: 3,
      materializations: 3,
    },
  };
  const cleanup = {
    status: "passed",
    observedAt: "2026-07-17T12:00:45Z",
    checks: {
      hpaAtMinimum: true,
      fastApiStable: true,
      fastApiPodsStable: true,
      sparkNodesReturnedToBaseline: true,
      temporaryResourcesZero: true,
      loadGeneratorStopped: true,
    },
    hpa: { current: 2 },
    fastapi: { deployment: { ready: 2 }, pods: { terminating: 0 } },
    campaign: { recoveredSparkNodes: 0 },
    temporary: {
      jobs: 0,
      pods: 0,
      configMaps: 0,
      secrets: 0,
      localLoadProcesses: 0,
    },
    preserved: { durableRuns: 3, snapshots: 3, materializations: 3 },
  };
  const priorReceipts = [
    { status: "partial", counts: { submittedRuns: 1, failedSubmissions: 2 } },
    { status: "partial", counts: { submittedRuns: 2, failedSubmissions: 1 } },
    { status: "submitted", counts: { submittedRuns: 3, failedSubmissions: 0 } },
  ];
  return {
    race,
    load,
    scaleRecords,
    campaign,
    multiRecords,
    multiResults,
    cleanup,
    priorReceipts,
    createdAt: "2026-07-17T12:01:00Z",
  };
}

test("builds a passed integrated receipt with two linked timelines", () => {
  const receipt = buildFinalReceipt(fixture());

  assert.equal(receipt.status, "passed");
  assert.ok(Object.values(receipt.checks).every(Boolean));
  assert.equal(receipt.outcomes.api.peakHpaReplicas, 6);
  assert.equal(receipt.outcomes.spark.peakSparkNodes, 2);
  assert.equal(receipt.outcomes.spark.finalCampaignSparkNodes, 0);
  assert.equal(receipt.outcomes.spark.trinoVerifiedRows, 300);
  assert.equal(receipt.identityLinks.multiSpark.length, 3);
  assert.deepEqual(
    receipt.sparkTimeline.map((item) => item.at),
    receipt.sparkTimeline.map((item) => item.at).sort(),
  );
});

test("fails when pending to running evidence is incomplete", () => {
  const input = fixture();
  input.multiRecords = input.multiRecords.filter(
    (item) => item.pods.totals.executor.Pending !== 3,
  );

  const receipt = buildFinalReceipt(input);

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.checks.pendingToRunning, false);
});

test("fails closed instead of throwing when Pending was never observed", () => {
  const input = fixture();
  input.multiRecords = input.multiRecords.map((item) => ({
    ...item,
    pods: {
      totals: {
        driver: { ...item.pods.totals.driver, Pending: 0 },
        executor: { ...item.pods.totals.executor, Pending: 0 },
      },
    },
  }));

  const receipt = buildFinalReceipt(input);

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.checks.pendingToRunning, false);
  assert.equal(receipt.checks.sparkNodeScaleOut, false);
});

test("fails when one cross-run isolation check fails", () => {
  const input = fixture();
  input.multiResults.checks.snapshotsUnique = false;

  const receipt = buildFinalReceipt(input);

  assert.equal(receipt.status, "failed");
  assert.equal(receipt.checks.multiRunDataExact, false);
  assert.equal(receipt.checks.multiRunIsolation, false);
});

test("never copies raw private identities into the final receipt", () => {
  const input = fixture();
  const receipt = buildFinalReceipt(input);
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.checks.evidenceSanitized, true);
  assert.match(serialized, /"alias":"Run A"/);
  assert.doesNotMatch(serialized, /private-race-run|private-race-job|private-Run/);
  assert.doesNotMatch(serialized, /"runId"|"jobId"|"applicationUid"|"snapshotId"/);
});
