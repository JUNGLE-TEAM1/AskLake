import { spawnSync } from "node:child_process";
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
import {
  createSparkRuntime,
  resolveSparkRuntime,
  SPARK_RUNTIME_IDS,
  SPARK_RUNTIME_OPERATIONS,
} from "./sparkRuntime.mjs";
import {
  assertProductionDataPlanePath,
  canonicalObjectStorageUri,
  createStorageLayout,
} from "./storageLayout.mjs";
import {
  createEmrServerlessBatchSubmission,
  emrServerlessArtifactUris,
  emrServerlessConfig,
} from "./emrServerless.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const emrServerlessClientScript = path.join(scriptsDir, "emr-serverless-client.mjs");
const sparkRestClientScript = path.join(scriptsDir, "spark-rest-client.mjs");
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
export const SPARK_REST_BRIDGE_GRACE_MS = 30_000;

export function runSparkPipeline(job, command, runId, options = {}) {
  const runtime = sparkBatchRuntime();
  if (runtime.id === SPARK_RUNTIME_IDS.DOCKER) ensureSparkServer();
  const allowWorldWritable = runtime.id === SPARK_RUNTIME_IDS.DOCKER;
  ensureWritableDir(reportDir, allowWorldWritable);
  if (runtime.id !== SPARK_RUNTIME_IDS.EMR_SERVERLESS) {
    ensureWritableDir(ivyDir, allowWorldWritable);
    ensureWritableDir(localOutputDir, allowWorldWritable);
    ensureWritableDir(sampleHostDir, allowWorldWritable);
    ensureWritableDir(reviewTextModelHostDir, allowWorldWritable);
  }

  const source = sparkSourceFromJob(job, runId);
  try {
    if (runtime.id === SPARK_RUNTIME_IDS.EMR_SERVERLESS && !/^s3a?:\/\//i.test(source.path)) {
      throw sparkConfigurationError(
        "EMR Serverless Batch Phase 3 requires an S3 source path; local exports and inline fixtures are not supported.",
      );
    }
    return runSparkPipelineWithSource(job, command, runId, source, runtime, options);
  } finally {
    cleanupSparkSource(source);
  }
}

function sparkBatchRuntime(environment = process.env) {
  return createSparkRuntime(environment, {
    [SPARK_RUNTIME_IDS.DOCKER]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: runSparkBatchDocker,
    },
    [SPARK_RUNTIME_IDS.SPARK_REST]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: (payload) => runSparkBatchRest(payload, environment),
    },
    [SPARK_RUNTIME_IDS.EMR_SERVERLESS]: {
      [SPARK_RUNTIME_OPERATIONS.BATCH]: (payload) => runSparkBatchEmrServerless(payload, environment),
    },
  });
}

function runSparkBatchDocker({ dockerArgs }) {
  return runSparkSubmitContainer(dockerArgs);
}

function runSparkBatchRest({ options, packages, runId, sparkEnvironment, sparkExecutorProperties }, environment) {
  return runSparkRestSubmission(
    createSparkRestSubmission({
      appName: sparkEnvironment.ASKLAKE_SPARK_APP_NAME,
      environmentVariables: sparkEnvironment,
      packages,
      scriptPath: sparkRestRuntimeConfig(environment).jobScript,
      sparkProperties: sparkExecutorProperties,
    }, environment),
    positiveInteger(options.sparkRuntimeTimeoutMs || options.sparkRestTimeoutMs, sparkRunTimeoutMs(environment)),
    environment,
    {
      stateFile: sparkRestStateFileForRun(
        runId,
        options.sparkRuntimeStateFile || options.sparkRestStateFile,
      ),
    },
  );
}

function runSparkBatchEmrServerless({
  jobId,
  manifestPath,
  options,
  packages,
  runId,
  sparkEnvironment,
}, environment) {
  const artifacts = emrServerlessArtifactUris(runId, environment);
  const submission = createEmrServerlessBatchSubmission({
    appName: sparkEnvironment.ASKLAKE_SPARK_APP_NAME,
    jobId,
    manifestUri: artifacts.manifestUri,
    packages,
    reportUri: artifacts.reportUri,
    runId,
    sparkEnvironment,
  }, environment);
  return runEmrServerlessSubmission({
    artifacts,
    manifestPath,
    stateFile: runtimeStateFileForRun(
      runId,
      options.sparkRuntimeStateFile || options.sparkRestStateFile,
      SPARK_RUNTIME_IDS.EMR_SERVERLESS,
    ),
    submission,
    timeoutMs: positiveInteger(options.sparkRuntimeTimeoutMs || options.sparkRestTimeoutMs, sparkRunTimeoutMs(environment)),
  }, environment);
}

function runSparkPipelineWithSource(job, command, runId, source, runtime, options = {}) {
  const executionMode = runtime.legacyRunner;
  const output = sparkOutputPath(job, runId);
  const reportPath = path.join(reportDir, `${runId}.json`);
  const dockerReportPath = `${reportContainerDir}/${runId}.json`;
  const manifestPath = path.join(reportDir, `${runId}.manifest.json`);
  const dockerManifestPath = `${reportContainerDir}/${runId}.manifest.json`;
  const emrArtifacts = runtime.id === SPARK_RUNTIME_IDS.EMR_SERVERLESS
    ? emrServerlessArtifactUris(runId)
    : null;
  const packages = sparkPackages(source, output);
  const packageArgs = sparkPackageArgs(packages);
  const localLlmEndpoint = process.env.ASKLAKE_LOCAL_LLM_ENDPOINT_IN_DOCKER
    || process.env.ASKLAKE_LOCAL_LLM_ENDPOINT
    || "http://host.docker.internal:1234/v1/chat/completions";
  const localLlmModel = process.env.ASKLAKE_LOCAL_LLM_MODEL || "local-review-analyzer";
  const localLlmTimeoutSeconds = process.env.ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS
    || String(Math.ceil(Number(process.env.ASKLAKE_LOCAL_LLM_TIMEOUT_MS || 120000) / 1000));
  const reviewAnalysisRuntime = process.env.ASKLAKE_REVIEW_ANALYSIS_RUNTIME || "scalable";
  assertSparkRestStorageCredentials(job.sourceConfig ?? [], executionMode);
  writeSparkJobManifest(manifestPath, job);
  const storageEnvironment = Object.fromEntries(
    objectStorageDockerEnv(job.sourceConfig ?? []).filter(([name]) => (
      executionMode === "docker"
      || !["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(name)
    )),
  );
  const sparkEnvironment = {
    ...storageEnvironment,
    ASKLAKE_SPARK_SOURCE_PATH: source.path,
    ASKLAKE_SPARK_SOURCE_FORMAT: source.format,
    ASKLAKE_SPARK_OUTPUT_PATH: output.sparkPath,
    ASKLAKE_SPARK_RUN_ROW_LIMIT: sparkRowLimitFromJob(job),
    ASKLAKE_SPARK_RUN_ID: runId,
    ASKLAKE_SPARK_JOB_MANIFEST_FILE: emrArtifacts ? "asklake-job-manifest.json" : dockerManifestPath,
    ASKLAKE_SPARK_TEXT_STRUCTURING_DEFINITION_FILE: emrArtifacts ? "asklake-job-manifest.json" : dockerManifestPath,
    ASKLAKE_SPARK_REPORT_FILE: emrArtifacts ? emrArtifacts.reportUri.replace(/^s3:\/\//, "s3a://") : dockerReportPath,
    ASKLAKE_SPARK_APP_NAME: `asklake-${command}-${job.id}`,
    ASKLAKE_LOCAL_LLM_ENDPOINT: localLlmEndpoint,
    ASKLAKE_LOCAL_LLM_MODEL: localLlmModel,
    ASKLAKE_LOCAL_LLM_TIMEOUT_SECONDS: localLlmTimeoutSeconds,
    ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS: process.env.ASKLAKE_LOCAL_LLM_MAX_INPUT_CHARS || "9000",
    ASKLAKE_REVIEW_ANALYSIS_RUNTIME: reviewAnalysisRuntime,
    ASKLAKE_REVIEW_TEXT_MODEL_ROOT: reviewTextModelContainerDir,
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

  const runtimePayload = {
    dockerArgs,
    jobId: job.id,
    manifestPath,
    options,
    packages,
    runId,
    sparkEnvironment,
    sparkExecutorProperties,
  };
  let result = runtime.execute(SPARK_RUNTIME_OPERATIONS.BATCH, runtimePayload);
  let report = readSparkReport(reportPath, result.stdout);
  if (executionMode === "docker" && report.status !== "success" && shouldRetryDockerWait(result)) {
    rmSync(reportPath, { force: true });
    result = runtime.execute(SPARK_RUNTIME_OPERATIONS.BATCH, runtimePayload);
    report = readSparkReport(reportPath, result.stdout);
  }
  if (executionMode === "docker" && report.status === "success") {
    copySparkOutputToHost(output);
    copySparkReportArtifactsToHost(report);
  }
  report = normalizeSparkReport(report, output);
  if (report.status !== "success") {
    const spawnError = result.error?.message || "";
    return {
      ...report,
      error: report.error || result.stderr || result.stdout || spawnError || "Spark job failed.",
      ...(result.runtimeError?.code ? {
        errorCode: result.runtimeError.code,
        errorStatus: result.runtimeError.status,
      } : {}),
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
  return resolveSparkRuntime(environment).legacyRunner;
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

export function runEmrServerlessSubmission({
  artifacts,
  manifestPath,
  stateFile,
  submission,
  timeoutMs,
}, environment = process.env) {
  const config = emrServerlessConfig(environment);
  const effectiveTimeoutMs = positiveInteger(timeoutMs, sparkRunTimeoutMs(environment));
  const result = spawnSync(process.execPath, [emrServerlessClientScript], {
    cwd: backendDir,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({
      manifestFile: manifestPath,
      manifestUri: artifacts.manifestUri,
      pollIntervalMs: config.pollIntervalMs,
      reportUri: artifacts.reportUri,
      stateFile,
      submission,
      timeoutMs: effectiveTimeoutMs,
    }),
    maxBuffer: 4 * 1024 * 1024,
    timeout: sparkRestBridgeTimeoutMs(effectiveTimeoutMs),
  });
  const runtimeError = markerPayload(result.stdout, "ASKLAKE_EMR_SERVERLESS_ERROR");
  if (!result.error && !result.signal) return { ...result, runtimeError };

  const recovery = spawnSync(process.execPath, [emrServerlessClientScript], {
    cwd: backendDir,
    encoding: "utf8",
    env: environment,
    input: JSON.stringify({ operation: "cancel-state", stateFile }),
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  const recoveryDetail = recovery.status === 0
    ? String(recovery.stdout || "").trim()
    : "EMR Serverless timeout recovery failed.";
  return {
    ...result,
    runtimeError: runtimeError || markerPayload(recovery.stdout, "ASKLAKE_EMR_SERVERLESS_ERROR"),
    stderr: [result.stderr, recoveryDetail].filter(Boolean).join("\n"),
  };
}

function writeSparkJobManifest(manifestPath, job) {
  const textStructuringColumns = textStructuringDefinitionColumns(job.transformSteps ?? []);
  const manifest = {
    createdAt: new Date().toISOString(),
    partitionColumns: job.partition || "",
    qualityRules: job.qualityRules ?? [],
    ruleContractVersion: job.ruleContractVersion ?? "1.0",
    ruleOutputSchema: job.ruleOutputSchema ?? job.transformOutputColumns ?? [],
    rules: job.rules ?? [],
    recordParsing: job.recordParsing ?? null,
    schemaColumns: job.schemaColumns ?? [],
    sourceCollection: sourceCollectionFromConfig(
      job.sourceConfig ?? [],
      job.sourceIncrementalSince,
      job.sourceIncrementalBefore,
      job.sourceWindowContractVersion,
      job.sourceWindowRebaseline,
      job.sourceObjectKeys,
      job.sourceObjectInventory,
    ),
    textStructuring: {
      columns: textStructuringColumns,
      specVersion: textStructuringColumns.length > 0 ? 1 : undefined,
    },
    transformSteps: job.transformSteps ?? [],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
  const scope = String(fieldValue(sourceConfig, "Collection Scope") || "file").trim().toLowerCase() === "folder"
    ? "folder"
    : "file";
  const collectionMode = String(fieldValue(sourceConfig, "Collection Mode") || "incremental").trim().toLowerCase();
  const mode = scope === "folder" && collectionMode !== "full" ? "incremental" : "full";
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
    filePattern: scope === "folder" ? fieldValue(sourceConfig, "File Pattern") || null : null,
    incrementalBefore: mode === "incremental" && incrementalBefore ? String(incrementalBefore) : null,
    incrementalSince: mode === "incremental" && incrementalSince ? String(incrementalSince) : null,
    mode,
    ...(boundedWindowVersion === 2 ? { objectInventory } : {}),
    objectKeys,
    rebaseline: boundedWindowVersion !== null && sourceWindowRebaseline === true,
    recursive: scope === "folder" && parseConfigBoolean(fieldValue(sourceConfig, "Recursive")),
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

function sparkPackages(source, output) {
  if (process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE === "none") return [];
  if (!usesS3A(source.path) && !usesS3A(output.sparkPath)) return [];
  return [process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1"];
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

function sparkSourceFromJob(job, runId) {
  const sourceType = job.sourceType || "";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  if (sourceType === "File / S3") {
    const bucket = normalizeBucketName(fieldValue(sourceConfig, "Bucket / Stage Name") || defaultRawBucket());
    const prefix = normalizeBucketRelativePath(
      normalizeSourcePath(fieldValue(sourceConfig, "Path / Prefix")),
      bucket,
    );
    if (/^s3a?:\/\//i.test(prefix)) {
      return {
        format: inferFormat(sourceConfig, prefix, "csv"),
        path: toS3APath(prefix),
      };
    }
    return {
      format: inferFormat(sourceConfig, prefix, "csv"),
      path: prefix ? `s3a://${bucket}/${prefix}` : `s3a://${bucket}/`,
    };
  }
  if (sourceType === "Data Lake") {
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
    };
  }

  throw sparkError(`Spark execution requires File / S3, Data Lake, or a connector sample with schema rows. Unsupported sourceType=${sourceType}`);
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
  const layer = normalizeColumnName(job.targetLayer || "gold") || "gold";
  const dataset = normalizeColumnName(job.target || job.name || "asklake_dataset");
  if ((process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local").toLowerCase() === "s3a") {
    // storagePath is the configured destination root. targetPath is the latest
    // observed Run output and must not become the next Run's parent directory.
    const layout = createStorageLayout({
      datasetId: job.datasetId || dataset,
      explicitRoot: job.storagePath,
      jobId: job.id,
      layer,
      runId,
    });
    const sparkPath = assertProductionDataPlanePath(layout.batchDataPath);
    return { displayPath: sparkPath, sparkPath, storageLayout: layout };
  }

  const relativePath = path.join(layer, dataset, runId);
  const sparkPath = `file://${outputContainerDir}/${relativePath.replace(/\\/g, "/")}`;
  assertProductionDataPlanePath(sparkPath);
  return {
    hostPath: path.join(localOutputDir, relativePath),
    relativePath: relativePath.replace(/\\/g, "/"),
    displayPath: path.join(localOutputDir, relativePath),
    sparkPath,
  };
}

export function normalizeSparkOutputTargetPath(value) {
  const configuredTarget = String(value || "").trim();
  if (!/^s3a?:\/\//i.test(configuredTarget)) return configuredTarget;
  return canonicalObjectStorageUri(configuredTarget);
}

function sparkRowLimitFromJob(job) {
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
  const fileType = String(fieldValue(sourceConfig, "File Type") || "").toLowerCase();
  const probe = `${sampleObject} ${prefix} ${fileType}`.toLowerCase();
  if (probe.includes(".jsonl") || probe.includes("jsonl") || probe.includes("ndjson")) return "jsonl";
  if (probe.includes(".json") || probe.includes("json")) return "json";
  if (probe.includes(".parquet") || probe.includes("parquet")) return "parquet";
  if (probe.includes(".txt") || probe.includes(".log") || probe.includes(".text") || probe.includes("txt") || probe.includes("log")) return "txt";
  if (probe.includes(".tsv") || probe.includes("tsv")) return "csv";
  if (probe.includes(".csv") || probe.includes("csv")) return "csv";
  return fallback;
}

function toS3APath(value) {
  return String(value).replace(/^s3:\/\//, "s3a://");
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

function markerPayload(stdout, markerName) {
  const prefix = `${markerName}=`;
  const line = String(stdout || "").split(/\r?\n/).findLast((item) => item.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length));
  } catch {
    return null;
  }
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
  return runtimeStateFileForRun(runId, configured, SPARK_RUNTIME_IDS.SPARK_REST);
}

function runtimeStateFileForRun(runId, configured, runtimeId) {
  const candidate = configured
    || path.join(reportDir, `${safeArtifactSegment(runId)}.${safeArtifactSegment(runtimeId)}-state.json`);
  const resolved = requiredRuntimeStateFile(candidate);
  const relative = path.relative(reportDir, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sparkConfigurationError("Spark runtime state file must be below ASKLAKE_SPARK_REPORT_DIR.");
  }
  return resolved;
}

function requiredSparkRestStateFile(value) {
  return requiredRuntimeStateFile(value, "Spark REST state file");
}

function requiredRuntimeStateFile(value, label = "Spark runtime state file") {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw sparkConfigurationError(`${label} must be an absolute path.`);
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
