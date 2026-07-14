import { createHash } from "node:crypto";

export const AWS_STAGING_RUNTIME_SCHEMA = "asklake.aws-staging-runtime.v1";

const BUCKET_KINDS = Object.freeze(["artifact", "checkpoint", "output", "report"]);
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const BUCKET_PATTERN = /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const APPLICATION_ID_PATTERN = /^[0-9a-z]{1,64}$/;
const ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:=,@%+\-]*$/;

export function renderAwsStagingRuntime(terraformOutput, phaseContract) {
  const contract = requiredObject(phaseContract, "Phase contract");
  const outputs = requiredObject(terraformOutput, "Terraform output");
  const infrastructure = terraformOutputValue(outputs, "infrastructure_contract", false);
  const brokerValue = terraformOutputValue(outputs, "msk_bootstrap_brokers_sasl_iam", true);

  validateInfrastructure(infrastructure, contract);
  const brokers = validateBrokers(brokerValue);
  const capacity = infrastructure.emr_capacity;
  const buckets = normalizeBuckets(infrastructure.bucket_names);
  const batch = contract.runtime.batchApplication;
  const continuous = contract.runtime.continuousApplication;
  const artifactRoot = `s3://${buckets.artifact}/emr-serverless`;
  const logRoot = `s3://${buckets.report}/emr-serverless/logs`;
  const allBuckets = BUCKET_KINDS.map((kind) => buckets[kind]);
  const brokerFingerprint = sha256(brokers.join(","));

  const environment = Object.freeze({
    APP_ENV: "staging",
    ASKLAKE_AWS_STAGING_ARTIFACT_BUCKET: buckets.artifact,
    ASKLAKE_AWS_STAGING_CHECKPOINT_BUCKET: buckets.checkpoint,
    ASKLAKE_AWS_STAGING_OUTPUT_BUCKET: buckets.output,
    ASKLAKE_AWS_STAGING_REPORT_BUCKET: buckets.report,
    ASKLAKE_AWS_STAGING_STACK_ID: infrastructure.stack_id,
    ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED: "true",
    ASKLAKE_EMR_SERVERLESS_APPLICATION_ID: infrastructure.batch_application_id,
    ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI: artifactRoot,
    ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_CONCURRENT_RUNS: String(batch.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_DISK_GB: String(batch.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_MEMORY_GB: String(batch.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_ACTOR_MAX_VCPU: String(batch.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_CONCURRENT_RUNS: String(batch.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_DISK_GB: String(batch.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_IDLE_MINUTES: String(batch.autoStopIdleMinutes),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_MEMORY_GB: String(batch.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_QUEUED_RUNS: String(infrastructure.batch_maximum_queued_runs),
    ASKLAKE_EMR_SERVERLESS_BATCH_MAX_VCPU: String(batch.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_CONCURRENT_RUNS: String(batch.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_DISK_GB: String(batch.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_MEMORY_GB: String(batch.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_BATCH_PROJECT_MAX_VCPU: String(batch.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_BATCH_QUEUE_TIMEOUT_MINUTES: String(capacity.queue_timeout_minutes),
    ASKLAKE_EMR_SERVERLESS_CANCEL_GRACE_SECONDS: "120",
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ALLOW_MAVEN_EGRESS: "false",
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_APPLICATION_ID: infrastructure.continuous_application_id,
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DEPENDENCY_MODE: contract.runtime.dependencyMode,
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DRIVER_CORES: String(continuous.driver.cores),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DRIVER_DISK_GB: String(continuous.driver.diskGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DRIVER_MEMORY: `${continuous.driver.memoryGb}g`,
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED: "false",
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENTRY_POINT_URI: `${artifactRoot}/kafka_continuous_stream.py`,
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_EXECUTOR_CORES: String(continuous.executor.cores),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_EXECUTOR_DISK_GB: String(continuous.executor.diskGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_EXECUTOR_MEMORY: `${continuous.executor.memoryGb}g`,
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_CONCURRENT_RUNS: String(continuous.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_DISK_GB: String(continuous.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_EXECUTORS: String(continuous.executor.maximumExecutors),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_FAILED_ATTEMPTS_PER_HOUR: "5",
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_IDLE_MINUTES: String(continuous.autoStopIdleMinutes),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_MEMORY_GB: String(continuous.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_QUEUED_RUNS: String(infrastructure.continuous_maximum_queued_runs),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_VCPU: String(continuous.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PROJECT_MAX_CONCURRENT_RUNS: String(continuous.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PROJECT_MAX_DISK_GB: String(continuous.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PROJECT_MAX_MEMORY_GB: String(continuous.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_PROJECT_MAX_VCPU: String(continuous.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ACTOR_MAX_CONCURRENT_RUNS: String(continuous.maximumConcurrentRuns),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ACTOR_MAX_DISK_GB: String(continuous.maximumCapacity.diskGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ACTOR_MAX_MEMORY_GB: String(continuous.maximumCapacity.memoryGb),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ACTOR_MAX_VCPU: String(continuous.maximumCapacity.vcpu),
    ASKLAKE_EMR_SERVERLESS_CONTINUOUS_QUEUE_TIMEOUT_MINUTES: String(capacity.queue_timeout_minutes),
    ASKLAKE_EMR_SERVERLESS_DRIVER_CORES: String(batch.driver.cores),
    ASKLAKE_EMR_SERVERLESS_DRIVER_DISK_GB: String(batch.driver.diskGb),
    ASKLAKE_EMR_SERVERLESS_DRIVER_MEMORY: `${batch.driver.memoryGb}g`,
    ASKLAKE_EMR_SERVERLESS_ENABLED: "true",
    ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI: `${artifactRoot}/spark_job_run.py`,
    ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN: infrastructure.emr_execution_role_arn,
    ASKLAKE_EMR_SERVERLESS_EXECUTOR_CORES: String(batch.executor.cores),
    ASKLAKE_EMR_SERVERLESS_EXECUTOR_DISK_GB: String(batch.executor.diskGb),
    ASKLAKE_EMR_SERVERLESS_EXECUTOR_MEMORY: `${batch.executor.memoryGb}g`,
    ASKLAKE_EMR_SERVERLESS_INITIAL_EXECUTORS: String(batch.executor.initialExecutors),
    ASKLAKE_EMR_SERVERLESS_LOG_URI: logRoot,
    ASKLAKE_EMR_SERVERLESS_MAX_EXECUTORS: String(batch.executor.maximumExecutors),
    ASKLAKE_EMR_SERVERLESS_MIN_EXECUTORS: String(batch.executor.minimumExecutors),
    ASKLAKE_EMR_SERVERLESS_PROJECT_KEY: `staging-${infrastructure.stack_id}`,
    ASKLAKE_EMR_SERVERLESS_REQUIRE_JOB_COST_ALLOCATION: "true",
    ASKLAKE_KAFKA_ENVIRONMENT: "staging",
    ASKLAKE_KAFKA_RUNTIME: "msk",
    ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS: String(contract.smoke.topicPartitions),
    ASKLAKE_KAFKA_TOPIC_POLICY_ENFORCED: "true",
    ASKLAKE_KAFKA_TOPIC_PREFIX: infrastructure.topic_namespace,
    ASKLAKE_KAFKA_TOPIC_RETENTION_MS: String(contract.smoke.topicRetentionMs),
    ASKLAKE_MSK_AUTH_MODE: "iam",
    ASKLAKE_MSK_BOOTSTRAP_BROKERS: brokers.join(","),
    ASKLAKE_MSK_ENABLED: "true",
    ASKLAKE_MSK_PROBE_TOPIC: `${infrastructure.topic_namespace}.probe`,
    ASKLAKE_MSK_REGION: infrastructure.region,
    ASKLAKE_MSK_TLS_ENABLED: "true",
    ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
    ASKLAKE_RAW_BUCKET: buckets.artifact,
    ASKLAKE_S3_READINESS_READ_BUCKETS: allBuckets.join(","),
    ASKLAKE_S3_READINESS_WRITE_BUCKETS: allBuckets.join(","),
    ASKLAKE_SPARK_OUTPUT_BUCKET: buckets.output,
    ASKLAKE_SPARK_OUTPUT_MODE: "s3a",
    ASKLAKE_SPARK_RUNTIME: "emr-serverless",
    ASKLAKE_STORAGE_BASE_PREFIX: "asklake",
    ASKLAKE_STORAGE_ENVIRONMENT: "staging",
    AWS_REGION: infrastructure.region,
    S3_ALLOWED_BUCKETS: allBuckets.join(","),
    S3_ENDPOINT: "",
    S3_FORCE_PATH_STYLE: "false",
  });

  const envText = serializeEnvironment(environment);
  const manifest = Object.freeze({
    schemaVersion: AWS_STAGING_RUNTIME_SCHEMA,
    activation: Object.freeze({
      batchConfigured: true,
      continuousConfigured: false,
      pending: Object.freeze(["checksum-verified-continuous-jar-bundle"]),
      runtimePromotionAllowed: false,
    }),
    source: Object.freeze({
      contractId: contract.contractId,
      environment: infrastructure.environment,
      expiresAt: infrastructure.expires_at,
      stackId: infrastructure.stack_id,
      terraformOutputShape: "terraform-output-json",
    }),
    runtime: Object.freeze({
      kafka: Object.freeze({
        authMode: "iam",
        bootstrapBrokerCount: brokers.length,
        bootstrapBrokerSha256: brokerFingerprint,
        region: infrastructure.region,
        runtime: "msk",
        tls: true,
        topicPrefix: infrastructure.topic_namespace,
      }),
      spark: Object.freeze({
        batchApplicationId: infrastructure.batch_application_id,
        continuousApplicationId: infrastructure.continuous_application_id,
        executionRoleArn: infrastructure.emr_execution_role_arn,
        releaseLabel: capacity.release_label,
        runtime: "emr-serverless",
      }),
      storage: Object.freeze({ buckets: Object.freeze({ ...buckets }), provider: "aws" }),
    }),
    security: Object.freeze({
      brokerEndpointIncluded: false,
      envFileMode: "0600",
      longLivedCredentialsIncluded: false,
    }),
    env: Object.freeze({
      keyCount: Object.keys(environment).length,
      sha256: sha256(envText),
    }),
  });

  return Object.freeze({
    brokerCount: brokers.length,
    brokerFingerprint,
    envText,
    environment,
    manifest,
    stackId: infrastructure.stack_id,
  });
}

function validateInfrastructure(value, contract) {
  const infrastructure = requiredObject(value, "Infrastructure contract");
  const capacity = requiredObject(infrastructure.emr_capacity, "EMR capacity contract");
  const batch = requiredObject(contract.runtime?.batchApplication, "Batch application contract");
  const continuous = requiredObject(contract.runtime?.continuousApplication, "Continuous application contract");
  const stackPattern = new RegExp(contract.naming.stackIdPattern);

  assertEqual(infrastructure.environment, contract.environment, "environment");
  assertEqual(infrastructure.region, contract.region, "region");
  if (!AWS_REGION_PATTERN.test(infrastructure.region)) fail("Terraform region is invalid.");
  if (!stackPattern.test(String(infrastructure.stack_id || ""))) fail("Terraform stack identity is invalid.");
  assertEqual(infrastructure.name_prefix, `asklake-staging-${infrastructure.stack_id}`, "name prefix");
  assertEqual(infrastructure.topic_namespace, `asklake.staging.${infrastructure.stack_id}`, "topic namespace");
  assertEqual(infrastructure.public_ingress_enabled, false, "public ingress boundary");
  assertEqual(infrastructure.nat_gateway_enabled, false, "NAT boundary");
  assertEqual(infrastructure.applications_concurrent, false, "application concurrency boundary");
  assertEqual(infrastructure.maximum_application_vcpu, batch.maximumCapacity.vcpu, "application vCPU boundary");
  assertEqual(infrastructure.budget_limit_usd, contract.costControl.smokeBudgetUsd, "budget boundary");
  assertEqual(infrastructure.batch_maximum_queued_runs, batch.maximumQueuedRuns, "batch queue boundary");
  assertEqual(infrastructure.continuous_maximum_queued_runs, continuous.maximumQueuedRuns, "continuous queue boundary");
  assertEqual(capacity.release_label, contract.runtime.emrReleaseLabel, "EMR release");
  assertEqual(capacity.maximum_vcpu, batch.maximumCapacity.vcpu, "EMR maximum vCPU");
  assertEqual(capacity.maximum_memory_gb, batch.maximumCapacity.memoryGb, "EMR maximum memory");
  assertEqual(capacity.maximum_disk_gb, batch.maximumCapacity.diskGb, "EMR maximum disk");
  assertEqual(capacity.maximum_concurrent_runs, batch.maximumConcurrentRuns, "EMR concurrency");
  assertEqual(capacity.auto_stop_idle_minutes, batch.autoStopIdleMinutes, "EMR auto-stop");
  assertEqual(capacity.driver?.cores, batch.driver.cores, "EMR driver cores");
  assertEqual(capacity.driver?.memory_gb, batch.driver.memoryGb, "EMR driver memory");
  assertEqual(capacity.driver?.disk_gb, batch.driver.diskGb, "EMR driver disk");
  assertEqual(capacity.executor?.cores, batch.executor.cores, "EMR executor cores");
  assertEqual(capacity.executor?.memory_gb, batch.executor.memoryGb, "EMR executor memory");
  assertEqual(capacity.executor?.disk_gb, batch.executor.diskGb, "EMR executor disk");
  assertEqual(capacity.executor?.minimum_executors, batch.executor.minimumExecutors, "EMR minimum executors");
  assertEqual(capacity.executor?.initial_executors, batch.executor.initialExecutors, "EMR initial executors");
  assertEqual(capacity.executor?.maximum_executors, batch.executor.maximumExecutors, "EMR maximum executors");

  if (!APPLICATION_ID_PATTERN.test(String(infrastructure.batch_application_id || ""))) {
    fail("Terraform Batch application identity is invalid.");
  }
  if (!APPLICATION_ID_PATTERN.test(String(infrastructure.continuous_application_id || ""))) {
    fail("Terraform Continuous application identity is invalid.");
  }
  const roleMatch = /^arn:(?:aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/[\w+=,.@\/-]+$/.exec(
    String(infrastructure.emr_execution_role_arn || ""),
  );
  if (!roleMatch) fail("Terraform EMR execution role identity is invalid.");
  const clusterMatch = /^arn:aws:kafka:([^:]+):([0-9]{12}):cluster\/[A-Za-z0-9._-]+\/[A-Za-z0-9-]+$/.exec(
    String(infrastructure.msk_cluster_arn || ""),
  );
  if (!clusterMatch || clusterMatch[1] !== infrastructure.region || clusterMatch[2] !== roleMatch[1]) {
    fail("Terraform MSK cluster identity does not match the staging account and region.");
  }
  const buckets = normalizeBuckets(infrastructure.bucket_names);
  for (const kind of BUCKET_KINDS) {
    const expected = `asklake-stg-${roleMatch[1]}-${contract.naming.bucketRegionAlias}-${infrastructure.stack_id}-${kind}`;
    assertEqual(buckets[kind], expected, `${kind} bucket identity`);
  }
}

function normalizeBuckets(value) {
  const source = requiredObject(value, "Bucket contract");
  const buckets = {};
  for (const kind of BUCKET_KINDS) {
    const bucket = String(source[kind] || "").trim();
    if (!BUCKET_PATTERN.test(bucket) || bucket.includes("..") || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
      fail(`Terraform ${kind} bucket identity is invalid.`);
    }
    buckets[kind] = bucket;
  }
  if (new Set(Object.values(buckets)).size !== BUCKET_KINDS.length) fail("Terraform staging buckets must be unique.");
  return Object.freeze(buckets);
}

function validateBrokers(value) {
  const brokers = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (brokers.length === 0 || new Set(brokers).size !== brokers.length) fail("Terraform MSK broker output is invalid.");
  for (const broker of brokers) {
    if (!/^[a-zA-Z0-9.-]+:9098$/.test(broker) || !broker.includes(".") || broker.includes("..")) {
      fail("Terraform MSK broker output is invalid.");
    }
  }
  return Object.freeze(brokers);
}

function terraformOutputValue(outputs, name, expectedSensitive) {
  const wrapper = requiredObject(outputs[name], `Terraform ${name} output`);
  if (wrapper.sensitive !== expectedSensitive) fail(`Terraform ${name} sensitivity contract drifted.`);
  if (!("value" in wrapper)) fail(`Terraform ${name} output has no value.`);
  return wrapper.value;
}

function serializeEnvironment(environment) {
  const lines = [
    "# Generated from Terraform output. Do not commit or print this file.",
    "# Continuous remains disabled until Phase 3 uploads and verifies the immutable JAR bundle.",
  ];
  for (const name of Object.keys(environment).sort()) {
    const value = String(environment[name]);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n\0]/.test(value) || !ENV_VALUE_PATTERN.test(value)) {
      fail("Generated runtime environment contains an unsafe value.");
    }
    lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function assertEqual(actual, expected, name) {
  if (actual !== expected) fail(`Terraform ${name} does not match the Phase contract.`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(message) {
  const error = new Error(message);
  error.code = "AWS_STAGING_RUNTIME_CONTRACT_INVALID";
  throw error;
}
