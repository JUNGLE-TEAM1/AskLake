import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createEmrServerlessContinuousSubmission,
  emrServerlessContinuousArtifactUris,
  emrServerlessContinuousConfig,
} from "../src/emrServerless.mjs";
import { manageEmrServerlessContinuous } from "../src/emrContinuous.mjs";
import { uploadEmrServerlessArtifact } from "./upload-emr-serverless-artifact.mjs";

const environment = {
  ASKLAKE_EMR_SERVERLESS_APPLICATION_ID: "00batchapplication",
  ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI: "s3://asklake-artifacts/emr-serverless",
  ASKLAKE_EMR_SERVERLESS_CONTINUOUS_APPLICATION_ID: "00streamapplication",
  ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED: "true",
  ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENTRY_POINT_URI: "s3://asklake-artifacts/emr-serverless/kafka_continuous_stream.py",
  ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_FAILED_ATTEMPTS_PER_HOUR: "7",
  ASKLAKE_EMR_SERVERLESS_ENABLED: "true",
  ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI: "s3://asklake-artifacts/emr-serverless/spark_job_run.py",
  ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/AskLakeEmrServerlessJobRole",
  ASKLAKE_EMR_SERVERLESS_LOG_URI: "s3://asklake-logs/emr-serverless",
  ASKLAKE_EMR_SERVERLESS_POLL_INTERVAL_MS: "250",
  ASKLAKE_SPARK_OUTPUT_BUCKET: "asklake-output-production",
  AWS_REGION: "ap-northeast-2",
};

const config = emrServerlessContinuousConfig(environment);
assert.equal(config.applicationId, "00streamapplication");
assert.equal(config.maxFailedAttemptsPerHour, 7);
assert.equal(config.pyFilesUris.length, 3);
assert.match(config.mskIamPackage, /aws-msk-iam-auth:2\.3\.6$/);
assert.throws(
  () => emrServerlessContinuousConfig({ ...environment, ASKLAKE_EMR_SERVERLESS_CONTINUOUS_ENABLED: "false" }),
  (error) => error?.code === "EMR_SERVERLESS_CONTINUOUS_DISABLED",
);
assert.throws(
  () => emrServerlessContinuousConfig({ ...environment, ASKLAKE_EMR_SERVERLESS_CONTINUOUS_MAX_FAILED_ATTEMPTS_PER_HOUR: "11" }),
  (error) => error?.code === "EMR_SERVERLESS_CONFIGURATION_INVALID",
);

const artifacts = emrServerlessContinuousArtifactUris("JOB Phase 5", "attempt-phase-5", environment);
const submission = createEmrServerlessContinuousSubmission({
  appName: "AskLake Phase 5",
  checkpointPath: "s3a://asklake-output-production/asklake/prod/datasets/reviews/bronze/_checkpoints/job-phase-5",
  jobId: "job-phase-5",
  manifestUri: artifacts.manifestUri,
  outputPath: "s3a://asklake-output-production/asklake/prod/datasets/reviews/bronze",
  reportUri: artifacts.reportUri,
  workerAttemptId: "attempt-phase-5",
}, environment);
assert.equal(submission.mode, "STREAMING");
assert.deepEqual(submission.retryPolicy, { maxFailedAttemptsPerHour: 7 });
assert.equal(submission.executionTimeoutMinutes, undefined);
assert.equal(submission.jobDriver.sparkSubmit.entryPoint, config.entryPointUri);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /asklake-continuous-manifest\.json/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /spark\.sql\.streaming\.stopGracefullyOnShutdown=true/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /aws-msk-iam-auth:2\.3\.6/);
assert.doesNotMatch(JSON.stringify(submission), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/);

async function main() {
const artifactS3 = new FakeS3Client();
const uploaded = await uploadEmrServerlessArtifact(
  environment,
  { s3Client: artifactS3 },
  { continuous: true },
);
assert.equal(uploaded.mode, "STREAMING");
assert.equal(uploaded.entryPointUri, config.entryPointUri);
assert.equal(uploaded.dependencies.length, 3);
assert.equal(artifactS3.putCount, 4, "Continuous artifact upload must include the three imported Python helpers.");

const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "asklake-emr-continuous-"));
try {
  const stateFile = path.join(temporaryDir, "job.emr-state.json");
  const catalogAckFile = path.join(temporaryDir, "job.catalog-ack.json");
  const emr = new FakeEmrClient();
  const s3 = new FakeS3Client();
  const request = {
    checkpointPath: "s3a://asklake-output-production/asklake/prod/datasets/reviews/bronze/_checkpoints/job-phase-5",
    jobId: "job-phase-5",
    outputPath: "s3a://asklake-output-production/asklake/prod/datasets/reviews/bronze",
    tail: 100,
  };
  const sparkEnvironment = (workerAttemptId, reportUri) => ({
    ASKLAKE_CONTINUOUS_BROKER: "boot-a.example.amazonaws.com:9098,boot-b.example.amazonaws.com:9098",
    ASKLAKE_CONTINUOUS_CHECKPOINT_PATH: request.checkpointPath,
    ASKLAKE_CONTINUOUS_COMMAND_FILE: "",
    ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID: "asklake-phase-5",
    ASKLAKE_CONTINUOUS_JOB_ID: request.jobId,
    ASKLAKE_CONTINUOUS_KAFKA_SASL_MECHANISM: "AWS_MSK_IAM",
    ASKLAKE_CONTINUOUS_OUTPUT_PATH: request.outputPath,
    ASKLAKE_CONTINUOUS_REPORT_FILE: reportUri.replace(/^s3:\/\//, "s3a://"),
    ASKLAKE_CONTINUOUS_TOPIC: "asklake.staging.reviews",
    ASKLAKE_CONTINUOUS_WORKER_ATTEMPT_ID: workerAttemptId,
  });
  const operation = (action, overrides = {}) => manageEmrServerlessContinuous({
    action,
    catalogAckFile,
    environment,
    request: { ...request, ...overrides },
    sparkEnvironment,
    stateFile,
  }, { emrClient: emr, s3Client: s3, sleep: async () => {} });

  const started = await operation("start");
  assert.equal(started.containerState, "running");
  assert.equal(started.runtime, "emr-serverless");
  assert.equal(started.jobRunId, "jr-stream-1");
  assert.equal(started.attempt, 1);
  assert(started.workerAttemptId);
  assert.equal(emr.startCount, 1);
  assert.equal(emr.lastStartInput.mode, "STREAMING");
  assert.equal(emr.lastStartInput.executionTimeoutMinutes, undefined);

  const duplicate = await operation("start");
  assert.equal(duplicate.jobRunId, started.jobRunId);
  assert.equal(duplicate.workerAttemptId, started.workerAttemptId);
  assert.equal(duplicate.started, false);
  assert.equal(emr.startCount, 1, "An active persisted Job Run must not be submitted twice.");

  const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  const manifest = JSON.parse(s3.objectText(persisted.manifestUri));
  assert.equal(manifest.workerAttemptId, started.workerAttemptId);
  assert.equal(manifest.environment.ASKLAKE_CONTINUOUS_KAFKA_SASL_MECHANISM, "AWS_MSK_IAM");
  assert.doesNotMatch(JSON.stringify(manifest), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/);
  s3.putJson(persisted.reportUri, {
    consumedCount: 120,
    heartbeatAt: "2026-07-14T00:00:00Z",
    lag: 8,
    lagAvailable: true,
    status: "running",
    storedCount: 118,
    workerAttemptId: started.workerAttemptId,
  });
  const restartedBackendStatus = await operation("status");
  assert.equal(restartedBackendStatus.jobRunId, started.jobRunId);
  assert.equal(restartedBackendStatus.report.storedCount, 118);
  assert.match(restartedBackendStatus.runtimeLogReference.uri, /attempts\/1\/$/);
  assert.equal(emr.startCount, 1);

  writeFileSync(catalogAckFile, '{"batchId":9}\n', "utf8");
  await operation("status");
  assert.equal(s3.objectText(persisted.reportUri.replace(/(?:\.[^./]+)?$/, ".catalog-ack.json")).trim(), '{"batchId":9}');

  const pause = await operation("pause");
  assert.equal(pause.containerState, "pauseRequested");
  assert.equal(emr.cancelCount, 1);
  assert.equal(emr.lastCancelInput.shutdownGracePeriodInSeconds, config.cancelGracePeriodSeconds);
  emr.setState(started.jobRunId, "CANCELLED");
  const paused = await operation("status");
  assert.equal(paused.containerState, "exited");
  assert.equal(paused.requestedAction, "pause");

  const resumed = await operation("start");
  assert.equal(resumed.jobRunId, "jr-stream-2");
  assert.notEqual(resumed.workerAttemptId, started.workerAttemptId);
  assert.equal(resumed.lastSuccessfulCheckpoint, request.checkpointPath);
  assert.equal(emr.startCount, 2);

  emr.setState(resumed.jobRunId, "FAILED", "token=do-not-leak unrecoverable stream failure");
  const failed = await operation("status");
  assert.equal(failed.containerState, "exited");
  assert.equal(failed.report.status, "failed");
  assert.match(failed.report.lastError, /unrecoverable stream failure/);
  const logs = await operation("logs", { tail: 100 });
  assert(logs.lines.some((line) => line.includes("[REDACTED]")));
  assert(logs.lines.every((line) => !line.includes("do-not-leak")));

  writeFileSync(`${stateFile}.lock`, `${JSON.stringify({ createdAt: Date.now(), pid: 2147483647 })}\n`, "utf8");
  const recoveredAfterCrash = await operation("start");
  assert.equal(recoveredAfterCrash.jobRunId, "jr-stream-3");
  assert.equal(emr.startCount, 3, "A dead process lock must not block a checkpoint resume.");
  const forced = await operation("terminate");
  assert.equal(forced.containerState, "terminateRequested");
  assert.equal(emr.lastCancelInput.shutdownGracePeriodInSeconds, 1);

  console.log("EMR Serverless Continuous verified: STREAMING submission, MSK IAM manifest, S3 report/ack, restart reconnect, pause/resume, stale-lock recovery, forced cancel, failure/log evidence.");
} finally {
  rmSync(temporaryDir, { force: true, recursive: true });
}
}

class FakeEmrClient {
  constructor() {
    this.cancelCount = 0;
    this.jobs = new Map();
    this.startCount = 0;
    this.tokens = new Map();
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "StartJobRunCommand") {
      this.lastStartInput = input;
      if (this.tokens.has(input.clientToken)) return { jobRunId: this.tokens.get(input.clientToken) };
      const jobRunId = `jr-stream-${++this.startCount}`;
      this.tokens.set(input.clientToken, jobRunId);
      this.jobs.set(jobRunId, { attempt: 1, state: "RUNNING", stateDetails: null });
      return { jobRunId };
    }
    if (name === "GetJobRunCommand") {
      const job = this.jobs.get(input.jobRunId);
      if (!job) throw Object.assign(new Error("missing"), { name: "ResourceNotFoundException" });
      return {
        jobRun: {
          attempt: job.attempt,
          jobRunId: input.jobRunId,
          startedAt: new Date("2026-07-14T00:00:00Z"),
          state: job.state,
          stateDetails: job.stateDetails,
        },
      };
    }
    if (name === "CancelJobRunCommand") {
      this.cancelCount += 1;
      this.lastCancelInput = input;
      const job = this.jobs.get(input.jobRunId);
      if (job) job.state = "CANCELLING";
      return {};
    }
    throw new Error(`Unexpected EMR command: ${name}`);
  }

  setState(jobRunId, state, stateDetails = null) {
    const job = this.jobs.get(jobRunId);
    assert(job, `Unknown fake Job Run: ${jobRunId}`);
    job.state = state;
    job.stateDetails = stateDetails;
  }
}

class FakeS3Client {
  constructor() {
    this.objects = new Map();
    this.putCount = 0;
  }

  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    const key = `${input.Bucket}/${input.Key}`;
    if (name === "PutObjectCommand") {
      this.putCount += 1;
      this.objects.set(key, Buffer.isBuffer(input.Body) ? input.Body.toString("utf8") : String(input.Body));
      return { ETag: `\"etag-${this.putCount}\"` };
    }
    if (name === "GetObjectCommand") {
      if (!this.objects.has(key)) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => this.objects.get(key) } };
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }

  objectText(uri) {
    const target = parseS3(uri);
    return this.objects.get(`${target.bucket}/${target.key}`);
  }

  putJson(uri, value) {
    const target = parseS3(uri);
    this.objects.set(`${target.bucket}/${target.key}`, `${JSON.stringify(value)}\n`);
  }
}

function parseS3(uri) {
  const match = /^s3a?:\/\/([^/]+)\/(.+)$/.exec(uri);
  assert(match, `Invalid S3 URI: ${uri}`);
  return { bucket: match[1], key: match[2] };
}

await main();
