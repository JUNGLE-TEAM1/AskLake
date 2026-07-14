import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AWS_STAGING_SMOKE_EVIDENCE_SCHEMA,
  AWS_STAGING_SMOKE_FAILURE_SCHEMA,
  createAwsStagingSmokePlan,
  createAwsStagingSmokeFailureEvidence,
  evaluateAwsStagingSmokeEvidence,
  evaluateAwsStagingSmokeFailureEvidence,
  smokeEvidenceSha256,
} from "../src/awsStagingSmoke.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));
const revision = "a".repeat(40);
const runtimeRootUri = "s3://asklake-stg-123456789012-apne2-phase4-artifact/emr-serverless/runtime/100-1";

const bundleSha256 = "b".repeat(64);
const plan = createAwsStagingSmokePlan({ runtimeRootUri, sourceRevision: revision, smokeBundleSha256: bundleSha256, stackId: "phase4" }, contract, {
  now: new Date("2026-07-14T00:00:00Z"),
});
assert.equal(plan.workload.recordCount, 1_000_000);
assert.equal(plan.workload.batchFixtureBytes, 104_857_600);
assert.equal(plan.runtimeRootUri, runtimeRootUri);
assert.throws(
  () => createAwsStagingSmokePlan({ runtimeRootUri: "s3://bucket/not-runtime/1", sourceRevision: revision, smokeBundleSha256: bundleSha256, stackId: "phase4" }, contract),
  invalid,
);

const evidence = sampleEvidence();
const evaluated = evaluateAwsStagingSmokeEvidence(evidence, contract);
assert.equal(evaluated.summary.status, "passed");
assert.equal(evaluated.summary.continuousRows, 1_000_000);
assert.match(smokeEvidenceSha256(evidence), /^[a-f0-9]{64}$/);
assert.equal(smokeEvidenceSha256(evidence), smokeEvidenceSha256(JSON.parse(JSON.stringify(evidence))));

const failureEvidence = createAwsStagingSmokeFailureEvidence({
  cleanupRequired: true,
  failureCode: "AWS_STAGING_SMOKE_FAILED",
  runtimeRootUri,
  smokeBundleSha256: bundleSha256,
  sourceRevision: revision,
  stackId: "phase4",
  startedAt: "2026-07-14T00:00:00Z",
}, contract, new Date("2026-07-14T00:01:00Z"));
assert.equal(failureEvidence.schemaVersion, AWS_STAGING_SMOKE_FAILURE_SCHEMA);
assert.equal(evaluateAwsStagingSmokeFailureEvidence(failureEvidence, contract).status, "failed");
const unsafeFailure = structuredClone(failureEvidence);
unsafeFailure.failureCode = "failure-with-details";
assert.throws(() => evaluateAwsStagingSmokeFailureEvidence(unsafeFailure, contract), invalid);
const expandedFailure = structuredClone(failureEvidence);
expandedFailure.detail = "must-not-be-exported";
assert.throws(() => evaluateAwsStagingSmokeFailureEvidence(expandedFailure, contract), invalid);

for (const mutate of [
  (value) => { value.checks[contract.smoke.requiredChecks[0]].status = "failed"; },
  (value) => { value.continuous.sinkCount -= 1; },
  (value) => { value.continuous.finalLag = 1; },
  (value) => { value.continuous.lagAvailable = false; },
  (value) => { value.continuous.quarantinedCount = 1; },
  (value) => { value.continuous.checkpointResumed = false; },
  (value) => { value.msk.continuousTopic = "asklake.staging.phase4.continuous-smoke"; },
  (value) => { value.continuous.attempts[1].jobRunId = value.continuous.attempts[0].jobRunId; },
  (value) => { value.resources.emrJobRuns[2].jobRunId = "jr-cont-phase4-other"; },
  (value) => { value.batch.outputRows -= 1; },
  (value) => { value.storage.continuousCheckpoint = false; },
  (value) => { value.resources.priceSnapshotCaptured = false; },
  (value) => { value.debug = { bootstrapBroker: "boot.secret.kafka.amazonaws.com:9098" }; },
]) {
  const changed = structuredClone(evidence);
  mutate(changed);
  assert.throws(() => evaluateAwsStagingSmokeEvidence(changed, contract), invalid);
}

const smokeWorkflow = readFileSync(path.join(repositoryRoot, ".github", "workflows", "aws-staging-smoke.yml"), "utf8");
for (const required of [
  "workflow_dispatch:",
  "environment: asklake-aws-staging-smoke",
  "AWS_STAGING_OPERATION: smoke",
  "smoke:<stack_id>",
  "aws ssm send-command",
  "run-aws-staging-smoke.mjs",
  "evaluate-aws-staging-smoke.mjs",
  "aws pricing get-products",
  "source_revision=$(node",
  "q(process.env.GITHUB_SHA)",
  "timeout-minutes: 150",
]) assert.ok(smokeWorkflow.includes(required), `Smoke workflow is missing: ${required}`);
assert.ok(!/\bon:\s*(?:push|pull_request|schedule)\b/.test(smokeWorkflow));
assert.ok(!/AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/.test(smokeWorkflow));

const artifactWorkflow = readFileSync(path.join(repositoryRoot, ".github", "workflows", "aws-staging-artifacts.yml"), "utf8");
for (const required of ["asklake-smoke-bundle.tgz", "smoke-bundle.json", "smokeBundleSha256"]) {
  assert.ok(artifactWorkflow.includes(required), `Artifact workflow is missing smoke bundle delivery: ${required}`);
}
assert.ok(artifactWorkflow.includes('"$RUNNER_TEMP/smoke-bundle"'));

const smokeRunner = readFileSync(path.join(repositoryRoot, "backend", "scripts", "run-aws-staging-smoke.mjs"), "utf8");
assert.ok(smokeRunner.includes("waitForContinuousCount(request, environment, firstTarget)"));
assert.ok(smokeRunner.includes("waitForContinuousCount(resumedRequest, environment, smokeContract.smoke.recordCount)"));
assert.ok(smokeRunner.includes("continuousAction({ ...request, action: \"status\" }, environment)"));

console.log("AWS staging Phase 4 smoke contract verification passed.");

function sampleEvidence() {
  const checks = Object.fromEntries(contract.smoke.requiredChecks.map((name) => [name, { status: "passed" }]));
  return {
    schemaVersion: AWS_STAGING_SMOKE_EVIDENCE_SCHEMA,
    batch: {
      applicationId: "00batchphase4",
      inputRows: 102400,
      jobRunId: "jr-batch-phase4",
      outputRows: 102400,
      outputUri: "s3://asklake-stg-123456789012-apne2-phase4-output/smoke/phase4/batch-output",
      reportUri: "s3://asklake-stg-123456789012-apne2-phase4-artifact/emr-serverless/runs/phase4/job-report.json",
      status: "success",
    },
    checks,
    completedAt: "2026-07-14T01:00:00Z",
    continuous: {
      applicationId: "00continuousphase4",
      attempts: [
        { duplicateSubmissionCount: 0, jobRunId: "jr-cont-phase4-1", workerAttemptId: "attempt-phase4-1" },
        { duplicateSubmissionCount: 0, jobRunId: "jr-cont-phase4-2", workerAttemptId: "attempt-phase4-2" },
      ],
      checkpointResumed: true,
      checkpointUri: "s3://asklake-stg-123456789012-apne2-phase4-output/smoke/phase4/checkpoint",
      consumedCount: 1_000_000,
      finalLag: 0,
      lagAvailable: true,
      outputUri: "s3://asklake-stg-123456789012-apne2-phase4-output/smoke/phase4/output",
      producedCount: 1_000_000,
      quarantinedCount: 0,
      reportUri: "s3://asklake-stg-123456789012-apne2-phase4-artifact/emr-serverless/continuous/jobs/phase4/job-report.json",
      sinkCount: 1_000_000,
    },
    contractId: contract.contractId,
    environment: contract.environment,
    msk: {
      continuousTopic: "asklake.staging.phase4.continuous-smoke.smoke-123-attempt1",
      continuousTopicPartitions: 3,
      continuousTopicPolicyMismatches: [],
      latencyMs: 20,
      partitions: 3,
      policyMismatches: [],
      retentionMs: 86_400_000,
      runtime: "msk",
      status: "success",
      topic: "asklake.staging.phase4.probe",
    },
    region: contract.region,
    resources: {
      emrJobRuns: [
        { applicationId: "00batchphase4", billedResourceUtilization: billed(), jobRunId: "jr-batch-phase4", state: "SUCCESS", workload: "batch" },
        { applicationId: "00continuousphase4", billedResourceUtilization: billed(), jobRunId: "jr-cont-phase4-1", state: "CANCELLED", workload: "continuous" },
        { applicationId: "00continuousphase4", billedResourceUtilization: billed(), jobRunId: "jr-cont-phase4-2", state: "CANCELLED", workload: "continuous" },
      ],
      priceSnapshotCaptured: true,
      priceSnapshotUri: "s3://asklake-stg-123456789012-apne2-phase4-artifact/emr-serverless/runtime/100-1/evidence/price.json",
    },
    runtimeRootUri,
    s3: { readBucketCount: 4, roundTripObjectsDeleted: true, writeBucketCount: 4 },
    sourceRevision: revision,
    smokeBundleSha256: bundleSha256,
    stackId: "phase4",
    startedAt: "2026-07-14T00:00:00Z",
    storage: {
      batchOutput: true,
      batchReport: true,
      continuousCheckpoint: true,
      continuousOutput: true,
      continuousReport: true,
    },
  };
}

function billed() {
  return { memoryGBHour: 0.2, storageGBHour: 0.1, vCPUHour: 0.05 };
}

function invalid(error) {
  return error?.code === "AWS_STAGING_SMOKE_EVIDENCE_INVALID";
}
