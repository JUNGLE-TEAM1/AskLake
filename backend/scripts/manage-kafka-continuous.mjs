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
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

import {
  createSparkRestSubmission,
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

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const masterUrl = process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077";
const payload = readPayload();

try {
  const result = await manage(payload);
  console.log(`ASKLAKE_KAFKA_CONTINUOUS_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_CONTINUOUS_ERROR=${JSON.stringify({
    code: "KAFKA_CONTINUOUS_WORKER_FAILED",
    message: error?.message || String(error),
    status: 502,
  })}`);
  process.exitCode = 1;
}

async function manage(request) {
  const jobId = required(request.jobId, "jobId");
  const action = required(request.action, "action");
  const containerName = workerName(jobId);
  const mode = continuousExecutionMode();
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(ivyDir, { recursive: true });

  if (mode === "rest") {
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
  const mode = sparkExecutionMode(process.env);
  if (mode === "docker" && !String(process.env.ASKLAKE_SPARK_RUNNER || "").trim()) {
    throw new Error("Development Docker continuous execution requires ASKLAKE_SPARK_RUNNER=docker.");
  }
  return mode;
}

async function startWorkerRest(request, containerName) {
  const jobId = required(request.jobId, "jobId");
  const previous = readWorkerState(jobId);
  if (previous) {
    const existing = await refreshWorkerState(jobId, previous);
    if (!isTerminalSparkDriverState(existing.driverState)) {
      return restWorkerResult(jobId, containerName, existing, { started: false });
    }
  }

  await ensureOutputBucket(required(request.outputPath, "outputPath"));
  clearCommand(jobId);
  if (existsSync(reportFile(jobId))) unlinkSync(reportFile(jobId));

  const workerAttemptId = randomUUID();
  const runtime = continuousRestRuntime();
  const submission = createSparkRestSubmission({
    appName: `asklake-kafka-continuous-${safeSegment(jobId)}`,
    environmentVariables: continuousEnvironment(request, workerAttemptId, runtime.reportRuntimeDir, false),
    packages: sparkPackageList(true),
    scriptPath: runtime.scriptPath,
    sparkProperties: {
      "spark.sql.streaming.stopGracefullyOnShutdown": "true",
    },
  }, process.env);
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

function continuousEnvironment(request, workerAttemptId, runtimeReportDir, includeCredentials = true) {
  const jobId = required(request.jobId, "jobId");
  return {
    ASKLAKE_CONTINUOUS_JOB_ID: jobId,
    ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID: workerAttemptId,
    ASKLAKE_CONTINUOUS_BROKER: required(request.broker, "broker"),
    ASKLAKE_CONTINUOUS_TOPIC: required(request.topic, "topic"),
    ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID: required(request.consumerGroupId, "consumerGroupId"),
    ASKLAKE_CONTINUOUS_OUTPUT_PATH: required(request.outputPath, "outputPath"),
    ASKLAKE_CONTINUOUS_CHECKPOINT_PATH: required(request.checkpointPath, "checkpointPath"),
    ASKLAKE_CONTINUOUS_OFFSET_POLICY: request.initialOffsetPolicy || "earliest",
    ASKLAKE_CONTINUOUS_TRIGGER_SECONDS: positiveInt(request.triggerIntervalSeconds, 30),
    ASKLAKE_CONTINUOUS_MAX_OFFSETS: positiveInt(request.maxOffsetsPerTrigger, 10000),
    ASKLAKE_CONTINUOUS_INITIAL_COUNTS: JSON.stringify(request.initialCounts || {}),
    ASKLAKE_CONTINUOUS_INITIAL_METRICS: JSON.stringify(request.initialMetrics || {}),
    ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE: JSON.stringify(request.initialSchemaState || {}),
    ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS: JSON.stringify(request.schemaColumns || []),
    ASKLAKE_CONTINUOUS_SCHEMA_POLICY: JSON.stringify(request.schemaEvolutionPolicy || {}),
    ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE: process.env.ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE || "false",
    ASKLAKE_CONTINUOUS_REPORT_FILE: path.posix.join(runtimeReportDir, reportFileName(jobId)),
    ASKLAKE_CONTINUOUS_COMMAND_FILE: path.posix.join(runtimeReportDir, commandFileName(jobId)),
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT_IN_DOCKER || process.env.MINIO_ENDPOINT || "http://minio:9000",
    MINIO_REGION: process.env.MINIO_REGION || "us-east-1",
    ...(includeCredentials ? {
      MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "",
      MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "",
    } : {}),
    HOME: "/tmp",
  };
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
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) {
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
  const workerAttemptId = randomUUID();
  const packages = sparkPackageList(true).join(",");
  const environment = continuousEnvironment(request, workerAttemptId, reportContainerDir);
  const packageArgs = packages ? ["--packages", packages] : [];
  const args = [
    "run", "-d", "--name", containerName, "--network", network,
    "--add-host", "host.docker.internal:host-gateway",
    "--label", "asklake.role=kafka-continuous-worker",
    "--label", `asklake.job-id=${jobId}`,
    "--label", `asklake.worker-attempt-id=${workerAttemptId}`,
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    "-v", `${reportDir}:${reportContainerDir}`,
    ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e", `ASKLAKE_CONTINUOUS_JOB_ID=${jobId}`,
    "-e", `ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID=${workerAttemptId}`,
    "-e", `ASKLAKE_CONTINUOUS_BROKER=${required(request.broker, "broker")}`,
    "-e", `ASKLAKE_CONTINUOUS_TOPIC=${required(request.topic, "topic")}`,
    "-e", `ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID=${required(request.consumerGroupId, "consumerGroupId")}`,
    "-e", `ASKLAKE_CONTINUOUS_OUTPUT_PATH=${required(request.outputPath, "outputPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_CHECKPOINT_PATH=${required(request.checkpointPath, "checkpointPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_OFFSET_POLICY=${request.initialOffsetPolicy || "earliest"}`,
    "-e", `ASKLAKE_CONTINUOUS_TRIGGER_SECONDS=${positiveInt(request.triggerIntervalSeconds, 30)}`,
    "-e", `ASKLAKE_CONTINUOUS_MAX_OFFSETS=${positiveInt(request.maxOffsetsPerTrigger, 10000)}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_COUNTS=${JSON.stringify(request.initialCounts || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_METRICS=${JSON.stringify(request.initialMetrics || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_SCHEMA_STATE=${JSON.stringify(request.initialSchemaState || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_CONTRACT_VERSION=${request.ruleContractVersion || "1.0"}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_FINGERPRINT=${required(request.ruleFingerprint, "ruleFingerprint")}`,
    "-e", `ASKLAKE_CONTINUOUS_RULE_OUTPUT_SCHEMA=${JSON.stringify(request.ruleOutputSchema || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_RULES=${JSON.stringify(request.rules || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS=${JSON.stringify(request.schemaColumns || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_SCHEMA_POLICY=${JSON.stringify(request.schemaEvolutionPolicy || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE=${process.env.ASKLAKE_CONTINUOUS_FAIL_AFTER_DATA_WRITE_ONCE || "false"}`,
    "-e", `ASKLAKE_CONTINUOUS_REPORT_FILE=${reportContainerDir}/${reportFileName(jobId)}`,
    "-e", `ASKLAKE_CONTINUOUS_COMMAND_FILE=${reportContainerDir}/${commandFileName(jobId)}`,
    "-e", `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://minio:9000"}`,
    "-e", `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ""}`,
    "-e", `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ""}`,
    "-e", `MINIO_REGION=${process.env.MINIO_REGION || "us-east-1"}`,
    "-e", "HOME=/tmp",
    image,
    "/opt/spark/bin/spark-submit", "--master", masterUrl,
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    "--conf", "spark.sql.streaming.stopGracefullyOnShutdown=true",
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

async function ensureOutputBucket(outputPath) {
  const bucket = /^s3a?:\/\/([^/]+)/i.exec(outputPath)?.[1];
  if (!bucket) return;
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY || "",
      secretAccessKey: process.env.MINIO_SECRET_KEY || "",
    },
    endpoint: process.env.MINIO_ENDPOINT_IN_DOCKER || process.env.MINIO_ENDPOINT || "http://minio:9000",
    forcePathStyle: true,
    region: process.env.MINIO_REGION || "us-east-1",
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
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
function workerName(jobId) { return `asklake-kafka-stream-${safeSegment(jobId)}`; }
function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}
function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`);
  return String(value);
}
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readPayload() {
  const raw = readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
