#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";

import {
  NodeScaleTracker,
  RDS_QUERY,
  RunAliasTracker,
  assertSanitizedSnapshot,
  buildIsolation,
  parseRdsPayload,
  parseScaleSlotConfig,
  parseSparkApplications,
  parseSparkPods,
  renderDashboard,
  shortHash,
} from "./watch-eks-day17-multi-spark.mjs";

function fixtureRun(index, overrides = {}) {
  const suffix = String(index).padStart(2, "0");
  return {
    createdAt: `2026-07-17T07:0${index}:00.000Z`,
    runHash: shortHash(`raw-run-${suffix}`),
    runLabelHash: shortHash(`raw-run-${suffix}`),
    jobHash: shortHash(`raw-job-${suffix}`),
    rds: "running",
    airflow: "running",
    spark: "running",
    catalog: "waiting",
    generation: 1,
    uidHash: shortHash(`raw-uid-${suffix}`),
    snapshotHash: null,
    datasetHash: shortHash(`raw-dataset-${suffix}`),
    groupHash: shortHash(`raw-group-${suffix}`),
    tableHash: shortHash(`raw-table-${suffix}`),
    outputHash: shortHash(`s3a://private/output/${suffix}`),
    checkpointHash: shortHash(`s3a://private/checkpoint/${suffix}`),
    ...overrides,
  };
}

function blankTestRoleCounts() {
  return {
    driver: { Pending: 0, Running: 0, Completed: 0 },
    executor: { Pending: 0, Running: 0, Completed: 0 },
  };
}

test("scale slot parser returns counts and booleans without raw group or table values", () => {
  const document = {
    data: {
      ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON: JSON.stringify([
        { consumerGroup: "asklake-eks-mvp-spark-v1", table: "eks_mvp_fixture" },
        { consumerGroup: "private-scale-01", table: "private_table_01" },
        { consumerGroup: "private-scale-02", table: "private_table_02" },
        { consumerGroup: "private-scale-03", table: "private_table_03" },
      ]),
    },
  };
  const parsed = parseScaleSlotConfig(document);
  assert.deepEqual(parsed, {
    status: "available",
    configured: true,
    valid: true,
    totalSlots: 4,
    scaleSlots: 3,
    uniqueConsumerGroups: true,
    uniqueTables: true,
    defaultPreserved: true,
  });
  assert.doesNotMatch(JSON.stringify(parsed), /private-scale|private_table/);

  assert.equal(parseScaleSlotConfig({ data: {} }).scaleSlots, 0);
  assert.equal(
    parseScaleSlotConfig({
      data: { ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON: "not-json" },
    }).status,
    "invalid",
  );
});

test("RDS payload parser accepts only hashes, bounded states, counts, and generations", () => {
  const rawRun = fixtureRun(1);
  const parsed = parseRdsPayload({
    multiSlotRuntimeSupport: true,
    fixtureJobs: 4,
    candidateScaleJobs: 3,
    candidateDistinctScaleSlots: 3,
    continuousSessionsStarted: 0,
    runs: [{
      ...rawRun,
      runId: "raw-run-must-not-survive",
      outputPath: "s3a://raw/private/path",
      rds: "running<script>",
    }],
  });
  assert.equal(parsed.status, "available");
  assert.equal(parsed.candidateDistinctScaleSlots, 3);
  assert.equal(parsed.runs[0].rds, "unknown");
  assert.equal(parsed.runs[0].runHash, rawRun.runHash);
  assert.doesNotMatch(JSON.stringify(parsed), /raw-run-must|s3a:|private\/path/);
});

test("Run aliases remain stable and isolation requires four 3-of-3 unique boundaries", () => {
  const tracker = new RunAliasTracker();
  const first = tracker.update([fixtureRun(1), fixtureRun(2)]);
  assert.deepEqual(first.map((run) => run.alias), ["A", "B", "C"]);
  assert.equal(first[0].runHash, fixtureRun(1).runHash);
  assert.equal(first[2].state, "waiting");

  const complete = tracker.update([fixtureRun(3), fixtureRun(1), fixtureRun(2)]);
  assert.deepEqual(complete.map((run) => run.runHash), [
    fixtureRun(1).runHash,
    fixtureRun(2).runHash,
    fixtureRun(3).runHash,
  ]);
  const isolation = buildIsolation(complete);
  assert.equal(isolation.valid, true);
  assert.equal(isolation.fields.consumerGroups.unique, 3);
  assert.equal(isolation.fields.icebergTables.unique, 3);
  assert.equal(isolation.fields.outputs.unique, 3);
  assert.equal(isolation.fields.checkpoints.unique, 3);

  const duplicated = complete.map((run, index) =>
    index === 2 ? { ...run, groupHash: complete[0].groupHash } : run,
  );
  assert.equal(buildIsolation(duplicated).valid, false);
});

test("SparkApplication parser emits only state plus Run and UID short hashes", () => {
  const parsed = parseSparkApplications({
    items: [
      {
        metadata: {
          name: "raw-application-name",
          uid: "123e4567-e89b-12d3-a456-426614174000",
          annotations: {
            "asklake.io/run-id": "raw-run-01",
            "asklake.io/job-id": "raw-job-01",
          },
        },
        status: { applicationState: { state: "RUNNING" } },
      },
      {
        metadata: {
          name: "raw-application-name-2",
          uid: "223e4567-e89b-12d3-a456-426614174000",
          annotations: { "asklake.io/run-id": "raw-run-02" },
        },
        status: { applicationState: { state: "COMPLETED" } },
      },
    ],
  });
  assert.deepEqual(parsed.counts, { Pending: 0, Running: 1, Completed: 1 });
  assert.equal(parsed.items[0].runHash, shortHash("raw-run-01"));
  assert.equal(parsed.items[0].uidHash, shortHash("123e4567-e89b-12d3-a456-426614174000"));
  assert.doesNotMatch(JSON.stringify(parsed), /raw-application|123e4567|raw-job/);
});

test("Spark Pod aggregation uses hashed Run labels and never exposes Pod names", () => {
  const parsed = parseSparkPods({
    items: [
      {
        metadata: {
          name: "raw-driver-name",
          labels: { "spark-role": "driver", "asklake.io/run-id": "raw-run-01" },
        },
        status: { phase: "Pending" },
      },
      {
        metadata: {
          name: "raw-executor-name",
          labels: { "spark-role": "executor", "asklake.io/run-id": "raw-run-01" },
        },
        status: { phase: "Running" },
      },
      {
        metadata: {
          name: "raw-executor-complete",
          labels: { "spark-role": "executor", "asklake.io/run-id": "raw-run-01" },
        },
        status: { phase: "Succeeded" },
      },
    ],
  });
  const counts = parsed.byRunLabelHash.get(shortHash("raw-run-01"));
  assert.equal(counts.driver.Pending, 1);
  assert.equal(counts.executor.Running, 1);
  assert.equal(counts.executor.Completed, 1);
  assert.doesNotMatch(JSON.stringify([...parsed.byRunLabelHash]), /raw-driver|raw-executor/);
});

test("node scale tracker distinguishes baseline, increase, event signal, and unavailable", () => {
  const startedAt = "2026-07-17T07:00:00.000Z";
  const tracker = new NodeScaleTracker(startedAt);
  const baseline = {
    status: "available",
    groups: [
      { pool: "asklake-general", type: "m7i-flex.large", state: "running", count: 2 },
      { pool: "asklake-spark", type: "m7i-flex.xlarge", state: "running", count: 1 },
    ],
  };
  assert.equal(tracker.observe(baseline, { items: [] }).status, "waiting");
  assert.equal(
    tracker.observe({
      status: "available",
      groups: [
        { pool: "asklake-spark", type: "m7i-flex.xlarge", state: "running", count: 2 },
      ],
    }, { items: [] }).status,
    "observable",
  );
  assert.equal(
    new NodeScaleTracker(startedAt).observe(baseline, {
      items: [{
        observedAt: "2026-07-17T07:00:05.000Z",
        reason: "Launched",
        kind: "NodeClaim",
      }],
    }).eventSignal,
    true,
  );
  assert.equal(
    new NodeScaleTracker(startedAt).observe({ status: "unavailable" }, { items: [] }).status,
    "unavailable",
  );
});

test("dashboard reports explicit General/Spark totals plus sanitized instance aggregation", () => {
  const output = renderDashboard({
    observedAt: "2026-07-17T07:00:00.000Z",
    runs: {
      entries: ["A", "B", "C"].map((alias) => ({ alias, state: "waiting" })),
    },
    sparkApplications: {
      status: "available",
      total: 0,
      counts: { Pending: 0, Running: 0, Completed: 0 },
      runs: ["A", "B", "C"].map((alias) => ({
        alias,
        state: "waiting",
        uidHash: null,
      })),
    },
    pods: {
      status: "available",
      runs: ["A", "B", "C"].map((alias) => ({
        alias,
        counts: blankTestRoleCounts(),
      })),
    },
    isolation: buildIsolation([]),
    nodes: {
      status: "available",
      groups: [
        { pool: "asklake-general", type: "m7i-flex.large", state: "running", count: 2 },
        { pool: "asklake-spark", type: "m7i-flex.xlarge", state: "running", count: 3 },
      ],
    },
    nodeScale: {
      status: "observable",
      baselineSparkNodes: 0,
      sparkNodes: 3,
    },
    events: { status: "available", items: [] },
    gates: {
      threeRunsActive: "waiting-0/3",
      applicationUidsUnique: "waiting-0/3",
      isolation: "waiting-0/3",
      continuous: "ready-0",
      nodeScale: "observable",
    },
    runtimeConfig: { scaleSlots: 3 },
    setup: {
      candidateDistinctScaleSlots: 3,
      multiSlotRuntimeSupport: true,
    },
    blockers: [],
    errors: [],
  }, { interval: 5 });

  assert.match(output, /NODES\s+General 2 · Spark 3/);
  assert.match(output, /general\/m7i-flex\.large\/running=2/);
  assert.match(output, /spark\/m7i-flex\.xlarge\/running=3/);
  assert.match(output, /node scale observable/);
});

test("sanitizer rejects raw identity keys and common endpoint/identifier values", () => {
  assert.equal(assertSanitizedSnapshot({ runHash: shortHash("run"), state: "running" }).state, "running");
  assert.throws(
    () => assertSanitizedSnapshot({ runId: "raw" }),
    /unsanitized key/,
  );
  assert.throws(
    () => assertSanitizedSnapshot({ value: "s3a://private/output" }),
    /unsanitized identifier/,
  );
  assert.throws(
    () => assertSanitizedSnapshot({ value: "arn:aws:iam::123456789012:role/private" }),
    /unsanitized identifier/,
  );
});

test("dashboard renders required sections and explicit blockers without raw identifiers", () => {
  const entries = [
    { ...fixtureRun(1), alias: "A", state: "observed" },
    { alias: "B", state: "waiting" },
    { alias: "C", state: "waiting" },
  ];
  const output = renderDashboard({
    observedAt: "2026-07-17T07:00:00.000Z",
    runs: { entries },
    sparkApplications: {
      status: "unavailable",
      error: "RBAC forbidden",
    },
    pods: {
      status: "available",
      runs: entries.map((run) => ({ alias: run.alias, counts: {
        driver: { Pending: 0, Running: 0, Completed: 0 },
        executor: { Pending: 0, Running: 0, Completed: 0 },
      } })),
    },
    isolation: buildIsolation(entries),
    nodes: { status: "unavailable", error: "AWS access denied", groups: [] },
    nodeScale: { status: "unavailable", baselineSparkNodes: null, sparkNodes: null },
    events: { status: "available", items: [] },
    gates: {
      threeRunsActive: "waiting-1/3",
      applicationUidsUnique: "unavailable",
      isolation: "waiting-1/3",
      continuous: "ready-0",
      nodeScale: "unavailable",
    },
    runtimeConfig: { scaleSlots: 0 },
    setup: {
      candidateDistinctScaleSlots: 0,
      multiSlotRuntimeSupport: false,
    },
    blockers: [
      "scale slots not configured",
      "candidate jobs missing",
      "SparkApplication RBAC unavailable",
      "Node visibility unavailable",
    ],
    errors: [],
  }, { interval: 5 });
  for (const section of ["RUNS", "SPARK", "PODS", "ISOLATION", "NODES", "EVENTS", "GATES", "BLOCKERS"]) {
    assert.match(output, new RegExp(section));
  }
  assert.match(output, /scale slots not configured/);
  assert.match(output, /candidate jobs missing/);
  assert.match(output, /SparkApplication RBAC unavailable/);
  assert.match(output, /Node visibility unavailable/);
  assert.match(output, /NODES\s+unavailable\/AWS access denied/);
  assert.match(output, /isolation valid waiting-1\/3/);
  assert.match(output, /Continuous 0/);
  assert.doesNotMatch(output, /s3a:|raw-group|raw-table|raw-job/);
});

test("in-Pod RDS query remains SELECT-only and hashes every returned identity", () => {
  assert.match(RDS_QUERY, /select\(ETLRunModel\)/);
  assert.match(RDS_QUERY, /short_hash\(boundary\.get\("consumerGroup"\)\)/);
  assert.match(RDS_QUERY, /short_hash\(boundary\.get\("outputPath"\)\)/);
  assert.doesNotMatch(
    RDS_QUERY,
    /\bdb\.(add|delete|commit|flush|merge|execute)\b|\bsession\.(add|delete|commit|flush|merge|execute)\b/,
  );
});
