import { readFileSync } from "node:fs";
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
    // Spark may briefly report UNKNOWN while the master is reconciling a
    // newly submitted or relaunched driver. Keep polling until timeout.
  }

  try {
    await killSparkRestDriver(restUrl, submissionId);
  } catch {
    // The timeout remains the actionable error; kill is best-effort cleanup.
  }
  const detail = lastStatusError ? ` Last status error: ${lastStatusError}` : "";
  throw new Error(`Spark driver ${submissionId} timed out in state ${lastState}.${detail}`);
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
    const restUrl = validateRestUrl(request.restUrl);
    const submission = validateSubmission(request.submission);
    const timeoutMs = boundedInteger(request.timeoutMs, 90_000, 1_000, 24 * 60 * 60 * 1000);
    const created = await createSparkRestDriver(restUrl, submission, Math.min(timeoutMs, 15_000));
    const result = await waitForSparkRestDriver({
      pollIntervalMs: request.pollIntervalMs,
      restUrl,
      submissionId: created.submissionId,
      timeoutMs,
    });
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
