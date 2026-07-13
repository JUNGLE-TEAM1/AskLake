import { randomUUID } from "node:crypto";
import {
  CancelJobRunCommand,
  EMRServerlessClient,
  GetJobRunCommand,
  StartJobRunCommand,
} from "@aws-sdk/client-emr-serverless";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCredentialFree,
  EMR_SERVERLESS_RUNTIME_ID,
  EMR_SERVERLESS_TERMINAL_STATES,
  emrServerlessConfig,
  emrServerlessLogReference,
  normalizeEmrServerlessState,
  safeEmrServerlessMessage,
} from "../src/emrServerless.mjs";

const staleStateLockMs = 5 * 60 * 1000;

export class TerminalEmrServerlessError extends Error {
  constructor(message, state = null) {
    super(message);
    this.name = "TerminalEmrServerlessError";
    this.code = state?.state === "CANCELLED" ? "EMR_SERVERLESS_CANCELLED" : "EMR_SERVERLESS_JOB_FAILED";
    this.status = state?.state === "CANCELLED" ? 409 : 502;
    this.runtimeState = state;
  }
}

export async function runEmrServerlessRequest(request, dependencies = {}) {
  const config = request?.config || emrServerlessConfig(dependencies.environment || process.env);
  const stateFile = validateStateFile(request?.stateFile);
  const manifestFile = validateInputFile(request?.manifestFile, "EMR manifest file");
  const manifestUri = requiredText(request?.manifestUri, "EMR manifest URI");
  const reportUri = requiredText(request?.reportUri, "EMR report URI");
  const submission = assertCredentialFree(request?.submission, "EMR StartJobRun request");
  if (!submission || typeof submission !== "object") throw emrClientError("EMR StartJobRun request is required.");
  if (submission.applicationId !== config.applicationId) {
    throw emrClientError("EMR submission application does not match runtime configuration.", "EMR_SERVERLESS_STATE_MISMATCH", 409);
  }
  const clients = emrClients(config, dependencies);
  const sleep = dependencies.sleep || delay;
  const timeoutMs = boundedInteger(request?.timeoutMs, 90_000, 1_000, 24 * 60 * 60 * 1000);
  const pollIntervalMs = boundedInteger(request?.pollIntervalMs, config.pollIntervalMs, 25, 10_000);
  const deadline = Date.now() + timeoutMs;
  let state = readEmrServerlessState(stateFile, false);
  if (state) assertStateIdentity(state, {
    clientToken: submission.clientToken,
    config,
    manifestUri,
    reportUri,
  });
  if ((!state || !state.jobRunId) && emrCancellationRequested(stateFile)) {
    throw emrClientError(
      "EMR Serverless execution was canceled before submission.",
      "EMR_SERVERLESS_CANCELLED",
      409,
    );
  }

  if (!state?.jobRunId) {
    const releaseStateLock = await acquireStateLock(stateFile, Math.min(timeoutMs, 15_000), sleep);
    try {
      state = readEmrServerlessState(stateFile, false);
      if (state) {
        assertStateIdentity(state, {
          clientToken: submission.clientToken,
          config,
          manifestUri,
          reportUri,
        });
      }
      if (!state) {
        const now = new Date().toISOString();
        state = {
          applicationId: config.applicationId,
          clientToken: requiredText(submission.clientToken, "EMR client token"),
          createdAt: now,
          logUri: config.logUri,
          manifestUri,
          region: config.region,
          reportUri,
          runner: EMR_SERVERLESS_RUNTIME_ID,
          state: "SUBMITTING",
          updatedAt: now,
          version: 1,
        };
        writeEmrServerlessState(stateFile, state);
      }
      if (emrCancellationRequested(stateFile)) {
        throw emrClientError(
          "EMR Serverless execution was canceled before submission.",
          "EMR_SERVERLESS_CANCELLED",
          409,
        );
      }
      await putS3Text(clients.s3, manifestUri, readFileSync(manifestFile, "utf8"));
      const created = await sendEmr(
        clients.emr,
        new StartJobRunCommand(submission),
        "start",
      );
      const jobRunId = requiredText(created?.jobRunId, "EMR Serverless Job Run ID");
      state = {
        ...state,
        jobRunId,
        state: "SUBMITTED",
        updatedAt: new Date().toISOString(),
      };
      try {
        writeEmrServerlessState(stateFile, state);
      } catch (error) {
        try {
          await cancelEmrServerlessJob(
            clients.emr,
            config.applicationId,
            jobRunId,
            config.cancelGracePeriodSeconds,
          );
        } catch {
          // The state persistence error remains primary; cleanup is best effort.
        }
        throw error;
      }
    } finally {
      releaseStateLock();
    }
  }

  while (Date.now() < deadline) {
    if (emrCancellationRequested(stateFile) && !state.cancelRequestedAt) {
      await cancelEmrServerlessJob(
        clients.emr,
        state.applicationId,
        state.jobRunId,
        config.cancelGracePeriodSeconds,
      );
      state = {
        ...state,
        cancelRequestedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeEmrServerlessState(stateFile, state);
    }
    const status = await getEmrServerlessJob(clients.emr, state.applicationId, state.jobRunId);
    state = mergeJobState(state, status);
    writeEmrServerlessState(stateFile, state);
    if (EMR_SERVERLESS_TERMINAL_STATES.has(state.state)) {
      const report = await readS3Json(clients.s3, reportUri, state.state === "SUCCESS");
      if (report) return { report: enrichReport(report, state), state };
      throw new TerminalEmrServerlessError(
        safeEmrServerlessMessage(state.stateDetails || `EMR Serverless Job Run ended in ${state.state}.`),
        state,
      );
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }

  let cancelError = null;
  try {
    await cancelEmrServerlessJob(clients.emr, state.applicationId, state.jobRunId, config.cancelGracePeriodSeconds);
    state = {
      ...state,
      cancelRequestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    cancelError = normalizeEmrError(error, "timeout cancellation");
  }
  state = {
    ...state,
    lastError: cancelError?.message || `EMR Serverless Job Run timed out in ${state.state}.`,
    updatedAt: new Date().toISOString(),
  };
  writeEmrServerlessState(stateFile, state);
  throw emrClientError(
    cancelError
      ? `EMR Serverless Job Run timed out and cancellation failed: ${cancelError.message}`
      : `EMR Serverless Job Run timed out in ${state.state}; cancellation was requested.`,
    "EMR_SERVERLESS_TIMEOUT",
    504,
  );
}

export async function getEmrServerlessJob(client, applicationId, jobRunId) {
  const result = await sendEmr(client, new GetJobRunCommand({ applicationId, jobRunId }), "status");
  const jobRun = result?.jobRun;
  if (!jobRun || String(jobRun.jobRunId || "") !== String(jobRunId)) {
    throw emrClientError("EMR Serverless status response did not identify the requested Job Run.");
  }
  return jobRun;
}

export async function cancelEmrServerlessJob(client, applicationId, jobRunId, graceSeconds = 60) {
  return sendEmr(client, new CancelJobRunCommand({
    applicationId: requiredText(applicationId, "EMR application ID"),
    jobRunId: requiredText(jobRunId, "EMR Job Run ID"),
    shutdownGracePeriodInSeconds: boundedInteger(graceSeconds, 60, 1, 3600),
  }), "cancel");
}

export async function cancelEmrServerlessSubmissionFromState(stateFileValue, environment = process.env, dependencies = {}) {
  const config = emrServerlessConfig(environment);
  const stateFile = validateStateFile(stateFileValue);
  let state = readEmrServerlessState(stateFile, true);
  assertStateIdentity(state, {
    clientToken: state.clientToken,
    config,
    manifestUri: state.manifestUri,
    reportUri: state.reportUri,
  });
  if (!state.jobRunId) {
    return {
      applicationId: state.applicationId,
      canceled: true,
      jobRunId: null,
      state: state.state,
    };
  }
  const clients = emrClients(config, dependencies);
  const jobRun = await getEmrServerlessJob(clients.emr, state.applicationId, state.jobRunId);
  state = mergeJobState(state, jobRun);
  if (EMR_SERVERLESS_TERMINAL_STATES.has(state.state)) {
    writeEmrServerlessState(stateFile, state);
    return {
      applicationId: state.applicationId,
      canceled: state.state === "CANCELLED",
      jobRunId: state.jobRunId,
      state: state.state,
    };
  }
  await cancelEmrServerlessJob(
    clients.emr,
    state.applicationId,
    state.jobRunId,
    config.cancelGracePeriodSeconds,
  );
  state = {
    ...state,
    cancelRequestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeEmrServerlessState(stateFile, state);
  return {
    applicationId: state.applicationId,
    canceled: true,
    jobRunId: state.jobRunId,
    state: state.state,
  };
}

export function readEmrServerlessState(stateFileValue, required = true) {
  const stateFile = validateStateFile(stateFileValue);
  if (!existsSync(stateFile)) {
    if (required) throw emrClientError(`EMR Serverless state file does not exist: ${stateFile}`);
    return null;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    throw emrClientError("EMR Serverless state file is unreadable.", "EMR_SERVERLESS_STATE_INVALID", 409);
  }
  assertCredentialFree(state, "EMR persisted state");
  if (
    !state
    || state.runner !== EMR_SERVERLESS_RUNTIME_ID
    || !String(state.applicationId || "").trim()
    || !String(state.region || "").trim()
    || (
      !String(state.jobRunId || "").trim()
      && !(state.state === "SUBMITTING" && String(state.clientToken || "").trim())
    )
  ) {
    throw emrClientError("EMR Serverless state file is invalid.", "EMR_SERVERLESS_STATE_INVALID", 409);
  }
  return state;
}

function emrClients(config, dependencies) {
  return {
    emr: dependencies.emrClient || new EMRServerlessClient({ region: config.region }),
    s3: dependencies.s3Client || new S3Client({ region: config.region }),
  };
}

async function sendEmr(client, command, operation) {
  try {
    return await client.send(command);
  } catch (error) {
    throw normalizeEmrError(error, operation);
  }
}

function normalizeEmrError(error, operation) {
  const name = String(error?.name || error?.code || "");
  const message = safeEmrServerlessMessage(error?.message || `${operation} failed.`);
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) {
    return emrClientError(`EMR Serverless ${operation} was denied.`, "EMR_SERVERLESS_ACCESS_DENIED", 403);
  }
  if (/ResourceNotFound|NotFound/i.test(name)) {
    return emrClientError(`EMR Serverless ${operation} resource was not found.`, "EMR_SERVERLESS_NOT_FOUND", 404);
  }
  if (/Conflict/i.test(name)) {
    return emrClientError(`EMR Serverless ${operation} conflicted with the current state.`, "EMR_SERVERLESS_CONFLICT", 409);
  }
  if (/Validation/i.test(name)) {
    return emrClientError(`EMR Serverless ${operation} request was invalid.`, "EMR_SERVERLESS_VALIDATION_FAILED", 422);
  }
  return emrClientError(`EMR Serverless ${operation} failed: ${message}`, "EMR_SERVERLESS_UNAVAILABLE", 502);
}

function mergeJobState(state, jobRun) {
  const emrState = String(jobRun?.state || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
  return {
    ...state,
    attempt: Number(jobRun?.attempt || state.attempt || 1),
    endedAt: isoDate(jobRun?.endedAt) || state.endedAt || null,
    normalizedState: normalizeEmrServerlessState(emrState),
    startedAt: isoDate(jobRun?.startedAt) || state.startedAt || null,
    state: emrState,
    stateDetails: safeEmrServerlessMessage(jobRun?.stateDetails || "") || null,
    updatedAt: new Date().toISOString(),
  };
}

function enrichReport(report, state) {
  const logReference = emrServerlessLogReference(state);
  return {
    ...report,
    runtime: {
      applicationId: state.applicationId,
      id: EMR_SERVERLESS_RUNTIME_ID,
      jobRunId: state.jobRunId,
      state: state.state,
    },
    runtimeJobId: state.jobRunId,
    runtimeLogReference: logReference,
  };
}

async function putS3Text(client, uri, text) {
  const target = parseS3Uri(uri);
  try {
    await client.send(new PutObjectCommand({
      Body: String(text),
      Bucket: target.bucket,
      ContentType: "application/json; charset=utf-8",
      Key: target.key,
    }));
  } catch (error) {
    throw normalizeEmrError(error, "manifest upload");
  }
}

async function readS3Json(client, uri, required) {
  const target = parseS3Uri(uri);
  let result;
  try {
    result = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key }));
  } catch (error) {
    const name = String(error?.name || error?.code || "");
    if (!required && /NoSuchKey|NotFound|NoSuchBucket/i.test(name)) return null;
    throw normalizeEmrError(error, "report read");
  }
  const body = await result?.Body?.transformToString?.("utf-8");
  try {
    const parsed = JSON.parse(String(body || ""));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw emrClientError("EMR Serverless report object is invalid JSON.", "EMR_SERVERLESS_REPORT_INVALID", 502);
  }
}

function parseS3Uri(value) {
  const match = /^s3a?:\/\/([^/]+)\/(.+)$/i.exec(String(value || ""));
  if (!match) throw emrClientError("EMR artifact URI must identify an S3 object.");
  return { bucket: match[1], key: decodeS3Key(match[2]) };
}

function decodeS3Key(value) {
  try {
    return String(value).split("/").map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    throw emrClientError("EMR artifact URI contains invalid percent encoding.");
  }
}

function assertStateIdentity(state, { clientToken, config, manifestUri, reportUri }) {
  if (
    state.applicationId !== config.applicationId
    || state.region !== config.region
    || state.manifestUri !== manifestUri
    || state.reportUri !== reportUri
    || (state.clientToken && state.clientToken !== clientToken)
  ) {
    throw emrClientError(
      "Persisted EMR Serverless state does not match the configured application or artifacts.",
      "EMR_SERVERLESS_STATE_MISMATCH",
      409,
    );
  }
}

function writeEmrServerlessState(stateFileValue, state) {
  const stateFile = validateStateFile(stateFileValue);
  assertCredentialFree(state, "EMR persisted state");
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temporary, stateFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function acquireStateLock(stateFileValue, timeoutMs, sleep) {
  const stateFile = validateStateFile(stateFileValue);
  const lockFile = `${stateFile}.lock`;
  const deadline = Date.now() + boundedInteger(timeoutMs, 15_000, 250, 60_000);
  while (Date.now() < deadline) {
    try {
      const descriptor = openSync(lockFile, "wx");
      try {
        writeFileSync(lockFile, `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`, "utf8");
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(lockFile);
        throw error;
      }
      return () => {
        try { closeSync(descriptor); } finally { if (existsSync(lockFile)) unlinkSync(lockFile); }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (isStaleStateLock(lockFile)) {
        try { unlinkSync(lockFile); } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      await sleep(50);
    }
  }
  throw emrClientError("EMR Serverless state lock timed out.", "EMR_SERVERLESS_STATE_LOCK_TIMEOUT", 504);
}

function isStaleStateLock(lockFile) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    metadata = null;
  }
  const createdAt = Number(metadata?.createdAt || 0);
  const pid = Number(metadata?.pid || 0);
  if (createdAt > 0 && Date.now() - createdAt < staleStateLockMs) return false;
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  try {
    return Date.now() - statSync(lockFile).mtimeMs >= staleStateLockMs;
  } catch {
    return false;
  }
}

function validateStateFile(value) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw emrClientError("EMR Serverless state file must be an absolute path.");
  }
  const resolved = path.resolve(raw);
  if (path.dirname(resolved) === resolved) throw emrClientError("EMR Serverless state file must identify a file.");
  return resolved;
}

function validateInputFile(value, name) {
  const resolved = validateStateFile(value);
  if (!existsSync(resolved)) throw emrClientError(`${name} does not exist.`);
  return resolved;
}

function emrCancellationRequested(stateFile) {
  return existsSync(`${validateStateFile(stateFile)}.cancel-requested`);
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw emrClientError(`${name} is required.`);
  return text;
}

function emrClientError(message, code = "EMR_SERVERLESS_CLIENT_FAILED", status = 502) {
  const error = new Error(safeEmrServerlessMessage(message));
  error.code = code;
  error.status = status;
  return error;
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
    if (request.operation === "cancel-state") {
      const recovered = await cancelEmrServerlessSubmissionFromState(request.stateFile);
      console.log(`ASKLAKE_EMR_SERVERLESS_RECOVERY=${JSON.stringify(recovered)}`);
      return;
    }
    const completed = await runEmrServerlessRequest(request);
    console.log(`ASKLAKE_EMR_SERVERLESS_RESULT=${JSON.stringify({
      applicationId: completed.state.applicationId,
      jobRunId: completed.state.jobRunId,
      state: completed.state.state,
    })}`);
    console.log(`ASKLAKE_SPARK_JOB_RESULT=${JSON.stringify(completed.report)}`);
    if (completed.report.status !== "success") process.exitCode = 1;
  } catch (error) {
    const normalized = error?.code ? error : normalizeEmrError(error, "client");
    console.log(`ASKLAKE_EMR_SERVERLESS_ERROR=${JSON.stringify({
      code: normalized.code || "EMR_SERVERLESS_CLIENT_FAILED",
      message: safeEmrServerlessMessage(normalized.message),
      status: Number(normalized.status || 502),
    })}`);
    console.error(safeEmrServerlessMessage(normalized.message));
    process.exitCode = 1;
  }
}

if (isMainModule()) await main();
