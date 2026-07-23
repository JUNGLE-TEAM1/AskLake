import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import {
  kubernetesIdentifier,
  normalizeSparkAttemptGeneration,
  sparkKubernetesAnnotations,
  sparkKubernetesApplicationName,
} from "./sparkKubernetesIdentity.mjs";
import { sparkKubernetesResourcePlan } from "./sparkResourcePlan.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sparkKubernetesClientScript = path.join(backendDir, "scripts", "spark-kubernetes-client.mjs");
const SPARK_BRIDGE_GRACE_MS = 30_000;

function configurationError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  error.status = 500;
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function environmentVariables(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([name, value]) => ({ name, value: String(value) }));
}

function runtimeSecretEnvironment(environment) {
  const secretName = String(environment.ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET || "asklake-spark-runtime").trim();
  return [
    ["ASKLAKE_SPARK_ICEBERG_JDBC_URL", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_URL_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_URL"],
    ["ASKLAKE_SPARK_ICEBERG_JDBC_USER", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_USER_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_USER"],
    ["ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_PASSWORD_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD"],
  ].map(([name, key]) => ({ name, valueFrom: { secretKeyRef: { key: String(key), name: secretName } } }));
}

function podPlacement() {
  return {
    nodeSelector: { "asklake.io/workload-class": "spark", "kubernetes.io/arch": "amd64" },
    tolerations: [{ effect: "NoSchedule", key: "asklake.io/workload-class", operator: "Equal", value: "spark" }],
  };
}

function driverSpec(environment, driverEnvironment, runLabel, serviceAccount) {
  return {
    coreLimit: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_LIMIT || environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES || "1"),
    coreRequest: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_REQUEST || environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES || "1"),
    cores: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES, 1),
    env: driverEnvironment, labels: { "asklake.io/run-id": runLabel },
    memory: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_MEMORY || "2g"),
    memoryOverhead: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_MEMORY_OVERHEAD || "512m"),
    serviceAccount, ...podPlacement(),
  };
}

function executorSpec(environment, driverEnvironment, executorInstances, runLabel, serviceAccount) {
  const allowed = new Set(["ASKLAKE_LOCAL_LLM_ENDPOINT", "ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS", "ASKLAKE_LOCAL_LLM_MODEL", "ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS", "ASKLAKE_OBJECT_STORAGE_PROVIDER", "ASKLAKE_REVIEW_ANALYSIS_RUNTIME", "ASKLAKE_REVIEW_TEXT_MODEL_ROOT", "AWS_REGION", "S3_ENDPOINT", "S3_FORCE_PATH_STYLE"]);
  return {
    coreLimit: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT || environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES || "2"),
    coreRequest: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST || environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES || "2"),
    cores: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES, 2),
    env: driverEnvironment.filter((item) => allowed.has(item.name)), instances: executorInstances,
    labels: { "asklake.io/run-id": runLabel }, memory: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY || "4g"),
    memoryOverhead: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD || "1g"), serviceAccount, ...podPlacement(),
  };
}

export function createSparkKubernetesApplication({ appName, attemptGeneration = 1, environmentVariables: values = {}, jars = [], jobId, packages = [], resourcePlan, runId }, environment = process.env) {
  const namespace = String(environment.ASKLAKE_SPARK_KUBERNETES_NAMESPACE || "asklake-dev").trim();
  const serviceAccount = String(environment.ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT || "asklake-spark").trim();
  const image = String(environment.ASKLAKE_SPARK_KUBERNETES_IMAGE || "").trim();
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw configurationError("ASKLAKE_SPARK_KUBERNETES_IMAGE must use repository@sha256:digest format.");
  const normalizedAttemptGeneration = normalizeSparkAttemptGeneration(attemptGeneration);
  const { annotations: resourcePlanAnnotations, appliedExecutors: executorInstances } = sparkKubernetesResourcePlan(resourcePlan, environment);
  const runLabel = kubernetesIdentifier(runId).slice(0, 63).replace(/-+$/g, "") || "run";
  const jobLabel = kubernetesIdentifier(jobId, "job").slice(0, 63).replace(/-+$/g, "") || "job";
  const driverEnvironment = [...environmentVariables(values), ...runtimeSecretEnvironment(environment)];
  return {
    apiVersion: "sparkoperator.k8s.io/v1beta2", kind: "SparkApplication",
    metadata: {
      annotations: sparkKubernetesAnnotations({ executorInstances, fixtureBatchId: String(values.ASKLAKE_KAFKA_FIXTURE_BATCH_ID || "").trim(), imageDigest: image.slice(image.lastIndexOf("@") + 1), jobId, normalizedAttemptGeneration, resourcePlanAnnotations, runId }),
      labels: { "app.kubernetes.io/name": "asklake-spark", "app.kubernetes.io/part-of": "asklake", "asklake.io/job-id": jobLabel, "asklake.io/run-id": runLabel },
      name: sparkKubernetesApplicationName(runId, normalizedAttemptGeneration), namespace,
    },
    spec: {
      deps: { jars: [...new Set(jars.map((item) => String(item || "").trim()).filter(Boolean))], packages: [...new Set(packages.map((item) => String(item || "").trim()).filter(Boolean))] },
      driver: driverSpec(environment, driverEnvironment, runLabel, serviceAccount),
      executor: executorSpec(environment, driverEnvironment, executorInstances, runLabel, serviceAccount),
      hadoopConf: { "fs.s3a.aws.credentials.provider": "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider", "fs.s3a.endpoint.region": String(environment.AWS_REGION || "ap-northeast-2"), "fs.s3a.path.style.access": "false" },
      image, imagePullPolicy: "IfNotPresent", mainApplicationFile: String(environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE || "local:///opt/asklake/scripts/spark_job_run.py").startsWith("local:///") ? String(environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE || "local:///opt/asklake/scripts/spark_job_run.py") : `local://${String(environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE || "/opt/asklake/scripts/spark_job_run.py")}`,
      mode: "cluster", pythonVersion: "3", restartPolicy: { type: "Never" }, sparkConf: { "spark.app.name": String(appName || `asklake-${runLabel}`), "spark.jars.ivy": "/tmp/.ivy2", "spark.kubernetes.executor.deleteOnTermination": "true", "spark.sql.shuffle.partitions": String(environment.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32") }, sparkVersion: String(environment.ASKLAKE_SPARK_VERSION || "4.0.1"), timeToLiveSeconds: 3_600, type: "Python",
    },
  };
}

export function runSparkKubernetesApplication(application, timeoutMs, environment = process.env, options = {}) {
  const effectiveTimeoutMs = positiveInteger(timeoutMs, 7_200_000);
  const result = spawnSync(process.execPath, [sparkKubernetesClientScript], {
    cwd: backendDir, encoding: "utf8", env: environment,
    input: JSON.stringify({ application, expectedKubernetesExecution: options.expectedKubernetesExecution, pollIntervalMs: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_POLL_INTERVAL_MS, 2_000), progressFile: options.progressFile, timeoutMs: effectiveTimeoutMs }),
    maxBuffer: 32 * 1024 * 1024, timeout: effectiveTimeoutMs + SPARK_BRIDGE_GRACE_MS,
  });
  if (result.status !== 0 || result.error || result.signal) return result;
  const marker = String(result.stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_SPARK_KUBERNETES_RESULT="));
  const payload = marker ? JSON.parse(marker.slice("ASKLAKE_SPARK_KUBERNETES_RESULT=".length)) : null;
  if (!payload?.report) return { ...result, status: 1, stderr: `${result.stderr || ""}\nKubernetes Spark client returned an invalid result.` };
  return { ...result, status: 0, stdout: `ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify(payload.report)}\n` };
}
