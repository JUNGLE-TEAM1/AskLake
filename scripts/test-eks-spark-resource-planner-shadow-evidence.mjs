#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  sparkResourcePlannerShadowEvidenceTemplate,
  validateSparkResourcePlannerShadowEvidence,
} from "./verify-eks-spark-resource-planner-shadow-evidence.mjs";


const PROFILE = {
  executorProfileName: "standard-v1",
  executorCores: 2,
  executorCpuRequest: "2",
  executorCpuLimit: "3",
  executorMemory: "4g",
  executorMemoryOverhead: "1g",
};


function plan(inputBytes, recommendedExecutors, overrides = {}) {
  const estimatedPartitions = Math.ceil(inputBytes / 134_217_728);
  const calculatedExecutors = Math.ceil(estimatedPartitions / 384);
  const value = {
    policyVersion: 3,
    policyName: "history-sla-cost-v1",
    policyTargetCompletionSeconds: 1800,
    mode: "shadow",
    decisionStatus: "planned",
    inputBytes,
    inputFileCount: 1,
    inputSizeSource: "s3_head",
    targetPartitionBytes: 134_217_728,
    targetPartitionsPerExecutor: 384,
    executorCandidates: [1, 2, 4],
    ...PROFILE,
    estimatedPartitions,
    calculatedExecutors,
    recommendedExecutors,
    baselineExecutors: 1,
    appliedExecutors: 1,
    minExecutors: 1,
    maxExecutors: 4,
    decisionBasis: "size_seed",
    historyEvidenceCount: 0,
    historyComparableCount: 0,
    historyRunIds: [],
    candidateEvaluations: [1, 2, 4].map((executors) => ({
      executors,
      estimatedDurationMs: null,
      estimatedExecutorSeconds: null,
      meetsTarget: null,
      evidenceCount: 0,
      estimateSource: "unavailable",
    })),
    costProxy: "executor_seconds",
    slaMetric: "spark_duration_ms",
    modelScalingExponent: 0.8,
    reason: "balanced_partition_budget",
    ...overrides,
  };
  const canonical = canonicalize(value);
  return {
    ...value,
    planHash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}


function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}


function run(alias, inputBytes, recommendedExecutors) {
  const resourcePlan = plan(inputBytes, recommendedExecutors);
  return {
    alias,
    resourcePlan,
    rds: { resourcePlanHash: resourcePlan.planHash },
    sparkApplication: {
      annotations: {
        "asklake.io/resource-plan-hash": resourcePlan.planHash,
        "asklake.io/resource-plan-mode": "shadow",
        "asklake.io/resource-policy": "history-sla-cost-v1",
        "asklake.io/executor-profile": "standard-v1",
        "asklake.io/calculated-executors": String(resourcePlan.calculatedExecutors),
        "asklake.io/recommended-executors": String(recommendedExecutors),
        "asklake.io/applied-executors": "1",
      },
      specExecutorInstances: 1,
    },
    outcome: {
      runStatus: "success",
      catalogStatus: "success",
      correctnessStatus: "passed",
      rowCountCheck: "passed",
      terminalState: "COMPLETED",
    },
    observation: {
      environmentComparable: true,
      concurrentSparkRuns: 1,
      coldStart: false,
      startedAt: "2026-07-20T00:00:00Z",
      endedAt: "2026-07-20T00:30:00Z",
    },
  };
}


function evidence() {
  return {
    contractVersion: "1.1",
    status: "passed",
    gitRevision: "a".repeat(40),
    backendImageDigest: `sha256:${"b".repeat(64)}`,
    sparkImageDigest: `sha256:${"c".repeat(64)}`,
    environment: {
      runtimeConfigMode: "shadow",
      runtimeConfigDataHash: "d".repeat(64),
      baselineExecutors: 1,
      executorProfile: { ...PROFILE },
      fastapiReady: 2,
      collectorReady: 1,
      externalHealthStatus: "passed",
      s3GatewayEndpointStatus: "available",
    },
    runs: [
      run("10gb-shadow", 9_235_015_833, 1),
      run("100gb-shadow", 97_079_116_733, 2),
    ],
    approvals: {
      backendRollout: true,
      runtimeShadowApply: true,
      run10gb: true,
      run100gb: true,
    },
    rollback: { plannerMode: "off", baselineExecutors: 1, valuesPrepared: true },
  };
}


test("accepts exact 10GB and 100GB shadow evidence", () => {
  assert.deepEqual(validateSparkResourcePlannerShadowEvidence(evidence()), {
    status: "passed",
    mode: "shadow",
    runs: ["10gb-shadow", "100gb-shadow"],
    actualExecutorInstances: 1,
  });
});

test("rejects recommendation, application, hash, and profile drift", () => {
  const recommendationDrift = evidence();
  recommendationDrift.runs[1].resourcePlan = plan(97_079_116_733, 4);
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(recommendationDrift),
    /recommendedExecutors is invalid/,
  );

  const applicationDrift = evidence();
  applicationDrift.runs[1].sparkApplication.specExecutorInstances = 2;
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(applicationDrift),
    /changed the actual executor count/,
  );

  const hashDrift = evidence();
  hashDrift.runs[0].resourcePlan.inputFileCount = 2;
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(hashDrift),
    /inputFileCount is invalid|hash does not match/,
  );

  const profileDrift = evidence();
  profileDrift.environment.executorProfile.executorCpuLimit = "2";
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(profileDrift),
    /does not match standard-v1/,
  );
});

test("rejects incomparable environments, missing approval, or rollback drift", () => {
  const incomparable = evidence();
  incomparable.runs[0].observation.environmentComparable = false;
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(incomparable),
    /comparability evidence is invalid/,
  );

  const unapproved = evidence();
  unapproved.approvals.run100gb = false;
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(unapproved),
    /required approvals/,
  );

  const rollbackDrift = evidence();
  rollbackDrift.rollback.plannerMode = "shadow";
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(rollbackDrift),
    /rollback values/,
  );
});

test("rejects raw infrastructure identities and emits a pending template", () => {
  const exposed = evidence();
  exposed.runs[0].runId = "raw-run-id";
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(exposed),
    /protected raw identity field/,
  );
  const exposedValue = evidence();
  exposedValue.notes = "arn:aws:s3:::raw-identity";
  assert.throws(
    () => validateSparkResourcePlannerShadowEvidence(exposedValue),
    /protected raw identity value/,
  );

  const template = sparkResourcePlannerShadowEvidenceTemplate();
  assert.equal(template.status, "pending");
  assert.deepEqual(
    template.runs.map((item) => item.alias),
    ["10gb-shadow", "100gb-shadow"],
  );
});
