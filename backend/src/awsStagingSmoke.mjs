import { createHash } from "node:crypto";

export const AWS_STAGING_SMOKE_EVIDENCE_SCHEMA = "asklake.aws-staging-smoke-evidence.v1";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const APPLICATION_ID = /^[0-9a-z]{1,64}$/;
const JOB_RUN_ID = /^[0-9A-Za-z_-]{1,256}$/;
const S3_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const FORBIDDEN_KEY = /(access.?key|secret|credential|password|authorization|bootstrap.?broker|session.?token)/i;

export function createAwsStagingSmokePlan(input, contract, options = {}) {
  const stackId = requiredPattern(input?.stackId, new RegExp(contract?.naming?.stackIdPattern || SAFE_ID), "stackId");
  const sourceRevision = requiredPattern(input?.sourceRevision, SHA, "sourceRevision");
  const smokeBundleSha256 = requiredPattern(input?.smokeBundleSha256, /^[a-f0-9]{64}$/, "smokeBundleSha256");
  const runtimeRootUri = requiredPattern(input?.runtimeRootUri, S3_URI, "runtimeRootUri").replace(/\/+$/, "");
  if (!runtimeRootUri.includes(`/runtime/`)) fail("Runtime root must identify an immutable runtime delivery.");
  if (contract?.environment !== "staging" || contract?.region !== "ap-northeast-2") {
    fail("AWS staging contract environment is invalid.");
  }
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) fail("Smoke plan time is invalid.");
  return Object.freeze({
    schemaVersion: "asklake.aws-staging-smoke-plan.v1",
    contractId: contract.contractId,
    createdAt: now.toISOString().replace(".000Z", "Z"),
    environment: contract.environment,
    region: contract.region,
    runtimeRootUri,
    sourceRevision,
    smokeBundleSha256,
    stackId,
    workload: Object.freeze({
      batchFixtureBytes: contract.smoke.batchFixtureBytes,
      maxOffsetsPerTrigger: contract.smoke.maxOffsetsPerTrigger,
      microBatchTriggerSeconds: contract.smoke.microBatchTriggerSeconds,
      producerRatePerSecond: contract.smoke.producerRatePerSecond,
      recordCount: contract.smoke.recordCount,
      topicPartitions: contract.smoke.topicPartitions,
    }),
  });
}

export function evaluateAwsStagingSmokeEvidence(value, contract) {
  const evidence = requiredObject(value, "evidence");
  assertNoSecrets(evidence);
  equal(evidence.schemaVersion, AWS_STAGING_SMOKE_EVIDENCE_SCHEMA, "schemaVersion");
  equal(evidence.contractId, contract.contractId, "contractId");
  equal(evidence.environment, contract.environment, "environment");
  equal(evidence.region, contract.region, "region");
  requiredPattern(evidence.stackId, new RegExp(contract?.naming?.stackIdPattern || SAFE_ID), "stackId");
  requiredPattern(evidence.sourceRevision, SHA, "sourceRevision");
  requiredPattern(evidence.smokeBundleSha256, /^[a-f0-9]{64}$/, "smokeBundleSha256");
  requiredPattern(evidence.runtimeRootUri, S3_URI, "runtimeRootUri");
  const startedAt = timestamp(evidence.startedAt, "startedAt");
  const completedAt = timestamp(evidence.completedAt, "completedAt");
  if (completedAt < startedAt) fail("Smoke evidence timestamps are out of order.");

  const checks = requiredObject(evidence.checks, "checks");
  const requiredChecks = new Set(contract.smoke.requiredChecks);
  for (const name of requiredChecks) {
    const check = requiredObject(checks[name], `checks.${name}`);
    if (check.status !== "passed") fail(`Required smoke check did not pass: ${name}.`);
  }

  const s3 = requiredObject(evidence.s3, "s3");
  equal(s3.readBucketCount, 4, "S3 read bucket count");
  equal(s3.writeBucketCount, 4, "S3 write bucket count");
  if (s3.roundTripObjectsDeleted !== true) fail("S3 readiness objects were not removed.");

  const msk = requiredObject(evidence.msk, "msk");
  equal(msk.status, "success", "MSK probe status");
  equal(msk.runtime, "msk", "MSK runtime");
  equal(msk.partitions, contract.smoke.topicPartitions, "MSK topic partition count");
  if (!Array.isArray(msk.policyMismatches) || msk.policyMismatches.length !== 0) {
    fail("MSK topic policy has mismatches.");
  }
  if (!String(msk.topic || "").startsWith(`asklake.staging.${evidence.stackId}.`)) {
    fail("MSK smoke topic is outside the stack namespace.");
  }
  if (!String(msk.continuousTopic || "").startsWith(`asklake.staging.${evidence.stackId}.continuous-smoke.`)) {
    fail("MSK continuous smoke topic is outside the isolated stack namespace.");
  }
  equal(msk.continuousTopicPartitions, contract.smoke.topicPartitions, "MSK continuous topic partition count");
  if (!Array.isArray(msk.continuousTopicPolicyMismatches) || msk.continuousTopicPolicyMismatches.length !== 0) {
    fail("MSK continuous topic policy has mismatches.");
  }

  const batch = requiredObject(evidence.batch, "batch");
  requiredPattern(batch.applicationId, APPLICATION_ID, "Batch applicationId");
  requiredPattern(batch.jobRunId, JOB_RUN_ID, "Batch jobRunId");
  equal(batch.status, "success", "Batch status");
  const batchInput = nonNegativeInteger(batch.inputRows, "Batch inputRows");
  const batchOutput = nonNegativeInteger(batch.outputRows, "Batch outputRows");
  if (batchInput < 1 || batchInput !== batchOutput) fail("Batch input/output counts do not match.");
  requiredPattern(batch.reportUri, S3_URI, "Batch reportUri");

  const continuous = requiredObject(evidence.continuous, "continuous");
  const produced = nonNegativeInteger(continuous.producedCount, "Continuous producedCount");
  const consumed = nonNegativeInteger(continuous.consumedCount, "Continuous consumedCount");
  const sink = nonNegativeInteger(continuous.sinkCount, "Continuous sinkCount");
  equal(produced, contract.smoke.recordCount, "Continuous produced count");
  if (produced !== consumed || consumed !== sink) fail("Continuous produced/consumed/sink counts do not match.");
  equal(nonNegativeInteger(continuous.finalLag, "Continuous finalLag"), 0, "Continuous final lag");
  if (continuous.lagAvailable !== true) fail("Continuous final lag was not observed.");
  equal(nonNegativeInteger(continuous.quarantinedCount, "Continuous quarantinedCount"), 0, "Continuous quarantine count");
  if (continuous.checkpointResumed !== true) fail("Continuous checkpoint was not resumed.");
  requiredPattern(continuous.checkpointUri, S3_URI, "Continuous checkpointUri");
  requiredPattern(continuous.reportUri, S3_URI, "Continuous reportUri");
  const attempts = array(continuous.attempts, "Continuous attempts");
  if (attempts.length !== 2) fail("Continuous smoke requires exactly two attempts.");
  const attemptIds = new Set();
  const jobRunIds = new Set();
  for (const [index, attempt] of attempts.entries()) {
    const item = requiredObject(attempt, `continuous.attempts[${index}]`);
    const attemptId = requiredText(item.workerAttemptId, `continuous.attempts[${index}].workerAttemptId`);
    const jobRunId = requiredPattern(item.jobRunId, JOB_RUN_ID, `continuous.attempts[${index}].jobRunId`);
    if (attemptIds.has(attemptId) || jobRunIds.has(jobRunId)) fail("Continuous attempt identity was reused.");
    attemptIds.add(attemptId);
    jobRunIds.add(jobRunId);
    if (item.duplicateSubmissionCount !== 0) fail("Continuous attempt submitted a duplicate remote Job.");
  }

  const storage = requiredObject(evidence.storage, "storage");
  for (const name of ["batchOutput", "batchReport", "continuousOutput", "continuousCheckpoint", "continuousReport"]) {
    if (storage[name] !== true) fail(`Required S3 evidence is missing: ${name}.`);
  }
  const resources = requiredObject(evidence.resources, "resources");
  if (!Array.isArray(resources.emrJobRuns) || resources.emrJobRuns.length !== 3) {
    fail("Exactly one Batch and two Continuous EMR Job Runs are required.");
  }
  if (!resources.priceSnapshotCaptured) fail("A run-time price snapshot is required.");
  const priceSnapshotUri = requiredPattern(resources.priceSnapshotUri, S3_URI, "resources.priceSnapshotUri");
  if (!priceSnapshotUri.startsWith(`${evidence.runtimeRootUri}/evidence/`)) {
    fail("Price snapshot is outside the immutable runtime evidence prefix.");
  }
  const workloadCounts = { batch: 0, continuous: 0 };
  const resourceJobRunIds = { batch: new Set(), continuous: new Set() };
  for (const [index, job] of resources.emrJobRuns.entries()) {
    const item = requiredObject(job, `resources.emrJobRuns[${index}]`);
    requiredPattern(item.applicationId, APPLICATION_ID, `resources.emrJobRuns[${index}].applicationId`);
    requiredPattern(item.jobRunId, JOB_RUN_ID, `resources.emrJobRuns[${index}].jobRunId`);
    if (!Object.hasOwn(workloadCounts, item.workload)) fail("EMR Job Run workload is invalid.");
    workloadCounts[item.workload] += 1;
    resourceJobRunIds[item.workload].add(item.jobRunId);
    equal(item.state, item.workload === "batch" ? "SUCCESS" : "CANCELLED", `EMR ${item.workload} Job state`);
    const billed = requiredObject(item.billedResourceUtilization, `resources.emrJobRuns[${index}].billedResourceUtilization`);
    for (const name of ["vCPUHour", "memoryGBHour", "storageGBHour"]) {
      const amount = Number(billed[name]);
      if (!Number.isFinite(amount) || amount < 0) fail(`EMR billed resource is invalid: ${name}.`);
    }
  }
  if (workloadCounts.batch !== 1 || workloadCounts.continuous !== 2) {
    fail("Smoke evidence requires one Batch and two Continuous EMR Job Runs.");
  }
  if (!resourceJobRunIds.batch.has(batch.jobRunId)) {
    fail("Batch evidence does not match the billed EMR Job Run.");
  }
  if (
    resourceJobRunIds.continuous.size !== jobRunIds.size
    || [...jobRunIds].some((jobRunId) => !resourceJobRunIds.continuous.has(jobRunId))
  ) {
    fail("Continuous attempts do not match the billed EMR Job Runs.");
  }

  const summary = Object.freeze({
    batchRows: batchOutput,
    continuousRows: sink,
    durationMs: completedAt - startedAt,
    passedChecks: requiredChecks.size,
    status: "passed",
  });
  return Object.freeze({ evidence: Object.freeze(structuredClone(evidence)), summary });
}

export function smokeEvidenceSha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertNoSecrets(value, path = "evidence") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) fail(`Sensitive key is not allowed in smoke evidence: ${path}.${key}.`);
      assertNoSecrets(item, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (/AKIA[0-9A-Z]{16}/.test(value) || /boot[^\s,]*\.kafka[^\s,]*:9098/i.test(value))) {
    fail(`Sensitive value is not allowed in smoke evidence: ${path}.`);
  }
}

function timestamp(value, name) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) fail(`${name} must be an ISO timestamp.`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative integer.`);
  return parsed;
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  return value;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\0]/.test(text)) fail(`${name} is invalid.`);
  return text;
}

function requiredPattern(value, pattern, name) {
  const text = requiredText(value, name);
  if (!pattern.test(text)) fail(`${name} is invalid.`);
  return text;
}

function equal(actual, expected, name) {
  if (actual !== expected) fail(`${name} does not match the Phase contract.`);
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_SMOKE_EVIDENCE_INVALID";
  throw error;
}
