import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activateAwsStagingContinuousRuntime } from "../src/awsStagingRuntime.mjs";
import {
  extractEmrServerlessConcurrentVcpu,
  prepareAwsStagingTerraformInputs,
} from "../src/awsStagingWorkflow.mjs";
import { createEmrJarBundle, uploadEmrJarBundle } from "../src/emrJarBundle.mjs";
import { writeAwsStagingTerraformInputs } from "./prepare-aws-staging-terraform-inputs.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));
const accountId = "123456789012";
const stackId = "phase3-test";
const now = new Date("2030-01-01T00:00:00Z");

function validInput(overrides = {}) {
  return {
    availableEmrServerlessConcurrentVcpu: 16,
    awsAccountId: accountId,
    budgetNotificationEmail: "staging-alerts@example.com",
    confirmation: "",
    enableSmokeRunner: false,
    githubOidcRoleArn: `arn:aws:iam::${accountId}:role/asklake-github-staging`,
    operation: "plan",
    region: "ap-northeast-2",
    smokeRunnerAmiId: "",
    stackId,
    stateBucketName: `asklake-terraform-state-${accountId}`,
    stateKmsKeyArn: `arn:aws:kms:ap-northeast-2:${accountId}:key/00000000-0000-4000-8000-000000000000`,
    ttlHours: 8,
    ...overrides,
  };
}

const prepared = prepareAwsStagingTerraformInputs(validInput(), contract, { now });
assert.equal(prepared.expiresAt, "2030-01-01T08:00:00Z");
assert.match(prepared.backend, /use_lockfile = true/);
assert.match(prepared.backend, /encrypt\s+= true/);
assert.equal(prepared.variables.available_emr_serverless_concurrent_vcpu, 16);
assert.equal(prepared.variables.stack_id, stackId);
assert.throws(
  () => prepareAwsStagingTerraformInputs(validInput({ operation: "apply", confirmation: "apply:wrong" }), contract, { now }),
  /confirmation does not match/,
);
assert.throws(
  () => prepareAwsStagingTerraformInputs(validInput({ ttlHours: 25 }), contract, { now }),
  /TTL is outside/,
);
assert.throws(
  () => prepareAwsStagingTerraformInputs(validInput({ availableEmrServerlessConcurrentVcpu: 15 }), contract, { now }),
  /quota is below/,
);
assert.throws(
  () => prepareAwsStagingTerraformInputs(validInput({
    stateKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000",
  }), contract, { now }),
  /KMS key does not match/,
);

const quotaPayload = {
  Quotas: [{ QuotaName: "Maximum concurrent vCPUs per account", Value: 32 }],
};
assert.equal(extractEmrServerlessConcurrentVcpu(quotaPayload, contract), 32);
assert.throws(
  () => extractEmrServerlessConcurrentVcpu({ Quotas: [{ QuotaName: "Maximum concurrent vCPUs", Value: 8 }] }, contract),
  /quota is below/,
);
assert.throws(
  () => extractEmrServerlessConcurrentVcpu({ Quotas: [...quotaPayload.Quotas, ...quotaPayload.Quotas] }, contract),
  /uniquely/,
);

const inputDirectory = mkdtempSync(path.join(os.tmpdir(), "asklake-phase3-inputs-"));
try {
  const backendFile = path.join(inputDirectory, "backend.hcl");
  const tfvarsFile = path.join(inputDirectory, "staging.tfvars.json");
  const outputFile = path.join(inputDirectory, "github-output.txt");
  writeAwsStagingTerraformInputs(validInput(), {
    backendFile,
    githubOutputFile: outputFile,
    now,
    tfvarsFile,
  });
  assert.equal(statSync(backendFile).mode & 0o777, 0o600);
  assert.equal(statSync(tfvarsFile).mode & 0o777, 0o600);
  const safeOutput = readFileSync(outputFile, "utf8");
  assert.match(safeOutput, /stack_id=phase3-test/);
  assert.ok(!safeOutput.includes("staging-alerts@example.com"));
  assert.ok(!safeOutput.includes(accountId));
} finally {
  rmSync(inputDirectory, { force: true, recursive: true });
}

const jarDirectory = mkdtempSync(path.join(os.tmpdir(), "asklake-phase3-jars-"));
try {
  writeFileSync(path.join(jarDirectory, "spark-sql-kafka-0-10_2.12-3.5.5.jar"), "spark-kafka");
  writeFileSync(path.join(jarDirectory, "aws-msk-iam-auth-2.3.6.jar"), "msk-iam");
  writeFileSync(path.join(jarDirectory, "kafka-clients-3.7.1.jar"), "kafka-client");
  const artifactRootUri = `s3://asklake-stg-${accountId}-apne2-${stackId}-artifact/emr-serverless`;
  const bundle = createEmrJarBundle(jarDirectory, artifactRootUri);
  assert.equal(bundle.manifest.jarCount, 3);
  assert.match(bundle.manifest.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    bundle.manifest.bundleRootUri,
    `${artifactRootUri}/dependencies/${bundle.manifest.bundleSha256}`,
  );
  const uploads = [];
  await uploadEmrJarBundle(bundle, { send: async (command) => uploads.push(command.input) });
  assert.equal(uploads.length, 4);
  assert.equal(uploads.at(-1).Key.endsWith("/bundle.json"), true);
  for (const upload of uploads) {
    assert.equal(upload.Metadata["asklake-bundle-sha256"], bundle.manifest.bundleSha256);
  }

  const runtimeEnvironment = [
    "# generated private runtime",
    `ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI=${artifactRootUri}`,
    "ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED=false",
    "ASKLAKE_MSK_BOOTSTRAP_BROKERS=broker.example.amazonaws.com:9098",
    "",
  ].join("\n");
  const runtimeManifest = {
    schemaVersion: "asklake.aws-staging-runtime.v1",
    activation: { runtimePromotionAllowed: false },
    env: {},
    runtime: { spark: {} },
  };
  const activated = activateAwsStagingContinuousRuntime(runtimeEnvironment, runtimeManifest, bundle.manifest);
  assert.equal(activated.environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED, "true");
  assert.equal(activated.manifest.activation.continuousConfigured, true);
  assert.equal(activated.manifest.activation.runtimePromotionAllowed, false);
  assert.equal(activated.manifest.runtime.spark.artifacts.bundleSha256, bundle.manifest.bundleSha256);
  assert.ok(!JSON.stringify(activated.manifest).includes("broker.example.amazonaws.com"));

  rmSync(path.join(jarDirectory, "aws-msk-iam-auth-2.3.6.jar"));
  assert.throws(() => createEmrJarBundle(jarDirectory, artifactRootUri), /missing a required direct dependency/);
  writeFileSync(path.join(jarDirectory, "aws-msk-iam-auth-2.3.6.jar"), "msk-iam");
  writeFileSync(path.join(jarDirectory, "unsafe-SNAPSHOT.jar"), "mutable");
  assert.throws(() => createEmrJarBundle(jarDirectory, artifactRootUri), /invalid or mutable/);
} finally {
  rmSync(jarDirectory, { force: true, recursive: true });
}

const workflows = Object.freeze({
  artifacts: readRepositoryFile(".github/workflows/aws-staging-artifacts.yml"),
  destroy: readRepositoryFile(".github/workflows/aws-staging-destroy.yml"),
  planApply: readRepositoryFile(".github/workflows/aws-staging-plan-apply.yml"),
});
for (const [name, workflow] of Object.entries(workflows)) {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m, `${name} must be manual-only`);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_run):/m, `${name} has an automatic trigger`);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\n  group: asklake-aws-staging-/m);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /timeout-minutes: [1-9][0-9]*/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /hashicorp\/setup-terraform@v4/);
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v6/);
  assert.match(workflow, /allowed-account-ids:/);
  assert.match(workflow, /mask-aws-account-id: true/);
  assert.match(workflow, /unset-current-credentials: true/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|aws-access-key-id/i);
}

assert.match(workflows.planApply, /operation:\n\s+description:[\s\S]*?- plan\n\s+- apply/);
assert.match(workflows.planApply, /environment: asklake-aws-staging-apply/);
assert.match(workflows.planApply, /inputs\.operation == 'apply'/);
assert.match(workflows.planApply, /service-quotas list-service-quotas/g);
assert.match(workflows.planApply, /terraform .* plan \\/);
assert.match(workflows.planApply, /terraform .* apply \\/);
assert.doesNotMatch(workflows.planApply, /download-artifact|terraform .* destroy/);
assert.match(workflows.planApply, /actions\/upload-artifact@v7/g);
const planEvidenceBlock = stepBlock(workflows.planApply, "Upload redacted plan evidence only");
assert.match(planEvidenceBlock, /path: \$\{\{ runner\.temp \}\}\/plan-evidence\//);
assert.doesNotMatch(planEvidenceBlock, /tfplan|\.env/);

assert.match(workflows.artifacts, /environment: asklake-aws-staging-artifacts/);
assert.match(workflows.artifacts, /actions\/setup-java@v5/);
assert.match(workflows.artifacts, /emr-continuous-dependencies\.pom\.xml/);
assert.match(workflows.artifacts, /upload-emr-continuous-jars\.mjs/);
assert.match(workflows.artifacts, /activate-aws-staging-runtime\.mjs/);
assert.match(workflows.artifacts, /runtime_root="\$\{ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI\}\/runtime\//);
const artifactEvidenceBlock = stepBlock(workflows.artifacts, "Upload redacted artifact evidence only");
assert.match(artifactEvidenceBlock, /jar-bundle\.json/);
assert.match(artifactEvidenceBlock, /delivery-receipt\.json/);
assert.doesNotMatch(artifactEvidenceBlock, /\.env/);

assert.match(workflows.destroy, /environment: asklake-aws-staging-destroy/);
assert.match(workflows.destroy, /AWS_STAGING_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/);
assert.match(workflows.destroy, /-destroy/);
assert.doesNotMatch(workflows.destroy, /service-quotas list-service-quotas/);

const pom = readRepositoryFile("infra/artifacts/emr-continuous-dependencies.pom.xml");
assert.match(pom, /<artifactId>spark-sql-kafka-0-10_2\.12<\/artifactId>\s*<version>3\.5\.5<\/version>/);
assert.match(pom, /<artifactId>aws-msk-iam-auth<\/artifactId>\s*<version>2\.3\.6<\/version>/);
assert.doesNotMatch(pom, /SNAPSHOT|LATEST|RELEASE|\[[^\]]+\]|\([^\)]+\)/);

for (const relative of [
  ".github/workflows/frontend-ci.yml",
  ".github/workflows/notion-task-sync.yml",
  ".github/workflows/pr-quality.yml",
]) {
  const absolute = path.join(repositoryRoot, relative);
  let source;
  try {
    source = readFileSync(absolute, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  assert.doesNotMatch(source, /terraform(?:\s+-chdir=[^\s]+)?\s+(?:apply|destroy)|aws-staging-(?:plan-apply|artifacts|destroy)/);
}

console.log("AWS staging Phase 3 workflow contract verification passed.");

function readRepositoryFile(relative) {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

function stepBlock(workflow, stepName) {
  const marker = `      - name: ${stepName}`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${stepName}`);
  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}
