import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCredentialFree,
  createEmrServerlessBatchSubmission,
  emrServerlessArtifactUris,
  emrServerlessConfig,
  normalizeEmrServerlessState,
  safeEmrServerlessMessage,
} from "../src/emrServerless.mjs";
import {
  cancelEmrServerlessSubmissionFromState,
  runEmrServerlessRequest,
  TerminalEmrServerlessError,
} from "./emr-serverless-client.mjs";
import { uploadEmrServerlessArtifact } from "./upload-emr-serverless-artifact.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const environment = {
  ASKLAKE_EMR_SERVERLESS_ADMISSION_ENABLED: "true",
  ASKLAKE_EMR_SERVERLESS_APPLICATION_ID: "00fakeapplication",
  ASKLAKE_EMR_SERVERLESS_ARTIFACT_URI: "s3://asklake-artifacts/emr-serverless",
  ASKLAKE_EMR_SERVERLESS_ENABLED: "true",
  ASKLAKE_EMR_SERVERLESS_ENTRY_POINT_URI: "s3://asklake-artifacts/emr-serverless/spark_job_run.py",
  ASKLAKE_EMR_SERVERLESS_EXECUTION_ROLE_ARN: "arn:aws:iam::123456789012:role/AskLakeEmrServerlessJobRole",
  ASKLAKE_EMR_SERVERLESS_LOG_URI: "s3://asklake-logs/emr-serverless",
  ASKLAKE_EMR_SERVERLESS_POLL_INTERVAL_MS: "250",
  ASKLAKE_SPARK_OUTPUT_BUCKET: "asklake-output-production",
  AWS_REGION: "ap-northeast-2",
};

const config = emrServerlessConfig(environment);

async function main() {
assert.equal(config.region, "ap-northeast-2");
assert.equal(config.maxExecutors, 10);
assert.equal(config.logUri, "s3://asklake-logs/emr-serverless/");
assert.throws(
  () => emrServerlessConfig({ ...environment, ASKLAKE_EMR_SERVERLESS_ENABLED: "false" }),
  (error) => error?.code === "EMR_SERVERLESS_DISABLED",
);
assert.throws(
  () => emrServerlessConfig({ ...environment, ASKLAKE_EMR_SERVERLESS_APPLICATION_ID: "" }),
  (error) => error?.code === "EMR_SERVERLESS_CONFIGURATION_INVALID",
);
assert.throws(
  () => assertCredentialFree({ AWS_SECRET_ACCESS_KEY: "must-not-pass" }),
  (error) => error?.code === "EMR_SERVERLESS_CONFIGURATION_INVALID",
);
assert.throws(
  () => assertCredentialFree({ credentials: { secretAccessKey: "must-not-pass" } }),
  (error) => error?.code === "EMR_SERVERLESS_CONFIGURATION_INVALID",
);

const artifacts = emrServerlessArtifactUris("Run Phase 3", environment);
const submission = createEmrServerlessBatchSubmission({
  appName: "AskLake Phase 3",
  jobId: "job-phase-3",
  manifestUri: artifacts.manifestUri,
  packages: [
    "org.postgresql:postgresql:42.7.5",
    "org.apache.hadoop:hadoop-aws:3.3.4",
  ],
  reportUri: artifacts.reportUri,
  runId: "run-phase-3",
  sparkEnvironment: {
    ASKLAKE_SPARK_OUTPUT_PATH: "s3a://asklake-output-production/asklake/prod/datasets/orders/silver/run-phase-3",
    ASKLAKE_SPARK_SOURCE_FORMAT: "parquet",
    ASKLAKE_SPARK_SOURCE_PATH: "s3a://asklake-source/orders/",
  },
}, environment);
assert.equal(submission.applicationId, config.applicationId);
assert.equal(submission.mode, "BATCH");
assert.equal(submission.jobDriver.sparkSubmit.entryPoint, config.entryPointUri);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /spark\.dynamicAllocation\.maxExecutors=10/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /spark\.emr-serverless\.driver\.disk=20g/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /spark\.emr-serverless\.executor\.disk=20g/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /spark\.emr-serverless\.driverEnv\.ASKLAKE_SPARK_REPORT_FILE=/);
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /--py-files/);
for (const name of ["object_storage_runtime.py", "snapshot_rule_runtime.py", "spark_snapshot_rules.py", "spark_source_identity.py"]) {
  assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, new RegExp(name.replace(".", "\\.")));
}
assert.match(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /org\.postgresql:postgresql:42\.7\.5/);
assert.doesNotMatch(submission.jobDriver.sparkSubmit.sparkSubmitParameters, /hadoop-aws/);
assert.doesNotMatch(JSON.stringify(submission), /AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/);

const artifactS3 = new FakeS3Client({});
const uploadedArtifact = await uploadEmrServerlessArtifact(environment, { s3Client: artifactS3 });
assert.equal(uploadedArtifact.entryPointUri, config.entryPointUri);
assert.equal(uploadedArtifact.checksum.length, 64);
assert.equal(uploadedArtifact.dependencies.length, 4);
assert.equal(artifactS3.putCount, 5);
const entryPointPut = artifactS3.putInputs.find((input) => input.Key === "emr-serverless/spark_job_run.py");
assert.equal(entryPointPut.Bucket, "asklake-artifacts");
assert.equal(entryPointPut.Metadata["asklake-sha256"], uploadedArtifact.checksum);
for (const name of ["object_storage_runtime.py", "snapshot_rule_runtime.py", "spark_snapshot_rules.py", "spark_source_identity.py"]) {
  assert.ok(artifactS3.putInputs.some((input) => input.Key === `emr-serverless/python/${name}`));
}

assert.equal(normalizeEmrServerlessState("QUEUED"), "queued");
assert.equal(normalizeEmrServerlessState("RUNNING"), "running");
assert.equal(normalizeEmrServerlessState("SUCCESS"), "success");
assert.equal(normalizeEmrServerlessState("CANCELLED"), "canceled");
assert.equal(
  safeEmrServerlessMessage("aws_secret_access_key=secret-value"),
  "aws_secret_access_key=[REDACTED]",
);

const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "asklake-emr-contract-"));
try {
  const manifestFile = path.join(temporaryDir, "manifest.json");
  const stateFile = path.join(temporaryDir, "run-state.json");
  writeFileSync(manifestFile, '{"schemaColumns":[]}\n', "utf8");
  const report = {
    endedAt: "2026-07-14T00:00:01.000Z",
    inputRows: 10,
    outputPath: "s3a://asklake-output-production/asklake/prod/datasets/orders/silver/run-phase-3",
    outputRows: 10,
    runId: "run-phase-3",
    startedAt: "2026-07-14T00:00:00.000Z",
    status: "success",
  };
  const emr = new FakeEmrClient(["RUNNING", "SUCCESS"]);
  const s3 = new FakeS3Client(report);
  const request = {
    config,
    environment,
    manifestFile,
    manifestUri: artifacts.manifestUri,
    pollIntervalMs: 25,
    reportUri: artifacts.reportUri,
    stateFile,
    submission,
    timeoutMs: 2_000,
  };
  const completed = await runEmrServerlessRequest(request, {
    emrClient: emr,
    s3Client: s3,
    sleep: async () => {},
  });
  assert.equal(completed.report.status, "success");
  assert.equal(completed.report.runtime.id, "emr-serverless");
  assert.equal(completed.report.runtimeJobId, "jr-phase-3");
  assert.equal(completed.report.emrApplicationAdmission.enabled, true);
  assert.match(completed.report.runtimeLogReference.uri, /applications\/00fakeapplication\/jobs\/jr-phase-3\/$/);
  assert.equal(emr.startCount, 1);
  assert.equal(s3.putCount, 1);

  const resumed = await runEmrServerlessRequest(request, {
    emrClient: emr,
    s3Client: s3,
    sleep: async () => {},
  });
  assert.equal(resumed.report.runtimeJobId, "jr-phase-3");
  assert.equal(emr.startCount, 1, "A persisted Job Run must not be submitted twice after restart.");
  assert.equal(s3.putCount, 1, "A persisted Job Run must not upload a second manifest.");

  const submittingStateFile = path.join(temporaryDir, "submitting-state.json");
  writeFileSync(submittingStateFile, `${JSON.stringify({
    applicationId: config.applicationId,
    clientToken: submission.clientToken,
    createdAt: "2026-07-14T00:00:00.000Z",
    logUri: config.logUri,
    manifestUri: artifacts.manifestUri,
    region: config.region,
    reportUri: artifacts.reportUri,
    runner: "emr-serverless",
    state: "SUBMITTING",
    updatedAt: "2026-07-14T00:00:00.000Z",
    version: 1,
  })}\n`, "utf8");
  const submittingClient = new FakeEmrClient(["SUCCESS"], "jr-resumed-submit");
  const resumedSubmission = await runEmrServerlessRequest(
    { ...request, stateFile: submittingStateFile },
    {
      emrClient: submittingClient,
      s3Client: new FakeS3Client(report),
      sleep: async () => {},
    },
  );
  assert.equal(resumedSubmission.report.runtimeJobId, "jr-resumed-submit");
  assert.equal(submittingClient.startCount, 1);
  assert.equal(submittingClient.lastStartInput.clientToken, submission.clientToken);

  const cancelStateFile = path.join(temporaryDir, "cancel-state.json");
  writeFileSync(cancelStateFile, `${JSON.stringify({
    applicationId: config.applicationId,
    createdAt: "2026-07-14T00:00:00.000Z",
    jobRunId: "jr-cancel",
    logUri: config.logUri,
    manifestUri: artifacts.manifestUri,
    region: config.region,
    reportUri: artifacts.reportUri,
    runner: "emr-serverless",
    state: "RUNNING",
    updatedAt: "2026-07-14T00:00:00.000Z",
    version: 1,
  })}\n`, "utf8");
  const cancelClient = new FakeEmrClient(["RUNNING"], "jr-cancel");
  const canceled = await cancelEmrServerlessSubmissionFromState(
    cancelStateFile,
    environment,
    { emrClient: cancelClient, s3Client: new FakeS3Client(report) },
  );
  assert.equal(canceled.canceled, true);
  assert.equal(cancelClient.cancelCount, 1);

  const preCanceledStateFile = path.join(temporaryDir, "pre-canceled-state.json");
  writeFileSync(`${preCanceledStateFile}.cancel-requested`, "{}\n", "utf8");
  const preCanceledClient = new FakeEmrClient(["SUCCESS"], "jr-never-created");
  await assert.rejects(
    runEmrServerlessRequest(
      { ...request, stateFile: preCanceledStateFile },
      { emrClient: preCanceledClient, s3Client: new FakeS3Client(report), sleep: async () => {} },
    ),
    (error) => error?.code === "EMR_SERVERLESS_CANCELLED" && error?.status === 409,
  );
  assert.equal(preCanceledClient.startCount, 0);

  const bridgeStateFile = path.join(temporaryDir, "bridge-state.json");
  writeFileSync(`${bridgeStateFile}.cancel-requested`, "{}\n", "utf8");
  const bridge = spawnSync(process.execPath, [path.join(backendDir, "scripts", "run-spark-job-once.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      APP_ENV: "production",
      ASKLAKE_OBJECT_STORAGE_PROVIDER: "aws",
      ASKLAKE_SPARK_OUTPUT_MODE: "s3a",
      ASKLAKE_SPARK_REPORT_DIR: temporaryDir,
      ASKLAKE_SPARK_RUNTIME: "emr-serverless",
      S3_FORCE_PATH_STYLE: "false",
    },
    input: JSON.stringify({
      command: "run",
      job: {
        datasetId: "ds_phase_3",
        id: "job-phase-3",
        name: "phase-3-emr-bridge",
        qualityRules: [],
        rules: [],
        schemaColumns: [{ included: true, sourceName: "id", targetName: "id", type: "String" }],
        source: "File / S3",
        sourceConfig: [
          ["Bucket / Stage Name", "asklake-source"],
          ["Path / Prefix", "orders/input.parquet"],
          ["File Format", "parquet"],
        ],
        sourceType: "File / S3",
        target: "orders_silver",
        targetLayer: "SILVER",
        transformSteps: [],
      },
      runId: "run-emr-bridge",
      sparkRuntimeStateFile: bridgeStateFile,
      sparkRuntimeTimeoutMs: 1_000,
    }),
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(bridge.status, 0, bridge.stderr);
  const bridgeMarker = String(bridge.stdout || "").split(/\r?\n/)
    .find((line) => line.startsWith("ASKLAKE_SPARK_RUN_RESULT="));
  assert(bridgeMarker, "The EMR Batch adapter did not return a Spark Run result marker.");
  const bridgeResult = JSON.parse(bridgeMarker.slice("ASKLAKE_SPARK_RUN_RESULT=".length));
  assert.equal(bridgeResult.status, "failed");
  assert.equal(bridgeResult.errorCode, "EMR_SERVERLESS_CANCELLED");
  assert.equal(bridgeResult.errorStatus, 409);
  assert.doesNotMatch(`${bridge.stdout}\n${bridge.stderr}`, /AKIA[0-9A-Z]{16}|AWS_SECRET_ACCESS_KEY=/);

  const failedStateFile = path.join(temporaryDir, "failed-state.json");
  const failedClient = new FakeEmrClient(["FAILED"], "jr-failed");
  await assert.rejects(
    runEmrServerlessRequest(
      { ...request, stateFile: failedStateFile },
      {
        emrClient: failedClient,
        s3Client: new FakeS3Client(null),
        sleep: async () => {},
      },
    ),
    (error) => error instanceof TerminalEmrServerlessError
      && error.code === "EMR_SERVERLESS_JOB_FAILED",
  );

  const persistedState = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persistedState.jobRunId, "jr-phase-3");
  assert.doesNotMatch(JSON.stringify(persistedState), /access.?key|secret.?key|session.?token/i);
} finally {
  rmSync(temporaryDir, { force: true, recursive: true });
}

console.log(
  "EMR Serverless contract verified: secure submission, S3 artifacts, polling, cancellation, failure, and restart reuse.",
);
}

class FakeEmrClient {
  constructor(states, jobRunId = "jr-phase-3") {
    this.cancelCount = 0;
    this.getCount = 0;
    this.getApplicationCount = 0;
    this.jobRunId = jobRunId;
    this.startCount = 0;
    this.states = [...states];
  }

  async send(command) {
    if (command.constructor.name === "GetApplicationCommand") {
      this.getApplicationCount += 1;
      return {
        application: {
          applicationId: config.applicationId,
          autoStopConfiguration: { enabled: true, idleTimeoutMinutes: 15 },
          jobLevelCostAllocationConfiguration: { enabled: true },
          maximumCapacity: { cpu: "80 vCPU", memory: "320 GB", disk: "2000 GB" },
          schedulerConfiguration: { maxConcurrentRuns: 4, queueTimeoutMinutes: 60 },
          state: "STARTED",
          type: "SPARK",
        },
      };
    }
    if (command.constructor.name === "StartJobRunCommand") {
      this.startCount += 1;
      this.lastStartInput = command.input;
      return { applicationId: config.applicationId, jobRunId: this.jobRunId };
    }
    if (command.constructor.name === "GetJobRunCommand") {
      const index = Math.min(this.getCount, this.states.length - 1);
      const state = this.states[index] || "SUCCESS";
      this.getCount += 1;
      return {
        jobRun: {
          applicationId: config.applicationId,
          attempt: 1,
          jobRunId: this.jobRunId,
          state,
          stateDetails: state === "FAILED" ? "Fixture schema mismatch" : "",
        },
      };
    }
    if (command.constructor.name === "CancelJobRunCommand") {
      this.cancelCount += 1;
      return { applicationId: config.applicationId, jobRunId: this.jobRunId };
    }
    throw new Error(`Unexpected EMR command: ${command.constructor.name}`);
  }
}

class FakeS3Client {
  constructor(report) {
    this.putCount = 0;
    this.putInputs = [];
    this.report = report;
  }

  async send(command) {
    if (command.constructor.name === "PutObjectCommand") {
      this.putCount += 1;
      this.lastPutInput = command.input;
      this.putInputs.push(command.input);
      return { ETag: "fixture-etag" };
    }
    if (command.constructor.name === "GetObjectCommand") {
      if (this.report === null) {
        const error = new Error("No such report");
        error.name = "NoSuchKey";
        throw error;
      }
      return {
        Body: {
          transformToString: async () => JSON.stringify(this.report),
        },
      };
    }
    throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
  }
}

await main();
