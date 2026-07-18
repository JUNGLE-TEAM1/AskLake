import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRawBucket,
  isMinioProvider,
  objectStorageDockerEnv,
  resolveObjectStorageConfig,
  toDockerEnvArgs,
} from "./objectStorageConfig.mjs";
import { fieldValue, normalizeColumnName } from "./profile.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const sparkRestClientScript = path.join(scriptsDir, "spark-rest-client.mjs");
const sparkKubernetesClientScript = path.join(scriptsDir, "spark-kubernetes-client.mjs");
const sparkHostScriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || scriptsDir);
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const localOutputDir = path.resolve(process.env.ASKLAKE_SPARK_LOCAL_OUTPUT_DIR || path.join(backendDir, "tmp", "spark-output"));
const sampleHostDir = path.resolve(process.env.ASKLAKE_LOCAL_SAMPLE_DIR || path.join(os.tmpdir(), "asklake-1gb-samples"));
const sampleContainerDir = process.env.ASKLAKE_SAMPLE_CONTAINER_DIR || "/opt/asklake-samples";
const reviewTextModelHostDir = path.resolve(
  process.env.ASKLAKE_REVIEW_TEXT_MODEL_HOST_DIR
    || path.join(backendDir, "..", "output", "nlp-eval", "template-model-validation", "runtime", "latest"),
);
const reviewTextModelContainerDir = process.env.ASKLAKE_REVIEW_TEXT_MODEL_CONTAINER_DIR || "/work/review-text-models";
const outputVolumeName = process.env.ASKLAKE_SPARK_OUTPUT_VOLUME || "asklake-spark-output";
const outputContainerDir = process.env.ASKLAKE_SPARK_OUTPUT_CONTAINER_DIR || "/work/output";
export const SPARK_MSK_IAM_SHADED_JAR = "local:///opt/asklake/jars/aws-msk-iam-auth-2.3.6-asklake-shaded.jar";
export const SPARK_REST_BRIDGE_GRACE_MS = 30_000;
export const EKS_MVP_FIXTURE_TOPIC = "asklake.eks-mvp.fixture.v1";
export const EKS_MVP_FIXTURE_CONSUMER_GROUP = "asklake-eks-mvp-spark-v1";
export const EKS_MVP_FIXTURE_SLOTS_ENV = "ASKLAKE_EKS_MVP_FIXTURE_SLOTS_JSON";
export const SPARK_EXECUTOR_INSTANCES_MAX = 4;
const EKS_MVP_FIXTURE_ICEBERG_TABLE = "eks_mvp_fixture";
const EKS_MVP_FIXTURE_MAX_SLOTS = 5;

export function eksMvpFixtureSlots(environment = process.env) {
  const defaultSlot = {
    consumerGroup: EKS_MVP_FIXTURE_CONSUMER_GROUP,
    table: EKS_MVP_FIXTURE_ICEBERG_TABLE,
  };
  const raw = String(environment[EKS_MVP_FIXTURE_SLOTS_ENV] || "").trim();
  if (!raw) return [defaultSlot];

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw sparkConfigurationError(`${EKS_MVP_FIXTURE_SLOTS_ENV} must be valid JSON.`);
  }
  if (!Array.isArray(payload) || payload.length < 1 || payload.length > EKS_MVP_FIXTURE_MAX_SLOTS) {
    throw sparkConfigurationError(
      `${EKS_MVP_FIXTURE_SLOTS_ENV} must contain between 1 and ${EKS_MVP_FIXTURE_MAX_SLOTS} slots.`,
    );
  }
  const consumerGroups = new Set();
  const tables = new Set();
  const slots = payload.map((item, index) => {
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || Object.keys(item).sort().join(",") !== "consumerGroup,table"
    ) {
      throw sparkConfigurationError(
        `${EKS_MVP_FIXTURE_SLOTS_ENV}[${index}] must contain only consumerGroup and table.`,
      );
    }
    const consumerGroup = String(item.consumerGroup || "").trim();
    const table = String(item.table || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(consumerGroup)) {
      throw sparkConfigurationError(`${EKS_MVP_FIXTURE_SLOTS_ENV}[${index}].consumerGroup is invalid.`);
    }
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(table)) {
      throw sparkConfigurationError(`${EKS_MVP_FIXTURE_SLOTS_ENV}[${index}].table is invalid.`);
    }
    if (consumerGroups.has(consumerGroup) || tables.has(table)) {
      throw sparkConfigurationError(
        `${EKS_MVP_FIXTURE_SLOTS_ENV} consumerGroup and table values must be unique.`,
      );
    }
    consumerGroups.add(consumerGroup);
    tables.add(table);
    return { consumerGroup, table };
  });
  if (!slots.some((slot) => (
    slot.consumerGroup === defaultSlot.consumerGroup && slot.table === defaultSlot.table
  ))) {
    throw sparkConfigurationError(`${EKS_MVP_FIXTURE_SLOTS_ENV} must preserve the default fixture slot.`);
  }
  return slots;
}

export function runSparkPipeline(job, command, runId, options = {}) {
  const executionMode = sparkExecutionMode();
  if (executionMode === "docker") ensureSparkServer();
  const allowWorldWritable = executionMode === "docker";
  ensureWritableDir(ivyDir, allowWorldWritable);
  ensureWritableDir(reportDir, allowWorldWritable);
  ensureWritableDir(localOutputDir, allowWorldWritable);
  ensureWritableDir(sampleHostDir, allowWorldWritable);
  ensureWritableDir(reviewTextModelHostDir, allowWorldWritable);

  const source = sparkSourceFromJob(job, runId);
  try {
    return runSparkPipelineWithSource(job, command, runId, source, executionMode, options);
  } finally {
    cleanupSparkSource(source);
  }
}

function runSparkPipelineWithSource(job, command, runId, source, executionMode, options = {}) {
  if (
    executionMode === "kubernetes"
    && !usesS3A(source.path)
    && !new Set(["iceberg", "kafka"]).has(String(source.format || "").toLowerCase())
  ) {
    throw sparkConfigurationError(
      `Kubernetes Spark requires an S3 or Iceberg source; backend-local source paths cannot be mounted. source=${source.path}`,
    );
  }
  const output = sparkOutputPath(job, runId);
  const kafkaFixtureEnvironment = sparkKafkaFixtureEnvironment(job, source, runId, executionMode);
  const reportPath = path.join(reportDir, `${runId}.json`);
  const dockerReportPath = `${reportContainerDir}/${runId}.json`;
  const manifestPath = path.join(reportDir, `${runId}.manifest.json`);
  const dockerManifestPath = `${reportContainerDir}/${runId}.manifest.json`;
  const packages = sparkPackages(job, source, output);
  const jars = sparkDependencyJars(source, executionMode, {
    ...process.env,
    ...kafkaFixtureEnvironment,
  });
  const packageArgs = sparkPackageArgs(packages);
  const localLlmEndpoint = process.env.ASKLAKE_LOCAL_LLM_ENDPOINT_IN_DOCKER
    || process.env.ASKLAKE_LOCAL_LLM_ENDPOINT
    || "http://host.docker.internal:1234/v1/chat/completions";
  const localLlmModel = process.env.ASKLAKE_LOCAL_LLM_MODEL || "local-review-analyzer";
  const localLlmTimeoutSeconds = process.env.ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS
    || String(Math.ceil(Number(process.env.ASKLAKE_LOCAL_LLM_TIMEOUT_MS || 120000) / 1000));
  const reviewAnalysisRuntime = process.env.ASKLAKE_REVIEW_ANALYSIS_RUNTIME || "scalable";
  const icebergEnvironment = sparkIcebergEnvironment(job, executionMode);
  assertSparkRestStorageCredentials(job.sourceConfig ?? [], executionMode);
  const jobManifest = sparkJobManifest(job);
  writeSparkJobManifest(manifestPath, jobManifest);
  const storageEnvironment = Object.fromEntries(
    objectStorageDockerEnv(job.sourceConfig ?? []).filter(([name]) => (
      executionMode === "docker"
      || !["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(name)
    )),
  );
  const sparkEnvironment = {
    ...storageEnvironment,
    ...kafkaFixtureEnvironment,
    ASKLAKE_SPARK_SOURCE_PATH: source.path,
    ASKLAKE_SPARK_SOURCE_FORMAT: source.format,
    ASKLAKE_SPARK_OUTPUT_PATH: output.sparkPath,
    ASKLAKE_SPARK_RUN_ROW_LIMIT: sparkRowLimitFromJob(job),
    ASKLAKE_SPARK_RUN_ID: runId,
    ASKLAKE_SPARK_JOB_MANIFEST_FILE: executionMode === "kubernetes" ? "" : dockerManifestPath,
    ASKLAKE_SPARK_JOB_MANIFEST_JSON: executionMode === "kubernetes" ? JSON.stringify(jobManifest) : "",
    ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE: executionMode === "kubernetes" ? "" : dockerManifestPath,
    ASKLAKE_SPARK_REPORT_FILE: executionMode === "kubernetes" ? "" : dockerReportPath,
    ASKLAKE_SPARK_APP_NAME: `asklake-${command}-${job.id}`,
    ASKLAKE_LOCAL_LLM_ENDPOINT: localLlmEndpoint,
    ASKLAKE_LOCAL_LLM_MODEL: localLlmModel,
    ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS: localLlmTimeoutSeconds,
    ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS: process.env.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS || "9000",
    ASKLAKE_REVIEW_ANALYSIS_RUNTIME: reviewAnalysisRuntime,
    ASKLAKE_REVIEW_TEXT_MODEL_ROOT: reviewTextModelContainerDir,
    ...icebergEnvironment,
    HOME: "/tmp",
  };
  const sparkExecutorProperties = Object.fromEntries(
    [
      "ASKLAKE_LOCAL_LLM_ENDPOINT",
      "ASKLAKE_LOCAL_LLM_MODEL",
      "ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS",
      "ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS",
      "ASKLAKE_REVIEW_ANALYSIS_RUNTIME",
      "ASKLAKE_REVIEW_TEXT_MODEL_ROOT",
    ].map((name) => [`spark.executorEnv.${name}`, sparkEnvironment[name]]),
  );
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${sparkHostScriptsDir}:/work/scripts:ro`,
    "-v",
    `${ivyDir}:/tmp/.ivy2`,
    "-v",
    `${reportDir}:${reportContainerDir}`,
    "-v",
    `${sampleHostDir}:${sampleContainerDir}:ro`,
    "-v",
    `${reviewTextModelHostDir}:${reviewTextModelContainerDir}:ro`,
    "-v",
    `${outputVolumeName}:${outputContainerDir}`,
    ...toDockerEnvArgs(objectStorageDockerEnv(job.sourceConfig ?? [])),
    "-e",
    `ASKLAKE_SPARK_SOURCE_PATH=${source.path}`,
    "-e",
    `ASKLAKE_SPARK_SOURCE_FORMAT=${source.format}`,
    "-e",
    `ASKLAKE_SPARK_OUTPUT_PATH=${output.sparkPath}`,
    "-e",
    `ASKLAKE_SPARK_RUN_ROW_LIMIT=${sparkRowLimitFromJob(job)}`,
    "-e",
    `ASKLAKE_SPARK_RUN_ID=${runId}`,
    "-e",
    `ASKLAKE_SPARK_JOB_MANIFEST_FILE=${dockerManifestPath}`,
    "-e",
    `ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE=${dockerManifestPath}`,
    "-e",
    `ASKLAKE_SPARK_REPORT_FILE=${dockerReportPath}`,
    "-e",
    `ASKLAKE_SPARK_APP_NAME=asklake-${command}-${job.id}`,
    "-e",
    `ASKLAKE_LOCAL_LLM_ENDPOINT=${localLlmEndpoint}`,
    "-e",
    `ASKLAKE_LOCAL_LLM_MODEL=${localLlmModel}`,
    "-e",
    `ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS=${localLlmTimeoutSeconds}`,
    "-e",
    `ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS=${process.env.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS || "9000"}`,
    "-e",
    `ASKLAKE_REVIEW_ANALYSIS_RUNTIME=${reviewAnalysisRuntime}`,
    "-e",
    `ASKLAKE_REVIEW_TEXT_MODEL_ROOT=${reviewTextModelContainerDir}`,
    ...Object.entries(icebergEnvironment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "-e",
    "HOME=/tmp",
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master",
    process.env.ASKLAKE_SPARK_MASTER_URL
      || `spark://${process.env.ASKLAKE_SPARK_MASTER_CONTAINER || "asklake-spark-master"}:7077`,
    "--driver-memory",
    process.env.ASKLAKE_SPARK_DRIVER_MEMORY || "4g",
    "--executor-memory",
    process.env.ASKLAKE_SPARK_EXECUTOR_MEMORY || "8g",
    "--conf",
    "spark.jars.ivy=/tmp/.ivy2",
    "--conf",
    `spark.executor.cores=${process.env.ASKLAKE_SPARK_EXECUTOR_CORES || "4"}`,
    "--conf",
    `spark.cores.max=${process.env.ASKLAKE_SPARK_CORES_MAX || "4"}`,
    "--conf",
    `spark.sql.shuffle.partitions=${process.env.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32"}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_LOCAL_LLM_ENDPOINT=${localLlmEndpoint}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_LOCAL_LLM_MODEL=${localLlmModel}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS=${localLlmTimeoutSeconds}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS=${process.env.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS || "9000"}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_REVIEW_ANALYSIS_RUNTIME=${reviewAnalysisRuntime}`,
    "--conf",
    `spark.executorEnv.ASKLAKE_REVIEW_TEXT_MODEL_ROOT=${reviewTextModelContainerDir}`,
    ...packageArgs,
    "/work/scripts/spark_job_run.py",
  ];

  let result = executionMode === "kubernetes"
    ? runSparkKubernetesApplication(
      createSparkKubernetesApplication({
        appName: sparkEnvironment.ASKLAKE_SPARK_APP_NAME,
        environmentVariables: sparkEnvironment,
        jars,
        jobId: job.id,
        packages,
        runId,
      }),
      positiveInteger(options.sparkRestTimeoutMs, sparkRunTimeoutMs()),
      process.env,
      {
        expectedKubernetesExecution: options.expectedKubernetesExecution,
        progressFile: sparkKubernetesProgressFileForRun(runId, options.sparkKubernetesProgressFile),
      },
    )
    : executionMode === "rest"
      ? runSparkRestSubmission(
      createSparkRestSubmission({
        appName: sparkEnvironment.ASKLAKE_SPARK_APP_NAME,
        environmentVariables: sparkEnvironment,
        packages,
        scriptPath: sparkRestRuntimeConfig().jobScript,
        sparkProperties: sparkExecutorProperties,
      }),
      positiveInteger(options.sparkRestTimeoutMs, sparkRunTimeoutMs()),
      process.env,
      {
        stateFile: sparkRestStateFileForRun(runId, options.sparkRestStateFile),
      },
      )
      : runSparkSubmitContainer(dockerArgs);
  let report = readSparkReport(reportPath, result.stdout);
  if (executionMode === "docker" && report.status !== "success" && shouldRetryDockerWait(result)) {
    rmSync(reportPath, { force: true });
    result = runSparkSubmitContainer(dockerArgs);
    report = readSparkReport(reportPath, result.stdout);
  }
  if (executionMode === "docker" && report.status === "success") {
    if (!report.icebergCommit) copySparkOutputToHost(output);
    copySparkReportArtifactsToHost(report);
  }
  report = normalizeSparkReport(report, output);
  if (report.status !== "success") {
    const spawnError = result.error?.message || "";
    return {
      ...report,
      error: report.error || result.stderr || result.stdout || spawnError || "Spark job failed.",
      sparkExitCode: result.status ?? 1,
      stderr: tail(result.stderr),
      stdout: tail(result.stdout),
      status: "failed",
    };
  }

  return {
    ...report,
    sparkExitCode: 0,
    stderr: tail(result.stderr),
    stdout: tail(result.stdout),
  };
}

export function sparkExecutionMode(environment = process.env) {
  const configured = String(environment.ASKLAKE_SPARK_RUNNER || "").trim().toLowerCase();
  const production = [environment.APP_ENV, environment.NODE_ENV]
    .some((value) => ["prod", "production"].includes(String(value || "").trim().toLowerCase()));
  if (production && !new Set(["rest", "kubernetes"]).has(configured)) {
    throw sparkConfigurationError(
      "Production Spark execution requires ASKLAKE_SPARK_RUNNER=rest or kubernetes; Docker-based submission is not allowed.",
    );
  }
  const mode = configured || "docker";
  if (!new Set(["docker", "rest", "kubernetes"]).has(mode)) {
    throw sparkConfigurationError(`Unsupported ASKLAKE_SPARK_RUNNER mode: ${mode}`);
  }
  return mode;
}

export function sparkRestRuntimeConfig(environment = process.env) {
  const restUrl = configuredSparkRestUrl(environment.ASKLAKE_SPARK_REST_URL || "http://spark-master:6066");
  const scriptDir = configuredSparkRuntimePath(
    environment.ASKLAKE_SPARK_SCRIPT_DIR || "/opt/asklake/scripts",
    "ASKLAKE_SPARK_SCRIPT_DIR",
  );
  const jobScript = configuredSparkScript(
    environment.ASKLAKE_SPARK_JOB_SCRIPT || `${scriptDir}/spark_job_run.py`,
    scriptDir,
    "ASKLAKE_SPARK_JOB_SCRIPT",
  );
  const sourceInspectScript = configuredSparkScript(
    environment.ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT || `${scriptDir}/spark_source_inspect_rest.py`,
    scriptDir,
    "ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT",
  );
  const ivyRuntimeDir = configuredSparkRuntimePath(
    environment.ASKLAKE_SPARK_IVY_RUNTIME_DIR
      || environment.ASKLAKE_SPARK_IVY_DIR
      || "/var/lib/asklake/spark-ivy",
    "ASKLAKE_SPARK_IVY_RUNTIME_DIR",
  );
  return { ivyRuntimeDir, jobScript, restUrl, scriptDir, sourceInspectScript };
}

export function createSparkRestSubmission({
  appName,
  environmentVariables = {},
  packages = [],
  scriptPath,
  sparkProperties = {},
}, environment = process.env) {
  const runtime = sparkRestRuntimeConfig(environment);
  const applicationScript = configuredSparkScript(
    scriptPath || runtime.jobScript,
    runtime.scriptDir,
    "Spark application script",
  );
  const packageList = [...new Set(packages.map((item) => String(item || "").trim()).filter(Boolean))];
  const properties = {
    ...stringValues(sparkProperties),
    "spark.app.name": String(appName || "asklake-spark-job"),
    "spark.cores.max": String(environment.ASKLAKE_SPARK_CORES_MAX || "2"),
    "spark.driver.cores": String(environment.ASKLAKE_SPARK_DRIVER_CORES || "1"),
    "spark.driver.memory": String(environment.ASKLAKE_SPARK_DRIVER_MEMORY || "1g"),
    "spark.executor.cores": String(environment.ASKLAKE_SPARK_EXECUTOR_CORES || "2"),
    "spark.executor.memory": String(environment.ASKLAKE_SPARK_EXECUTOR_MEMORY || "4g"),
    "spark.jars.ivy": runtime.ivyRuntimeDir,
    "spark.master": String(environment.ASKLAKE_SPARK_MASTER_URL || "spark://spark-master:7077"),
    "spark.sql.shuffle.partitions": String(environment.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32"),
    "spark.submit.deployMode": "cluster",
  };
  if (packageList.length > 0) properties["spark.jars.packages"] = packageList.join(",");
  return {
    action: "CreateSubmissionRequest",
    appArgs: [applicationScript],
    appResource: "",
    clientSparkVersion: String(environment.ASKLAKE_SPARK_VERSION || "4.0.1"),
    environmentVariables: {
      ...stringValues(environmentVariables),
      HOME: String(environmentVariables.HOME || "/tmp"),
      PYSPARK_DRIVER_PYTHON: String(environment.PYSPARK_DRIVER_PYTHON || "/usr/bin/python3"),
      PYSPARK_PYTHON: String(environment.PYSPARK_PYTHON || "/usr/bin/python3"),
    },
    mainClass: "org.apache.spark.deploy.SparkSubmit",
    sparkProperties: properties,
  };
}

function kubernetesIdentifier(value, fallback = "run") {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || fallback;
}

export function sparkKubernetesApplicationName(runId) {
  const normalized = kubernetesIdentifier(runId);
  const digest = createHash("sha256").update(String(runId || "")).digest("hex").slice(0, 10);
  return `asklake-run-${normalized.slice(0, 38).replace(/-+$/g, "")}-${digest}`;
}

function kubernetesEnvironmentVariables(environmentVariables) {
  return Object.entries(stringValues(environmentVariables))
    .filter(([, value]) => value !== "")
    .map(([name, value]) => ({ name, value }));
}

function requiredDigestImage(environment) {
  const image = String(environment.ASKLAKE_SPARK_KUBERNETES_IMAGE || "").trim();
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    throw sparkConfigurationError("ASKLAKE_SPARK_KUBERNETES_IMAGE must use repository@sha256:digest format.");
  }
  return image;
}

function sparkRuntimeSecretEnvironment(environment) {
  const secretName = String(environment.ASKLAKE_SPARK_KUBERNETES_RUNTIME_SECRET || "asklake-spark-runtime").trim();
  const mappings = [
    ["ASKLAKE_SPARK_ICEBERG_JDBC_URL", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_URL_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_URL"],
    ["ASKLAKE_SPARK_ICEBERG_JDBC_USER", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_USER_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_USER"],
    ["ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD", environment.ASKLAKE_SPARK_KUBERNETES_JDBC_PASSWORD_KEY || "ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD"],
  ];
  return mappings.map(([name, key]) => ({
    name,
    valueFrom: { secretKeyRef: { key: String(key), name: secretName } },
  }));
}

function sparkKubernetesPodPlacement() {
  return {
    nodeSelector: {
      "asklake.io/workload-class": "spark",
      "kubernetes.io/arch": "amd64",
    },
    tolerations: [{
      effect: "NoSchedule",
      key: "asklake.io/workload-class",
      operator: "Equal",
      value: "spark",
    }],
  };
}

export function createSparkKubernetesApplication({
  appName,
  environmentVariables = {},
  jars = [],
  jobId,
  packages = [],
  runId,
}, environment = process.env) {
  const namespace = String(environment.ASKLAKE_SPARK_KUBERNETES_NAMESPACE || "asklake-dev").trim();
  const serviceAccount = String(environment.ASKLAKE_SPARK_KUBERNETES_SERVICE_ACCOUNT || "asklake-spark").trim();
  const image = requiredDigestImage(environment);
  const imageDigest = image.slice(image.lastIndexOf("@") + 1);
  const fixtureBatchId = String(environmentVariables.ASKLAKE_KAFKA_FIXTURE_BATCH_ID || "").trim();
  const executorInstances = sparkExecutorInstances(environment);
  const name = sparkKubernetesApplicationName(runId);
  const runLabel = kubernetesIdentifier(runId).slice(0, 63).replace(/-+$/g, "") || "run";
  const jobLabel = kubernetesIdentifier(jobId, "job").slice(0, 63).replace(/-+$/g, "") || "job";
  const driverEnvironment = [
    ...kubernetesEnvironmentVariables(environmentVariables),
    ...sparkRuntimeSecretEnvironment(environment),
  ];
  const executorEnvironmentNames = new Set([
    "ASKLAKE_LOCAL_LLM_ENDPOINT",
    "ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS",
    "ASKLAKE_LOCAL_LLM_MODEL",
    "ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS",
    "ASKLAKE_OBJECT_STORAGE_PROVIDER",
    "ASKLAKE_REVIEW_ANALYSIS_RUNTIME",
    "ASKLAKE_REVIEW_TEXT_MODEL_ROOT",
    "AWS_REGION",
    "S3_ENDPOINT",
    "S3_FORCE_PATH_STYLE",
  ]);
  const executorEnvironment = driverEnvironment.filter((item) => executorEnvironmentNames.has(item.name));
  const jarList = [...new Set(jars.map((item) => String(item || "").trim()).filter(Boolean))];
  const packageList = [...new Set(packages.map((item) => String(item || "").trim()).filter(Boolean))];
  return {
    apiVersion: "sparkoperator.k8s.io/v1beta2",
    kind: "SparkApplication",
    metadata: {
      annotations: {
        "asklake.io/image-digest": imageDigest,
        "asklake.io/job-id": String(jobId),
        "asklake.io/run-id": String(runId),
        "asklake.io/executor-instances": String(executorInstances),
        ...(fixtureBatchId ? { "asklake.io/fixture-batch-id": fixtureBatchId } : {}),
      },
      labels: {
        "app.kubernetes.io/name": "asklake-spark",
        "app.kubernetes.io/part-of": "asklake",
        "asklake.io/job-id": jobLabel,
        "asklake.io/run-id": runLabel,
      },
      name,
      namespace,
    },
    spec: {
      deps: { jars: jarList, packages: packageList },
      driver: {
        coreLimit: String(
          environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_LIMIT
            || environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES
            || "1",
        ),
        coreRequest: String(
          environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORE_REQUEST
            || environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES
            || "1",
        ),
        cores: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_CORES, 1),
        env: driverEnvironment,
        labels: { "asklake.io/run-id": runLabel },
        memory: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_MEMORY || "2g"),
        memoryOverhead: String(environment.ASKLAKE_SPARK_KUBERNETES_DRIVER_MEMORY_OVERHEAD || "512m"),
        serviceAccount,
        ...sparkKubernetesPodPlacement(),
      },
      executor: {
        coreLimit: String(
          environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_LIMIT
            || environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES
            || "2",
        ),
        coreRequest: String(
          environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORE_REQUEST
            || environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES
            || "2",
        ),
        cores: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_CORES, 2),
        env: executorEnvironment,
        instances: executorInstances,
        labels: { "asklake.io/run-id": runLabel },
        memory: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY || "4g"),
        memoryOverhead: String(environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_MEMORY_OVERHEAD || "1g"),
        serviceAccount,
        ...sparkKubernetesPodPlacement(),
      },
      hadoopConf: {
        "fs.s3a.aws.credentials.provider": "software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider",
        "fs.s3a.endpoint.region": String(environment.AWS_REGION || "ap-northeast-2"),
        "fs.s3a.path.style.access": "false",
      },
      image,
      imagePullPolicy: "IfNotPresent",
      mainApplicationFile: String(
        environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE
          || "/opt/asklake/scripts/spark_job_run.py",
      ).startsWith("local:///")
        ? String(environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE)
        : `local://${String(
          environment.ASKLAKE_SPARK_KUBERNETES_MAIN_APPLICATION_FILE
            || "/opt/asklake/scripts/spark_job_run.py",
        )}`,
      mode: "cluster",
      pythonVersion: "3",
      restartPolicy: { type: "Never" },
      sparkConf: {
        "spark.app.name": String(appName || `asklake-${runLabel}`),
        "spark.jars.ivy": "/tmp/.ivy2",
        "spark.kubernetes.executor.deleteOnTermination": "true",
        "spark.sql.shuffle.partitions": String(environment.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32"),
      },
      sparkVersion: String(environment.ASKLAKE_SPARK_VERSION || "4.0.1"),
      timeToLiveSeconds: 3_600,
      type: "Python",
    },
  };
}

export function sparkExecutorInstances(environment = process.env) {
  const raw = environment.ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES;
  if (raw === undefined || raw === null || String(raw).trim() === "") return 1;
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < 1
    || parsed > SPARK_EXECUTOR_INSTANCES_MAX
  ) {
    throw sparkConfigurationError(
      "ASKLAKE_SPARK_KUBERNETES_EXECUTOR_INSTANCES "
      + `must be an integer between 1 and ${SPARK_EXECUTOR_INSTANCES_MAX}.`,
    );
  }
  return parsed;
}

export function runSparkKubernetesApplication(application, timeoutMs, environment = process.env, options = {}) {
  const result = spawnSync(process.execPath, [sparkKubernetesClientScript], {
    cwd: backendDir,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({
      application,
      expectedKubernetesExecution: options.expectedKubernetesExecution,
      pollIntervalMs: positiveInteger(environment.ASKLAKE_SPARK_KUBERNETES_POLL_INTERVAL_MS, 2_000),
      progressFile: options.progressFile,
      timeoutMs: positiveInteger(timeoutMs, 7_200_000),
    }),
    maxBuffer: 32 * 1024 * 1024,
    timeout: positiveInteger(timeoutMs, 7_200_000) + SPARK_REST_BRIDGE_GRACE_MS,
  });
  if (result.status !== 0 || result.error || result.signal) return result;
  const marker = String(result.stdout || "").split(/\r?\n/)
    .findLast((line) => line.startsWith("ASKLAKE_SPARK_KUBERNETES_RESULT="));
  if (!marker) {
    return { ...result, status: 1, stderr: `${result.stderr || ""}\nKubernetes Spark client returned no result marker.` };
  }
  const payload = safeJsonParse(marker.slice("ASKLAKE_SPARK_KUBERNETES_RESULT=".length));
  if (!payload?.report) {
    return { ...result, status: 1, stderr: `${result.stderr || ""}\nKubernetes Spark client returned an invalid result.` };
  }
  return {
    ...result,
    status: 0,
    stdout: `ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify(payload.report)}\n`,
  };
}

export function runSparkRestSubmission(submission, timeoutMs, environment = process.env, options = {}) {
  const runtime = sparkRestRuntimeConfig(environment);
  const effectiveTimeoutMs = positiveInteger(timeoutMs, 90_000);
  const stateFile = requiredSparkRestStateFile(options.stateFile);
  const result = spawnSync(process.execPath, [sparkRestClientScript], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify({
      pollIntervalMs: positiveInteger(environment.ASKLAKE_SPARK_REST_POLL_INTERVAL_MS, 1_000),
      restUrl: runtime.restUrl,
      stateFile,
      submission,
      timeoutMs: effectiveTimeoutMs,
    }),
    maxBuffer: 4 * 1024 * 1024,
    timeout: sparkRestBridgeTimeoutMs(effectiveTimeoutMs),
  });
  if (!result.error && !result.signal) return result;

  const recovery = spawnSync(process.execPath, [sparkRestClientScript], {
    cwd: backendDir,
    encoding: "utf8",
    input: JSON.stringify({ operation: "kill-state", restUrl: runtime.restUrl, stateFile }),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  const recoveryDetail = recovery.status === 0
    ? String(recovery.stdout || "").trim()
    : `Spark REST timeout recovery failed: ${recovery.stderr || recovery.error?.message || "unknown error"}`;
  return {
    ...result,
    stderr: [result.stderr, recoveryDetail].filter(Boolean).join("\n"),
  };
}

export function sparkJobManifest(job) {
  const textStructuringColumns = textStructuringDefinitionColumns(job.transformSteps ?? []);
  return {
    createdAt: new Date().toISOString(),
    icebergTarget: job.icebergTarget ?? null,
    jobId: job.id,
    partitionColumns: job.partitionColumns ?? job.partition ?? "",
    qualityRules: job.qualityRules ?? [],
    ruleContractVersion: job.ruleContractVersion ?? "1.0",
    ruleOutputSchema: job.ruleOutputSchema ?? job.transformOutputColumns ?? [],
    rules: job.rules ?? [],
    recordParsing: job.recordParsing ?? null,
    ruleFingerprint: job.ruleFingerprint ?? null,
    schemaColumns: job.schemaColumns ?? [],
    schemaFingerprint: job.schemaFingerprint ?? null,
    sourceBoundary: job.sourceBoundary ?? null,
    sourceCollection: sourceCollectionFromConfig(
      job.sourceConfig ?? [],
      job.sourceIncrementalSince,
      job.sourceIncrementalBefore,
      job.sourceWindowContractVersion,
      job.sourceWindowRebaseline,
      job.sourceObjectKeys,
      job.sourceObjectInventory,
    ),
    sourceSelection: sourceSelectionFromJob(job),
    textStructuring: {
      columns: textStructuringColumns,
      specVersion: textStructuringColumns.length > 0 ? 1 : undefined,
    },
    transformSteps: job.transformSteps ?? [],
  };
}

function writeSparkJobManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function sourceSelectionFromJob(job) {
  const sourceConfig = Array.isArray(job?.sourceConfig) ? job.sourceConfig : [];
  const kind = String(fieldValue(sourceConfig, "__Selection Kind") || "file").trim().toLowerCase();
  if (kind !== "prefix") return { kind: "file" };
  return {
    expectedFileCount: positiveInteger(fieldValue(sourceConfig, "__Source Unit Count")),
    expectedTotalBytes: nonNegativeInteger(fieldValue(sourceConfig, "__Source Total Bytes")),
    format: String(fieldValue(sourceConfig, "__Dataset Format") || fieldValue(sourceConfig, "File Type") || "").trim().toLowerCase(),
    kind: "prefix",
    prefix: normalizePrefix(fieldValue(sourceConfig, "Path / Prefix")),
    representativeObject: fieldValue(sourceConfig, "__Sample Object") || "",
    schemaFingerprint: fieldValue(sourceConfig, "__Schema Fingerprint") || "",
  };
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function sourceCollectionFromConfig(
  sourceConfig,
  incrementalSince = undefined,
  incrementalBefore = undefined,
  windowContractVersion = undefined,
  sourceWindowRebaseline = false,
  sourceObjectKeys = undefined,
  sourceObjectInventory = undefined,
) {
  const selectionKind = String(fieldValue(sourceConfig, "__Selection Kind") || "file").trim().toLowerCase();
  const configuredScope = String(fieldValue(sourceConfig, "Collection Scope") || "file").trim().toLowerCase();
  const scope = selectionKind === "prefix" || configuredScope === "folder"
    ? "folder"
    : "file";
  const collectionMode = String(fieldValue(sourceConfig, "Collection Mode") || "incremental").trim().toLowerCase();
  const mode = selectionKind === "prefix"
    ? "full"
    : scope === "folder" && collectionMode !== "full" ? "incremental" : "full";
  const requestedWindowVersion = Number(windowContractVersion);
  const boundedWindowVersion = mode === "incremental" && [1, 2].includes(requestedWindowVersion)
    ? requestedWindowVersion
    : null;
  const objectInventory = boundedWindowVersion === 2
    ? normalizeSourceObjectInventory(sourceObjectInventory)
    : null;
  const objectKeys = boundedWindowVersion === 2 && Array.isArray(objectInventory)
    ? objectInventory.map((item) => item.key)
    : mode === "incremental" && Array.isArray(sourceObjectKeys)
    ? [...new Set(sourceObjectKeys.map((key) => String(key || "").trim()).filter(Boolean))].sort()
    : null;
  return {
    ...(selectionKind === "prefix" ? {
      expectedFileCount: positiveInteger(fieldValue(sourceConfig, "__Source Unit Count")),
      expectedTotalBytes: nonNegativeInteger(fieldValue(sourceConfig, "__Source Total Bytes")),
    } : {}),
    filePattern: scope === "folder"
      ? fieldValue(sourceConfig, "File Pattern") || prefixDatasetFilePattern(sourceConfig)
      : null,
    incrementalBefore: mode === "incremental" && incrementalBefore ? String(incrementalBefore) : null,
    incrementalSince: mode === "incremental" && incrementalSince ? String(incrementalSince) : null,
    mode,
    ...(boundedWindowVersion === 2 ? { objectInventory } : {}),
    objectKeys,
    rebaseline: boundedWindowVersion !== null && sourceWindowRebaseline === true,
    recursive: scope === "folder" && (selectionKind === "prefix" || parseConfigBoolean(fieldValue(sourceConfig, "Recursive"))),
    ...(selectionKind === "prefix" ? { selectionKind } : {}),
    scope,
    windowContractVersion: boundedWindowVersion,
  };
}

function normalizeSourceObjectInventory(value) {
  if (!Array.isArray(value)) return null;
  const inventoryByKey = new Map();
  let invalid = false;
  value.forEach((item) => {
    if (!item || typeof item !== "object") {
      invalid = true;
      return;
    }
    const key = String(item.key ?? item.Key ?? "").trim();
    const eTag = normalizeEtag(item.eTag ?? item.ETag ?? item.etag);
    const lastModified = String(item.lastModified ?? item.LastModified ?? "").trim();
    const rawSize = item.size ?? item.Size;
    const size = Number(rawSize);
    const hasValidRawSize = typeof rawSize !== "boolean"
      && rawSize !== null
      && rawSize !== undefined
      && String(rawSize).trim() !== "";
    if (!key || !eTag || !lastModified || !hasValidRawSize || !Number.isSafeInteger(size) || size < 0) {
      invalid = true;
      return;
    }
    const rawVersionId = String(item.versionId ?? item.VersionId ?? "").trim();
    const normalized = {
      key,
      eTag,
      versionId: rawVersionId && rawVersionId.toLowerCase() !== "null" ? rawVersionId : null,
      lastModified,
      size,
    };
    if (inventoryByKey.has(key) && JSON.stringify(inventoryByKey.get(key)) !== JSON.stringify(normalized)) {
      invalid = true;
      return;
    }
    inventoryByKey.set(key, normalized);
  });
  return invalid ? null : [...inventoryByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeEtag(value) {
  let normalized = String(value ?? "").trim();
  if (normalized.startsWith("W/")) normalized = normalized.slice(2).trim();
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

function parseConfigBoolean(value) {
  return ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function prefixDatasetFilePattern(sourceConfig) {
  if (String(fieldValue(sourceConfig, "__Selection Kind") || "file").trim().toLowerCase() !== "prefix") {
    return null;
  }
  const format = canonicalSparkSourceFormat(
    fieldValue(sourceConfig, "__Dataset Format") || fieldValue(sourceConfig, "File Type"),
  );
  return {
    csv: "*.{csv,tsv}",
    json: "*.json",
    jsonl: "*.{jsonl,ndjson}",
    parquet: "*.parquet",
    txt: "*.{txt,log,text}",
  }[format] || null;
}

function textStructuringDefinitionColumns(transformSteps) {
  return (Array.isArray(transformSteps) ? transformSteps : [])
    .map((step) => {
      if (!step || step.kind !== "derive") return null;
      const rawParams = typeof step.params === "string" ? step.params : "";
      const parsed = rawParams ? safeJsonParse(rawParams) : {};
      const columns = Array.isArray(parsed?.columns) ? parsed.columns : [];
      const firstColumn = columns.find((column) => column?.targetName === step.output) || columns[0] || {};
      if (!firstColumn || !parsed?.sourceField) return null;
      return {
        allowedValues: Array.isArray(firstColumn.allowedValues) ? firstColumn.allowedValues : [],
        fallbackAllowed: Boolean(firstColumn.fallbackAllowed),
        method: firstColumn.method || "",
        modelArtifact: firstColumn.modelArtifact || "",
        modelId: firstColumn.modelId || "",
        modelSelectionPolicy: firstColumn.modelSelectionPolicy || "",
        outputColumn: step.output || firstColumn.targetName || "",
        requireModel: Boolean(firstColumn.requireModel),
        sourceField: parsed.sourceField,
        type: firstColumn.type || step.type || "string",
      };
    })
    .filter(Boolean);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function sparkPackages(job, source, output) {
  const packages = [];
  if (String(source?.format || "").trim().toLowerCase() === "kafka") {
    packages.push(
      process.env.ASKLAKE_SPARK_KAFKA_PACKAGE
      || "org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1",
    );
  }
  if (
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE !== "none"
    && (usesS3A(source.path) || usesS3A(output.sparkPath) || job?.icebergTarget)
  ) {
    packages.push(process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1");
  }
  if (job?.icebergTarget) {
    packages.push(
      process.env.ASKLAKE_SPARK_ICEBERG_PACKAGE
        || "org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.11.0",
      process.env.ASKLAKE_SPARK_POSTGRES_PACKAGE
        || "org.postgresql:postgresql:42.7.7",
    );
  }
  return [...new Set(packages.filter((item) => item && item !== "none"))];
}

export function sparkDependencyJars(source, executionMode, environment = process.env) {
  const sourceFormat = String(source?.format || "").trim().toLowerCase();
  const authMode = String(environment.ASKLAKE_KAFKA_AUTH_MODE || "").trim().toLowerCase();
  if (executionMode !== "kubernetes" || sourceFormat !== "kafka" || authMode !== "iam") return [];

  const jar = String(environment.ASKLAKE_SPARK_MSK_IAM_AUTH_JAR || SPARK_MSK_IAM_SHADED_JAR).trim();
  if (!/^local:\/\/\/opt\/asklake\/jars\/[a-zA-Z0-9._-]+\.jar$/.test(jar)) {
    throw sparkConfigurationError(
      "ASKLAKE_SPARK_MSK_IAM_AUTH_JAR must be a local:///opt/asklake/jars/*.jar image path.",
    );
  }
  return [jar];
}

export function sparkKafkaFixtureEnvironment(job, source, runId, executionMode) {
  if (String(source?.format || "").trim().toLowerCase() !== "kafka") return {};
  if (executionMode !== "kubernetes") {
    throw sparkConfigurationError("EKS MVP Kafka fixture execution requires Kubernetes Spark.");
  }
  const boundary = job?.sourceBoundary;
  if (!boundary || typeof boundary !== "object" || Array.isArray(boundary)) {
    throw sparkConfigurationError("EKS MVP Kafka fixture execution requires a persisted sourceBoundary.");
  }
  const broker = String(boundary.broker || "").trim();
  const brokers = broker.split(",").map((item) => item.trim()).filter(Boolean);
  const fixtureBatchId = String(boundary.fixtureBatchId || "").trim();
  const expectedCount = Number(boundary.expectedCount);
  const outputPath = String(boundary.outputPath || "").replace(/\/+$/g, "");
  const checkpointPath = String(boundary.checkpointPath || "").replace(/\/+$/g, "");
  const consumerGroup = String(boundary.consumerGroup || "").trim();
  const slots = eksMvpFixtureSlots(process.env);
  const fixtureSlot = slots.find((slot) => slot.consumerGroup === consumerGroup);
  if (
    boundary.kind !== "kafka_snapshot"
    || String(boundary.snapshotId || "") !== String(runId)
    || String(boundary.topic || "") !== EKS_MVP_FIXTURE_TOPIC
    || !fixtureSlot
    || String(job?.icebergTarget?.table || "") !== fixtureSlot.table
    || !fixtureBatchId
    || !Number.isInteger(expectedCount)
    || expectedCount <= 0
    || !brokers.length
    || brokers.some((item) => !/^[^,\s:]+:9098$/.test(item))
    || !/^s3a:\/\/[^/]+\/eks-mvp\/output\/[^/]+$/.test(outputPath)
    || !/^s3a:\/\/[^/]+\/eks-mvp\/checkpoints\/[^/]+$/.test(checkpointPath)
    || !outputPath.endsWith(`/${runId}`)
    || !checkpointPath.endsWith(`/${runId}`)
  ) {
    throw sparkConfigurationError("Persisted EKS MVP Kafka fixture boundary is invalid.");
  }
  return {
    [EKS_MVP_FIXTURE_SLOTS_ENV]: JSON.stringify(slots),
    ASKLAKE_KAFKA_AUTH_MODE: "iam",
    ASKLAKE_KAFKA_BROKER: brokers.join(","),
    ASKLAKE_KAFKA_CONSUMER_GROUP: consumerGroup,
    ASKLAKE_KAFKA_EXPECTED_COUNT: String(expectedCount),
    ASKLAKE_KAFKA_FIXTURE_BATCH_ID: fixtureBatchId,
    ASKLAKE_KAFKA_TOPIC: EKS_MVP_FIXTURE_TOPIC,
    ASKLAKE_SPARK_CHECKPOINT_PATH: checkpointPath,
  };
}

export function sparkIcebergEnvironment(job, executionMode = sparkExecutionMode()) {
  if (!job?.icebergTarget) return {};
  const database = String(process.env.TRINO_ICEBERG_JDBC_DATABASE || process.env.POSTGRES_DB || "asklake");
  const warehouseBucket = String(process.env.TRINO_ICEBERG_WAREHOUSE_BUCKET || "").trim();
  const warehousePrefix = normalizePrefix(process.env.TRINO_ICEBERG_WAREHOUSE_PREFIX || "warehouse");
  const warehouse = String(
    process.env.ASKLAKE_SPARK_ICEBERG_WAREHOUSE
      || (warehouseBucket ? `s3a://${warehouseBucket}/${warehousePrefix}` : ""),
  ).replace(/\/+$/, "");
  const jdbcUrl = String(
    process.env.ASKLAKE_SPARK_ICEBERG_JDBC_URL
      || `jdbc:postgresql://postgres:5432/${database}`,
  ).trim();
  const jdbcUser = String(process.env.TRINO_ICEBERG_JDBC_USER || "").trim();
  const jdbcPassword = String(process.env.TRINO_ICEBERG_JDBC_PASSWORD || "");
  if (!warehouse) {
    throw sparkConfigurationError(
      "Iceberg Spark execution requires TRINO_ICEBERG_WAREHOUSE_BUCKET or ASKLAKE_SPARK_ICEBERG_WAREHOUSE.",
    );
  }
  const environment = {
    ASKLAKE_SPARK_ICEBERG_CATALOG_NAME: String(
      process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME
        || process.env.TRINO_ICEBERG_CATALOG_NAME
        || "asklake",
    ),
    ASKLAKE_SPARK_ICEBERG_WAREHOUSE: warehouse,
  };
  if (executionMode === "kubernetes") return environment;
  if (!jdbcUrl || !jdbcUser || !jdbcPassword) {
    throw sparkConfigurationError(
      "Iceberg Spark execution requires TRINO_ICEBERG_JDBC_USER and TRINO_ICEBERG_JDBC_PASSWORD.",
    );
  }
  return {
    ...environment,
    ASKLAKE_SPARK_ICEBERG_JDBC_PASSWORD: jdbcPassword,
    ASKLAKE_SPARK_ICEBERG_JDBC_URL: jdbcUrl,
    ASKLAKE_SPARK_ICEBERG_JDBC_USER: jdbcUser,
  };
}

function sparkPackageArgs(packages) {
  return packages.length > 0 ? ["--packages", packages.join(",")] : [];
}

function usesS3A(value) {
  return /^s3a?:\/\//i.test(String(value || ""));
}

function runSparkSubmitContainer(dockerArgs) {
  return spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function shouldRetryDockerWait(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return result.status !== 0 && /error waiting for container: unexpected EOF/i.test(text);
}

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "start-spark-server.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ASKLAKE_SPARK_REPORT_CONTAINER_DIR: reportContainerDir,
      ASKLAKE_SPARK_REPORT_DIR: reportDir,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
  }
}

export function sparkSourceFromJob(job, runId) {
  const sourceType = job.sourceType || "";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  if (job?.sourceBoundary?.kind === "kafka_snapshot" && job.sourceBoundary.fixtureBatchId) {
    return {
      format: "kafka",
      path: String(job.sourceBoundary.topic || EKS_MVP_FIXTURE_TOPIC),
    };
  }
  if (sourceType === "File / S3") {
    const bucket = normalizeBucketName(fieldValue(sourceConfig, "Bucket / Stage Name") || defaultRawBucket());
    const selectionKind = String(fieldValue(sourceConfig, "__Selection Kind") || "file").trim().toLowerCase();
    let prefix = normalizeBucketRelativePath(
      normalizeSourcePath(fieldValue(sourceConfig, "Path / Prefix")),
      bucket,
    );
    if (selectionKind === "prefix") prefix = normalizePrefix(prefix);
    if (/^s3a?:\/\//i.test(prefix)) {
      return {
        format: inferFormat(sourceConfig, prefix, "csv"),
        path: toS3APath(prefix),
        selectionKind,
      };
    }
    return {
      format: inferFormat(sourceConfig, prefix, "csv"),
      path: prefix ? `s3a://${bucket}/${prefix}` : `s3a://${bucket}/`,
      selectionKind,
    };
  }
  if (sourceType === "Data Lake") {
    if (job.sourceIcebergTable) {
      return {
        format: "iceberg",
        path: sparkIcebergSourceIdentifier(job.sourceIcebergTable),
      };
    }
    return {
      format: "parquet",
      path: toS3APath(fieldValue(sourceConfig, "Path") || "s3://m3-raw/nyc_taxi/yellow_parquet/"),
    };
  }

  if (isPostgresSource(sourceType)) {
    const exportPath = exportPostgresExecutionSource(job, runId);
    return {
      format: "jsonl",
      path: `file://${reportContainerDir}/${path.basename(exportPath)}`,
      temporaryPath: exportPath,
    };
  }

  const samplePath = hasInlineSampleEndpoint(job)
    ? writeSampleRowsSource(job, runId) || writeConnectorSampleRowsSource(job, runId)
    : isConnectorSampleSource(sourceType)
      ? writeConnectorSampleRowsSource(job, runId) || writeSampleRowsSource(job, runId)
      : writeSampleRowsSource(job, runId) || writeConnectorSampleRowsSource(job, runId);
  if (samplePath) {
    return {
      format: "jsonl",
      path: `file://${reportContainerDir}/${path.basename(samplePath)}`,
      ...(job.cleanupSource ? { temporaryPath: samplePath } : {}),
    };
  }

  throw sparkError(`Spark execution requires File / S3, Data Lake, or a connector sample with schema rows. Unsupported sourceType=${sourceType}`);
}

function sparkIcebergSourceIdentifier(source) {
  const catalog = String(
    process.env.ASKLAKE_SPARK_ICEBERG_CATALOG_NAME
      || process.env.TRINO_ICEBERG_CATALOG_NAME
      || "asklake",
  ).trim();
  const namespace = String(source?.namespace || source?.schema || "").trim();
  const table = String(source?.table || "").trim();
  const identifiers = [catalog, namespace, table];
  if (identifiers.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
    throw sparkError("Data Lake Iceberg source contains an invalid catalog identifier.");
  }
  return identifiers.join(".");
}

function isConnectorSampleSource(sourceType) {
  return ["mongodb", "postgresql", "database", "rest api", "stream / kafka", "kafka json"].includes(
    String(sourceType || "").trim().toLowerCase(),
  );
}

function isPostgresSource(sourceType) {
  return ["postgresql", "database"].includes(String(sourceType || "").trim().toLowerCase());
}

function exportPostgresExecutionSource(job, runId) {
  const outputPath = path.join(reportDir, `${runId}-source.jsonl`);
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "export-postgres-execution-source.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      outputPath,
      runId,
      sourceConfig: Array.isArray(job.sourceConfig) ? job.sourceConfig : [],
    }),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`PostgreSQL full-table execution export failed.\n${result.stdout}\n${result.stderr}`);
  }
  const marker = String(result.stdout || "").split(/\r?\n/)
    .findLast((line) => line.startsWith("ASKLAKE_POSTGRES_EXECUTION_SOURCE="));
  if (!marker) throw sparkError("PostgreSQL full-table execution export returned no result marker.");
  const exported = safeJsonParse(marker.slice("ASKLAKE_POSTGRES_EXECUTION_SOURCE=".length));
  if (exported.runId !== runId || Number(exported.rowCount) <= 0 || path.resolve(exported.outputPath || "") !== outputPath) {
    throw sparkError(`PostgreSQL full-table execution export identity mismatch for runId=${runId}.`);
  }
  return outputPath;
}

function cleanupSparkSource(source) {
  const temporaryPath = String(source?.temporaryPath || "").trim();
  if (!temporaryPath) return;
  const resolved = path.resolve(temporaryPath);
  if (path.dirname(resolved) !== reportDir) {
    console.error(`Refusing to remove Spark source outside report directory: ${resolved}`);
    return;
  }
  try {
    rmSync(resolved, { force: true });
  } catch (error) {
    console.error(`Spark temporary source cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasInlineSampleEndpoint(job) {
  const sourceConfig = Array.isArray(job?.sourceConfig) ? job.sourceConfig : [];
  const endpoint = fieldValue(sourceConfig, "Endpoint URL") || fieldValue(sourceConfig, "Endpoint");
  return /^sample:\/\//i.test(endpoint);
}

function writeSampleRowsSource(job, runId) {
  const rows = Array.isArray(job.schemaSampleRows) ? job.schemaSampleRows : [];
  const columns = Array.isArray(job.schemaColumns) ? job.schemaColumns : [];
  if (rows.length === 0 || columns.length === 0) return "";
  return writeRowsSource(runId, columns, rows);
}

function writeConnectorSampleRowsSource(job, runId) {
  const sourceType = job.sourceType || "";
  if (!isConnectorSampleSource(sourceType)) return "";

  const result = spawnSync(process.execPath, [path.join(scriptsDir, "export-connector-sample.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      sourceConfig: Array.isArray(job.sourceConfig) ? job.sourceConfig : [],
      sourceType,
    }),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`Connector sample export failed for ${sourceType}.\n${result.stdout}\n${result.stderr}`);
  }

  const marker = String(result.stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_CONNECTOR_SAMPLE="));
  if (!marker) return "";
  const sample = JSON.parse(marker.slice("ASKLAKE_CONNECTOR_SAMPLE=".length));
  const rows = Array.isArray(sample.rows) ? sample.rows : [];
  const columns = Array.isArray(sample.columns) ? sample.columns : [];
  if (rows.length === 0 || columns.length === 0) return "";
  return writeRowsSource(runId, columns, rows);
}

function writeRowsSource(runId, columns, rows) {
  const outputColumns = columns.map((column, index) => ({
    index,
    sourceName: String(column?.sourceName || ""),
    targetName: String(column?.targetName || column?.sourceName || `column_${index + 1}`),
  }));
  const filePath = path.join(reportDir, `${runId}-source.jsonl`);
  const content = rows.map((row, rowIndex) => {
    const item = { row_id: String(rowIndex + 1) };
    outputColumns.forEach((column) => {
      const value = sourceRowValue(row, column);
      setSourceField(item, column.targetName, value);
      setSourceField(item, normalizeColumnName(column.targetName), value);
      setSourceField(item, column.sourceName, value);
      setSourceField(item, normalizeColumnName(column.sourceName), value);
    });
    return JSON.stringify(item);
  }).join("\n");
  writeFileSync(filePath, `${content}\n`, "utf8");
  return filePath;
}

function sourceRowValue(row, column) {
  if (Array.isArray(row)) return row[column.index] ?? "";
  if (!row || typeof row !== "object") return "";
  const names = [
    column.sourceName,
    column.targetName,
    normalizeColumnName(column.sourceName),
    normalizeColumnName(column.targetName),
  ].filter(Boolean);
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name] ?? "";
  }
  return "";
}

function setSourceField(item, name, value) {
  const key = String(name || "").trim();
  if (!key || Object.prototype.hasOwnProperty.call(item, key)) return;
  item[key] = value;
}

function sparkOutputPath(job, runId) {
  if (job?.sourceBoundary?.kind === "kafka_snapshot" && job.sourceBoundary.fixtureBatchId) {
    const sparkPath = String(job.sourceBoundary.outputPath || "").replace(/\/+$/g, "");
    if (!sparkPath || String(job.sourceBoundary.snapshotId || "") !== String(runId)) {
      throw sparkConfigurationError("Persisted EKS MVP Kafka fixture output boundary is invalid.");
    }
    return { displayPath: sparkPath, sparkPath };
  }
  const layer = normalizeColumnName(job.targetLayer || "gold") || "gold";
  const dataset = normalizeColumnName(job.target || job.name || "asklake_dataset");
  const prefix = normalizePrefix(process.env.ASKLAKE_SPARK_OUTPUT_PREFIX || "asklake-output");
  if ((process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local").toLowerCase() === "s3a") {
    // storagePath is the configured destination root. targetPath is the latest
    // observed Run output and must not become the next Run's parent directory.
    const configuredTarget = normalizeSparkOutputTargetPath(job.storagePath);
    const targetBase = /^s3a?:\/\//i.test(configuredTarget)
      ? toS3APath(configuredTarget).replace(/\/+$/, "")
      : `s3a://${process.env.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output"}/${prefix}${layer}/${dataset}`;
    const sparkPath = targetBase.endsWith(`/${runId}`) ? targetBase : `${targetBase}/${runId}`;
    return { displayPath: sparkPath, sparkPath };
  }

  const relativePath = path.join(layer, dataset, runId);
  return {
    hostPath: path.join(localOutputDir, relativePath),
    relativePath: relativePath.replace(/\\/g, "/"),
    displayPath: path.join(localOutputDir, relativePath),
    sparkPath: `file://${outputContainerDir}/${relativePath.replace(/\\/g, "/")}`,
  };
}

export function normalizeSparkOutputTargetPath(value) {
  const configuredTarget = String(value || "").trim();
  if (!/^s3a?:\/\//i.test(configuredTarget)) return configuredTarget;
  const normalizedTarget = toS3APath(configuredTarget).replace(/\/+$/, "");
  const configuredBucket = normalizeBucketName(process.env.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output");
  if (!configuredBucket || configuredBucket.toLowerCase() === "asklake-output") return normalizedTarget;
  return normalizedTarget.replace(
    /^s3a:\/\/asklake-output(?=\/|$)/i,
    `s3a://${configuredBucket}`,
  );
}

function sparkRowLimitFromJob(job) {
  if (job?.sourceBoundary?.kind === "kafka_snapshot" && job.sourceBoundary.fixtureBatchId) return "0";
  if (isPostgresSource(job.sourceType)) return "0";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  const configuredLimit = fieldValue(sourceConfig, "__Execution Row Limit") || fieldValue(sourceConfig, "Execution Row Limit");
  if (configuredLimit && Number(configuredLimit) > 0) return configuredLimit;
  const scope = fieldValue(sourceConfig, "__Schema Sample Scope");
  if (scope === "slice1gb") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "10000";
  if (scope === "full") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "0";
  return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "0";
}

function inferFormat(sourceConfig, prefix, fallback) {
  const sampleObject = fieldValue(sourceConfig, "__Sample Object");
  const configuredFormat = canonicalSparkSourceFormat(fieldValue(sourceConfig, "__Dataset Format"))
    || canonicalSparkSourceFormat(fieldValue(sourceConfig, "File Type"));
  if (configuredFormat) return configuredFormat;
  const probe = `${sampleObject} ${prefix}`.toLowerCase();
  if (probe.includes(".jsonl") || probe.includes("jsonl") || probe.includes("ndjson")) return "jsonl";
  if (probe.includes(".json") || probe.includes("json")) return "json";
  if (probe.includes(".parquet") || probe.includes("parquet")) return "parquet";
  if (probe.includes(".txt") || probe.includes(".log") || probe.includes(".text") || probe.includes("txt") || probe.includes("log")) return "txt";
  if (probe.includes(".tsv") || probe.includes("tsv")) return "csv";
  if (probe.includes(".csv") || probe.includes("csv")) return "csv";
  return fallback;
}

function canonicalSparkSourceFormat(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized || ["auto", "autodetect", "automatic"].includes(normalized)) return "";
  if (normalized.includes("jsonl") || normalized.includes("ndjson") || normalized.includes("jsonlines")) return "jsonl";
  if (normalized === "json" || normalized.endsWith("json")) return "json";
  if (normalized.includes("parquet")) return "parquet";
  if (normalized.includes("tsv") || normalized.includes("tabseparated")) return "csv";
  if (normalized.includes("csv") || normalized.includes("commaseparated")) return "csv";
  if (normalized.includes("txt") || normalized.includes("text") || normalized.includes("log")) return "txt";
  return "";
}

function toS3APath(value) {
  return String(value).replace(/^s3:\/\//, "s3a://");
}

function normalizePrefix(value) {
  const cleaned = String(value ?? "").replace(/^\/+/, "");
  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function normalizeSourcePath(value) {
  return String(value ?? "").replace(/^\/+/, "");
}

function normalizeBucketName(value) {
  return String(value ?? "")
    .replace(/^s3a?:\/\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeBucketRelativePath(value, bucket) {
  const normalized = String(value ?? "").replace(/^\/+/, "");
  if (!normalized || /^s3a?:\/\//i.test(normalized)) return normalized;
  const normalizedBucket = normalizeBucketName(bucket);
  if (!normalizedBucket) return normalized;
  if (normalized === normalizedBucket) return "";
  const bucketPrefix = `${normalizedBucket}/`;
  return normalized.startsWith(bucketPrefix) ? normalized.slice(bucketPrefix.length) : normalized;
}

function readSparkReport(reportPath, stdout) {
  if (existsSync(reportPath)) {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  }
  const marker = String(stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_SPARK_JOB_RESULT="));
  if (marker) return JSON.parse(marker.slice("ASKLAKE_SPARK_JOB_RESULT=".length));
  return { status: "failed" };
}

function normalizeSparkReport(report, output) {
  if (!report || typeof report !== "object") return report;
  return {
    ...report,
    outputPath: normalizeSparkOutputDisplayPath(report.outputPath, output),
    sparkOutputPath: output.sparkPath,
    quality: normalizeSparkReportQuality(report.quality, output),
  };
}

function copySparkOutputToHost(output) {
  if (!output.relativePath || !output.hostPath) return;
  copySparkVolumeRelativePathToHost(output.relativePath, output.hostPath, "Spark output");
}

function copySparkReportArtifactsToHost(report) {
  const quarantinePath = report?.quality?.quarantine?.path;
  const quarantineArtifact = localOutputArtifactFromSparkPath(quarantinePath);
  if (quarantineArtifact) {
    copySparkVolumeRelativePathToHost(
      quarantineArtifact.relativePath,
      quarantineArtifact.hostPath,
      "Spark quarantine output",
    );
  }
}

function normalizeSparkReportQuality(quality, output) {
  if (!quality || typeof quality !== "object") return quality;
  const quarantine = quality.quarantine && typeof quality.quarantine === "object"
    ? {
      ...quality.quarantine,
      path: normalizeSparkOutputDisplayPath(quality.quarantine.path, output),
    }
    : quality.quarantine;
  return {
    ...quality,
    quarantine,
  };
}

function normalizeSparkOutputDisplayPath(value, output) {
  if (value === output.sparkPath) return output.displayPath;
  const artifact = localOutputArtifactFromSparkPath(value);
  return artifact?.hostPath ?? value;
}

function localOutputArtifactFromSparkPath(value) {
  const text = String(value || "");
  const prefix = `file://${outputContainerDir.replace(/\/+$/g, "")}/`;
  if (!text.startsWith(prefix)) return null;
  const relativePath = text.slice(prefix.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("\0")) return null;
  const hostPath = path.resolve(localOutputDir, ...relativePath.split("/").filter(Boolean));
  assertWithinLocalOutput(hostPath);
  return {
    hostPath,
    relativePath,
  };
}

function copySparkVolumeRelativePathToHost(relativePath, hostPath, label) {
  assertWithinLocalOutput(hostPath);
  ensureWritableDir(path.dirname(hostPath));
  const hostParent = path.dirname(hostPath);
  const leaf = path.basename(hostPath);
  const tmpLeaf = `${leaf}.tmp`;
  const script = [
    `test -d /from/${shellQuote(relativePath)}`,
    `rm -rf /to/${shellQuote(tmpLeaf)}`,
    `cp -r /from/${shellQuote(relativePath)} /to/${shellQuote(tmpLeaf)}`,
    `rm -rf /to/${shellQuote(leaf)}`,
    `mv /to/${shellQuote(tmpLeaf)} /to/${shellQuote(leaf)}`,
  ].join(" && ");
  const result = spawnSync("docker", [
    "run",
    "--rm",
    "-v",
    `${outputVolumeName}:/from:ro`,
    "-v",
    `${hostParent}:/to`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/bin/sh",
    "-c",
    script,
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`${label} was written but could not be copied to host.\n${result.stdout}\n${result.stderr}`);
  }
}

function assertWithinLocalOutput(hostPath) {
  const resolved = path.resolve(hostPath);
  const relative = path.relative(localOutputDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sparkError(`Refusing to copy Spark artifact outside local output directory: ${resolved}`);
  }
}

function ensureWritableDir(dir, allowWorldWritable = true) {
  mkdirSync(dir, { recursive: true });
  if (allowWorldWritable) chmodSync(dir, 0o777);
}

export function sparkRunTimeoutMs(environment = process.env) {
  const timeoutSeconds = boundedInteger(
    environment.ASKLAKE_SPARK_RUN_TIMEOUT_SECONDS,
    7200,
    1,
    24 * 60 * 60,
  );
  return timeoutSeconds * 1000;
}

export function sparkRestBridgeTimeoutMs(pollTimeoutMs) {
  return boundedInteger(pollTimeoutMs, 90_000, 1_000, 24 * 60 * 60 * 1000)
    + SPARK_REST_BRIDGE_GRACE_MS;
}

function sparkRestStateFileForRun(runId, configured) {
  const candidate = configured
    || path.join(reportDir, `${safeArtifactSegment(runId)}.spark-rest-state.json`);
  const resolved = requiredSparkRestStateFile(candidate);
  const relative = path.relative(reportDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sparkConfigurationError("Spark REST state file must be below ASKLAKE_SPARK_REPORT_DIR.");
  }
  return resolved;
}

function sparkKubernetesProgressFileForRun(runId, configured) {
  const candidate = configured
    || path.join(reportDir, `${safeArtifactSegment(runId)}.spark-kubernetes-state.json`);
  const resolved = requiredSparkRestStateFile(candidate);
  const relative = path.relative(reportDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sparkConfigurationError("Spark Kubernetes progress file must be below ASKLAKE_SPARK_REPORT_DIR.");
  }
  return resolved;
}

function requiredSparkRestStateFile(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw sparkConfigurationError("Spark REST state file must be an absolute path.");
  }
  return path.resolve(raw);
}

function safeArtifactSegment(value) {
  return String(value || "run")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "run";
}

export function assertSparkRestStorageCredentials(sourceConfig = [], executionMode = "rest") {
  if (executionMode !== "rest" || !isMinioProvider(sourceConfig)) return;

  const sourceStorage = resolveObjectStorageConfig(sourceConfig, { docker: true });
  const inheritedStorage = resolveObjectStorageConfig([], { docker: true });
  if (
    sourceStorage.accessKeyId !== inheritedStorage.accessKeyId
    || sourceStorage.secretAccessKey !== inheritedStorage.secretAccessKey
  ) {
    throw sparkConfigurationError(
      "Spark REST execution only supports the MinIO application credentials inherited by the worker.",
    );
  }
}

function configuredSparkRestUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw sparkConfigurationError("ASKLAKE_SPARK_REST_URL must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw sparkConfigurationError("ASKLAKE_SPARK_REST_URL must use HTTP(S) without embedded credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw sparkConfigurationError("ASKLAKE_SPARK_REST_URL must contain only the Spark REST origin.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function configuredSparkRuntimePath(value, name) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
  if (!path.posix.isAbsolute(normalized) || normalized === "/") {
    throw sparkConfigurationError(`${name} must be an absolute Spark runtime path.`);
  }
  return normalized.replace(/\/$/, "");
}

function configuredSparkScript(value, scriptDir, name) {
  const scriptPath = configuredSparkRuntimePath(value, name);
  const relative = path.posix.relative(scriptDir, scriptPath);
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw sparkConfigurationError(`${name} must be a file below ASKLAKE_SPARK_SCRIPT_DIR.`);
  }
  return scriptPath;
}

function stringValues(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .filter(([, item]) => item !== undefined && item !== null)
      .map(([key, item]) => [key, String(item)]),
  );
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function tail(value) {
  const text = String(value || "");
  return text.length > 4000 ? text.slice(-4000) : text;
}

function sparkError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUN_FAILED";
  error.status = 500;
  return error;
}

function sparkConfigurationError(message) {
  const error = sparkError(message);
  error.code = "SPARK_RUNNER_CONFIGURATION_INVALID";
  return error;
}
