import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emrServerlessConfig } from "../src/emrServerless.mjs";
import { emrAdmissionPolicy } from "../src/emrAdmission.mjs";
import { renderAwsStagingRuntime } from "../src/awsStagingRuntime.mjs";
import { resolveKafkaRuntimeConfig } from "../src/kafkaRuntime.mjs";
import { resolveSparkRuntime } from "../src/sparkRuntime.mjs";
import { writeAwsStagingRuntimeFiles } from "./render-aws-staging-runtime.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const contract = JSON.parse(readFileSync(
  path.join(repositoryRoot, "infra", "contracts", "aws-staging-smoke.v1.json"),
  "utf8",
));
const broker = "boot-1.example.kafka-serverless.ap-northeast-2.amazonaws.com:9098";
const stackId = "phase2-test";
const accountId = "123456789012";

function terraformFixture() {
  return {
    infrastructure_contract: {
      sensitive: false,
      type: ["object", {}],
      value: {
        applications_concurrent: false,
        batch_application_id: "00batchphase2test",
        batch_maximum_queued_runs: 2,
        bucket_names: {
          artifact: `asklake-stg-${accountId}-apne2-${stackId}-artifact`,
          checkpoint: `asklake-stg-${accountId}-apne2-${stackId}-checkpoint`,
          output: `asklake-stg-${accountId}-apne2-${stackId}-output`,
          report: `asklake-stg-${accountId}-apne2-${stackId}-report`,
        },
        budget_limit_usd: 30,
        continuous_application_id: "00continuousphase2test",
        continuous_maximum_queued_runs: 1,
        emr_capacity: {
          architecture: "X86_64",
          auto_stop_idle_minutes: 10,
          driver: { cores: 1, disk_gb: 20, memory_gb: 4 },
          executor: {
            cores: 2,
            disk_gb: 20,
            initial_executors: 2,
            maximum_executors: 7,
            memory_gb: 4,
            minimum_executors: 0,
          },
          maximum_concurrent_runs: 1,
          maximum_disk_gb: 320,
          maximum_memory_gb: 64,
          maximum_vcpu: 16,
          queue_timeout_minutes: 15,
          release_label: "emr-7.9.0",
        },
        emr_execution_role_arn: `arn:aws:iam::${accountId}:role/asklake-staging-${stackId}-emr-execution`,
        environment: "staging",
        expires_at: "2030-01-01T08:00:00Z",
        maximum_application_vcpu: 16,
        msk_cluster_arn: `arn:aws:kafka:ap-northeast-2:${accountId}:cluster/asklake-staging-${stackId}-msk/00000000-0000-0000-0000-000000000000`,
        name_prefix: `asklake-staging-${stackId}`,
        nat_gateway_enabled: false,
        public_ingress_enabled: false,
        region: "ap-northeast-2",
        smoke_runner_enabled: false,
        stack_id: stackId,
        topic_namespace: `asklake.staging.${stackId}`,
        vpc_cidr: "10.77.0.0/16",
      },
    },
    msk_bootstrap_brokers_sasl_iam: {
      sensitive: true,
      type: "string",
      value: broker,
    },
  };
}

function envObject(text) {
  return Object.fromEntries(text.split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

function mutatedFixture(mutator) {
  const fixture = structuredClone(terraformFixture());
  mutator(fixture);
  return fixture;
}

const rendered = renderAwsStagingRuntime(terraformFixture(), contract);
const environment = envObject(rendered.envText);
assert.equal(rendered.stackId, stackId);
assert.equal(rendered.brokerCount, 1);
assert.equal(rendered.brokerFingerprint.length, 64);
assert.equal(environment.ASKLAKE_SPARK_RUNTIME, "emr-serverless");
assert.equal(environment.ASKLAKE_KAFKA_RUNTIME, "msk");
assert.equal(environment.ASKLAKE_MSK_BOOTSTRAP_BROKERS, broker);
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_APPLICATION_ID, "00batchphase2test");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_APPLICATION_ID, "00continuousphase2test");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN, `arn:aws:iam::${accountId}:role/asklake-staging-${stackId}-emr-execution`);
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_MAX_EXECUTORS, "7");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_BATCH_MAX_VCPU, "16");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_BATCH_MAX_QUEUED_RUNS, "2");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_QUEUED_RUNS, "1");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_DEPENDENCY_MODE, "jars");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ALLOW_MAVEN_EGRESS, "false");
assert.equal(environment.ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED, "false");
assert.equal(environment.ASKLAKE_SPARK_OUTPUT_BUCKET, `asklake-stg-${accountId}-apne2-${stackId}-output`);
assert.equal(environment.ASKLAKE_RAW_BUCKET, `asklake-stg-${accountId}-apne2-${stackId}-artifact`);
assert.equal(environment.ASKLAKE_KAFKA_TOPIC_PREFIX, `asklake.staging.${stackId}`);
assert.equal(environment.ASKLAKE_KAFKA_TOPIC_MIN_PARTITIONS, "3");
assert.equal(environment.ASKLAKE_KAFKA_TOPIC_RETENTION_MS, "86400000");
assert.equal(environment.S3_ENDPOINT, "");
assert.equal(environment.S3_FORCE_PATH_STYLE, "false");

assert.equal(resolveSparkRuntime(environment).id, "emr-serverless");
assert.equal(resolveKafkaRuntimeConfig({ env: environment }).runtime, "msk");
assert.equal(resolveKafkaRuntimeConfig({ env: environment }).brokers[0], broker);
assert.equal(emrServerlessConfig(environment).applicationId, "00batchphase2test");
assert.equal(emrServerlessConfig(environment).maxExecutors, 7);
assert.deepEqual(
  {
    concurrent: emrAdmissionPolicy(environment, "batch").maxConcurrentRuns,
    disk: emrAdmissionPolicy(environment, "batch").maxDiskGb,
    memory: emrAdmissionPolicy(environment, "batch").maxMemoryGb,
    queued: emrAdmissionPolicy(environment, "batch").maxQueuedRuns,
    timeout: emrAdmissionPolicy(environment, "batch").queueTimeoutMinutes,
    vcpu: emrAdmissionPolicy(environment, "batch").maxVcpu,
  },
  { concurrent: 1, disk: 320, memory: 64, queued: 2, timeout: 15, vcpu: 16 },
);
assert.deepEqual(
  {
    concurrent: emrAdmissionPolicy(environment, "continuous").maxConcurrentRuns,
    queued: emrAdmissionPolicy(environment, "continuous").maxQueuedRuns,
  },
  { concurrent: 1, queued: 1 },
);

const manifestText = JSON.stringify(rendered.manifest);
assert.equal(rendered.manifest.schemaVersion, "asklake.aws-staging-runtime.v1");
assert.equal(rendered.manifest.activation.batchConfigured, true);
assert.equal(rendered.manifest.activation.continuousConfigured, false);
assert.equal(rendered.manifest.activation.runtimePromotionAllowed, false);
assert.equal(rendered.manifest.security.brokerEndpointIncluded, false);
assert.equal(rendered.manifest.security.longLivedCredentialsIncluded, false);
assert.equal(rendered.manifest.runtime.kafka.bootstrapBrokerCount, 1);
assert.equal(rendered.manifest.runtime.kafka.bootstrapBrokerSha256, rendered.brokerFingerprint);
assert.ok(!manifestText.includes(broker));
assert.ok(!manifestText.includes("AWS_ACCESS_KEY_ID"));
assert.ok(!manifestText.includes("AWS_SECRET_ACCESS_KEY"));
assert.ok(!manifestText.includes("AWS_SESSION_TOKEN"));

assert.throws(
  () => renderAwsStagingRuntime(mutatedFixture((fixture) => {
    fixture.msk_bootstrap_brokers_sasl_iam.sensitive = false;
  }), contract),
  /sensitivity contract drifted/,
);
assert.throws(
  () => renderAwsStagingRuntime(mutatedFixture((fixture) => {
    fixture.msk_bootstrap_brokers_sasl_iam.value = `${broker}\nAWS_SECRET_ACCESS_KEY=unsafe`;
  }), contract),
  /broker output is invalid/,
);
assert.throws(
  () => renderAwsStagingRuntime(mutatedFixture((fixture) => {
    fixture.infrastructure_contract.value.emr_capacity.maximum_vcpu = 32;
  }), contract),
  /maximum vCPU does not match/,
);
assert.throws(
  () => renderAwsStagingRuntime(mutatedFixture((fixture) => {
    fixture.infrastructure_contract.value.bucket_names.report = fixture.infrastructure_contract.value.bucket_names.output;
  }), contract),
  /buckets must be unique/,
);
assert.throws(
  () => renderAwsStagingRuntime(mutatedFixture((fixture) => {
    fixture.infrastructure_contract.value.msk_cluster_arn = fixture.infrastructure_contract.value.msk_cluster_arn.replace(
      accountId,
      "210987654321",
    );
  }), contract),
  /cluster identity does not match/,
);

const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "asklake-aws-staging-runtime-"));
try {
  const files = writeAwsStagingRuntimeFiles(terraformFixture(), { outputDirectory });
  assert.equal(statSync(files.envFile).mode & 0o777, 0o600);
  assert.equal(statSync(files.manifestFile).mode & 0o777, 0o600);
  assert.equal(readFileSync(files.envFile, "utf8"), rendered.envText);
  assert.ok(!readFileSync(files.manifestFile, "utf8").includes(broker));
  assert.throws(
    () => writeAwsStagingRuntimeFiles(terraformFixture(), { outputDirectory }),
    /already exist/,
  );
  writeAwsStagingRuntimeFiles(terraformFixture(), { outputDirectory, overwrite: true });
} finally {
  rmSync(outputDirectory, { force: true, recursive: true });
}

const cliDirectory = mkdtempSync(path.join(os.tmpdir(), "asklake-aws-staging-runtime-cli-"));
try {
  const result = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "backend", "scripts", "render-aws-staging-runtime.mjs"), "--output-dir", cliDirectory],
    { encoding: "utf8", input: JSON.stringify(terraformFixture()) },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ASKLAKE_AWS_STAGING_RUNTIME_FILES=/);
  assert.ok(!result.stdout.includes(broker));
  assert.ok(!result.stderr.includes(broker));

  const invalidResult = spawnSync(
    process.execPath,
    [path.join(repositoryRoot, "backend", "scripts", "render-aws-staging-runtime.mjs"), "--output-dir", `${cliDirectory}-invalid`],
    {
      encoding: "utf8",
      input: JSON.stringify(mutatedFixture((fixture) => {
        fixture.msk_bootstrap_brokers_sasl_iam.value = `${broker}\nAWS_ACCESS_KEY_ID=unsafe-test-value`;
      })),
    },
  );
  assert.notEqual(invalidResult.status, 0);
  assert.ok(!invalidResult.stdout.includes(broker));
  assert.ok(!invalidResult.stderr.includes(broker));
  assert.ok(!invalidResult.stderr.includes("unsafe-test-value"));
} finally {
  rmSync(cliDirectory, { force: true, recursive: true });
  rmSync(`${cliDirectory}-invalid`, { force: true, recursive: true });
}

console.log("AWS staging Runtime Phase 2 render contract verified.");
