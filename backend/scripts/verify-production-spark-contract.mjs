import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createSparkSourceInspectRestSubmission } from "../src/connectors.mjs";
import {
  assertSparkRestStorageCredentials,
  createSparkRestSubmission,
  sparkExecutionMode,
  sparkRestBridgeTimeoutMs,
  sparkRestRuntimeConfig,
  sparkRunTimeoutMs,
} from "../src/sparkRunner.mjs";
import { validateSubmission } from "./spark-rest-client.mjs";

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
const runtimeGuard = requiredService(compose, "spark-runtime-guard");
const master = requiredService(compose, "spark-master");
const readiness = requiredService(compose, "aws-s3-readiness");
const worker = requiredService(compose, "spark-worker");
const backendEnvironment = backend.environment || {};

assert.equal(backendEnvironment.APP_ENV, "production");
assert.equal(compose.services["spark-dir-init"], undefined, "Production must not depend on a one-shot Spark initializer.");
assert.equal(backend.build?.target, "backend-runtime", "Backend must use the Docker-free runtime target.");
assert.equal(master.build?.target, "spark-runtime", "Spark master must use the embedded-script Spark target.");
assert.equal(worker.build?.target, "spark-runtime", "Spark worker must use the embedded-script Spark target.");
assert.equal(backendEnvironment.ASKLAKE_SPARK_RUNNER, "rest");
assert.equal(backendEnvironment.ASKLAKE_MINIO_DOCKER_FALLBACK, "false");
assert.equal(backendEnvironment.ASKLAKE_SPARK_REST_URL, "http://spark-master:6066");
assert.equal(backendEnvironment.ASKLAKE_SPARK_MASTER_URL, "spark://spark-master:7077");
assert.equal(backendEnvironment.ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS, "4");
assert.equal(backendEnvironment.ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL, "WARN");
assert.equal(backendEnvironment.ASKLAKE_SPARK_JOB_SCRIPT, "/opt/asklake/scripts/spark_job_run.py");
assert.equal(
  backendEnvironment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT,
  "/opt/asklake/scripts/spark_source_inspect_rest.py",
);
assert.equal(
  backendEnvironment.ASKLAKE_SPARK_CONTINUOUS_SCRIPT,
  "/opt/asklake/scripts/kafka_continuous_stream.py",
);
assert.equal(
  backendEnvironment.ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT,
  "/opt/asklake/scripts/kafka_continuous_maintenance.py",
);
assert.equal(compose.services.minio, undefined, "AWS production Compose must not include MinIO.");
assert.equal(compose.services["minio-init"], undefined, "AWS production Compose must not include MinIO bootstrap.");
assert.equal(backendEnvironment.ASKLAKE_OBJECT_STORAGE_PROVIDER, "aws");
assert.equal(worker.environment?.ASKLAKE_OBJECT_STORAGE_PROVIDER, "aws");
assert.equal(worker.environment?.AWS_REGION, backendEnvironment.AWS_REGION);
assert.equal(readiness.environment?.ASKLAKE_OBJECT_STORAGE_PROVIDER, "aws");
assert.equal(readiness.environment?.AWS_REGION, backendEnvironment.AWS_REGION);
for (const name of [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "MINIO_ACCESS_KEY",
  "MINIO_SECRET_KEY",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
]) {
  assert.equal(backendEnvironment[name], undefined, `Backend must not receive static credential ${name}.`);
  assert.equal(worker.environment?.[name], undefined, `Spark worker must not receive static credential ${name}.`);
}

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
  assert(hasVolumeTarget(runtimeGuard, target), `Spark runtime guard is missing ${target}.`);
  assert(hasVolumeTarget(worker, target), `Spark worker is missing shared Spark path ${target}.`);
}
assert.equal(runtimeGuard.user, "0:0", "Spark runtime guard must be able to repair fresh bind ownership.");
assert.equal(runtimeGuard.restart, "unless-stopped", "Spark runtime guard must run again after Docker daemon restart.");
assert.deepEqual(
  runtimeGuard.command,
  ["python3", "/opt/asklake/scripts/ensure_spark_runtime_paths.py", "guard"],
);
assert.equal(runtimeGuard.environment?.ASKLAKE_SPARK_RUNTIME_UID, "185");
assert.equal(runtimeGuard.environment?.ASKLAKE_SPARK_RUNTIME_GID, "185");
assert.equal(runtimeGuard.environment?.ASKLAKE_SPARK_RUNTIME_DIRECTORY_MODE, "2770");
assert.equal(runtimeGuard.environment?.ASKLAKE_SPARK_RUNTIME_FILE_MODE, "0660");
assert.deepEqual(master.depends_on?.["spark-runtime-guard"]?.condition, "service_healthy");
assert.deepEqual(worker.depends_on?.["spark-runtime-guard"]?.condition, "service_healthy");
assert.deepEqual(backend.depends_on?.["spark-runtime-guard"]?.condition, "service_healthy");
assert.deepEqual(backend.command?.slice(0, 4), [
  "python",
  "/app/scripts/ensure_spark_runtime_paths.py",
  "wait-backend-exec",
  "--",
]);
assert.deepEqual(worker.command?.slice(0, 4), [
  "python3",
  "/opt/asklake/scripts/ensure_spark_runtime_paths.py",
  "wait-writer-exec",
  "--",
]);
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
assert.doesNotThrow(
  () => assertSparkRestStorageCredentials([["Storage Provider", "aws"]], "rest"),
  "AWS Spark REST execution must not resolve or require MinIO credentials.",
);

const pipelineSubmission = createSparkRestSubmission({
  appName: "contract-pipeline",
  environmentVariables: {
    ASKLAKE_SPARK_JOB_MANIFEST_FILE: "/var/lib/asklake/spark-runs/run.manifest.json",
    ASKLAKE_SPARK_OUTPUT_PATH: `s3a://${backendEnvironment.ASKLAKE_SPARK_OUTPUT_BUCKET}/contract/run`,
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
assert.throws(
  () => validateSubmission({
    ...pipelineSubmission,
    environmentVariables: {
      ...pipelineSubmission.environmentVariables,
      AWS_SECRET_ACCESS_KEY: "must-not-cross-rest-boundary",
    },
  }),
  /inherit application credentials from the worker environment/,
);

const inspectSubmission = createSparkSourceInspectRestSubmission({
  environmentVariables: {
    ASKLAKE_SOURCE_INSPECT_REPORT_FILE: "/var/lib/asklake/spark-runs/source-inspect.json",
    ASKLAKE_SOURCE_PATH: `s3a://${backendEnvironment.ASKLAKE_RAW_BUCKET}/contract.parquet`,
  },
}, backendEnvironment);
assert.deepEqual(inspectSubmission.appArgs, [backendEnvironment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT]);
assert.equal(
  inspectSubmission.environmentVariables.ASKLAKE_SOURCE_INSPECT_REPORT_FILE,
  backendEnvironment.ASKLAKE_SPARK_REPORT_CONTAINER_DIR + "/source-inspect.json",
);
assert.equal(sparkRunTimeoutMs({ ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS: "1" }), 1_000);
assert.equal(sparkRunTimeoutMs({ ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS: "0" }), 7_200_000);
assert.equal(sparkRestBridgeTimeoutMs(1_000), 31_000);

const dockerfile = readFileSync(path.join(backendDir, "Dockerfile"), "utf8");
assert.doesNotMatch(dockerfile, /\bdocker-cli\b/, "Production backend image must not install Docker CLI.");
assert.match(dockerfile, /^FROM apache\/spark:4\.0\.1 AS spark-runtime$/m);
assert.match(dockerfile, /^FROM python:3\.13-slim AS backend-runtime$/m);

const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || (process.platform === "win32" ? "python" : "python3");
const runtimePathsResult = spawnSync(pythonBin, [
  path.join(backendDir, "scripts", "verify-spark-runtime-paths.py"),
], {
  cwd: backendDir,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30_000,
});
assert.equal(
  runtimePathsResult.status,
  0,
  `Spark runtime path contract failed: ${runtimePathsResult.stderr || runtimePathsResult.stdout}`,
);
const bridgeTimeoutResult = spawnSync(pythonBin, [
  path.join(backendDir, "scripts", "verify-spark-bridge-timeout-contract.py"),
], {
  cwd: backendDir,
  encoding: "utf8",
  env: {
    ...process.env,
    PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  maxBuffer: 4 * 1024 * 1024,
  timeout: 30_000,
});
assert.equal(
  bridgeTimeoutResult.status,
  0,
  `Spark bridge timeout contract failed: ${bridgeTimeoutResult.stderr || bridgeTimeoutResult.stdout}`,
);

const continuousRestResult = spawnSync(process.execPath, [
  path.join(backendDir, "scripts", "verify-kafka-continuous-rest.mjs"),
], {
  cwd: backendDir,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  timeout: 60_000,
});
assert.equal(
  continuousRestResult.status,
  0,
  `Production Kafka continuous REST contract failed: ${continuousRestResult.stderr || continuousRestResult.stdout}`,
);

console.log(continuousRestResult.stdout.trim());
console.log(bridgeTimeoutResult.stdout.trim());
console.log(runtimePathsResult.stdout.trim());
console.log("Production Spark contract verified: REST runner, reboot-safe UID 185 paths, and no backend Docker dependency.");

function requiredService(config, name) {
  const service = config.services?.[name];
  assert(service, `Production Compose is missing service ${name}.`);
  return service;
}

function hasVolumeTarget(service, target) {
  return (service.volumes || []).some((volume) => volume.target === target);
}
