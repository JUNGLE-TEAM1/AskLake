import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class TerminalSparkError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "TerminalSparkError";
    this.status = status;
  }
}

export const terminalSparkFailureStates = new Set(["ERROR", "FAILED", "KILLED"]);

const forbiddenCredentialNames = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "MINIO_ACCESS_KEY",
  "MINIO_ROOT_PASSWORD",
  "MINIO_ROOT_USER",
  "MINIO_SECRET_KEY",
  "SPARK_MINIO_ACCESS_KEY",
  "SPARK_MINIO_SECRET_KEY",
]);

export async function createSparkRestDriver(restUrlValue, submissionValue, timeoutMs = 15_000) {
  const restUrl = validateRestUrl(restUrlValue);
  const submission = validateSubmission(submissionValue);
  const created = await requestJson(`${restUrl}/v1/submissions/create`, {
    body: JSON.stringify(submission),
    headers: { "content-type": "application/json;charset=UTF-8" },
    method: "POST",
  }, boundedInteger(timeoutMs, 15_000, 250, 60_000));
  if (created?.success !== true || !created.submissionId) {
    throw new Error(`Spark REST submission was rejected: ${safeSparkRestMessage(created?.message)}`);
  }
  return { ...created, submissionId: String(created.submissionId) };
}

export async function getSparkRestDriverStatus(restUrlValue, submissionIdValue, timeoutMs = 10_000) {
  const restUrl = validateRestUrl(restUrlValue);
  const submissionId = requiredSubmissionId(submissionIdValue);
  const status = await requestJson(
    `${restUrl}/v1/submissions/status/${encodeURIComponent(submissionId)}`,
    { method: "GET" },
    boundedInteger(timeoutMs, 10_000, 250, 60_000),
  );
  if (status?.success !== true) {
    throw new Error(`Spark REST status failed: ${safeSparkRestMessage(status?.message)}`);
  }
  return {
    ...status,
    driverState: normalizeSparkDriverState(status.driverState),
    submissionId: String(status.submissionId || submissionId),
  };
}

export async function killSparkRestDriver(restUrlValue, submissionIdValue, timeoutMs = 5_000) {
  const restUrl = validateRestUrl(restUrlValue);
  const submissionId = requiredSubmissionId(submissionIdValue);
  const result = await requestJson(
    `${restUrl}/v1/submissions/kill/${encodeURIComponent(submissionId)}`,
    { method: "POST" },
    boundedInteger(timeoutMs, 5_000, 250, 60_000),
  );
  if (result?.success !== true) {
    throw new Error(`Spark REST kill failed: ${safeSparkRestMessage(result?.message)}`);
  }
  return { ...result, submissionId: String(result.submissionId || submissionId) };
}

export async function waitForSparkRestDriver({
  killOnTimeout = true,
  onStatus,
  pollIntervalMs: pollIntervalValue,
  restUrl: restUrlValue,
  submissionId: submissionIdValue,
  timeoutMs: timeoutValue,
}) {
  const restUrl = validateRestUrl(restUrlValue);
  const submissionId = requiredSubmissionId(submissionIdValue);
  const timeoutMs = boundedInteger(timeoutValue, 90_000, 1_000, 24 * 60 * 60 * 1000);
  const pollIntervalMs = boundedInteger(pollIntervalValue, 1_000, 250, 10_000);
  const deadline = Date.now() + timeoutMs;
  let lastState = "SUBMITTED";
  let lastStatus = null;
  let lastStatusError = "";

  while (Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    let status;
    try {
      const remainingMs = Math.max(250, deadline - Date.now());
      status = await getSparkRestDriverStatus(restUrl, submissionId, Math.min(10_000, remainingMs));
    } catch (error) {
      lastStatusError = safeSparkRestMessage(error?.message);
      continue;
    }
    lastStatus = status;
    lastState = status.driverState;
    lastStatusError = "";
    if (typeof onStatus === "function") await onStatus(status);
    if (lastState === "FINISHED") {
      return { state: lastState, status: lastStatus, submissionId };
    }
    if (terminalSparkFailureStates.has(lastState)) {
      throw new TerminalSparkError(
        `Spark driver ${submissionId} ended in state ${lastState}.`,
        lastStatus,
      );
    }
    // UNKNOWN is transient while the standalone master reconciles a driver.
  }

  if (killOnTimeout) {
    try {
      await killSparkRestDriver(restUrl, submissionId);
    } catch {
      // The timeout remains the actionable error; callers may retry cleanup.
    }
  }
  const detail = lastStatusError ? ` Last status error: ${lastStatusError}` : "";
  throw new Error(`Spark driver ${submissionId} timed out in state ${lastState}.${detail}`);
}

export async function runSparkRestRequest({
  pollIntervalMs,
  restUrl: restUrlValue,
  stateFile: stateFileValue,
  submission: submissionValue,
  timeoutMs,
}) {
  const restUrl = validateRestUrl(restUrlValue);
  const submission = validateSubmission(submissionValue);
  const stateFile = validateStateFile(stateFileValue);
  let state = readSparkRestState(stateFile, false);

  if (state && state.restUrl !== restUrl) {
    throw new Error("Spark REST state URL does not match the configured control plane.");
  }

  if (!state) {
    const created = await createSparkRestDriver(restUrl, submission, Math.min(timeoutMs, 15_000));
    const now = new Date().toISOString();
    state = {
      createdAt: now,
      driverState: "SUBMITTED",
      restUrl,
      runner: "rest",
      submissionId: created.submissionId,
      updatedAt: now,
      version: 1,
    };
    try {
      writeSparkRestState(stateFile, state);
    } catch (error) {
      try {
        await killSparkRestDriver(restUrl, created.submissionId);
      } catch {
        // Preserve the state persistence error; cleanup is best effort here.
      }
      throw error;
    }
  }

  try {
    const completed = await waitForSparkRestDriver({
      killOnTimeout: false,
      onStatus: (status) => {
        state = {
          ...state,
          driverState: status.driverState,
          lastStatusError: null,
          updatedAt: new Date().toISOString(),
        };
        writeSparkRestState(stateFile, state);
      },
      pollIntervalMs,
      restUrl,
      submissionId: state.submissionId,
      timeoutMs,
    });
    state = {
      ...state,
      driverState: completed.state,
      lastStatusError: null,
      updatedAt: new Date().toISOString(),
    };
    writeSparkRestState(stateFile, state);
    return completed;
  } catch (error) {
    let cleanupError = "";
    if (!(error instanceof TerminalSparkError)) {
      try {
        await killSparkRestDriver(restUrl, state.submissionId);
        state = { ...state, killRequestedAt: new Date().toISOString() };
      } catch (cleanupFailure) {
        cleanupError = safeSparkRestMessage(cleanupFailure?.message || cleanupFailure);
      }
    }
    state = {
      ...state,
      lastError: safeSparkRestMessage(error?.message || error),
      lastStatusError: cleanupError || state.lastStatusError || null,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeSparkRestState(stateFile, state);
    } catch {
      // The original polling or persistence error remains actionable.
    }
    throw error;
  }
}

export async function killSparkRestSubmissionFromState(stateFileValue, expectedRestUrlValue) {
  const stateFile = validateStateFile(stateFileValue);
  let state = readSparkRestState(stateFile, true);
  const restUrl = validateRestUrl(state.restUrl);
  const expectedRestUrl = validateRestUrl(expectedRestUrlValue);
  if (restUrl !== expectedRestUrl) {
    throw new Error("Spark REST recovery state does not match the configured control plane.");
  }
  let status = null;
  try {
    status = await getSparkRestDriverStatus(restUrl, state.submissionId, 2_000);
  } catch (error) {
    state = {
      ...state,
      lastStatusError: safeSparkRestMessage(error?.message || error),
      updatedAt: new Date().toISOString(),
    };
  }
  if (status && isTerminalSparkDriverState(status.driverState)) {
    state = {
      ...state,
      driverState: status.driverState,
      lastStatusError: null,
      updatedAt: new Date().toISOString(),
    };
    writeSparkRestState(stateFile, state);
    return { driverState: status.driverState, killed: false, submissionId: state.submissionId };
  }

  await killSparkRestDriver(restUrl, state.submissionId);
  state = {
    ...state,
    killRequestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeSparkRestState(stateFile, state);
  return { driverState: state.driverState, killed: true, submissionId: state.submissionId };
}

export function readSparkRestState(stateFileValue, required = true) {
  const stateFile = validateStateFile(stateFileValue);
  if (!existsSync(stateFile)) {
    if (required) throw new Error(`Spark REST state file does not exist: ${stateFile}`);
    return null;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    throw new Error(`Spark REST state file is unreadable: ${safeSparkRestMessage(error?.message || error)}`);
  }
  if (
    !state
    || state.runner !== "rest"
    || !String(state.restUrl || "").trim()
    || !String(state.submissionId || "").trim()
  ) {
    throw new Error("Spark REST state file is invalid.");
  }
  return state;
}

export function normalizeSparkDriverState(value) {
  const state = String(value || "UNKNOWN").trim().toUpperCase();
  return state || "UNKNOWN";
}

export function isTerminalSparkDriverState(value) {
  const state = normalizeSparkDriverState(value);
  return state === "FINISHED" || terminalSparkFailureStates.has(state);
}

export function validateRestUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("Spark REST URL must be an absolute HTTP(S) origin.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Spark REST URL must use HTTP(S) without embedded credentials.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("Spark REST URL must not include a path, query, or fragment.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function validateSubmission(value) {
  if (!value || typeof value !== "object") throw new Error("Spark REST submission payload is required.");
  if (value.action !== "CreateSubmissionRequest" || value.mainClass !== "org.apache.spark.deploy.SparkSubmit") {
    throw new Error("Spark REST client only accepts SparkSubmit create requests.");
  }
  if (!Array.isArray(value.appArgs) || value.appArgs.length !== 1) {
    throw new Error("Spark REST submission must contain exactly one application script.");
  }
  const script = path.posix.normalize(String(value.appArgs[0] || ""));
  if (!path.posix.isAbsolute(script) || script === "/" || script.includes("\0")) {
    throw new Error("Spark REST application script must be an absolute runtime path.");
  }
  const credentialFields = [
    ...Object.keys(value.environmentVariables || {}),
    ...Object.keys(value.sparkProperties || {}),
  ].filter(isCredentialField);
  if (credentialFields.length > 0) {
    throw new Error(
      `Spark REST submission must inherit application credentials from the worker environment; forbidden fields: ${credentialFields.join(", ")}`,
    );
  }
  return value;
}

export function safeSparkRestMessage(value) {
  const text = String(value || "unknown error").replace(/[\r\n]+/g, " ").trim();
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

async function requestJson(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Spark REST returned HTTP ${response.status}: ${safeSparkRestMessage(body)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("Spark REST returned a non-JSON response.");
    }
  } finally {
    clearTimeout(timer);
  }
}

function writeSparkRestState(stateFileValue, state) {
  const stateFile = validateStateFile(stateFileValue);
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temporary, stateFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function validateStateFile(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw new Error("Spark REST state file must be an absolute path.");
  }
  const resolved = path.resolve(raw);
  if (path.dirname(resolved) === resolved) {
    throw new Error("Spark REST state file must identify a file.");
  }
  return resolved;
}

function isCredentialField(value) {
  const name = String(value || "");
  const leaf = name.split(".").at(-1)?.toUpperCase() || "";
  return forbiddenCredentialNames.has(leaf)
    || /(?:^|\.)fs\.s3a\.(?:access|secret)\.key$/i.test(name);
}

function requiredSubmissionId(value) {
  const submissionId = String(value || "").trim();
  if (!submissionId) throw new Error("Spark REST submission ID is required.");
  return submissionId;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const current = path.resolve(fileURLToPath(import.meta.url));
  const invoked = path.resolve(process.argv[1]);
  return process.platform === "win32"
    ? current.toLowerCase() === invoked.toLowerCase()
    : current === invoked;
}

async function main() {
  try {
    const request = JSON.parse(readFileSync(0, "utf8") || "{}");
    if (request.operation === "kill-state") {
      const recovered = await killSparkRestSubmissionFromState(request.stateFile, request.restUrl);
      console.log(`ASKLAKE_SPARK_REST_RECOVERY=${JSON.stringify(recovered)}`);
      return;
    }
    const result = await runSparkRestRequest(request);
    console.log(`ASKLAKE_SPARK_REST_RESULT=${JSON.stringify({
      state: result.state,
      submissionId: result.submissionId,
    })}`);
  } catch (error) {
    console.error(safeSparkRestMessage(error?.message || error));
    process.exitCode = 1;
  }
}

if (isMainModule()) await main();
