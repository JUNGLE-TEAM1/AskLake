import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const canonicalContractPath = fileURLToPath(
  new URL("../../infra/contracts/aws-staging-smoke.v1.json", import.meta.url),
);
const contractPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : canonicalContractPath;

const REQUIRED_TAGS = {
  Project: "AskLake",
  Environment: "staging",
  ManagedBy: "terraform",
  Issue: "727",
  StackId: "${stackId}",
  ExpiresAt: "${expiresAt}",
};
const REQUIRED_CHECKS = [
  "terraform-static-contract",
  "s3-readiness",
  "msk-iam-roundtrip",
  "emr-batch-submit-poll-result",
  "emr-continuous-start-ingest-pause-resume",
  "checkpoint-continuity",
  "output-integrity",
  "cost-and-resource-evidence",
];
const REQUIRED_REFERENCES = [
  "https://developer.hashicorp.com/terraform/language/backend/s3",
  "https://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/vpc-access.html",
  "https://docs.aws.amazon.com/emr/latest/EMR-Serverless-UserGuide/endpoints-quotas.html",
  "https://docs.aws.amazon.com/msk/latest/developerguide/limits.html",
  "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
  "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_oidc.html",
];

function requireObject(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function requirePositiveInteger(value, label) {
  assert.ok(Number.isInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

function assertStringSet(actual, expected, label) {
  assert.ok(Array.isArray(actual), `${label} must be an array`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} drifted`);
}

function validateApplication(application, label, minimumRequiredAccountConcurrentVcpu) {
  requireObject(application, label);
  const capacity = requireObject(application.maximumCapacity, `${label}.maximumCapacity`);
  const driver = requireObject(application.driver, `${label}.driver`);
  const executor = requireObject(application.executor, `${label}.executor`);

  assert.equal(capacity.vcpu, 16, `${label} vCPU cap must remain at the Phase 0 quota`);
  assert.ok(
    capacity.vcpu <= minimumRequiredAccountConcurrentVcpu,
    `${label} vCPU cap exceeds the minimum account quota contract`,
  );
  assert.equal(capacity.memoryGb, 64, `${label} memory cap drifted`);
  assert.equal(capacity.diskGb, 320, `${label} disk cap drifted`);
  assert.equal(application.maximumConcurrentRuns, 1, `${label} concurrency must remain one`);
  requirePositiveInteger(application.maximumQueuedRuns, `${label}.maximumQueuedRuns`);
  assert.equal(application.autoStopIdleMinutes, 10, `${label} auto-stop drifted`);

  assert.equal(driver.cores, 1, `${label} driver core contract drifted`);
  assert.equal(executor.cores, 2, `${label} executor core contract drifted`);
  assert.equal(executor.minimumExecutors, 0, `${label} minimum executors drifted`);
  assert.equal(executor.initialExecutors, 2, `${label} initial executors drifted`);
  assert.equal(executor.maximumExecutors, 7, `${label} maximum executors drifted`);
  assert.ok(
    driver.cores + executor.cores * executor.maximumExecutors <= capacity.vcpu,
    `${label} worker plan exceeds maximumCapacity`,
  );
}

function validateContract(contract) {
  requireObject(contract, "contract");
  assert.equal(contract.schemaVersion, "asklake.aws-staging-contract.v1", "schema version drifted");
  assert.equal(contract.contractId, "issue-727-phase0", "contract identity drifted");
  assert.equal(contract.environment, "staging", "only staging is allowed");
  assert.equal(contract.region, "ap-northeast-2", "staging region drifted");

  const naming = requireObject(contract.naming, "naming");
  assert.equal(naming.stackIdPattern, "^[a-z0-9][a-z0-9-]{2,15}$", "stack id policy drifted");
  assert.ok(naming.resourcePrefixTemplate.includes("${stackId}"), "resource names must isolate stackId");
  assert.ok(naming.bucketPrefixTemplate.includes("${accountId}"), "bucket names must isolate accountId");
  assert.ok(naming.bucketPrefixTemplate.includes("${regionAlias}"), "bucket names must isolate region alias");
  assert.equal(naming.bucketRegionAlias, "apne2", "bucket region alias drifted");
  const longestBucketName = naming.bucketPrefixTemplate
    .replace("${accountId}", "123456789012")
    .replace("${regionAlias}", naming.bucketRegionAlias)
    .replace("${stackId}", "a".repeat(16)) + "-checkpoint";
  assert.ok(longestBucketName.length <= 63, "bucket naming contract exceeds the S3 limit");
  assert.equal(naming.topicNamespaceTemplate, "asklake.staging.${stackId}", "topic namespace drifted");
  assert.deepEqual(naming.requiredTags, REQUIRED_TAGS, "required AWS tags drifted");

  const state = requireObject(contract.terraformState, "terraformState");
  assert.equal(state.backend, "s3", "Terraform state backend must be S3");
  assert.equal(state.configurationMode, "partial", "Terraform backend values must remain external inputs");
  assert.equal(state.bootstrapMode, "separate-stack", "Terraform state must use a separate bootstrap stack");
  assert.ok(state.keyTemplate.includes("${stackId}"), "Terraform state key must isolate stackId");
  assert.equal(state.useLockfile, true, "Terraform S3 lockfile is required");
  assert.equal(state.dynamoDbLocking, false, "deprecated DynamoDB locking must not be introduced");
  assert.equal(state.bucketVersioningRequired, true, "state bucket versioning is required");
  assert.equal(state.encryptionRequired, true, "state encryption is required");
  assert.equal(state.embeddedCredentialsAllowed, false, "embedded Terraform credentials are forbidden");
  assertStringSet(state.requiredInputs, ["stateBucketName", "stateKmsKeyArn"], "Terraform state inputs");

  const network = requireObject(contract.network, "network");
  assert.equal(network.vpcMode, "dedicated", "staging must use a dedicated VPC");
  assert.equal(network.vpcCidr, "10.77.0.0/16", "staging VPC CIDR drifted");
  assert.equal(network.availabilityZoneCount, 3, "staging must span three availability zones");
  assertStringSet(
    network.privateSubnetCidrs,
    ["10.77.0.0/20", "10.77.16.0/20", "10.77.32.0/20"],
    "private subnet CIDRs",
  );
  assert.deepEqual(network.publicSubnetCidrs, [], "public subnets are forbidden");
  assert.equal(network.natGatewayEnabled, false, "Phase 0 forbids NAT/Maven egress");
  assert.equal(network.s3GatewayEndpointRequired, true, "private S3 access is required");
  assertStringSet(
    network.requiredInterfaceEndpoints,
    ["ssm", "ssmmessages", "ec2messages", "logs", "monitoring", "emr-serverless"],
    "private interface endpoints",
  );
  assert.equal(network.publicIngressAllowed, false, "public ingress is forbidden");
  const smokeRunner = requireObject(network.smokeRunner, "network.smokeRunner");
  assert.equal(smokeRunner.mode, "ephemeral-ec2-ssm", "smoke runner mode drifted");
  assert.equal(smokeRunner.placement, "private-subnet", "smoke runner must remain private");
  assert.equal(smokeRunner.sshIngressAllowed, false, "SSH ingress is forbidden");
  assert.equal(smokeRunner.artifactDelivery, "s3", "offline artifact delivery must use S3");

  const authentication = requireObject(contract.authentication, "authentication");
  assert.equal(authentication.ciCredentialMode, "github-oidc", "CI must use GitHub OIDC");
  assert.equal(authentication.longLivedAwsKeysAllowed, false, "long-lived AWS keys are forbidden");
  assert.equal(authentication.mskAuthentication, "iam", "MSK Serverless must use IAM auth");
  assert.equal(authentication.tlsRequired, true, "MSK TLS is required");
  assert.equal(authentication.secretOutputsAllowed, false, "secret Terraform outputs are forbidden");

  const cost = requireObject(contract.costControl, "costControl");
  assert.equal(cost.currency, "USD", "budget currency drifted");
  assert.equal(cost.smokeBudgetUsd, 30, "Phase 0 smoke budget drifted");
  assert.deepEqual(cost.budgetAlertThresholdPercent, [50, 80, 100], "budget thresholds drifted");
  assert.equal(cost.budgetIsRealtimeKillSwitch, false, "AWS Budgets must not be treated as a kill switch");
  assert.equal(cost.stackTtlHours, 8, "default stack TTL drifted");
  assert.equal(cost.maximumStackTtlHours, 24, "maximum stack TTL drifted");
  assert.ok(cost.stackTtlHours <= cost.maximumStackTtlHours, "default TTL exceeds the maximum TTL");
  assert.equal(cost.priceSnapshotRequiredAtRun, true, "a current price snapshot is required");
  assertStringSet(
    cost.requiredCostTags,
    ["Project", "Environment", "StackId", "ExpiresAt"],
    "cost allocation tags",
  );

  const runtime = requireObject(contract.runtime, "runtime");
  assert.equal(runtime.sparkProvider, "emr-serverless", "Spark provider drifted");
  assert.equal(runtime.kafkaProvider, "msk-serverless", "Kafka provider drifted");
  assert.equal(runtime.emrReleaseLabel, "emr-7.9.0", "AskLake graceful-stop release baseline drifted");
  assert.equal(runtime.dependencyMode, "jars", "private staging must use immutable JARs");
  assert.equal(runtime.mavenEgressAllowed, false, "Maven egress is forbidden");
  assert.equal(
    runtime.minimumRequiredAccountConcurrentVcpu,
    16,
    "Phase 0 minimum account quota requirement drifted",
  );
  assert.equal(runtime.applicationsMayRunConcurrently, false, "Batch and Continuous smoke must be sequential");
  validateApplication(
    runtime.batchApplication,
    "batchApplication",
    runtime.minimumRequiredAccountConcurrentVcpu,
  );
  validateApplication(
    runtime.continuousApplication,
    "continuousApplication",
    runtime.minimumRequiredAccountConcurrentVcpu,
  );

  const smoke = requireObject(contract.smoke, "smoke");
  assert.equal(smoke.purpose, "functional-connectivity", "Phase 0 smoke purpose drifted");
  assert.equal(smoke.performanceClaimAllowed, false, "Phase 0 cannot make a performance claim");
  assert.equal(smoke.recordCount, 1_000_000, "smoke record count drifted");
  assert.equal(smoke.averageMessageBytes, 1_024, "average message size drifted");
  assert.equal(smoke.p95MessageBytes, 4_096, "P95 message size drifted");
  assert.equal(
    smoke.estimatedIngressBytes,
    smoke.recordCount * smoke.averageMessageBytes,
    "estimated ingress bytes must match count times average size",
  );
  assert.equal(smoke.producerRatePerSecond, 5_000, "smoke producer rate drifted");
  assert.equal(smoke.topicPartitions, 3, "smoke topic partition count drifted");
  assert.equal(smoke.topicRetentionMs, 86_400_000, "smoke topic retention drifted");
  assert.equal(smoke.microBatchTriggerSeconds, 2, "micro-batch trigger drifted");
  assert.equal(
    smoke.maxOffsetsPerTrigger,
    smoke.producerRatePerSecond * smoke.microBatchTriggerSeconds,
    "maxOffsetsPerTrigger must cover one trigger of planned input",
  );
  assert.equal(smoke.batchFixtureBytes, 104_857_600, "batch fixture size drifted");
  assertStringSet(smoke.requiredChecks, REQUIRED_CHECKS, "smoke required checks");
  const success = requireObject(smoke.successCriteria, "smoke.successCriteria");
  assert.equal(success.exactProducedConsumedSinkCounts, true, "exact count integrity is required");
  assert.equal(success.maximumFinalLag, 0, "smoke must drain all lag");
  assert.equal(success.maximumQuarantineRecords, 0, "smoke quarantine must remain empty");
  assert.equal(success.checkpointResumeRequired, true, "checkpoint resume evidence is required");
  assert.equal(success.singleRemoteJobIdentityRequired, true, "remote job identity evidence is required");
  assert.equal(success.s3ReportAndCheckpointRequired, true, "S3 report/checkpoint evidence is required");
  assert.equal(success.latencyThresholdRequired, false, "Phase 0 must not invent a latency SLO");

  const lifecycle = requireObject(contract.lifecycle, "lifecycle");
  assert.equal(lifecycle.applyRequiresManualApproval, true, "staging apply must be approved");
  assert.equal(
    lifecycle.normalApplicationDeployMayApplyInfrastructure,
    false,
    "normal deploy must not create paid infrastructure",
  );
  assert.equal(lifecycle.automaticRuntimePromotionAllowed, false, "automatic Runtime promotion is forbidden");
  assert.equal(lifecycle.destroyAfterSmoke, true, "staging stack must be destroyed after smoke");
  assert.equal(lifecycle.destroyOnFailureAfterEvidenceExport, true, "failed smoke must clean up after evidence export");
  const ttlSweep = requireObject(lifecycle.ttlSweep, "lifecycle.ttlSweep");
  assert.equal(ttlSweep.maximumStateFilesPerRun, 100, "TTL sweep state bound drifted");
  assert.equal(ttlSweep.expiredStackGraceMinutes, 15, "TTL sweep grace drifted");
  assert.equal(ttlSweep.automaticDestroyAllowed, false, "TTL sweep must require manual destroy");
  assert.equal(ttlSweep.evidenceRequired, true, "TTL sweep evidence must remain required");
  assert.equal(lifecycle.workflowArtifactRetentionDays, 7, "workflow evidence retention drifted");
  assert.equal(lifecycle.sharedResourceDestructionAllowed, false, "shared resource destruction is forbidden");

  assertStringSet(
    contract.requiredExternalInputs,
    [
      "awsAccountId",
      "availableEmrServerlessConcurrentVcpu",
      "stateBucketName",
      "stateKmsKeyArn",
      "githubOidcRoleArn",
      "budgetNotificationEndpoint",
      "stackId",
      "expiresAt",
    ],
    "required external inputs",
  );
  assertStringSet(contract.references, REQUIRED_REFERENCES, "official reference URLs");

  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /AKIA[0-9A-Z]{16}/, "AWS access key shaped value is forbidden");
  assert.doesNotMatch(serialized, /aws_secret_access_key\s*[=:]/i, "AWS secret value is forbidden");
  assert.doesNotMatch(serialized, /b-\d+\.[a-z0-9.-]+\.kafka\./i, "MSK broker endpoints must not be committed");
}

function expectInvalid(contract, mutate, expectedMessage) {
  const candidate = structuredClone(contract);
  mutate(candidate);
  assert.throws(() => validateContract(candidate), expectedMessage);
}

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
validateContract(contract);

if (contractPath === canonicalContractPath) {
  expectInvalid(contract, (value) => {
    value.region = "us-east-1";
  }, /staging region drifted/);
  expectInvalid(contract, (value) => {
    value.costControl.smokeBudgetUsd = 31;
  }, /smoke budget drifted/);
  expectInvalid(contract, (value) => {
    value.authentication.longLivedAwsKeysAllowed = true;
  }, /long-lived AWS keys are forbidden/);
  expectInvalid(contract, (value) => {
    value.network.natGatewayEnabled = true;
  }, /forbids NAT/);
  expectInvalid(contract, (value) => {
    value.runtime.batchApplication.maximumCapacity.vcpu = 32;
  }, /vCPU cap must remain/);
  expectInvalid(contract, (value) => {
    value.smoke.performanceClaimAllowed = true;
  }, /cannot make a performance claim/);
  expectInvalid(contract, (value) => {
    value.smoke.successCriteria.checkpointResumeRequired = false;
  }, /checkpoint resume evidence is required/);
  expectInvalid(contract, (value) => {
    value.lifecycle.normalApplicationDeployMayApplyInfrastructure = true;
  }, /normal deploy must not create paid infrastructure/);
}

console.log(`AWS staging Phase 0 contract verified: ${contractPath}`);
