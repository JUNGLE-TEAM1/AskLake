import { readFileSync } from "node:fs";
import path from "node:path";

class TerminalSparkError extends Error {}

const terminalFailureStates = new Set(["ERROR", "FAILED", "KILLED", "UNKNOWN"]);
const request = JSON.parse(readFileSync(0, "utf8") || "{}");
const restUrl = validateRestUrl(request.restUrl);
const submission = validateSubmission(request.submission);
const timeoutMs = boundedInteger(request.timeoutMs, 90_000, 1_000, 24 * 60 * 60 * 1000);
const pollIntervalMs = boundedInteger(request.pollIntervalMs, 1_000, 250, 10_000);

let submissionId = "";
try {
  const created = await requestJson(`${restUrl}/v1/submissions/create`, {
    body: JSON.stringify(submission),
    headers: { "content-type": "application/json;charset=UTF-8" },
    method: "POST",
  }, Math.min(timeoutMs, 15_000));
  if (created?.success !== true || !created.submissionId) {
    throw new Error(`Spark REST submission was rejected: ${safeMessage(created?.message)}`);
  }

  submissionId = String(created.submissionId);
  const deadline = Date.now() + timeoutMs;
  let lastState = "SUBMITTED";
  let lastStatusError = "";
  let finished = false;
  while (Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    try {
      const status = await requestJson(
        `${restUrl}/v1/submissions/status/${encodeURIComponent(submissionId)}`,
        { method: "GET" },
        Math.min(10_000, Math.max(1_000, deadline - Date.now())),
      );
      if (status?.success !== true) {
        throw new Error(`Spark REST status failed: ${safeMessage(status?.message)}`);
      }
      lastState = String(status.driverState || "UNKNOWN").toUpperCase();
      lastStatusError = "";
      if (lastState === "FINISHED") {
        console.log(`ASKLAKE_SPARK_REST_RESULT=${JSON.stringify({ state: lastState, submissionId })}`);
        finished = true;
        break;
      }
      if (terminalFailureStates.has(lastState)) {
        throw new TerminalSparkError(`Spark driver ${submissionId} ended in state ${lastState}.`);
      }
    } catch (error) {
      if (error instanceof TerminalSparkError) throw error;
      lastStatusError = safeMessage(error?.message);
    }
  }

  if (!finished) {
    await killSubmission(restUrl, submissionId);
    const detail = lastStatusError ? ` Last status error: ${lastStatusError}` : "";
    throw new Error(`Spark driver ${submissionId} timed out in state ${lastState}.${detail}`);
  }
} catch (error) {
  console.error(safeMessage(error?.message || error));
  process.exitCode = 1;
}

function validateRestUrl(value) {
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

function validateSubmission(value) {
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

async function requestJson(url, options, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Spark REST returned HTTP ${response.status}: ${safeMessage(body)}`);
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

async function killSubmission(baseUrl, id) {
  try {
    await requestJson(
      `${baseUrl}/v1/submissions/kill/${encodeURIComponent(id)}`,
      { method: "POST" },
      5_000,
    );
  } catch {
    // The original timeout remains the actionable failure.
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function safeMessage(value) {
  const text = String(value || "unknown error").replace(/[\r\n]+/g, " ").trim();
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
