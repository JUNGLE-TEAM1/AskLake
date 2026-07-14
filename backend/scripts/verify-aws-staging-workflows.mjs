import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { activateAwsStagingContinuousRuntime } from "../src/awsStagingRuntime.mjs";
import {
  extractEmrServerlessConcurrentVcpu,
  prepareAwsStagingTerraformInputs,
} from "../src/awsStagingWorkflow.mjs";
import { createEmrJarBundle, uploadEmrJarBundle } from "../src/emrJarBundle.mjs";
import { fingerprintTerraformPlan } from "../src/terraformPlanFingerprint.mjs";
import { writeAwsStagingTerraformInputs } from "./prepare-aws-staging-terraform-inputs.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));
const accountId = "123456789012";
const stackId = "phase3-test";
const now = new Date("2030-01-01T00:00:00Z");

const planFixture = {
  format_version: "1.2",
  terraform_version: "1.15.8",
  timestamp: "2030-01-01T00:00:00Z",
  variables: { secret: { value: "must-not-be-printed" } },
  resource_changes: [{
    address: "aws_s3_bucket.example",
    change: { actions: ["create"], after: { bucket: "example" }, before: null },
    mode: "managed",
    name: "example",
    provider_name: "registry.terraform.io/hashicorp/aws",
    type: "aws_s3_bucket",
  }],
};
const planFingerprint = fingerprintTerraformPlan(planFixture);
assert.match(planFingerprint.sha256, /^[a-f0-9]{64}$/);
assert.equal(
  fingerprintTerraformPlan({ ...planFixture, timestamp: "2030-01-01T00:01:00Z" }).sha256,
  planFingerprint.sha256,
);
assert.notEqual(
  fingerprintTerraformPlan(structuredClone({
    ...planFixture,
    resource_changes: [{ ...planFixture.resource_changes[0], change: { actions: ["delete"], after: null, before: {} } }],
  })).sha256,
  planFingerprint.sha256,
);
assert.ok(!JSON.stringify(planFingerprint).includes("must-not-be-printed"));
assert.match(fingerprintTerraformPlan({ format_version: "1.2" }).sha256, /^[a-f0-9]{64}$/);
assert.throws(() => fingerprintTerraformPlan({ resource_changes: [] }), /invalid/);

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
for (const ttlHours of [0, "0", -1, Number.NaN]) {
  assert.throws(
    () => prepareAwsStagingTerraformInputs(validInput({ ttlHours }), contract, { now }),
    /TTL|invalid/,
  );
}
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
for (const operation of ["artifacts", "smoke", "destroy"]) {
  const cleanup = prepareAwsStagingTerraformInputs(validInput({
    availableEmrServerlessConcurrentVcpu: undefined,
    budgetNotificationEmail: undefined,
    confirmation: `${operation}:${stackId}`,
    operation,
    smokeRunnerAmiId: "invalid-but-ignored-for-cleanup",
  }), contract, { now });
  assert.equal(cleanup.variables.available_emr_serverless_concurrent_vcpu, 16);
  assert.equal(cleanup.variables.budget_notification_email, `asklake-${operation}@example.invalid`);
  assert.equal(cleanup.variables.enable_smoke_runner, false);
}

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

class FakeS3Client {
  constructor(options = {}) {
    this.conflictsRemaining = options.conflictsRemaining || 0;
    this.failFileName = options.failFileName || "";
    this.heads = [];
    this.objects = new Map();
    this.puts = [];
    this.wrongHeadChecksum = Boolean(options.wrongHeadChecksum);
  }

  async send(command) {
    const input = command.input;
    const objectId = `${input.Bucket}/${input.Key}`;
    if (!Object.hasOwn(input, "Body")) {
      this.heads.push(input);
      const stored = this.objects.get(objectId);
      if (!stored) throw s3Error("NotFound", 404);
      return {
        ChecksumSHA256: this.wrongHeadChecksum ? Buffer.alloc(32, 2).toString("base64") : stored.checksum,
        ContentLength: stored.size,
        Metadata: stored.metadata,
      };
    }

    this.puts.push(input);
    if (this.failFileName && input.Key.endsWith(`/${this.failFileName}`)) {
      throw new Error("simulated upload failure");
    }
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      throw s3Error("ConditionalRequestConflict", 409);
    }
    if (this.objects.has(objectId)) throw s3Error("PreconditionFailed", 412);
    const actualChecksum = createHash("sha256").update(input.Body).digest("base64");
    if (actualChecksum !== input.ChecksumSHA256) throw new Error("simulated bad digest");
    this.objects.set(objectId, {
      checksum: actualChecksum,
      metadata: Object.fromEntries(Object.entries(input.Metadata || {}).map(([key, value]) => [key.toLowerCase(), value])),
      size: Buffer.isBuffer(input.Body) ? input.Body.length : Buffer.byteLength(input.Body),
    });
    return { ChecksumSHA256: actualChecksum };
  }
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
  const s3 = new FakeS3Client();
  await uploadEmrJarBundle(bundle, s3);
  assert.equal(s3.puts.length, 4);
  assert.equal(s3.heads.length, 4);
  assert.equal(s3.puts.at(-1).Key.endsWith("/bundle.json"), true);
  for (const upload of s3.puts) {
    assert.equal(upload.IfNoneMatch, "*");
    assert.equal(upload.ChecksumAlgorithm, "SHA256");
    assert.equal(upload.Metadata["asklake-bundle-sha256"], bundle.manifest.bundleSha256);
  }
  await uploadEmrJarBundle(bundle, s3);
  assert.equal(s3.objects.size, 4, "identical immutable bundle replay must be idempotent");

  const conflictS3 = new FakeS3Client({ conflictsRemaining: 1 });
  await uploadEmrJarBundle(bundle, conflictS3);
  assert.equal(conflictS3.conflictsRemaining, 0);
  const exhaustedConflictS3 = new FakeS3Client({ conflictsRemaining: 4 });
  await assert.rejects(() => uploadEmrJarBundle(bundle, exhaustedConflictS3), /ConditionalRequestConflict/);
  assert.equal(exhaustedConflictS3.conflictsRemaining, 1, "conditional conflict retry must be bounded to three attempts");

  const mismatchS3 = new FakeS3Client({ wrongHeadChecksum: true });
  await assert.rejects(() => uploadEmrJarBundle(bundle, mismatchS3), /checksum or size/);
  assert.equal([...mismatchS3.objects.keys()].some((key) => key.endsWith("bundle.json")), false);

  const partialFailureS3 = new FakeS3Client({ failFileName: "kafka-clients-3.7.1.jar" });
  await assert.rejects(() => uploadEmrJarBundle(bundle, partialFailureS3), /simulated upload failure/);
  assert.equal([...partialFailureS3.objects.keys()].some((key) => key.endsWith("bundle.json")), false);

  const manifestKey = [...s3.objects.keys()].find((key) => key.endsWith("bundle.json"));
  s3.objects.get(manifestKey).checksum = Buffer.alloc(32, 1).toString("base64");
  await assert.rejects(() => uploadEmrJarBundle(bundle, s3), /checksum or size/);

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
  smoke: readRepositoryFile(".github/workflows/aws-staging-smoke.yml"),
  ttlSweep: readRepositoryFile(".github/workflows/aws-staging-ttl-sweep.yml"),
});
for (const [name, workflow] of Object.entries(Object.fromEntries(Object.entries(workflows).filter(([name]) => name !== "ttlSweep")))) {
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
assert.match(workflows.planApply, /plan_fingerprint: \$\{\{ steps\.plan\.outputs\.plan_fingerprint \}\}/);
assert.equal((workflows.planApply.match(/fingerprint-terraform-plan\.mjs/g) || []).length, 2);
assert.match(workflows.planApply, /test "\$actual_plan_fingerprint" = "\$APPROVED_PLAN_FINGERPRINT"/);
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
assert.match(artifactEvidenceBlock, /smoke-bundle\.json/);
assert.match(artifactEvidenceBlock, /delivery-receipt\.json/);
assert.doesNotMatch(artifactEvidenceBlock, /\.env/);

assert.match(workflows.destroy, /environment: asklake-aws-staging-destroy/);
assert.match(workflows.destroy, /AWS_STAGING_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/);
assert.match(workflows.destroy, /-destroy/);
assert.doesNotMatch(workflows.destroy, /service-quotas list-service-quotas/);
assert.doesNotMatch(workflows.destroy, /AWS_BUDGET_NOTIFICATION_EMAIL|AWS_EMR_SERVERLESS_CONCURRENT_VCPU/);
assert.match(workflows.destroy, /destroy_plan:[\s\S]*destroy_apply:/);
assert.match(workflows.destroy, /needs: destroy_plan/);
assert.equal((workflows.destroy.match(/fingerprint-terraform-plan\.mjs/g) || []).length, 2);
assert.match(workflows.destroy, /test "\$actual_plan_fingerprint" = "\$APPROVED_PLAN_FINGERPRINT"/);
assert.ok(
  workflows.destroy.indexOf("destroy_apply:") < workflows.destroy.indexOf("environment: asklake-aws-staging-destroy"),
  "destroy approval must protect only the apply job",
);
assert.doesNotMatch(workflows.artifacts, /AWS_BUDGET_NOTIFICATION_EMAIL|AWS_EMR_SERVERLESS_CONCURRENT_VCPU/);

assert.match(workflows.smoke, /environment: asklake-aws-staging-smoke/);
assert.match(workflows.smoke, /AWS_STAGING_OPERATION: smoke/);
assert.match(workflows.smoke, /aws ssm send-command/);
assert.match(workflows.smoke, /aws pricing get-products/);
assert.match(workflows.smoke, /run-aws-staging-smoke\.mjs/);
assert.match(workflows.smoke, /evaluate-aws-staging-smoke\.mjs/);
assert.match(workflows.smoke, /asklake-smoke-bundle\.tgz/);
assert.match(workflows.smoke, /stack_confirmed: \$\{\{ steps\.verified_target\.outputs\.stack_confirmed \}\}/);
assert.match(workflows.smoke, /printf 'stack_confirmed=true\\n' >> "\$GITHUB_OUTPUT"/);
assert.match(workflows.smoke, /SMOKE_EXECUTION_STARTED=true/);
assert.match(workflows.smoke, /SMOKE_EVIDENCE_AVAILABLE/);
assert.match(workflows.smoke, /Write redacted smoke completion receipt/);
assert.match(workflows.smoke, /smoke-completion-receipt\.json/);
assert.match(workflows.smoke, /cleanup_plan:[\s\S]*needs: smoke/);
assert.match(workflows.smoke, /if: always\(\) && needs\.smoke\.outputs\.stack_confirmed == 'true'/);
assert.match(workflows.smoke, /cleanup_apply:[\s\S]*needs: cleanup_plan/);
assert.match(workflows.smoke, /if: always\(\) && needs\.cleanup_plan\.result == 'success'/);
assert.match(workflows.smoke, /environment: asklake-aws-staging-destroy/);
assert.match(workflows.smoke, /Create reviewable smoke cleanup plan/);
assert.match(workflows.smoke, /Replan, verify approved fingerprint, and destroy/);
assert.match(workflows.smoke, /test "\$actual_plan_fingerprint" = "\$APPROVED_PLAN_FINGERPRINT"/);
assert.match(workflows.smoke, /-destroy/);
assert.match(workflows.smoke, /smoke-cleanup\/receipt\.json/);
const smokeJobBlock = workflows.smoke.slice(0, workflows.smoke.indexOf("\n  cleanup_plan:"));
assert.doesNotMatch(smokeJobBlock, /terraform .* -destroy|terraform .* apply/);
assert.doesNotMatch(workflows.smoke, /AWS_BUDGET_NOTIFICATION_EMAIL|AWS_EMR_SERVERLESS_CONCURRENT_VCPU/);

assert.match(workflows.ttlSweep, /^on:\n  workflow_dispatch:\n  schedule:/m);
assert.match(workflows.ttlSweep, /environment: asklake-aws-staging-ttl-sweep/);
assert.match(workflows.ttlSweep, /sweep-aws-staging-ttl\.mjs/);
assert.match(workflows.ttlSweep, /Require manual destroy for expired or invalid stacks/);
assert.doesNotMatch(workflows.ttlSweep, /DeleteObjectCommand|terraform\s+destroy|terraform\s+apply|aws\s+.*delete/i);

const pom = readRepositoryFile("infra/artifacts/emr-continuous-dependencies.pom.xml");
assert.match(pom, /<artifactId>spark-sql-kafka-0-10_2\.12<\/artifactId>\s*<version>3\.5\.5<\/version>/);
assert.match(pom, /<artifactId>aws-msk-iam-auth<\/artifactId>\s*<version>2\.3\.6<\/version>/);
assert.doesNotMatch(pom, /SNAPSHOT|LATEST|RELEASE|\[[^\]]+\]|\([^\)]+\)/);

const workflowDirectory = path.join(repositoryRoot, ".github", "workflows");
const dedicatedWorkflowFiles = new Set([
  "aws-staging-artifacts.yml",
  "aws-staging-destroy.yml",
  "aws-staging-plan-apply.yml",
  "aws-staging-smoke.yml",
  "aws-staging-ttl-sweep.yml",
]);
const generalWorkflowFiles = readdirSync(workflowDirectory)
  .filter((name) => /\.ya?ml$/.test(name) && !dedicatedWorkflowFiles.has(name) && name !== "aws-staging-contract-checks.yml");
assert.ok(generalWorkflowFiles.length >= 3, "general workflow discovery unexpectedly found too few files");
for (const name of generalWorkflowFiles) {
  const source = readFileSync(path.join(workflowDirectory, name), "utf8");
  assert.doesNotMatch(source, /terraform(?:\s+-chdir=[^\s]+)?\s+(?:apply|destroy)|aws-staging-(?:plan-apply|artifacts|destroy|smoke|ttl-sweep)/);
}

const contractChecks = readRepositoryFile(".github/workflows/aws-staging-contract-checks.yml");
assert.match(contractChecks, /^  pull_request:/m);
assert.match(contractChecks, /verify:aws-staging-workflows/);
assert.match(contractChecks, /verify:aws-staging-smoke/);
assert.match(contractChecks, /verify:aws-staging-lifecycle/);
assert.match(contractChecks, /verify:aws-staging-handoff/);
assert.match(contractChecks, /verify:aws-staging-terraform/);
assert.doesNotMatch(contractChecks, /id-token: write|configure-aws-credentials|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);

console.log("AWS staging Phase 3/4/5 workflow contract verification passed.");

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

function s3Error(name, status) {
  const error = new Error(name);
  error.name = name;
  error.$metadata = { httpStatusCode: status };
  return error;
}
