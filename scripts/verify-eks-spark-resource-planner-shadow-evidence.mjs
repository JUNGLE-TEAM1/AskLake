#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


const STANDARD_PROFILE = Object.freeze({
  executorProfileName: "standard-v1",
  executorCores: 2,
  executorCpuRequest: "2",
  executorCpuLimit: "3",
  executorMemory: "4g",
  executorMemoryOverhead: "1g",
});
const EXPECTED_RUNS = Object.freeze({
  "10gb-shadow": { inputBytes: 9_235_015_833, recommendedExecutors: 1 },
  "100gb-shadow": { inputBytes: 97_079_116_733, recommendedExecutors: 2 },
});
const FORBIDDEN_KEYS = new Set([
  "accountid", "applicationname", "arn", "bucket", "credential", "endpoint",
  "jobid", "password", "runid", "secret", "snapshotid", "token",
]);
const FORBIDDEN_VALUE_PATTERNS = [
  /arn:aws:/i,
  /AKIA[0-9A-Z]{16}/,
  /asklake-run-[a-z0-9-]{8,}/i,
  /[a-z0-9.-]+\.(rds|kafka-serverless)\.[a-z0-9-]+\.amazonaws\.com/i,
];


function fail(message) {
  throw new Error(message);
}


function isSha256(value) {
  return /^sha256:[0-9a-f]{64}$/.test(String(value || ""));
}


function canonicalPlanHash(plan) {
  const canonical = canonicalize(
    Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planHash")),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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


function rejectProtectedIdentity(value, path = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectProtectedIdentity(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "string" && FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(`${path} contains a protected raw identity value`);
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail(`${path}.${key} is a protected raw identity field`);
    }
    rejectProtectedIdentity(item, `${path}.${key}`);
  }
}


function validateProfile(profile, label) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    fail(`${label} executor profile is missing`);
  }
  for (const [key, expected] of Object.entries(STANDARD_PROFILE)) {
    if (profile[key] !== expected) {
      fail(`${label} ${key} does not match standard-v1`);
    }
  }
}


function validatePlan(plan, expected, alias) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail(`${alias} Resource Plan is missing`);
  }
  const estimated = Math.max(1, Math.ceil(expected.inputBytes / 134_217_728));
  const calculated = Math.max(1, Math.ceil(estimated / 384));
  const exact = {
    policyVersion: 3,
    policyName: "history-sla-cost-v1",
    policyTargetCompletionSeconds: 1800,
    mode: "shadow",
    decisionStatus: "planned",
    inputBytes: expected.inputBytes,
    inputFileCount: 1,
    inputSizeSource: "s3_head",
    targetPartitionBytes: 134_217_728,
    targetPartitionsPerExecutor: 384,
    estimatedPartitions: estimated,
    calculatedExecutors: calculated,
    recommendedExecutors: expected.recommendedExecutors,
    baselineExecutors: 1,
    appliedExecutors: 1,
    minExecutors: 1,
    maxExecutors: 4,
    costProxy: "executor_seconds",
    slaMetric: "spark_duration_ms",
    modelScalingExponent: 0.8,
  };
  for (const [key, value] of Object.entries(exact)) {
    if (plan[key] !== value) fail(`${alias} Resource Plan ${key} is invalid`);
  }
  if (JSON.stringify(plan.executorCandidates) !== JSON.stringify([1, 2, 4])) {
    fail(`${alias} Resource Plan executorCandidates are invalid`);
  }
  validateHistoryDecision(plan, alias);
  validateProfile(plan, `${alias} Resource Plan`);
  if (!/^[0-9a-f]{64}$/.test(String(plan.planHash || ""))) {
    fail(`${alias} Resource Plan hash is invalid`);
  }
  if (canonicalPlanHash(plan) !== plan.planHash) {
    fail(`${alias} Resource Plan hash does not match its canonical payload`);
  }
}


function validateHistoryDecision(plan, alias) {
  if (!new Set(["history_sla_cost", "size_seed"]).has(plan.decisionBasis)) {
    fail(`${alias} Resource Plan decisionBasis is invalid`);
  }
  if (
    !Number.isSafeInteger(plan.historyEvidenceCount)
    || plan.historyEvidenceCount < 0
    || plan.historyEvidenceCount > 20
    || !Number.isSafeInteger(plan.historyComparableCount)
    || plan.historyComparableCount < 0
    || plan.historyComparableCount > plan.historyEvidenceCount
    || !Array.isArray(plan.historyRunIds)
    || plan.historyRunIds.length !== plan.historyEvidenceCount
  ) {
    fail(`${alias} Resource Plan history evidence is invalid`);
  }
  const evaluations = plan.candidateEvaluations;
  if (!Array.isArray(evaluations) || evaluations.length !== 3) {
    fail(`${alias} Resource Plan candidate evaluations are invalid`);
  }
  for (const [index, candidate] of [1, 2, 4].entries()) {
    const evaluation = evaluations[index];
    if (!evaluation || evaluation.executors !== candidate) {
      fail(`${alias} Resource Plan candidate executor is invalid`);
    }
  }
  if (plan.decisionBasis === "size_seed") {
    if (evaluations.some((item) => item.estimateSource !== "unavailable")) {
      fail(`${alias} size-seed Resource Plan contains modeled history`);
    }
    return;
  }
  if (plan.historyComparableCount < 1) {
    fail(`${alias} history Resource Plan lacks comparable evidence`);
  }
  const available = evaluations.filter((item) => (
    Number.isSafeInteger(item.estimatedDurationMs)
    && Number.isFinite(item.estimatedExecutorSeconds)
    && item.estimatedExecutorSeconds > 0
    && item.meetsTarget === (item.estimatedDurationMs <= 1_800_000)
    && new Set(["measured", "modeled"]).has(item.estimateSource)
  ));
  const meetingTarget = available.filter((item) => item.meetsTarget);
  const selected = meetingTarget.length > 0
    ? [...meetingTarget].sort((left, right) => (
      left.estimatedExecutorSeconds - right.estimatedExecutorSeconds
      || left.executors - right.executors
    ))[0]
    : [...available].sort((left, right) => right.executors - left.executors)[0];
  if (!selected || selected.executors !== plan.recommendedExecutors) {
    fail(`${alias} history Resource Plan recommendation is inconsistent`);
  }
}


function validateRun(run, expected, alias) {
  if (!run || run.alias !== alias) fail(`${alias} evidence is missing`);
  validatePlan(run.resourcePlan, expected, alias);
  const hash = run.resourcePlan.planHash;
  if (run.rds?.resourcePlanHash !== hash) fail(`${alias} RDS Plan hash does not match`);
  const annotations = run.sparkApplication?.annotations;
  const expectedAnnotations = {
    "asklake.io/resource-plan-hash": hash,
    "asklake.io/resource-plan-mode": "shadow",
    "asklake.io/resource-policy": "history-sla-cost-v1",
    "asklake.io/executor-profile": "standard-v1",
    "asklake.io/calculated-executors": String(run.resourcePlan.calculatedExecutors),
    "asklake.io/recommended-executors": String(expected.recommendedExecutors),
    "asklake.io/applied-executors": "1",
  };
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    if (annotations?.[key] !== value) fail(`${alias} SparkApplication annotation ${key} is invalid`);
  }
  if (run.sparkApplication?.specExecutorInstances !== 1) {
    fail(`${alias} shadow changed the actual executor count`);
  }
  const outcome = run.outcome;
  if (
    outcome?.runStatus !== "success"
    || outcome.catalogStatus !== "success"
    || outcome.correctnessStatus !== "passed"
    || outcome.rowCountCheck !== "passed"
    || outcome.terminalState !== "COMPLETED"
  ) {
    fail(`${alias} correctness or terminal outcome did not pass`);
  }
  const observation = run.observation;
  if (
    observation?.environmentComparable !== true
    || !Number.isSafeInteger(observation.concurrentSparkRuns)
    || observation.concurrentSparkRuns < 0
    || typeof observation.coldStart !== "boolean"
  ) {
    fail(`${alias} environment comparability evidence is invalid`);
  }
  const started = Date.parse(observation.startedAt);
  const ended = Date.parse(observation.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    fail(`${alias} observation timestamps are invalid`);
  }
}


export function validateSparkResourcePlannerShadowEvidence(evidence) {
  rejectProtectedIdentity(evidence);
  if (evidence?.contractVersion !== "1.1" || evidence.status !== "passed") {
    fail("shadow evidence contractVersion/status is invalid");
  }
  if (!/^[0-9a-f]{40}$/.test(String(evidence.gitRevision || ""))) {
    fail("shadow evidence Git revision is invalid");
  }
  if (!isSha256(evidence.backendImageDigest) || !isSha256(evidence.sparkImageDigest)) {
    fail("shadow evidence image digest is invalid");
  }
  const environment = evidence.environment;
  if (
    environment?.runtimeConfigMode !== "shadow"
    || environment.baselineExecutors !== 1
    || environment.fastapiReady !== 2
    || environment.collectorReady !== 1
    || environment.externalHealthStatus !== "passed"
    || environment.s3GatewayEndpointStatus !== "available"
    || !/^[0-9a-f]{64}$/.test(String(environment.runtimeConfigDataHash || ""))
  ) {
    fail("shadow environment readiness is invalid");
  }
  validateProfile(environment.executorProfile, "shadow environment");
  const runs = evidence.runs;
  if (!Array.isArray(runs) || runs.length !== 2) fail("shadow evidence must contain two runs");
  for (const [alias, expected] of Object.entries(EXPECTED_RUNS)) {
    validateRun(runs.find((run) => run?.alias === alias), expected, alias);
  }
  const approvals = evidence.approvals;
  if (
    approvals?.backendRollout !== true
    || approvals.runtimeShadowApply !== true
    || approvals.run10gb !== true
    || approvals.run100gb !== true
  ) {
    fail("shadow evidence does not record all required approvals");
  }
  if (
    evidence.rollback?.plannerMode !== "off"
    || evidence.rollback.baselineExecutors !== 1
    || evidence.rollback.valuesPrepared !== true
  ) {
    fail("shadow rollback values are not prepared");
  }
  return {
    status: "passed",
    mode: "shadow",
    runs: Object.keys(EXPECTED_RUNS),
    actualExecutorInstances: 1,
  };
}


export function sparkResourcePlannerShadowEvidenceTemplate() {
  return {
    contractVersion: "1.1",
    status: "pending",
    gitRevision: "<40-hex-git-revision>",
    backendImageDigest: "sha256:<64-hex>",
    sparkImageDigest: "sha256:<64-hex>",
    environment: {
      runtimeConfigMode: "shadow",
      runtimeConfigDataHash: "<64-hex>",
      baselineExecutors: 1,
      executorProfile: STANDARD_PROFILE,
      fastapiReady: 2,
      collectorReady: 1,
      externalHealthStatus: "pending",
      s3GatewayEndpointStatus: "available",
    },
    runs: Object.entries(EXPECTED_RUNS).map(([alias, expected]) => ({
      alias,
      expectedInputBytes: expected.inputBytes,
      expectedRecommendedExecutors: expected.recommendedExecutors,
      resourcePlan: "<copy sanitized full RDS resourcePlan>",
      rds: { resourcePlanHash: "<64-hex>" },
      sparkApplication: {
        annotations: "<copy only asklake.io Resource Planner annotations>",
        specExecutorInstances: 1,
      },
      outcome: {
        runStatus: "pending",
        catalogStatus: "pending",
        correctnessStatus: "pending",
        rowCountCheck: "pending",
        terminalState: "pending",
      },
      observation: {
        environmentComparable: false,
        concurrentSparkRuns: 0,
        coldStart: false,
        startedAt: "<ISO-8601>",
        endedAt: "<ISO-8601>",
      },
    })),
    approvals: {
      backendRollout: false,
      runtimeShadowApply: false,
      run10gb: false,
      run100gb: false,
    },
    rollback: { plannerMode: "off", baselineExecutors: 1, valuesPrepared: true },
  };
}


function main() {
  const argument = process.argv[2];
  if (argument === "--print-template" && process.argv.length === 3) {
    process.stdout.write(`${JSON.stringify(sparkResourcePlannerShadowEvidenceTemplate(), null, 2)}\n`);
    return;
  }
  if (!argument || process.argv.length !== 3) {
    console.error(`usage: ${process.argv[1]} --print-template|<private-evidence.json>`);
    process.exit(2);
  }
  try {
    const evidence = JSON.parse(readFileSync(argument, "utf8"));
    process.stdout.write(`${JSON.stringify(validateSparkResourcePlannerShadowEvidence(evidence))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
