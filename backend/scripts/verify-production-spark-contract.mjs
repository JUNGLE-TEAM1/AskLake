import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSparkSourceInspectRestSubmission } from "../src/connectors.mjs";
import {
  createSparkRestSubmission,
  sparkExecutionMode,
  sparkRestRuntimeConfig,
} from "../src/sparkRunner.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDir = path.dirname(backendDir);
const composeFile = path.join(repositoryDir, "deploy", "docker-compose.prod.yml");
const envFile = path.join(repositoryDir, "deploy", ".env.example");
const composeResult = spawnSync("docker", [
  "compose",
  "--env-file",
  envFile,
  "-f",
  composeFile,
  "config",
  "--format",
  "json",
], {
  cwd: repositoryDir,
  encoding: "utf8",
  env: { ...process.env, APP_ENV: "production" },
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(
  composeResult.status,
  0,
  `Production Compose config failed: ${composeResult.stderr || composeResult.stdout}`,
);

const compose = JSON.parse(composeResult.stdout);
const backend = requiredService(compose, "backend");
const init = requiredService(compose, "spark-dir-init");
const master = requiredService(compose, "spark-master");
const minio = requiredService(compose, "minio");
const minioInit = requiredService(compose, "minio-init");
const worker = requiredService(compose, "spark-worker");
const backendEnvironment = backend.environment || {};

assert.equal(backendEnvironment.APP_ENV, "production");
assert.equal(backend.build?.target, "backend-runtime", "Backend must use the Docker-free runtime target.");
assert.equal(master.build?.target, "spark-runtime", "Spark master must use the embedded-script Spark target.");
assert.equal(worker.build?.target, "spark-runtime", "Spark worker must use the embedded-script Spark target.");
assert.equal(backendEnvironment.ASKLAKE_SPARK_RUNNER, "rest");
assert.equal(backendEnvironment.ASKLAKE_MINIO_DOCKER_FALLBACK, "false");
assert.equal(backendEnvironment.ASKLAKE_SPARK_REST_URL, "http://spark-master:6066");
assert.equal(backendEnvironment.ASKLAKE_SPARK_MASTER_URL, "spark://spark-master:7077");
assert.equal(backendEnvironment.ASKLAKE_SPARK_JOB_SCRIPT, "/opt/asklake/scripts/spark_job_run.py");
assert.equal(
  backendEnvironment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT,
  "/opt/asklake/scripts/spark_source_inspect_rest.py",
);
assert.equal(minio.environment?.MINIO_ROOT_USER, minioInit.environment?.MINIO_ROOT_USER);
assert.equal(minio.environment?.MINIO_ROOT_PASSWORD, minioInit.environment?.MINIO_ROOT_PASSWORD);
assert.equal(backendEnvironment.MINIO_ACCESS_KEY, minioInit.environment?.MINIO_ACCESS_KEY);
assert.equal(backendEnvironment.MINIO_SECRET_KEY, minioInit.environment?.MINIO_SECRET_KEY);
assert.notEqual(backendEnvironment.MINIO_ACCESS_KEY, minio.environment?.MINIO_ROOT_USER);
assert.notEqual(backendEnvironment.MINIO_SECRET_KEY, minio.environment?.MINIO_ROOT_PASSWORD);

const sharedPaths = [
  "/var/lib/asklake/spark-ivy",
  "/var/lib/asklake/spark-output",
  "/var/lib/asklake/spark-runs",
  "/var/lib/asklake/samples",
  "/var/lib/asklake/review-text-models",
];
for (const volume of backend.volumes || []) {
  assert.notEqual(volume.source, "/var/run/docker.sock", "Backend must not mount the Docker socket.");
  assert.notEqual(volume.target, "/var/run/docker.sock", "Backend must not expose the Docker socket.");
}
for (const target of sharedPaths) {
  assert(hasVolumeTarget(backend, target), `Backend is missing shared Spark path ${target}.`);
  assert(hasVolumeTarget(init, target), `Spark directory initializer is missing ${target}.`);
  assert(hasVolumeTarget(worker, target), `Spark worker is missing shared Spark path ${target}.`);
}
assert.equal(init.user, "0:0", "Spark directory initializer must be able to repair fresh bind ownership.");
assert.match(JSON.stringify(init.command), /chown -R 185:185/);
assert.equal(master.user, "185:185");
assert.equal(worker.user, "185:185");
assert.match(master.environment?.SPARK_MASTER_OPTS || "", /spark\.master\.rest\.enabled=true/);
assert.match(master.environment?.SPARK_MASTER_OPTS || "", /spark\.deploy\.maxDrivers=2/);
assert((master.expose || []).includes("6066"), "Spark REST port must be internal-only and exposed to the Compose network.");
assert.equal(master.ports, undefined, "Spark master ports must not be published on the host.");

const runtime = sparkRestRuntimeConfig(backendEnvironment);
assert.equal(sparkExecutionMode(backendEnvironment), "rest");
assert.equal(runtime.ivyRuntimeDir, "/var/lib/asklake/spark-ivy");
assert.equal(runtime.jobScript, backendEnvironment.ASKLAKE_SPARK_JOB_SCRIPT);
assert.equal(runtime.sourceInspectScript, backendEnvironment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT);
assert.throws(
  () => sparkExecutionMode({ APP_ENV: "production", ASKLAKE_SPARK_RUNNER: "docker" }),
  (error) => error?.code === "SPARK_RUNNER_CONFIGURATION_INVALID",
  "Production must fail closed when Docker execution is selected.",
);

const pipelineSubmission = createSparkRestSubmission({
  appName: "contract-pipeline",
  environmentVariables: {
    ASKLAKE_SPARK_JOB_MANIFEST_FILE: "/var/lib/asklake/spark-runs/run.manifest.json",
    ASKLAKE_SPARK_OUTPUT_PATH: "s3a://asklake-output/contract/run",
    ASKLAKE_SPARK_REPORT_FILE: "/var/lib/asklake/spark-runs/run.json",
  },
  packages: [backendEnvironment.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE],
  scriptPath: runtime.jobScript,
}, backendEnvironment);
assert.deepEqual(pipelineSubmission.appArgs, [backendEnvironment.ASKLAKE_SPARK_JOB_SCRIPT]);
assert.equal(pipelineSubmission.sparkProperties["spark.jars.ivy"], backendEnvironment.ASKLAKE_SPARK_IVY_DIR);
assert.equal(
  pipelineSubmission.environmentVariables.ASKLAKE_SPARK_REPORT_FILE,
  backendEnvironment.ASKLAKE_SPARK_REPORT_DIR + "/run.json",
);
assert.equal(
  pipelineSubmission.sparkProperties["spark.executorEnv.ASKLAKE_REVIEW_TEXT_MODEL_ROOT"],
  undefined,
  "Generic submissions must not invent ETL business environment values.",
);

const inspectSubmission = createSparkSourceInspectRestSubmission({
  environmentVariables: {
    ASKLAKE_SOURCE_INSPECT_REPORT_FILE: "/var/lib/asklake/spark-runs/source-inspect.json",
    ASKLAKE_SOURCE_PATH: "s3a://m3-raw/contract.parquet",
  },
}, backendEnvironment);
assert.deepEqual(inspectSubmission.appArgs, [backendEnvironment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT]);
assert.equal(
  inspectSubmission.environmentVariables.ASKLAKE_SOURCE_INSPECT_REPORT_FILE,
  backendEnvironment.ASKLAKE_SPARK_REPORT_CONTAINER_DIR + "/source-inspect.json",
);

const dockerfile = readFileSync(path.join(backendDir, "Dockerfile"), "utf8");
assert.doesNotMatch(dockerfile, /\bdocker-cli\b/, "Production backend image must not install Docker CLI.");
assert.match(dockerfile, /^FROM apache\/spark:4\.0\.1 AS spark-runtime$/m);
assert.match(dockerfile, /^FROM python:3\.13-slim AS backend-runtime$/m);

console.log("Production Spark contract verified: REST runner, configured paths, UID 185 binds, no backend Docker socket.");

function requiredService(config, name) {
  const service = config.services?.[name];
  assert(service, `Production Compose is missing service ${name}.`);
  return service;
}

function hasVolumeTarget(service, target) {
  return (service.volumes || []).some((volume) => volume.target === target);
}
