import { randomUUID } from "node:crypto";
import {
  assertEmrAdmissionApplication,
  emrAdmissionPolicy,
  estimateEmrJobResources,
} from "./emrAdmission.mjs";
import {
  CancelJobRunCommand,
  EMRServerlessClient,
  GetApplicationCommand,
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

import {
  assertCredentialFree,
  createEmrServerlessContinuousSubmission,
  EMR_SERVERLESS_RUNTIME_ID,
  EMR_SERVERLESS_TERMINAL_STATES,
  emrServerlessContinuousArtifactUris,
  emrServerlessContinuousConfig,
  emrServerlessLogReference,
  safeEmrServerlessMessage,
} from "./emrServerless.mjs";

const STATE_VERSION = 1;

export async function manageEmrServerlessContinuous({
  action,
  catalogAckFile,
  environment = process.env,
  request,
  sparkEnvironment,
  stateFile,
}, dependencies = {}) {
  const config = emrServerlessContinuousConfig(environment);
  const clients = {
    emr: dependencies.emrClient || new EMRServerlessClient({ region: config.region }),
    s3: dependencies.s3Client || new S3Client({ region: config.region }),
  };
  const context = {
    catalogAckFile: validateAbsoluteFile(catalogAckFile, "Continuous catalog ack file"),
    clients,
    config,
    environment,
    request,
    sleep: dependencies.sleep || delay,
    sparkEnvironment,
    stateFile: validateAbsoluteFile(stateFile, "EMR Continuous state file"),
  };

  if (action === "start") return withStateLock(context, () => startContinuous(context));
  if (action === "status") return statusContinuous(context);
  if (action === "pause" || action === "stop") {
    return withStateLock(context, () => stopContinuous(context, action, false));
  }
  if (action === "terminate") return withStateLock(context, () => stopContinuous(context, null, true));
  if (action === "logs") return logsContinuous(context, boundedInteger(request?.tail, 200, 1, 1000));
  throw emrContinuousError(`Unsupported EMR Continuous action: ${String(action || "(empty)")}.`, "EMR_CONTINUOUS_ACTION_INVALID", 422);
}

async function startContinuous(context) {
  let state = readContinuousState(context.stateFile, false);
  if (state && !EMR_SERVERLESS_TERMINAL_STATES.has(state.state)) {
    state = await ensureSubmitted(context, state);
    return workerResult(context, await refreshState(context, state), { started: false });
  }

  const workerAttemptId = randomUUID();
  const artifacts = emrServerlessContinuousArtifactUris(
    context.request.jobId,
    workerAttemptId,
    context.environment,
  );
  const submission = submissionFor(context, workerAttemptId, artifacts);
  const now = new Date().toISOString();
  state = appendEvent({
    applicationId: context.config.applicationId,
    cancelAcceptedAt: null,
    cancelCompletedAt: null,
    cancelError: null,
    cancelFailedAt: null,
    cancelRequestState: null,
    cancelRequestedAt: null,
    checkpointPath: requiredText(context.request.checkpointPath, "checkpointPath"),
    clientToken: submission.clientToken,
    createdAt: now,
    events: [],
    jobId: requiredText(context.request.jobId, "jobId"),
    logUri: context.config.logUri,
    manifestUri: artifacts.manifestUri,
    outputPath: requiredText(context.request.outputPath, "outputPath"),
    region: context.config.region,
    reportUri: artifacts.reportUri,
    requestedAction: null,
    runner: EMR_SERVERLESS_RUNTIME_ID,
    state: "SUBMITTING",
    updatedAt: now,
    version: STATE_VERSION,
    workerAttemptId,
  }, "submitting", "EMR Serverless streaming submission is being prepared.");
  writeContinuousState(context.stateFile, state);
  state = await ensureSubmitted(context, state);
  return workerResult(context, await refreshState(context, state), { started: true });
}

async function ensureSubmitted(context, state) {
  assertRequestIdentity(context, state);
  if (state.jobRunId || state.requestedAction) return state;
  const applicationAdmission = await validateContinuousApplication(context);
  if (applicationAdmission.enabled) {
    state = {
      ...state,
      applicationAdmission,
      updatedAt: new Date().toISOString(),
    };
    writeContinuousState(context.stateFile, state);
  }
  const artifacts = {
    manifestUri: state.manifestUri,
    reportUri: state.reportUri,
  };
  const submission = submissionFor(context, state.workerAttemptId, artifacts);
  if (submission.clientToken !== state.clientToken) {
    throw emrContinuousError("Persisted EMR Continuous client token does not match the worker attempt.", "EMR_CONTINUOUS_STATE_MISMATCH", 409);
  }
  const manifest = {
    createdAt: state.createdAt,
    environment: sparkEnvironmentFor(context, state.workerAttemptId, state.reportUri),
    jobId: state.jobId,
    version: 1,
    workerAttemptId: state.workerAttemptId,
  };
  await putS3Json(context.clients.s3, state.manifestUri, manifest, "manifest upload");
  const created = await sendEmr(
    context.clients.emr,
    new StartJobRunCommand(submission),
    "start",
  );
  const jobRunId = requiredText(created?.jobRunId, "EMR Serverless Job Run ID");
  const submitted = appendEvent({
    ...state,
    jobRunId,
    state: "SUBMITTED",
  }, "submitted", `EMR Serverless Job Run ${jobRunId} was accepted.`, "SUBMITTED");
  try {
    writeContinuousState(context.stateFile, submitted);
  } catch (error) {
    try {
      await sendEmr(context.clients.emr, new CancelJobRunCommand({
        applicationId: state.applicationId,
        jobRunId,
        shutdownGracePeriodInSeconds: context.config.cancelGracePeriodSeconds,
      }), "rollback cancellation");
    } catch {
      // The durable state failure remains primary; remote cleanup is best effort.
    }
    throw error;
  }
  return submitted;
}

async function validateContinuousApplication(context) {
  const result = await sendEmr(
    context.clients.emr,
    new GetApplicationCommand({ applicationId: context.config.applicationId }),
    "application validation",
  );
  const application = result?.application;
  if (!application || String(application.applicationId || "") !== context.config.applicationId) {
    throw emrContinuousError(
      "EMR Serverless application validation did not identify the configured application.",
      "EMR_CONTINUOUS_APPLICATION_INVALID",
      422,
    );
  }
  if (String(application.type || "").trim().toUpperCase() !== "SPARK") {
    throw emrContinuousError(
      "EMR Serverless Continuous requires a SPARK application.",
      "EMR_CONTINUOUS_APPLICATION_INCOMPATIBLE",
      422,
    );
  }
  if (compareEmrRelease(application.releaseLabel, "emr-7.9.0") < 0) {
    throw emrContinuousError(
      "EMR Serverless graceful streaming cancellation requires release emr-7.9.0 or newer.",
      "EMR_CONTINUOUS_APPLICATION_INCOMPATIBLE",
      422,
    );
  }
  const applicationState = String(application.state || "").trim().toUpperCase();
  const autoStartEnabled = application.autoStartConfiguration?.enabled !== false;
  const submissionReady = applicationState === "STARTED"
    || (autoStartEnabled && ["CREATED", "STOPPED"].includes(applicationState));
  if (!submissionReady) {
    throw emrContinuousError(
      `EMR Serverless application is not ready for submission: ${applicationState || "UNKNOWN"}.`,
      "EMR_CONTINUOUS_APPLICATION_NOT_READY",
      409,
    );
  }
  return assertEmrAdmissionApplication(
    application,
    emrAdmissionPolicy(context.environment, "continuous"),
    estimateEmrJobResources(context.config),
  );
}

async function statusContinuous(context) {
  const state = readContinuousState(context.stateFile, false);
  if (!state) return workerResult(context, null);
  assertRequestIdentity(context, state);
  const submitted = state.state === "SUBMITTING" && !state.requestedAction
    ? await withStateLock(context, async () => {
        const current = readContinuousState(context.stateFile, true);
        return ensureSubmitted(context, current);
      })
    : state;
  return workerResult(context, await refreshState(context, submitted));
}

async function stopContinuous(context, requestedAction, force) {
  let state = readContinuousState(context.stateFile, false);
  if (!state) return workerResult(context, null, { containerState: "not_running" });
  assertRequestIdentity(context, state);
  if (EMR_SERVERLESS_TERMINAL_STATES.has(state.state)) {
    return workerResult(context, state, { containerState: "not_running" });
  }
  const now = new Date().toISOString();
  state = appendEvent({
    ...state,
    cancelAcceptedAt: null,
    cancelCompletedAt: null,
    cancelError: null,
    cancelFailedAt: null,
    cancelRequestState: "requested",
    cancelRequestedAt: now,
    requestedAction,
  }, "cancel_requested", force
    ? "Forced EMR Serverless cancellation was requested."
    : `${requestedAction} requested with graceful Spark shutdown.`);
  writeContinuousState(context.stateFile, state);
  if (!state.jobRunId) {
    state = appendEvent({
      ...state,
      cancelAcceptedAt: now,
      cancelCompletedAt: now,
      cancelRequestState: "completed",
      state: "CANCELLED",
    }, "cancelled", "Submission was cancelled before StartJobRun.", "CANCELLED");
    writeContinuousState(context.stateFile, state);
    return workerResult(context, state, { containerState: force ? "terminateRequested" : `${requestedAction}Requested` });
  }
  try {
    await sendEmr(context.clients.emr, new CancelJobRunCommand({
      applicationId: state.applicationId,
      jobRunId: state.jobRunId,
      shutdownGracePeriodInSeconds: force ? 0 : context.config.cancelGracePeriodSeconds,
    }), "cancel");
  } catch (error) {
    const failedAt = new Date().toISOString();
    writeContinuousState(context.stateFile, appendEvent({
      ...state,
      cancelError: safeEmrServerlessMessage(error?.message || error),
      cancelFailedAt: failedAt,
      cancelRequestState: "failed",
    }, "cancel_failed", "EMR Serverless cancellation request failed."));
    throw error;
  }
  const acceptedAt = new Date().toISOString();
  state = appendEvent({
    ...state,
    cancelAcceptedAt: acceptedAt,
    cancelError: null,
    cancelRequestState: "accepted",
    state: "CANCELLING",
  }, "cancel_accepted", "EMR Serverless accepted the cancellation request.", "CANCELLING");
  writeContinuousState(context.stateFile, state);
  return workerResult(context, state, {
    containerState: force ? "terminateRequested" : `${requestedAction}Requested`,
  });
}

async function logsContinuous(context, tail) {
  const status = await statusContinuous(context);
  const state = readContinuousState(context.stateFile, false);
  const lines = (state?.events || []).map((event) => {
    const stateSuffix = event.driverState ? ` state=${event.driverState}` : "";
    return `${event.at} ${event.message}${stateSuffix}`;
  });
  if (state?.stateDetails) lines.push(`${state.updatedAt} ${state.stateDetails}`);
  if (state?.lastError) lines.push(`${state.updatedAt} ${state.lastError}`);
  if (status.report?.lastError) lines.push(String(status.report.lastError));
  if (status.runtimeLogReference?.uri) lines.push(`${state?.updatedAt || new Date().toISOString()} logs=${status.runtimeLogReference.uri}`);
  const safeLines = lines.map(redactLogLine);
  return {
    containerId: status.containerId,
    containerName: status.containerName,
    containerState: status.containerState,
    lines: safeLines.slice(-tail),
    truncated: safeLines.length > tail,
    workerAttemptId: status.workerAttemptId,
  };
}

async function refreshState(context, state) {
  if (!state?.jobRunId) return state;
  if (EMR_SERVERLESS_TERMINAL_STATES.has(state.state)) {
    const terminal = await refreshCatalogAck(context, state);
    writeContinuousState(context.stateFile, terminal);
    return terminal;
  }
  const result = await sendEmr(context.clients.emr, new GetJobRunCommand({
    applicationId: state.applicationId,
    jobRunId: state.jobRunId,
  }), "status");
  const jobRun = result?.jobRun;
  if (!jobRun || String(jobRun.jobRunId || "") !== state.jobRunId) {
    throw emrContinuousError("EMR Serverless status response did not identify the requested Job Run.");
  }
  const nextState = String(jobRun.state || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
  let next = {
    ...state,
    attempt: positiveInteger(jobRun.attempt, state.attempt || 1),
    endedAt: isoDate(jobRun.endedAt) || state.endedAt || null,
    startedAt: isoDate(jobRun.startedAt) || state.startedAt || null,
    state: nextState,
    stateDetails: safeEmrServerlessMessage(jobRun.stateDetails || "") || null,
    updatedAt: new Date().toISOString(),
  };
  if (nextState !== state.state) {
    next = appendEvent(next, "state_changed", `EMR Serverless state changed from ${state.state} to ${nextState}.`, nextState);
  }
  if (nextState === "CANCELLING" && next.cancelRequestState === "requested") {
    next = appendEvent({
      ...next,
      cancelAcceptedAt: next.cancelAcceptedAt || new Date().toISOString(),
      cancelRequestState: "accepted",
    }, "cancel_accepted", "EMR Serverless entered CANCELLING after the persisted request.", nextState);
  } else if (nextState === "CANCELLED" && ["requested", "accepted", "completed"].includes(next.cancelRequestState)) {
    next = appendEvent({
      ...next,
      cancelAcceptedAt: next.cancelAcceptedAt || new Date().toISOString(),
      cancelCompletedAt: next.cancelCompletedAt || new Date().toISOString(),
      cancelRequestState: "completed",
    }, "cancel_completed", "EMR Serverless cancellation completed.", nextState);
  } else if (["FAILED", "SUCCESS"].includes(nextState) && next.cancelRequestState === "accepted") {
    next = appendEvent({
      ...next,
      cancelError: next.stateDetails || `EMR Serverless ended in ${nextState} instead of CANCELLED.`,
      cancelFailedAt: next.cancelFailedAt || new Date().toISOString(),
      cancelRequestState: "failed",
    }, "cancel_failed", `EMR Serverless ended in ${nextState} instead of completing cancellation.`, nextState);
  }
  next = await refreshCatalogAck(context, next);
  writeContinuousState(context.stateFile, next);
  return next;
}

async function refreshCatalogAck(context, state) {
  try {
    const published = await publishCatalogAck(context, state);
    if (!published) return state;
    return {
      ...state,
      catalogAckUploadedAt: new Date().toISOString(),
      lastCatalogAckError: null,
    };
  } catch (error) {
    return appendEvent({
      ...state,
      lastCatalogAckError: safeEmrServerlessMessage(error?.message || error),
    }, "catalog_ack_retry", "Catalog acknowledgement upload failed; status polling will retry.", state.state);
  }
}

async function workerResult(context, state, overrides = {}) {
  const report = state?.reportUri
    ? await readS3Json(context.clients.s3, state.reportUri, false, "report read")
    : null;
  const currentReport = report?.workerAttemptId === state?.workerAttemptId ? report : null;
  const terminalFailure = state && ["FAILED", "SUCCESS"].includes(state.state)
    ? {
        ...(currentReport || {}),
        failedCount: Math.max(1, Number(currentReport?.failedCount || 0) + 1),
        heartbeatAt: state.updatedAt,
        lastError: state.state === "SUCCESS"
          ? "EMR Serverless streaming Job Run ended in SUCCESS unexpectedly; long-running streaming jobs must be cancelled explicitly."
          : state.stateDetails || "EMR Serverless streaming Job Run failed.",
        status: "failed",
        workerAttemptId: state.workerAttemptId,
      }
    : null;
  const attempt = positiveInteger(state?.attempt, 1);
  const runtimeLogReference = state?.jobRunId
    ? emrServerlessLogReference({ ...state, attempt, attemptPath: true })
    : null;
  return {
    applicationId: state?.applicationId || context.config.applicationId,
    applicationAdmission: state?.applicationAdmission || null,
    attempt: state ? attempt : null,
    cancelAcceptedAt: state?.cancelAcceptedAt || null,
    cancelCompletedAt: state?.cancelCompletedAt || null,
    cancelError: state?.cancelError || null,
    cancelFailedAt: state?.cancelFailedAt || null,
    cancelRequestState: state?.cancelRequestState || null,
    cancelRequestedAt: state?.cancelRequestedAt || null,
    containerId: state?.jobRunId || null,
    containerName: `asklake-emr-stream-${safeSegment(context.request.jobId)}`,
    containerState: overrides.containerState || containerState(state?.state),
    driverState: state?.state || null,
    exitCode: exitCode(state?.state),
    jobId: context.request.jobId,
    jobRunId: state?.jobRunId || null,
    lastSuccessfulCheckpoint: state?.checkpointPath || context.request.checkpointPath,
    lastCatalogAckError: state?.lastCatalogAckError || null,
    report: terminalFailure || currentReport,
    requestedAction: state?.requestedAction || null,
    runtime: EMR_SERVERLESS_RUNTIME_ID,
    runtimeLogReference,
    stateDetails: state?.stateDetails || null,
    workerAttemptId: state?.workerAttemptId || null,
    ...overrides,
  };
}

function submissionFor(context, workerAttemptId, artifacts) {
  return createEmrServerlessContinuousSubmission({
    appName: `asklake-kafka-continuous-${safeSegment(context.request.jobId)}`,
    checkpointPath: context.request.checkpointPath,
    jobId: context.request.jobId,
    manifestUri: artifacts.manifestUri,
    outputPath: context.request.outputPath,
    reportUri: artifacts.reportUri,
    workerAttemptId,
  }, context.environment);
}

function sparkEnvironmentFor(context, workerAttemptId, reportUri) {
  const value = typeof context.sparkEnvironment === "function"
    ? context.sparkEnvironment(workerAttemptId, reportUri)
    : context.sparkEnvironment;
  if (!value || typeof value !== "object") {
    throw emrContinuousError("EMR Continuous Spark environment is required.", "EMR_CONTINUOUS_REQUEST_INVALID", 422);
  }
  return assertCredentialFree(value, "EMR Continuous manifest environment");
}

function assertRequestIdentity(context, state) {
  if (
    state.applicationId !== context.config.applicationId
    || state.region !== context.config.region
    || state.jobId !== String(context.request.jobId)
    || state.checkpointPath !== String(context.request.checkpointPath)
    || state.outputPath !== String(context.request.outputPath)
  ) {
    throw emrContinuousError(
      "Persisted EMR Continuous state does not match the current Job identity or storage layout.",
      "EMR_CONTINUOUS_STATE_MISMATCH",
      409,
    );
  }
}

function readContinuousState(stateFile, required) {
  if (!existsSync(stateFile)) {
    if (required) throw emrContinuousError("EMR Continuous state file does not exist.", "EMR_CONTINUOUS_STATE_INVALID", 409);
    return null;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    throw emrContinuousError("EMR Continuous state file is unreadable.", "EMR_CONTINUOUS_STATE_INVALID", 409);
  }
  assertCredentialFree(state, "EMR Continuous persisted state");
  if (
    !state
    || state.runner !== EMR_SERVERLESS_RUNTIME_ID
    || state.version !== STATE_VERSION
    || !String(state.jobId || "").trim()
    || !String(state.workerAttemptId || "").trim()
    || (!String(state.jobRunId || "").trim() && !String(state.clientToken || "").trim())
  ) {
    throw emrContinuousError("EMR Continuous state file is invalid.", "EMR_CONTINUOUS_STATE_INVALID", 409);
  }
  return normalizeContinuousState(state);
}

function normalizeContinuousState(state) {
  const validCancelStates = new Set(["requested", "accepted", "failed", "completed"]);
  let cancelRequestState = validCancelStates.has(state.cancelRequestState)
    ? state.cancelRequestState
    : null;
  if (!cancelRequestState && state.requestedAction) {
    if (state.state === "CANCELLED") cancelRequestState = "completed";
    else if (state.state === "CANCELLING") cancelRequestState = "accepted";
    else cancelRequestState = "requested";
  }
  return {
    ...state,
    cancelAcceptedAt: state.cancelAcceptedAt || null,
    cancelCompletedAt: state.cancelCompletedAt || null,
    cancelError: state.cancelError || null,
    cancelFailedAt: state.cancelFailedAt || null,
    cancelRequestState,
    cancelRequestedAt: state.cancelRequestedAt || null,
    catalogAckUploadedAt: state.catalogAckUploadedAt || null,
    lastCatalogAckError: state.lastCatalogAckError || null,
  };
}

function writeContinuousState(stateFile, state) {
  assertCredentialFree(state, "EMR Continuous persisted state");
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temporary, stateFile);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function withStateLock(context, callback) {
  const lockFile = `${context.stateFile}.lock`;
  const deadline = Date.now() + 10_000;
  let descriptor;
  while (Date.now() < deadline) {
    try {
      descriptor = openSync(lockFile, "wx");
      writeFileSync(descriptor, `${JSON.stringify({ createdAt: Date.now(), pid: process.pid })}\n`, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (staleStateLock(lockFile)) {
        try { unlinkSync(lockFile); } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      await context.sleep(50);
    }
  }
  if (descriptor === undefined) {
    throw emrContinuousError("EMR Continuous state lock timed out.", "EMR_CONTINUOUS_STATE_LOCK_TIMEOUT", 504);
  }
  try {
    return await callback();
  } finally {
    try { closeSync(descriptor); } finally { if (existsSync(lockFile)) unlinkSync(lockFile); }
  }
}

function staleStateLock(lockFile) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(lockFile, "utf8"));
  } catch {
    metadata = null;
  }
  const pid = Number(metadata?.pid || 0);
  if (pid > 0) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
    }
  }
  const createdAt = Number(metadata?.createdAt || 0);
  if (createdAt > 0) return Date.now() - createdAt > 5 * 60 * 1000;
  try {
    return Date.now() - statSync(lockFile).mtimeMs > 5 * 60 * 1000;
  } catch {
    return false;
  }
}

function appendEvent(state, type, message, driverState = state.state) {
  const at = new Date().toISOString();
  return {
    ...state,
    events: [
      ...(Array.isArray(state.events) ? state.events : []),
      { at, driverState: String(driverState || "UNKNOWN"), message, type },
    ].slice(-1000),
    updatedAt: at,
  };
}

async function publishCatalogAck(context, state) {
  if (!existsSync(context.catalogAckFile)) return false;
  let payload;
  try {
    payload = JSON.parse(readFileSync(context.catalogAckFile, "utf8"));
  } catch {
    return false;
  }
  await putS3Json(context.clients.s3, catalogAckUri(state.reportUri), payload, "catalog ack upload");
  return true;
}

function catalogAckUri(reportUri) {
  return String(reportUri).replace(/(?:\.[^./]+)?$/, ".catalog-ack.json");
}

async function putS3Json(client, uri, value, operation) {
  const target = parseS3Uri(uri);
  try {
    await client.send(new PutObjectCommand({
      Body: `${JSON.stringify(value)}\n`,
      Bucket: target.bucket,
      ContentType: "application/json; charset=utf-8",
      Key: target.key,
    }));
  } catch (error) {
    throw normalizeAwsError(error, operation);
  }
}

async function readS3Json(client, uri, required, operation) {
  const target = parseS3Uri(uri);
  let result;
  try {
    result = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: target.key }));
  } catch (error) {
    const name = String(error?.name || error?.code || "");
    if (!required && /NoSuchKey|NotFound|NoSuchBucket/i.test(name)) return null;
    throw normalizeAwsError(error, operation);
  }
  const body = await result?.Body?.transformToString?.("utf-8");
  try {
    const parsed = JSON.parse(String(body || ""));
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch {
    throw emrContinuousError("EMR Continuous report object is invalid JSON.", "EMR_CONTINUOUS_REPORT_INVALID", 502);
  }
}

async function sendEmr(client, command, operation) {
  try {
    return await client.send(command);
  } catch (error) {
    throw normalizeAwsError(error, operation);
  }
}

function normalizeAwsError(error, operation) {
  const name = String(error?.name || error?.code || "");
  if (/AccessDenied|Unauthorized|Forbidden/i.test(name)) {
    return emrContinuousError(`EMR Continuous ${operation} was denied.`, "EMR_CONTINUOUS_ACCESS_DENIED", 403);
  }
  if (/ResourceNotFound|NotFound/i.test(name)) {
    return emrContinuousError(`EMR Continuous ${operation} resource was not found.`, "EMR_CONTINUOUS_NOT_FOUND", 404);
  }
  if (/Conflict/i.test(name)) {
    return emrContinuousError(`EMR Continuous ${operation} conflicted with the current state.`, "EMR_CONTINUOUS_CONFLICT", 409);
  }
  if (/Validation/i.test(name)) {
    return emrContinuousError(`EMR Continuous ${operation} request was invalid.`, "EMR_CONTINUOUS_VALIDATION_FAILED", 422);
  }
  return emrContinuousError(
    `EMR Continuous ${operation} failed: ${safeEmrServerlessMessage(error?.message || error)}`,
    "EMR_CONTINUOUS_UNAVAILABLE",
    502,
  );
}

function parseS3Uri(value) {
  const match = /^s3a?:\/\/([^/]+)\/(.+)$/i.exec(String(value || ""));
  if (!match) throw emrContinuousError("EMR Continuous artifact URI must identify an S3 object.", "EMR_CONTINUOUS_URI_INVALID", 422);
  return { bucket: match[1], key: match[2] };
}

function containerState(state) {
  if (!state) return "missing";
  if (["SUBMITTING", "SUBMITTED", "PENDING", "QUEUED", "SCHEDULED"].includes(state)) return "starting";
  if (state === "RUNNING") return "running";
  if (state === "CANCELLING") return "stopping";
  if (EMR_SERVERLESS_TERMINAL_STATES.has(state)) return "exited";
  return "unknown";
}

function exitCode(state) {
  if (state === "SUCCESS") return 0;
  if (state === "CANCELLED") return 143;
  if (state === "FAILED") return 1;
  return null;
}

function validateAbsoluteFile(value, name) {
  const raw = String(value || "");
  if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) {
    throw emrContinuousError(`${name} must be an absolute path.`, "EMR_CONTINUOUS_STATE_INVALID", 500);
  }
  return path.resolve(raw);
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw emrContinuousError(`${name} is required.`, "EMR_CONTINUOUS_REQUEST_INVALID", 422);
  return text;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compareEmrRelease(value, minimum) {
  const parse = (candidate) => {
    const match = /^emr-(\d+)\.(\d+)\.(\d+)$/i.exec(String(candidate || "").trim());
    if (!match) return null;
    return match.slice(1).map(Number);
  };
  const current = parse(value);
  const required = parse(minimum);
  if (!current || !required) return -1;
  for (let index = 0; index < required.length; index += 1) {
    if (current[index] !== required[index]) return current[index] > required[index] ? 1 : -1;
  }
  return 0;
}

function safeSegment(value) {
  return String(value || "job").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}

function redactLogLine(value) {
  return safeEmrServerlessMessage(value)
    .replace(/((?:["']?(?:access[_-]?key|secret(?:[_-]?access)?[_-]?key|api[_-]?key|token|password)["']?)\s*[=:]\s*["']?)[^\s,"']+/gi, "$1[REDACTED]")
    .slice(0, 4000);
}

function emrContinuousError(message, code = "EMR_CONTINUOUS_FAILED", status = 502) {
  const error = new Error(safeEmrServerlessMessage(message));
  error.code = code;
  error.status = status;
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
