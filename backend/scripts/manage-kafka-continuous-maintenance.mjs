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
  waitForSparkRestDriver,
} from "./spark-rest-client.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const masterUrl = process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077";
const request = readPayload();

try {
  const result = await manageMaintenance(request);
  console.log(`ASKLAKE_KAFKA_MAINTENANCE_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_MAINTENANCE_ERROR=${JSON.stringify({
    code: "KAFKA_CONTINUOUS_MAINTENANCE_FAILED",
    message: error?.message || String(error),
    status: 502,
  })}`);
  process.exitCode = 1;
}

async function manageMaintenance(input) {
  const action = required(input.action, "action");
  const mode = maintenanceExecutionMode();
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(ivyDir, { recursive: true });
  if (action === "cleanup") {
    return mode === "rest" ? cleanupMaintenanceRest(input) : cleanupMaintenanceDocker(input);
  }
  if (action !== "run") throw new Error(`Unsupported continuous maintenance action: ${action}`);
  return mode === "rest" ? runMaintenanceRest(input) : runMaintenanceDockerWithSpark(input);
}

function maintenanceExecutionMode() {
  const mode = sparkExecutionMode(process.env);
  if (mode === "docker" && !String(process.env.ASKLAKE_SPARK_RUNNER || "").trim()) {
    throw new Error("Development Docker maintenance execution requires ASKLAKE_SPARK_RUNNER=docker.");
  }
  return mode;
}

async function runMaintenanceRest(input) {
  const runId = required(input.runId, "runId");
  const runtime = maintenanceRestRuntime();
  let state = readMaintenanceState(runId);
  const existingResult = readMaintenanceResult(runId, false);
  if (state?.driverState === "FINISHED" && existingResult) return existingResult;

  if (!state) {
    if (existsSync(resultFile(runId))) unlinkSync(resultFile(runId));
    const submission = createSparkRestSubmission({
      appName: `asklake-${safeSegment(required(input.kind, "kind"))}-${safeSegment(runId)}`,
      environmentVariables: maintenanceEnvironment(input, runtime.reportRuntimeDir),
      packages: sparkPackageList(),
      scriptPath: runtime.scriptPath,
    }, process.env);
    const created = await createSparkRestDriver(runtime.restUrl, submission);
    const now = new Date().toISOString();
    state = appendStateEvent({
      createdAt: now,
      driverState: "SUBMITTED",
      events: [],
      kind: required(input.kind, "kind"),
      runId,
      runner: "rest",
      submissionId: created.submissionId,
      updatedAt: now,
      version: 1,
    }, "submitted", `Spark maintenance submission ${created.submissionId} was accepted.`);
    try {
      replaceMaintenanceState(runId, state, null);
    } catch (error) {
      try {
        await killSparkRestDriver(runtime.restUrl, created.submissionId);
      } catch {
        // Preserve the state conflict; duplicate-driver cleanup is best effort.
      }
      throw error;
    }
  }

  try {
    const completed = await waitForSparkRestDriver({
      onStatus: async (status) => {
        const previousState = normalizeSparkDriverState(state.driverState);
        state = {
          ...state,
          driverState: status.driverState,
          lastStatusError: null,
          updatedAt: new Date().toISOString(),
        };
        if (status.driverState !== previousState) {
          state = appendStateEvent(
            state,
            "state_changed",
            `Spark maintenance submission changed from ${previousState} to ${status.driverState}.`,
            status.driverState,
          );
        }
        state = persistMaintenanceState(runId, state);
      },
      pollIntervalMs: positiveInt(process.env.ASKLAKE_SPARK_REST_POLL_INTERVAL_MS, 1_000),
      restUrl: runtime.restUrl,
      submissionId: state.submissionId,
      timeoutMs: maintenanceTimeoutMs(),
    });
    state = persistMaintenanceState(runId, {
      ...state,
      driverState: completed.state,
      lastStatusError: null,
      updatedAt: new Date().toISOString(),
    });
    return waitForMaintenanceResult(runId, 5_000);
  } catch (error) {
    state = persistMaintenanceState(runId, appendStateEvent({
      ...state,
      lastStatusError: safeSparkRestMessage(error?.message || error),
      updatedAt: new Date().toISOString(),
    }, "failed", "Spark maintenance submission did not complete successfully."));
    throw error;
  }
}

async function cleanupMaintenanceRest(input) {
  const runId = required(input.runId, "runId");
  const containerName = maintenanceName(runId);
  let state = readMaintenanceState(runId);
  if (!state) return { cleaned: false, containerName, runId, submissionId: null };
  const runtime = maintenanceRestRuntime();
  let status;
  try {
    status = await getSparkRestDriverStatus(runtime.restUrl, state.submissionId);
  } catch (error) {
    state = persistMaintenanceState(runId, {
      ...state,
      driverState: "UNKNOWN",
      lastStatusError: safeSparkRestMessage(error?.message || error),
      updatedAt: new Date().toISOString(),
    });
  }
  if (status) {
    state = persistMaintenanceState(runId, {
      ...state,
      driverState: status.driverState,
      lastStatusError: null,
      updatedAt: new Date().toISOString(),
    });
    if (isTerminalSparkDriverState(status.driverState)) {
      return {
        cleaned: true,
        containerName,
        driverState: status.driverState,
        runId,
        submissionId: state.submissionId,
      };
    }
  }
  await killSparkRestDriver(runtime.restUrl, state.submissionId);
  state = persistMaintenanceState(runId, appendStateEvent({
    ...state,
    killRequestedAt: new Date().toISOString(),
  }, "kill_requested", "Maintenance cleanup requested through Spark REST kill."));
  return {
    cleaned: true,
    containerName,
    driverState: state.driverState,
    runId,
    submissionId: state.submissionId,
  };
}

function maintenanceRestRuntime() {
  const runtime = sparkRestRuntimeConfig(process.env);
  const scriptPath = runtimeScriptPath(
    process.env.ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT
      || `${runtime.scriptDir}/kafka_continuous_maintenance.py`,
    runtime.scriptDir,
    "ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT",
  );
  const reportRuntimeDir = absoluteRuntimePath(
    process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports",
    "ASKLAKE_SPARK_REPORT_CONTAINER_DIR",
  );
  return { ...runtime, reportRuntimeDir, scriptPath };
}

function maintenanceEnvironment(input, runtimeReportDir) {
  const runId = required(input.runId, "runId");
  return {
    ASKLAKE_MAINTENANCE_KIND: required(input.kind, "kind"),
    ASKLAKE_MAINTENANCE_RUN_ID: runId,
    ASKLAKE_MAINTENANCE_OUTPUT_PATH: required(input.outputPath, "outputPath"),
    ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS: JSON.stringify(input.schemaColumns || []),
    ASKLAKE_MAINTENANCE_SCHEMA_POLICY: JSON.stringify(input.schemaEvolutionPolicy || {}),
    ASKLAKE_MAINTENANCE_APPROVE_UNKNOWN_FIELDS: Boolean(input.approveUnknownFields),
    ASKLAKE_MAINTENANCE_OFFSETS: JSON.stringify(input.offsets || []),
    ASKLAKE_MAINTENANCE_TARGET_MB: input.targetFileSizeMb || 256,
    ASKLAKE_MAINTENANCE_LIMIT: input.limit || 100,
    ASKLAKE_MAINTENANCE_RESULT_FILE: path.posix.join(runtimeReportDir, resultFileName(runId)),
    MINIO_ENDPOINT: process.env.MINIO_ENDPOINT_IN_DOCKER || process.env.MINIO_ENDPOINT || "http://minio:9000",
    MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "",
    MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "",
    MINIO_REGION: process.env.MINIO_REGION || "us-east-1",
    HOME: "/tmp",
  };
}

function readMaintenanceState(runId) {
  const file = stateFile(runId);
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Maintenance Spark state is unreadable for ${runId}: ${error?.message || error}`);
  }
  if (
    !value
    || value.runner !== "rest"
    || String(value.runId || "") !== String(runId)
    || !String(value.submissionId || "").trim()
  ) {
    throw new Error(`Maintenance Spark state is invalid for ${runId}.`);
  }
  return value;
}

function persistMaintenanceState(runId, next) {
  const current = readMaintenanceState(runId);
  if (current && current.submissionId !== next.submissionId) return current;
  writeJsonAtomic(stateFile(runId), next);
  return next;
}

function replaceMaintenanceState(runId, next, expectedSubmissionId) {
  const current = readMaintenanceState(runId);
  if ((current?.submissionId || null) !== expectedSubmissionId) {
    throw new Error(`Maintenance Spark state changed concurrently for ${runId}; refusing a duplicate submission.`);
  }
  writeJsonAtomic(stateFile(runId), next);
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

async function waitForMaintenanceResult(runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      const result = readMaintenanceResult(runId, true);
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  if (lastError) throw lastError;
  throw new Error(`Maintenance result artifact was not published for ${runId}.`);
}

function readMaintenanceResult(runId, strict) {
  const file = resultFile(runId);
  if (!existsSync(file)) return null;
  try {
    const result = JSON.parse(readFileSync(file, "utf8"));
    if (!result || String(result.runId || "") !== String(runId)) {
      throw new Error(`Maintenance result artifact does not match run ${runId}.`);
    }
    return result;
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

function runMaintenanceDockerWithSpark(input) {
  ensureSparkServer();
  return runMaintenanceDocker(input);
}

function cleanupMaintenanceDocker(input) {
  const runId = required(input.runId, "runId");
  const containerName = maintenanceName(runId);
  const execution = spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  if (execution.status !== 0 && !String(execution.stderr || "").includes("No such container")) {
    throw new Error(`Maintenance container cleanup failed.\n${execution.stdout}\n${execution.stderr}`);
  }
  return { cleaned: execution.status === 0, containerName, runId };
}

function runMaintenanceDocker(input) {
  const runId = required(input.runId, "runId");
  if (existsSync(resultFile(runId))) unlinkSync(resultFile(runId));
  const packages = sparkPackageList().join(",");
  const packageArgs = packages ? ["--packages", packages] : [];
  const environment = maintenanceEnvironment(input, reportContainerDir);
  const args = [
    "run", "--rm", "--network", network,
    "--name", maintenanceName(runId),
    "--label", "asklake.role=kafka-continuous-maintenance",
    "--label", `asklake.maintenance-run-id=${runId}`,
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    "-v", `${reportDir}:${reportContainerDir}`,
    ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-e", `ASKLAKE_MAINTENANCE_KIND=${required(input.kind, "kind")}`,
    "-e", `ASKLAKE_MAINTENANCE_RUN_ID=${required(input.runId, "runId")}`,
    "-e", `ASKLAKE_MAINTENANCE_OUTPUT_PATH=${required(input.outputPath, "outputPath")}`,
    "-e", `ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS=${JSON.stringify(input.schemaColumns || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_SCHEMA_POLICY=${JSON.stringify(input.schemaEvolutionPolicy || {})}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_CONTRACT_VERSION=${input.ruleContractVersion || "1.0"}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_FINGERPRINT=${input.ruleFingerprint || ""}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_OUTPUT_SCHEMA=${JSON.stringify(input.ruleOutputSchema || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_RULES=${JSON.stringify(input.rules || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_APPROVE_UNKNOWN_FIELDS=${Boolean(input.approveUnknownFields)}`,
    "-e", `ASKLAKE_MAINTENANCE_OFFSETS=${JSON.stringify(input.offsets || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_TARGET_MB=${input.targetFileSizeMb || 256}`,
    "-e", `ASKLAKE_MAINTENANCE_LIMIT=${input.limit || 100}`,
    "-e", `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://minio:9000"}`,
    "-e", `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ""}`,
    "-e", `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ""}`,
    "-e", "HOME=/tmp",
    image,
    "/opt/spark/bin/spark-submit", "--master", masterUrl,
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    ...packageArgs,
    "/work/scripts/kafka_continuous_maintenance.py",
  ];
  const execution = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (execution.status !== 0) {
    throw new Error(`Maintenance Spark task failed.\n${execution.stdout}\n${execution.stderr}`);
  }
  const result = readMaintenanceResult(runId, true);
  if (!result) throw new Error("Maintenance result artifact was not emitted.");
  return result;
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

function sparkPackageList() {
  return [process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1"]
    .map((value) => String(value || "").trim())
    .filter((value) => value && value !== "none");
}

function maintenanceTimeoutMs() {
  return boundedInt(
    process.env.ASKLAKE_CONTINUOUS_MAINTENANCE_TIMEOUT_MS,
    540_000,
    1_000,
    24 * 60 * 60 * 1000,
  );
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

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`);
  return String(value);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function maintenanceName(runId) {
  return `asklake-kafka-maint-${safeSegment(runId)}`.slice(0, 120);
}

function safeSegment(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function stateFileName(runId) { return `kafka-continuous-maintenance-${safeSegment(runId)}.state.json`; }
function resultFileName(runId) { return `kafka-continuous-maintenance-${safeSegment(runId)}.result.json`; }
function stateFile(runId) { return path.join(reportDir, stateFileName(runId)); }
function resultFile(runId) { return path.join(reportDir, resultFileName(runId)); }

function readPayload() {
  const raw = readFileSync(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
