import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  isMinioProvider,
  objectStorageDockerEnv,
  resolveObjectStorageConfig,
  s3ClientOptions,
} from "../src/objectStorageConfig.mjs";
import {
  createSparkRestSubmission,
  sparkIcebergEnvironment,
  sparkPackages,
  sparkExecutionMode,
  sparkRestRuntimeConfig,
} from "../src/sparkRunner.mjs";
import {
  createSparkRestDriver,
  getSparkRestDriverStatus,
  isTerminalSparkDriverState,
  killSparkRestDriver,
  normalizeSparkDriverState,
  safeSparkRestMessage,
} from "./spark-rest-client.mjs";
import {
  createKubernetesClient,
  kubernetesRuntimeConfig,
  sparkApplicationName,
  sparkApplicationState,
} from "./spark-kubernetes-client.mjs";
import { buildContinuousSparkApplication } from "./kafka-continuous-kubernetes.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const masterUrl = process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077";
if (isEntrypoint()) {
  try {
    const result = await manage(readPayload());
    console.log(`ASKLAKE_KAFKA_CONTINUOUS_RESULT=${JSON.stringify(result)}`);
  } catch (error) {
    console.log(`ASKLAKE_KAFKA_CONTINUOUS_ERROR=${JSON.stringify({
      code: "KAFKA_CONTINUOUS_WORKER_FAILED",
      message: error?.message || String(error),
      status: 502,
    })}`);
    process.exitCode = 1;
  }
}

async function manage(request) {
  const jobId = required(request.jobId, "jobId");
  const action = required(request.action, "action");
  const containerName = workerName(jobId);
  const mode = continuousExecutionMode();
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(ivyDir, { recursive: true });

  if (action === "ack") {
    return mode === "kubernetes"
      ? acknowledgeCatalogKubernetes(jobId, request.batchId, containerName)
      : acknowledgeCatalog(jobId, request.batchId, containerName, mode);
  }

  if (mode === "kubernetes") {
    if (action === "start") return startWorkerKubernetes(request, containerName);
    if (action === "pause" || action === "stop") return stopWorkerKubernetes(jobId, action, containerName);
    if (action === "terminate") return terminateWorkerKubernetes(jobId, containerName);
    if (action === "status") return workerStatusKubernetes(jobId, containerName);
    if (action === "logs") return workerLogsKubernetes(jobId, containerName, positiveInt(request.tail, 200));
  } else if (mode === "rest") {
    if (action === "start") return startWorkerRest(request, containerName);
    if (action === "pause" || action === "stop") return stopWorkerRest(jobId, action, containerName);
    if (action === "terminate") return terminateWorkerRest(jobId, containerName);
    if (action === "status") return workerStatusRest(jobId, containerName);
    if (action === "logs") return workerLogsRest(jobId, containerName, positiveInt(request.tail, 200));
  } else {
    if (action === "start") return startWorkerDocker(request, containerName);
    if (action === "pause" || action === "stop") return stopWorkerDocker(jobId, action, containerName);
    if (action === "terminate") return terminateWorkerDocker(jobId, containerName);
    if (action === "status") return workerStatusDocker(jobId, containerName);
    if (action === "logs") return workerLogsDocker(jobId, containerName, positiveInt(request.tail, 200));
  }
  throw new Error(`Unsupported continuous worker action: ${action}`);
}

function continuousExecutionMode() {
  const explicit = String(process.env.ASKLAKE_CONTINUOUS_SPARK_RUNNER || "").trim().toLowerCase();
  if (explicit === "kubernetes") return "kubernetes";
  const mode = sparkExecutionMode(process.env);
  if (mode === "docker" && !String(process.env.ASKLAKE_SPARK_RUNNER || "").trim()) {
    throw new Error("Development Docker continuous execution requires ASKLAKE_SPARK_RUNNER=docker.");
  }
  return mode;
}

async function startWorkerKubernetes(request, containerName) {
  const jobId = required(request.jobId, "jobId");
  const runtime = kubernetesRuntimeConfig();
  const client = createKubernetesClient(runtime);
  const applicationName = sparkApplicationName(jobId);
  const existing = await client.get(applicationName);
  if (existing && !["exited", "failed"].includes(sparkApplicationState(existing))) {
    return kubernetesWorkerResult(jobId, containerName, existing, { started: false });
  }
  if (existing) {
    await client.delete(applicationName);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await sleep(200);
      if (!await client.get(applicationName)) break;
      if (attempt === 24) {
        throw new Error(`SparkApplication ${applicationName} is still terminating; retry start shortly.`);
      }
    }
  }

  await ensureOutputBucket(required(request.outputPath, "outputPath"));
  await clearKubernetesCommand(jobId);
  // The API/control-plane has already committed this fence before asking the
  // runner to submit.  Preserve it so a stale REST status cannot leave a
  // durable start intent permanently stuck in `starting`.
  const requestedWorkerAttemptId = String(request.workerAttemptId || "").trim() || null;
  const workerAttemptId = requestedWorkerAttemptId || randomUUID();
  const application = continuousSparkApplication(request, runtime, workerAttemptId);
  const created = await client.create(application);
  return kubernetesWorkerResult(jobId, containerName, created, { started: true, workerAttemptId });
}

async function stopWorkerKubernetes(jobId, action, containerName) {
  const runtime = kubernetesRuntimeConfig();
  const client = createKubernetesClient(runtime);
  const application = await client.get(sparkApplicationName(jobId));
  await writeKubernetesCommand(
    jobId,
    action,
    application?.metadata?.labels?.["asklake.worker-attempt-id"] || null,
  );
  return kubernetesWorkerResult(jobId, containerName, application, {
    containerState: `${action}Requested`,
    requestedAction: action,
  });
}

async function terminateWorkerKubernetes(jobId, containerName) {
  const runtime = kubernetesRuntimeConfig();
  const client = createKubernetesClient(runtime);
  const applicationName = sparkApplicationName(jobId);
  const application = await client.get(applicationName);
  if (!application) return kubernetesWorkerResult(jobId, containerName, null, { containerState: "not_running" });
  await client.delete(applicationName);
  return kubernetesWorkerResult(jobId, containerName, application, { containerState: "terminateRequested" });
}

async function workerStatusKubernetes(jobId, containerName) {
  const client = createKubernetesClient(kubernetesRuntimeConfig());
  return kubernetesWorkerResult(jobId, containerName, await client.get(sparkApplicationName(jobId)));
}

async function workerLogsKubernetes(jobId, containerName, tail) {
  const status = await workerStatusKubernetes(jobId, containerName);
  const application = status.application || {};
  const state = application?.status?.applicationState || {};
  const lines = [
    `SparkApplication ${application?.metadata?.name || sparkApplicationName(jobId)} state=${state.state || "unknown"}`,
    state.errorMessage ? String(state.errorMessage) : "",
  ].filter(Boolean);
  return {
    ...status,
    lines: lines.slice(-Math.min(Math.max(tail, 1), 1000)),
    truncated: false,
  };
}

function kubernetesWorkerResult(jobId, containerName, application, overrides = {}) {
  const status = sparkApplicationState(application);
  const labels = application?.metadata?.labels || {};
  return {
    application,
    containerId: application?.metadata?.uid || null,
    containerName,
    containerState: application ? status : "missing",
    driverState: status.toUpperCase(),
    exitCode: status === "failed" ? 1 : status === "exited" ? 0 : null,
    jobId,
    report: null,
    workerAttemptId: labels["asklake.worker-attempt-id"] || null,
    ...overrides,
  };
}

export function continuousSparkApplication(request, runtime, workerAttemptId, environment = process.env) {
  const jobId = required(request.jobId, "jobId");
  const runtimeEnvironment = continuousEnvironment(
    request,
    workerAttemptId,
    requiredRuntimeDocumentPrefix(environment),
    false,
    environment,
  );
  const packages = continuousSparkPackages(
    request.outputPath,
    requiredObject(request.icebergTarget, "icebergTarget"),
  );
  return buildContinuousSparkApplication({
    jobId,
    runtime,
    workerAttemptId,
    runtimeEnvironment,
    packages,
    environment,
  });
}

function requiredRuntimeDocumentPrefix(environment = process.env) {
  const prefix = String(environment.ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX || "").trim().replace(/\/$/, "");
  if (!/^s3a?:\/\/[^/]+\/.+/i.test(prefix)) {
    throw new Error("Kubernetes Continuous execution requires ASKLAKE_CONTINUOUS_RUNTIME_DOCUMENT_PREFIX=s3a://<bucket>/<prefix>.");
  }
  return prefix;
}

function runtimeDocumentLocation(jobId, kind) {
  const prefix = requiredRuntimeDocumentPrefix();
  const name = `kafka-continuous-${safeSegment(jobId)}${kind === "command" ? ".command" : ""}.json`;
  const matched = /^s3a?:\/\/([^/]+)\/(.+)$/i.exec(`${prefix}/${name}`);
  return { bucket: matched[1], key: matched[2] };
}

async function writeKubernetesCommand(jobId, action, workerAttemptId) {
  const location = runtimeDocumentLocation(jobId, "command");
  const client = new S3Client(s3ClientOptions(resolveObjectStorageConfig()));
  await client.send(new PutObjectCommand({
    Bucket: location.bucket,
    Key: location.key,
    Body: JSON.stringify({ action, requestedAt: new Date().toISOString(), workerAttemptId }),
    ContentType: "application/json",
  }));
}

async function clearKubernetesCommand(jobId) {
  const location = runtimeDocumentLocation(jobId, "command");
  const client = new S3Client(s3ClientOptions(resolveObjectStorageConfig()));
  await client.send(new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }));
}

async function acknowledgeCatalogKubernetes(jobId, batchId, containerName) {
  const parsed = Number.parseInt(batchId, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("batchId must be a non-negative integer");
  const prefix = requiredRuntimeDocumentPrefix();
  const matched = /^s3a?:\/\/([^/]+)\/(.+)$/i.exec(`${prefix}/kafka-continuous-${safeSegment(jobId)}.catalog-ack.json`);
  const location = { bucket: matched[1], key: matched[2] };
  const s3 = new S3Client(s3ClientOptions(resolveObjectStorageConfig()));
  let current = -1;
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: location.bucket, Key: location.key }));
    const text = await response.Body?.transformToString();
    current = Number.parseInt(JSON.parse(text || "{}").batchId, 10);
  } catch (error) {
    if (!isMissingS3Object(error)) throw error;
  }
  const acknowledged = Math.max(Number.isFinite(current) ? current : -1, parsed);
  await s3.send(new PutObjectCommand({
    Bucket: location.bucket,
    Key: location.key,
    Body: JSON.stringify({ batchId: acknowledged, updatedAt: new Date().toISOString() }),
    ContentType: "application/json",
  }));
  const status = await workerStatusKubernetes(jobId, containerName);
  return { acknowledgedBatchId: acknowledged, ...status };
}

async function startWorkerRest(request, containerName) {
  const jobId = required(request.jobId, "jobId");
  const continuousSqlContract = continuousSqlWorkerContract(request);
  const previous = readWorkerState(jobId);
  if (previous) {
    const existing = await refreshWorkerState(jobId, previous);
    if (!isRestartableRestWorkerState(existing)) {
      requireMatchingContinuousSqlWorker(existing, continuousSqlContract);
      return restWorkerResult(jobId, containerName, existing, { started: false });
    }
  }

  await ensureOutputBucket(required(request.outputPath, "outputPath"));
  clearCommand(jobId);
  if (existsSync(reportFile(jobId))) unlinkSync(reportFile(jobId));

  const workerAttemptId = String(request.workerAttemptId || "").trim() || randomUUID();
  const runtime = continuousRestRuntime();
  const submission = createSparkRestSubmission({
    appName: `${continuousSqlContract ? "asklake-continuous-sql" : "asklake-kafka-continuous"}-${safeSegment(jobId)}`,
    environmentVariables: continuousEnvironment(request, workerAttemptId, runtime.reportRuntimeDir, false),
    packages: continuousSparkPackages(request.outputPath, requiredObject(request.icebergTarget, "icebergTarget")),
    scriptPath: runtime.scriptPath,
    sparkProperties: {
      "spark.sql.streaming.stopGracefullyOnShutdown": "true",
    },
  }, {
    ...process.env,
    ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS: String(continuousSparkShufflePartitions()),
  });
  const created = await createSparkRestDriver(runtime.restUrl, submission);
  const now = new Date().toISOString();
  let state = appendStateEvent({
    createdAt: now,
    driverState: "SUBMITTED",
    events: [],
    jobId,
    restUrl: runtime.restUrl,
    runner: "rest",
    submissionId: created.submissionId,
    updatedAt: now,
    version: 1,
    workerAttemptId,
    continuousSqlPlanHash: continuousSqlContract?.planHash || null,
    continuousSqlRunGeneration: continuousSqlContract?.runGeneration || null,
  }, "submitted", `Spark submission ${created.submissionId} was accepted.`);
  try {
    state = replaceWorkerState(jobId, state, previous?.workerAttemptId || null);
  } catch (error) {
    try {
      await killSparkRestDriver(runtime.restUrl, created.submissionId);
    } catch {
      // Preserve the state write error; duplicate-driver cleanup is best effort.
    }
    throw error;
  }
  return restWorkerResult(jobId, containerName, state, { started: true });
}

function isRestartableRestWorkerState(state) {
  const driverState = normalizeSparkDriverState(state.driverState);
  if (isTerminalSparkDriverState(driverState)) return true;
  return driverState === "UNKNOWN" && isTerminalSparkDriverState(state.lastKnownDriverState);
}

async function stopWorkerRest(jobId, action, containerName) {
  writeCommand(jobId, action);
  const existing = readWorkerState(jobId);
  if (!existing) {
    return restWorkerResult(jobId, containerName, null, { containerState: "not_running" });
  }
  const state = await refreshWorkerState(jobId, existing);
  if (isTerminalSparkDriverState(state.driverState)) {
    return restWorkerResult(jobId, containerName, state, { containerState: "not_running" });
  }
  const runtime = continuousRestRuntime();
  await killSparkRestDriver(runtime.restUrl, state.submissionId);
  const requested = appendStateEvent({
    ...state,
    killRequestedAt: new Date().toISOString(),
    requestedAction: action,
  }, "kill_requested", `${action} requested through Spark REST kill.`);
  const persisted = persistWorkerState(jobId, requested);
  return restWorkerResult(jobId, containerName, persisted, { containerState: `${action}Requested` });
}

async function terminateWorkerRest(jobId, containerName) {
  const existing = readWorkerState(jobId);
  if (!existing) {
    return restWorkerResult(jobId, containerName, null, { containerState: "not_running" });
  }
  const state = await refreshWorkerState(jobId, existing);
  if (isTerminalSparkDriverState(state.driverState)) {
    return restWorkerResult(jobId, containerName, state, { containerState: "not_running" });
  }
  const runtime = continuousRestRuntime();
  await killSparkRestDriver(runtime.restUrl, state.submissionId);
  const requested = appendStateEvent({
    ...state,
    killRequestedAt: new Date().toISOString(),
  }, "kill_requested", "terminate requested through Spark REST kill.");
  const persisted = persistWorkerState(jobId, requested);
  return restWorkerResult(jobId, containerName, persisted, { containerState: "terminateRequested" });
}

async function workerStatusRest(jobId, containerName) {
  const existing = readWorkerState(jobId);
  if (!existing) return restWorkerResult(jobId, containerName, null);
  const state = await refreshWorkerState(jobId, existing);
  return restWorkerResult(jobId, containerName, state);
}

async function workerLogsRest(jobId, containerName, tail) {
  const status = await workerStatusRest(jobId, containerName);
  const state = readWorkerState(jobId);
  const report = readReport(jobId);
  const lines = (state?.events || []).map((event) => {
    const stateSuffix = event.driverState ? ` state=${event.driverState}` : "";
    return `${event.at} ${event.message}${stateSuffix}`;
  });
  if (state?.lastStatusError) lines.push(`${state.updatedAt} Spark REST status error: ${state.lastStatusError}`);
  if (report) {
    lines.push(`${report.heartbeatAt || state?.updatedAt || new Date().toISOString()} worker report status=${report.status || "unknown"}`);
    if (report.lastError) lines.push(String(report.lastError));
  }
  const limit = Math.min(Math.max(tail, 1), 1000);
  const safeLines = lines.map(redactLogLine);
  return {
    containerId: status.containerId,
    containerName,
    containerState: status.containerState,
    lines: safeLines.slice(-limit),
    truncated: safeLines.length > limit,
    workerAttemptId: status.workerAttemptId,
  };
}

async function refreshWorkerState(jobId, state) {
  const runtime = continuousRestRuntime();
  const previousState = normalizeSparkDriverState(state.driverState);
  let status;
  try {
    status = await getSparkRestDriverStatus(runtime.restUrl, state.submissionId);
  } catch (error) {
    const message = safeSparkRestMessage(error?.message || error);
    let next = {
      ...state,
      driverState: "UNKNOWN",
      lastKnownDriverState: previousState === "UNKNOWN" ? state.lastKnownDriverState : previousState,
      lastStatusError: message,
      updatedAt: new Date().toISOString(),
    };
    if (previousState !== "UNKNOWN" || state.lastStatusError !== message) {
      next = appendStateEvent(next, "status_retry", "Spark REST status is temporarily unavailable; polling will retry.", "UNKNOWN");
    }
    return persistWorkerState(jobId, next);
  }
  let next = {
    ...state,
    driverState: status.driverState,
    lastKnownDriverState: status.driverState === "UNKNOWN"
      ? state.lastKnownDriverState || previousState
      : status.driverState,
    lastStatusError: null,
    restMessage: status.message ? safeSparkRestMessage(status.message) : null,
    updatedAt: new Date().toISOString(),
  };
  if (status.driverState !== previousState) {
    next = appendStateEvent(
      next,
      "state_changed",
      `Spark submission ${state.submissionId} changed from ${previousState} to ${status.driverState}.`,
      status.driverState,
    );
  }
  return persistWorkerState(jobId, next);
}

function restWorkerResult(jobId, containerName, state, overrides = {}) {
  const driverState = state ? normalizeSparkDriverState(state.driverState) : null;
  const command = readCommand(jobId);
  return {
    containerId: state?.submissionId || null,
    containerName,
    containerState: state ? containerStateFromSpark(driverState) : "missing",
    driverState,
    exitCode: sparkExitCode(driverState),
    jobId,
    report: readReport(jobId),
    requestedAction: command?.action || null,
    workerAttemptId: state?.workerAttemptId || null,
    ...overrides,
  };
}

function containerStateFromSpark(state) {
  if (state === "SUBMITTED" || state === "WAITING") return "starting";
  if (state === "RUNNING" || state === "RELAUNCHING") return "running";
  if (state === "UNKNOWN") return "unknown";
  if (isTerminalSparkDriverState(state)) return "exited";
  return "unknown";
}

function sparkExitCode(state) {
  if (state === "FINISHED") return 0;
  if (state === "KILLED") return 143;
  if (state === "FAILED" || state === "ERROR") return 1;
  return null;
}

function continuousRestRuntime() {
  const runtime = sparkRestRuntimeConfig(process.env);
  const scriptPath = runtimeScriptPath(
    process.env.ASKLAKE_SPARK_CONTINUOUS_SCRIPT || `${runtime.scriptDir}/kafka_continuous_stream.py`,
    runtime.scriptDir,
    "ASKLAKE_SPARK_CONTINUOUS_SCRIPT",
  );
  const reportRuntimeDir = absoluteRuntimePath(
    process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports",
    "ASKLAKE_SPARK_REPORT_CONTAINER_DIR",
  );
  return { ...runtime, reportRuntimeDir, scriptPath };
}

function continuousEnvironment(request, workerAttemptId, runtimeReportDir, includeCredentials = true, environment = process.env) {
  const jobId = required(request.jobId, "jobId");
  const icebergTarget = requiredObject(request.icebergTarget, "icebergTarget");
  const storageEnvironment = Object.fromEntries(
    objectStorageDockerEnv().filter(([name]) => (
      includeCredentials
      || !["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(name)
    )),
  );
  return {
    ASKLAKE_CONTINUOUS_JOB_ID: jobId,
    ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID: workerAttemptId,
    ASKLAKE_CONTINUOUS_BROKER: resolveContinuousWorkerBroker(required(request.broker, "broker"), environment),
    ASKLAKE_CONTINUOUS_TOPIC: required(request.topic, "topic"),
    ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID: required(request.consumerGroupId, "consumerGroupId"),
    ASKLAKE_CONTINUOUS_OUTPUT_PATH: required(request.outputPath, "outputPath"),
    ASKLAKE_CONTINUOUS_CHECKPOINT_PATH: required(request.checkpointPath, "checkpointPath"),
    ASKLAKE_CONTINUOUS_OFFSET_POLICY: request.initialOffsetPolicy || "earliest",
    ASKLAKE_CONTINUOUS_TRIGGER_SECONDS: positiveInt(request.triggerIntervalSeconds, 10),
    ASKLAKE_CONTINUOUS_MAX_OFFSETS: positiveInt(request.maxOffsetsPerTrigger, 100),
    ASKLAKE_CONTINUOUS_INITIAL_COUNTS: JSON.stringify(request.initialCounts || {}),
    ASKLAKE_CONTINUOUS_INITIAL_METRICS: JSON.stringify(request.initialMetrics || {}),
    ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE: JSON.stringify(request.initialSchemaState || {}),
    ASKLAKE_CONTINUOUS_STREAM_PARTITION_CURSORS: JSON.stringify(request.streamPartitionCursors || []),
    ASKLAKE_CONTINUOUS_SQL_PLAN: JSON.stringify(request.continuousSqlPlan || {}),
    ASKLAKE_CONTINUOUS_ICEBERG_TARGET: JSON.stringify(icebergTarget),
    ASKLAKE_CONTINUOUS_EXPECTED_SCHEMA_FINGERPRINT: String(request.schemaFingerprint || ""),
    ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION: request.ruleContractVersion || "1.0",
    ASKLAKE_CONTINUOUS_RULE_FINGERPRINT: required(request.ruleFingerprint, "ruleFingerprint"),
    ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA: JSON.stringify(request.ruleOutputSchema || []),
    ASKLAKE_CONTINUOUS_RULES: JSON.stringify(request.rules || []),
    ASKLAKE_CONTINUOUS_RECORD_PARSING: JSON.stringify(request.recordParsing || {}),
    ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS: JSON.stringify(request.schemaColumns || []),
    ASKLAKE_CONTINUOUS_SCHEMA_POLICY: JSON.stringify(request.schemaEvolutionPolicy || {}),
    ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS: String(continuousSparkShufflePartitions()),
    ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL: environment.ASKLAKE_CONTINUOUS_SPARK_LOG_LEVEL || "WARN",
    ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE: environment.ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE || "false",
    ASKLAKE_CONTINUOUS_REPORT_FILE: runtimeDocumentPath(runtimeReportDir, reportFileName(jobId)),
    ASKLAKE_CONTINUOUS_COMMAND_FILE: runtimeDocumentPath(runtimeReportDir, commandFileName(jobId)),
    ...sparkIcebergEnvironment({ icebergTarget }),
    ...storageEnvironment,
    HOME: "/tmp",
  };
}

function runtimeDocumentPath(base, filename) {
  const normalized = String(base || "").replace(/\/$/, "");
  if (/^s3a?:\/\//i.test(normalized)) return `${normalized}/${filename}`;
  return path.posix.join(normalized, filename);
}

function readWorkerState(jobId) {
  const file = stateFile(jobId);
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Continuous Spark state is unreadable for ${jobId}: ${error?.message || error}`);
  }
  if (
    !value
    || value.runner !== "rest"
    || String(value.jobId || "") !== String(jobId)
    || !String(value.submissionId || "").trim()
    || !String(value.workerAttemptId || "").trim()
  ) {
    throw new Error(`Continuous Spark state is invalid for ${jobId}.`);
  }
  return value;
}

function persistWorkerState(jobId, next) {
  const current = readWorkerState(jobId);
  if (current && current.workerAttemptId !== next.workerAttemptId) return current;
  writeJsonAtomic(stateFile(jobId), next);
  return next;
}

function replaceWorkerState(jobId, next, expectedPreviousAttemptId) {
  const current = readWorkerState(jobId);
  if ((current?.workerAttemptId || null) !== expectedPreviousAttemptId) {
    throw new Error(`Continuous Spark state changed concurrently for ${jobId}; refusing a duplicate submission.`);
  }
  writeJsonAtomic(stateFile(jobId), next);
  return next;
}

function appendStateEvent(state, type, message, driverState = state.driverState) {
  const at = new Date().toISOString();
  return {
    ...state,
    events: [
      ...(Array.isArray(state.events) ? state.events : []),
      { at, driverState: normalizeSparkDriverState(driverState), message, type },
    ].slice(-1000),
    updatedAt: at,
  };
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function startWorkerDocker(request, containerName) {
  const jobId = required(request.jobId, "jobId");
  const continuousSqlContract = continuousSqlWorkerContract(request);
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) {
    requireMatchingContinuousSqlWorker({
      continuousSqlPlanHash: existing.Config?.Labels?.["asklake.continuous-sql-plan-hash"] || null,
      continuousSqlRunGeneration: existing.Config?.Labels?.["asklake.continuous-sql-generation"] || null,
    }, continuousSqlContract);
    return {
      containerId: existing.Id,
      containerName,
      containerState: "running",
      jobId,
      report: readReport(jobId),
      started: false,
      workerAttemptId: existing.Config?.Labels?.["asklake.worker-attempt-id"] || null,
    };
  }
  if (existing) runDocker(["rm", "-f", containerName], true);

  ensureSparkServer();
  await ensureOutputBucket(required(request.outputPath, "outputPath"));
  clearCommand(jobId);
  if (existsSync(reportFile(jobId))) unlinkSync(reportFile(jobId));
  const workerAttemptId = String(request.workerAttemptId || "").trim() || randomUUID();
  const icebergTarget = requiredObject(request.icebergTarget, "icebergTarget");
  const packages = continuousSparkPackages(request.outputPath, icebergTarget).join(",");
  const environment = continuousEnvironment(request, workerAttemptId, reportContainerDir);
  const packageArgs = packages ? ["--packages", packages] : [];
  const args = [
    "run", "-d", "--name", containerName, "--network", network,
    "--add-host", "host.docker.internal:host-gateway",
    "--label", "asklake.role=kafka-continuous-worker",
    "--label", `asklake.job-id=${jobId}`,
    "--label", `asklake.worker-attempt-id=${workerAttemptId}`,
    ...(continuousSqlContract ? [
      "--label", `asklake.continuous-sql-plan-hash=${continuousSqlContract.planHash}`,
      "--label", `asklake.continuous-sql-generation=${continuousSqlContract.runGeneration}`,
    ] : []),
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    "-v", `${reportDir}:${reportContainerDir}`,
    ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e", `ASKLAKE_CONTINUOUS_JOB_ID=${jobId}`,
    "-e", `ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID=${workerAttemptId}`,
    "-e", `ASKLAKE_CONTINUOUS_BROKER=${resolveContinuousWorkerBroker(required(request.broker, "broker"))}`,
    "-e", `ASKLAKE_CONTINUOUS_TOPIC=${required(request.topic, "topic")}`,
    "-e", `ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID=${required(request.consumerGroupId, "consumerGroupId")}`,
    "-e", `ASKLAKE_CONTINUOUS_OUTPUT_PATH=${required(request.outputPath, "outputPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_CHECKPOINT_PATH=${required(request.checkpointPath, "checkpointPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_OFFSET_POLICY=${request.initialOffsetPolicy || "earliest"}`,
    "-e", `ASKLAKE_CONTINUOUS_TRIGGER_SECONDS=${positiveInt(request.triggerIntervalSeconds, 10)}`,
    "-e", `ASKLAKE_CONTINUOUS_MAX_OFFSETS=${positiveInt(request.maxOffsetsPerTrigger, 100)}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_COUNTS=${JSON.stringify(request.initialCounts || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_METRICS=${JSON.stringify(request.initialMetrics || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE=${JSON.stringify(request.initialSchemaState || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION=${request.ruleContractVersion || "1.0"}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_FINGERPRINT=${required(request.ruleFingerprint, "ruleFingerprint")}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA=${JSON.stringify(request.ruleOutputSchema || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_RULES=${JSON.stringify(request.rules || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_RECORD_PARSING=${JSON.stringify(request.recordParsing || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS=${JSON.stringify(request.schemaColumns || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_SCHEMA_POLICY=${JSON.stringify(request.schemaEvolutionPolicy || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE=${process.env.ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE || "false"}`,
    "-e", `ASKLAKE_CONTINUOUS_REPORT_FILE=${reportContainerDir}/${reportFileName(jobId)}`,
    "-e", `ASKLAKE_CONTINUOUS_COMMAND_FILE=${reportContainerDir}/${commandFileName(jobId)}`,
    "-e", "HOME=/tmp",
    image,
    "/opt/spark/bin/spark-submit", "--master", masterUrl,
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    "--conf", "spark.sql.streaming.stopGracefullyOnShutdown=true",
    "--conf", `spark.sql.shuffle.partitions=${continuousSparkShufflePartitions()}`,
    ...packageArgs,
    "/work/scripts/kafka_continuous_stream.py",
  ];
  const containerId = runDocker(args).trim();
  return {
    containerId,
    containerName,
    containerState: "starting",
    jobId,
    report: readReport(jobId),
    started: true,
    workerAttemptId,
  };
}

async function ensureOutputBucket(outputPath) {
  const bucket = /^s3a?:\/\/([^/]+)/i.exec(outputPath)?.[1];
  if (!bucket) return;
  // This preflight runs in the Node control-plane process. Spark receives the
  // Docker endpoint separately through continuousEnvironment().
  const client = new S3Client(s3ClientOptions(resolveObjectStorageConfig()));
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isMinioProvider()) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

function stopWorkerDocker(jobId, action, containerName) {
  writeCommand(jobId, action);
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) runDocker(["kill", "--signal=SIGTERM", containerName], true);
  return {
    containerName,
    containerState: existing?.State?.Running ? `${action}Requested` : "not_running",
    jobId,
    report: readReport(jobId),
  };
}

function workerStatusDocker(jobId, containerName) {
  const existing = inspectContainer(containerName);
  const command = readCommand(jobId);
  return {
    containerName,
    containerId: existing?.Id || null,
    containerState: existing?.State?.Running ? "running" : existing ? "exited" : "missing",
    exitCode: existing?.State?.ExitCode ?? null,
    jobId,
    report: readReport(jobId),
    requestedAction: command?.action || null,
    workerAttemptId: existing?.Config?.Labels?.["asklake.worker-attempt-id"] || null,
  };
}

function terminateWorkerDocker(jobId, containerName) {
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) runDocker(["kill", "--signal=SIGTERM", containerName], true);
  return {
    containerId: existing?.Id || null,
    containerName,
    containerState: existing?.State?.Running ? "terminateRequested" : "not_running",
    jobId,
    report: readReport(jobId),
    workerAttemptId: existing?.Config?.Labels?.["asklake.worker-attempt-id"] || null,
  };
}

function workerLogsDocker(jobId, containerName, tail) {
  const existing = inspectContainer(containerName);
  if (!existing) {
    const report = readReport(jobId);
    return {
      containerName,
      containerState: "missing",
      lines: report?.lastError ? [redactLogLine(String(report.lastError))] : [],
      truncated: false,
    };
  }
  const limit = Math.min(Math.max(tail, 1), 1000);
  const result = spawnSync("docker", ["logs", "--tail", String(limit), containerName], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const lines = combined.split(/\r?\n/).filter(Boolean).slice(-limit).map(redactLogLine);
  return {
    containerName,
    containerState: existing.State?.Running ? "running" : "exited",
    lines,
    truncated: combined.length >= 1024 * 1024,
  };
}

function redactLogLine(value) {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/((?:["']?(?:access[_-]?key|secret(?:[_-]?access)?[_-]?key|api[_-]?key|token|password)["']?)\s*[=:]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*[=:]\s*["']?bearer\s+)[^\s,"']+/gi, "$1[REDACTED]")
    .slice(0, 4000);
}

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(backendDir, "scripts", "start-spark-server.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
  }
}

function sparkPackageList(includeKafka) {
  const packages = [
    includeKafka ? process.env.ASKLAKE_SPARK_KAFKA_PACKAGE || "org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1" : "",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
  ];
  return packages.map((value) => String(value || "").trim()).filter((value) => value && value !== "none");
}

function continuousSparkPackages(outputPath, icebergTarget) {
  return [...new Set([
    ...sparkPackageList(true),
    ...sparkPackages(
      { icebergTarget },
      { path: "" },
      { sparkPath: required(outputPath, "outputPath") },
    ),
  ])];
}

function inspectContainer(name) {
  const result = runDocker(["inspect", name], true);
  if (!result) return null;
  try {
    return JSON.parse(result)[0] || null;
  } catch {
    return null;
  }
}

function runDocker(args, allowFailure = false) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.status === 0 ? result.stdout || "" : "";
}

function runtimeScriptPath(value, scriptDir, name) {
  const script = absoluteRuntimePath(value, name);
  const relative = path.posix.relative(scriptDir, script);
  if (!relative || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error(`${name} must be a file below ASKLAKE_SPARK_SCRIPT_DIR.`);
  }
  return script;
}

function absoluteRuntimePath(value, name) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/"));
  if (!path.posix.isAbsolute(normalized) || normalized === "/" || normalized.includes("\0")) {
    throw new Error(`${name} must be an absolute Spark runtime path.`);
  }
  return normalized.replace(/\/$/, "");
}

function reportFileName(jobId) { return `kafka-continuous-${safeSegment(jobId)}.json`; }
function commandFileName(jobId) { return `kafka-continuous-${safeSegment(jobId)}.command.json`; }
function stateFileName(jobId) { return `kafka-continuous-${safeSegment(jobId)}.state.json`; }
function reportFile(jobId) { return path.join(reportDir, reportFileName(jobId)); }
function commandFile(jobId) { return path.join(reportDir, commandFileName(jobId)); }
function stateFile(jobId) { return path.join(reportDir, stateFileName(jobId)); }
function catalogAckFile(jobId) { return path.join(reportDir, `kafka-continuous-${safeSegment(jobId)}.catalog-ack.json`); }
function clearCommand(jobId) { if (existsSync(commandFile(jobId))) writeFileSync(commandFile(jobId), "", "utf8"); }
function writeCommand(jobId, action) {
  writeFileSync(commandFile(jobId), `${JSON.stringify({ action, requestedAt: new Date().toISOString() })}\n`, "utf8");
}
function readReport(jobId) {
  try {
    return existsSync(reportFile(jobId)) ? JSON.parse(readFileSync(reportFile(jobId), "utf8")) : null;
  } catch {
    return null;
  }
}
function readCommand(jobId) {
  try {
    return existsSync(commandFile(jobId)) ? JSON.parse(readFileSync(commandFile(jobId), "utf8")) : null;
  } catch {
    return null;
  }
}
function acknowledgeCatalog(jobId, batchId, containerName, mode) {
  const parsed = Number.parseInt(batchId, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("batchId must be a non-negative integer");
  let current = -1;
  try {
    current = Number.parseInt(JSON.parse(readFileSync(catalogAckFile(jobId), "utf8")).batchId, 10);
  } catch {
    current = -1;
  }
  const acknowledged = Math.max(Number.isFinite(current) ? current : -1, parsed);
  writeJsonAtomic(catalogAckFile(jobId), { batchId: acknowledged, updatedAt: new Date().toISOString() });
  return {
    acknowledgedBatchId: acknowledged,
    containerName,
    containerState: mode === "rest"
      ? (readWorkerState(jobId) ? "running" : "missing")
      : workerStatusDocker(jobId, containerName).containerState,
    jobId,
  };
}
function workerName(jobId) { return `asklake-kafka-stream-${safeSegment(jobId)}`; }
function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}
function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`);
  return String(value);
}
export function resolveContinuousWorkerBroker(broker, environment = process.env) {
  const configured = required(broker, "broker");
  const dockerOverride = String(environment.ASKLAKE_KAFKA_BROKER_IN_DOCKER || "").trim();
  if (!dockerOverride) return configured;

  const [host] = configured.split(":", 1);
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase())
    ? dockerOverride
    : configured;
}
function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}
function continuousSqlWorkerContract(request) {
  const plan = request.continuousSqlPlan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || Object.keys(plan).length === 0) return null;
  const planHash = required(plan.planHash, "continuousSqlPlan.planHash");
  const runGeneration = positiveInt(plan.runGeneration, 0);
  if (runGeneration < 1) throw new Error("continuousSqlPlan.runGeneration must be a positive integer");
  return { planHash, runGeneration };
}
function requireMatchingContinuousSqlWorker(existing, expected) {
  const existingHash = String(existing?.continuousSqlPlanHash || "");
  const existingGeneration = Number.parseInt(existing?.continuousSqlRunGeneration, 10);
  if (!expected) {
    if (existingHash || Number.isFinite(existingGeneration)) {
      throw new Error("Existing worker belongs to a Continuous SQL generation.");
    }
    return;
  }
  if (existingHash !== expected.planHash || existingGeneration !== expected.runGeneration) {
    throw new Error(
      "Existing worker belongs to a different Continuous SQL plan or generation; terminate it before retrying.",
    );
  }
}
function continuousSparkShufflePartitions() {
  return positiveInt(process.env.ASKLAKE_CONTINUOUS_SPARK_SHUFFLE_PARTITIONS, 4);
}
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function isMissingS3Object(error) {
  return Number(error?.$metadata?.httpStatusCode || error?.statusCode) === 404
    || ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error?.name || error?.Code || ""));
}
function isEntrypoint() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
function readPayload() {
  const raw = readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
