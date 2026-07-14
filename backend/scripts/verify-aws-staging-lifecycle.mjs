import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AWS_STAGING_TTL_SWEEP_SCHEMA,
  createAwsStagingTtlSweepEvidence,
  evaluateAwsStagingTtlSweepEvidence,
  inspectAwsStagingTerraformState,
} from "../src/awsStagingLifecycle.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"), "utf8"));
const now = new Date("2026-07-14T12:00:00Z");
const active = inspectAwsStagingTerraformState({
  stateKey: "asklake/staging/phase5/terraform.tfstate",
  terraformState: terraformState("phase5", "2026-07-14T12:30:00Z"),
}, contract, now);
assert.equal(active.status, "active");

const expired = inspectAwsStagingTerraformState({
  stateKey: "asklake/staging/phase5-expired/terraform.tfstate",
  terraformState: terraformState("phase5-expired", "2026-07-14T11:00:00Z"),
}, contract, now);
assert.equal(expired.status, "expired");

const invalid = inspectAwsStagingTerraformState({
  stateKey: "asklake/staging/phase5-invalid/terraform.tfstate",
  terraformState: terraformState("other-stack", "2026-07-14T11:00:00Z"),
}, contract, now);
assert.deepEqual(invalid, {
  reason: "stack-identity-mismatch",
  stateKey: "asklake/staging/phase5-invalid/terraform.tfstate",
  status: "invalid",
});

const evidence = createAwsStagingTtlSweepEvidence({ states: [active, expired, invalid] }, contract, now);
assert.equal(evidence.schemaVersion, AWS_STAGING_TTL_SWEEP_SCHEMA);
assert.equal(evidence.summary.expiredCount, 1);
assert.equal(evidence.summary.invalidCount, 1);
const evaluated = evaluateAwsStagingTtlSweepEvidence(evidence, contract);
assert.equal(evaluated.attentionRequired, true);

const altered = structuredClone(evidence);
altered.automaticDestroyAllowed = true;
assert.throws(() => evaluateAwsStagingTtlSweepEvidence(altered, contract), invalidError);
const summaryDrift = structuredClone(evidence);
summaryDrift.summary.expiredCount = 0;
assert.throws(() => evaluateAwsStagingTtlSweepEvidence(summaryDrift, contract), invalidError);

const sweepScript = readFileSync(path.join(repositoryRoot, "backend", "scripts", "sweep-aws-staging-ttl.mjs"), "utf8");
assert.match(sweepScript, /ListObjectsV2Command/);
assert.match(sweepScript, /GetObjectCommand/);
assert.match(sweepScript, /asklake\\\/staging/);
assert.doesNotMatch(sweepScript, /DeleteObjectCommand|terraform\s+destroy|aws\s+.*delete/i);

console.log("AWS staging Phase 5 lifecycle contract verification passed.");

function terraformState(stackId, expiresAt) {
  return {
    resources: [
      {
        instances: [
          {
            attributes: {
              tags: {
                Environment: "staging",
                ExpiresAt: expiresAt,
                Issue: "727",
                ManagedBy: "terraform",
                Project: "AskLake",
                StackId: stackId,
              },
            },
          },
        ],
      },
    ],
  };
}

function invalidError(error) {
  return error?.code === "AWS_STAGING_TTL_SWEEP_INVALID";
}
