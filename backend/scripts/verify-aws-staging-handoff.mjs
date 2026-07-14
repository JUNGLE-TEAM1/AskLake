import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAwsStagingHandoff, renderAwsStagingHandoffMarkdown } from "../src/awsStagingHandoff.mjs";
import { createAwsStagingTtlSweepEvidence } from "../src/awsStagingLifecycle.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(path.join(root, "infra", "contracts", "aws-staging-smoke.v1.json"), "utf8"));
const revision = "a".repeat(40);
const smoke = sampleSmoke();
const ttl = createAwsStagingTtlSweepEvidence({ states: [{
  resourceTagCount: 0,
  stateKey: "asklake/staging/phase6/terraform.tfstate",
  status: "empty",
}] }, contract, new Date("2026-07-14T02:00:00Z"));
const cleanup = {
  commit: revision,
  planFingerprint: "c".repeat(64),
  schemaVersion: "asklake.aws-staging-smoke-cleanup.v1",
  smokeCommandStatus: "Success",
  stackId: "phase6",
  status: "destroy-request-completed",
};
const handoff = createAwsStagingHandoff({ cleanupReceipt: cleanup, smokeEvidence: smoke, ttlSweepEvidence: ttl }, contract);
assert.equal(handoff.status, "handoff-ready");
assert.equal(handoff.phase7Pilot.eligible, false);
assert.match(renderAwsStagingHandoffMarkdown(handoff), /Phase 7 pilot/);
assert.match(renderAwsStagingHandoffMarkdown(handoff), /jr-cont-2/);

const staleCleanup = structuredClone(cleanup);
staleCleanup.commit = "b".repeat(40);
assert.throws(() => createAwsStagingHandoff({ cleanupReceipt: staleCleanup, smokeEvidence: smoke, ttlSweepEvidence: ttl }, contract), invalid);
const expiredTtl = structuredClone(ttl);
expiredTtl.states = [{ expiresAt: "2026-07-14T00:00:00Z", resourceTagCount: 1, stackId: "phase6", stateKey: "asklake/staging/phase6/terraform.tfstate", status: "expired" }];
expiredTtl.summary = { activeCount: 0, emptyCount: 0, expiredCount: 1, invalidCount: 0, stateCount: 1 };
assert.throws(() => createAwsStagingHandoff({ cleanupReceipt: cleanup, smokeEvidence: smoke, ttlSweepEvidence: expiredTtl }, contract), invalid);
const unsafe = structuredClone(smoke);
unsafe.debug = { bootstrapBroker: "boot.secret.kafka.amazonaws.com:9098" };
assert.throws(() => createAwsStagingHandoff({ cleanupReceipt: cleanup, smokeEvidence: unsafe, ttlSweepEvidence: ttl }, contract), invalid);

const handoffDirectory = mkdtempSync(path.join(os.tmpdir(), "asklake-phase6-handoff-"));
try {
  const smokeFile = path.join(handoffDirectory, "input", "smoke.json");
  const cleanupFile = path.join(handoffDirectory, "input", "cleanup.json");
  const ttlFile = path.join(handoffDirectory, "input", "ttl.json");
  writeJson(smokeFile, smoke);
  writeJson(cleanupFile, cleanup);
  writeJson(ttlFile, ttl);
  const outputJson = path.join(handoffDirectory, "json", "handoff.json");
  const outputMarkdown = path.join(handoffDirectory, "markdown", "nested", "handoff.md");
  const cli = spawnSync(process.execPath, [
    path.join(root, "backend", "scripts", "render-aws-staging-handoff.mjs"),
    "--smoke-evidence", smokeFile,
    "--cleanup-receipt", cleanupFile,
    "--ttl-sweep-evidence", ttlFile,
    "--output-json", outputJson,
    "--output-markdown", outputMarkdown,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(existsSync(outputJson), true);
  assert.equal(existsSync(outputMarkdown), true);
} finally {
  rmSync(handoffDirectory, { force: true, recursive: true });
}

console.log("AWS staging Phase 6 handoff contract verification passed.");

function sampleSmoke() {
  const checks = Object.fromEntries(contract.smoke.requiredChecks.map((name) => [name, { status: "passed" }]));
  const billed = { memoryGBHour: 0.2, storageGBHour: 0.1, vCPUHour: 0.05 };
  return {
    schemaVersion: "asklake.aws-staging-smoke-evidence.v1",
    batch: { applicationId: "batchphase6", inputRows: 10, jobRunId: "jr-batch", outputRows: 10, reportUri: "s3://asklake-stg-123456789012-apne2-phase6-artifact/emr-serverless/runs/phase6/report.json", status: "success" },
    checks,
    completedAt: "2026-07-14T01:00:00Z",
    continuous: {
      applicationId: "continuousphase6",
      attempts: [{ duplicateSubmissionCount: 0, jobRunId: "jr-cont-1", workerAttemptId: "attempt-1" }, { duplicateSubmissionCount: 0, jobRunId: "jr-cont-2", workerAttemptId: "attempt-2" }],
      checkpointResumed: true,
      checkpointUri: "s3://asklake-stg-123456789012-apne2-phase6-output/smoke/checkpoint",
      consumedCount: 1_000_000,
      finalLag: 0,
      lagAvailable: true,
      producedCount: 1_000_000,
      quarantinedCount: 0,
      reportUri: "s3://asklake-stg-123456789012-apne2-phase6-artifact/emr-serverless/continuous/jobs/phase6/report.json",
      sinkCount: 1_000_000,
    },
    contractId: contract.contractId,
    environment: "staging",
    msk: { continuousTopic: "asklake.staging.phase6.continuous-smoke.run", continuousTopicPartitions: 3, continuousTopicPolicyMismatches: [], partitions: 3, policyMismatches: [], runtime: "msk", status: "success", topic: "asklake.staging.phase6.probe" },
    region: "ap-northeast-2",
    resources: { emrJobRuns: [{ applicationId: "batchphase6", billedResourceUtilization: billed, jobRunId: "jr-batch", state: "SUCCESS", workload: "batch" }, { applicationId: "continuousphase6", billedResourceUtilization: billed, jobRunId: "jr-cont-1", state: "CANCELLED", workload: "continuous" }, { applicationId: "continuousphase6", billedResourceUtilization: billed, jobRunId: "jr-cont-2", state: "CANCELLED", workload: "continuous" }], priceSnapshotCaptured: true, priceSnapshotUri: "s3://asklake-stg-123456789012-apne2-phase6-artifact/emr-serverless/runtime/1-1/evidence/price.json" },
    runtimeRootUri: "s3://asklake-stg-123456789012-apne2-phase6-artifact/emr-serverless/runtime/1-1",
    s3: { readBucketCount: 4, roundTripObjectsDeleted: true, writeBucketCount: 4 },
    smokeBundleSha256: "b".repeat(64),
    sourceRevision: revision,
    stackId: "phase6",
    startedAt: "2026-07-14T00:00:00Z",
    storage: { batchOutput: true, batchReport: true, continuousCheckpoint: true, continuousOutput: true, continuousReport: true },
  };
}

function invalid(error) { return error?.code === "AWS_STAGING_HANDOFF_INVALID"; }

function writeJson(file, value) {
  const directory = path.dirname(file);
  // The CLI must create only output directories; fixture input directories are test-owned.
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}
