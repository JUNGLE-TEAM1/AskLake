import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.dirname(scriptsDir);
const continuousScript = path.join(scriptsDir, "manage-kafka-continuous.mjs");
const maintenanceScript = path.join(scriptsDir, "manage-kafka-continuous-maintenance.mjs");
const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "asklake-continuous-rest-"));
const reportDir = path.join(temporaryDir, "reports");
const ivyDir = path.join(temporaryDir, "ivy");
const fakeBinDir = path.join(temporaryDir, "bin");
const dockerCallMarker = path.join(temporaryDir, "docker-called.txt");
const minioAccessSentinel = "REST_BODY_ACCESS_SENTINEL";
const minioSecretSentinel = "REST_BODY_SECRET_SENTINEL";
mkdirSync(reportDir, { recursive: true });
mkdirSync(ivyDir, { recursive: true });
mkdirSync(fakeBinDir, { recursive: true });
installDockerSentinel(fakeBinDir);

const submissions = new Map();
const createRequests = [];
const killRequests = [];
let continuousCreateCount = 0;
let maintenanceCreateCount = 0;

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/v1/submissions/create") {
      const body = JSON.parse(await readBody(request));
      createRequests.push(body);
      const isMaintenance = String(body.appArgs?.[0] || "").endsWith("/kafka_continuous_maintenance.py");
      const submissionId = isMaintenance
        ? `maintenance-${++maintenanceCreateCount}`
        : `continuous-${++continuousCreateCount}`;
      submissions.set(submissionId, {
        body,
        isMaintenance,
        killed: false,
        polls: 0,
      });
      return json(response, 200, { success: true, submissionId });
    }

    const statusMatch = request.url?.match(/^\/v1\/submissions\/status\/([^/]+)$/);
    if (request.method === "GET" && statusMatch) {
      const submissionId = decodeURIComponent(statusMatch[1]);
      const submission = submissions.get(submissionId);
      if (!submission) return json(response, 200, { message: "unknown submission", success: false });
      submission.polls += 1;
      let driverState;
      if (submission.killed) {
        driverState = "KILLED";
      } else if (submission.forceRunning) {
        driverState = "RUNNING";
      } else if (submission.isMaintenance) {
        driverState = submission.polls === 1 ? "UNKNOWN" : "FINISHED";
        if (driverState === "FINISHED") publishMaintenanceArtifact(submission.body);
      } else {
        driverState = submission.polls === 1 ? "UNKNOWN" : "RUNNING";
      }
      return json(response, 200, { driverState, submissionId, success: true });
    }

    const killMatch = request.url?.match(/^\/v1\/submissions\/kill\/([^/]+)$/);
    if (request.method === "POST" && killMatch) {
      const submissionId = decodeURIComponent(killMatch[1]);
      const submission = submissions.get(submissionId);
      if (!submission) return json(response, 200, { message: "unknown submission", success: false });
      submission.killed = true;
      killRequests.push(submissionId);
      return json(response, 200, { submissionId, success: true });
    }

    return json(response, 404, { message: "not found", success: false });
  } catch (error) {
    return json(response, 500, { message: error?.message || String(error), success: false });
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert(address && typeof address === "object");
  const environment = {
    ...process.env,
    APP_ENV: "production",
    ASKLAKE_CONTINUOUS_MAINTENANCE_TIMEOUT_MS: "5000",
    ASKLAKE_DOCKER_CALL_MARKER: dockerCallMarker,
    ASKLAKE_SPARK_CONTINUOUS_MAINTENANCE_SCRIPT: "/opt/asklake/scripts/kafka_continuous_maintenance.py",
    ASKLAKE_SPARK_CONTINUOUS_SCRIPT: "/opt/asklake/scripts/kafka_continuous_stream.py",
    ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: "none",
    ASKLAKE_SPARK_ICEBERG_PACKAGE: "none",
    ASKLAKE_SPARK_IVY_DIR: ivyDir,
    ASKLAKE_SPARK_IVY_RUNTIME_DIR: "/var/lib/asklake/spark-ivy",
    ASKLAKE_SPARK_JOB_SCRIPT: "/opt/asklake/scripts/spark_job_run.py",
    ASKLAKE_SPARK_KAFKA_PACKAGE: "none",
    ASKLAKE_SPARK_POSTGRES_PACKAGE: "none",
    ASKLAKE_SPARK_MASTER_URL: "spark://spark-master:7077",
    ASKLAKE_SPARK_REPORT_CONTAINER_DIR: "/var/lib/asklake/spark-runs",
    ASKLAKE_SPARK_REPORT_DIR: reportDir,
    ASKLAKE_SPARK_REST_POLL_INTERVAL_MS: "250",
    ASKLAKE_SPARK_REST_URL: `http://127.0.0.1:${address.port}`,
    ASKLAKE_SPARK_RUNNER: "rest",
    ASKLAKE_SPARK_SCRIPT_DIR: "/opt/asklake/scripts",
    ASKLAKE_SPARK_SOURCE_INSPECT_SCRIPT: "/opt/asklake/scripts/spark_source_inspect_rest.py",
    MINIO_ACCESS_KEY: minioAccessSentinel,
    MINIO_SECRET_KEY: minioSecretSentinel,
    TRINO_ICEBERG_JDBC_PASSWORD: "rest-contract-password",
    TRINO_ICEBERG_JDBC_USER: "rest-contract-user",
    TRINO_ICEBERG_WAREHOUSE_BUCKET: "asklake-warehouse",
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
  };

  const jobId = "job-rest-contract";
  const workerRequest = {
    action: "start",
    broker: "redpanda:9092",
    checkpointPath: "s3a://asklake-output/checkpoints/job-rest-contract",
    consumerGroupId: "asklake-rest-contract",
    initialCounts: {},
    initialMetrics: {},
    initialOffsetPolicy: "earliest",
    initialSchemaState: {},
    icebergTarget: {
      catalog: "iceberg",
      namespace: "asklake",
      partitionColumns: [],
      table: "reviews_rest_contract",
      tableUri: "iceberg://iceberg/asklake/reviews_rest_contract",
      writeMode: "append",
    },
    jobId,
    maxOffsetsPerTrigger: 100,
    outputPath: "/tmp/continuous-output",
    ruleContractVersion: "1.0",
    ruleFingerprint: "rule-rest-contract-v1",
    ruleOutputSchema: [["value", "string"]],
    rules: [],
    schemaColumns: [{ included: true, nullable: true, sourceName: "value", targetName: "value", type: "string" }],
    schemaFingerprint: "schema-rest-contract-v1",
    schemaEvolutionPolicy: {},
    topic: "reviews.rest.contract",
    triggerIntervalSeconds: 5,
  };

  const emptyStatus = await continuousAction("status", workerRequest, environment);
  assert.equal(emptyStatus.containerState, "missing");
  assert.equal(emptyStatus.containerId, null);
  assert.equal(emptyStatus.workerAttemptId, null);
  const emptyLogs = await continuousAction("logs", { ...workerRequest, tail: 100 }, environment);
  assert.equal(emptyLogs.containerState, "missing");
  assert.deepEqual(emptyLogs.lines, []);

  const started = await runManager(continuousScript, workerRequest, environment, "ASKLAKE_KAFKA_CONTINUOUS_RESULT");
  assert.equal(started.containerState, "starting");
  assert.equal(started.containerId, "continuous-1");
  assert.equal(started.started, true);
  assert(started.workerAttemptId);

  const duplicateStart = await runManager(continuousScript, workerRequest, environment, "ASKLAKE_KAFKA_CONTINUOUS_RESULT");
  assert.equal(duplicateStart.containerId, started.containerId);
  assert.equal(duplicateStart.workerAttemptId, started.workerAttemptId);
  assert.equal(duplicateStart.containerState, "unknown");
  assert.equal(duplicateStart.started, false);
  assert.equal(continuousCreateCount, 1, "UNKNOWN status must not create a duplicate continuous driver.");

  const restartedBackendStatus = await continuousAction("status", workerRequest, environment);
  assert.equal(restartedBackendStatus.containerState, "running");
  assert.equal(restartedBackendStatus.containerId, started.containerId);
  assert.equal(restartedBackendStatus.workerAttemptId, started.workerAttemptId);

  const reportFile = path.join(reportDir, `kafka-continuous-${jobId}.json`);
  writeFileSync(reportFile, JSON.stringify({
    heartbeatAt: "2026-07-12T00:00:00Z",
    lastError: "token=secret-value",
    status: "running",
    workerAttemptId: started.workerAttemptId,
  }), "utf8");
  const logs = await continuousAction("logs", { ...workerRequest, tail: 100 }, environment);
  assert.equal(logs.containerState, "running");
  assert(logs.lines.some((line) => line.includes("worker report status=running")));
  assert(logs.lines.some((line) => line.includes("[REDACTED]")));
  assert(logs.lines.every((line) => !line.includes("secret-value")));

  const pause = await continuousAction("pause", workerRequest, environment);
  assert.equal(pause.containerState, "pauseRequested");
  assert.equal(killRequests.at(-1), "continuous-1");
  const pausedStatus = await continuousAction("status", workerRequest, environment);
  assert.equal(pausedStatus.containerState, "exited");
  assert.equal(pausedStatus.requestedAction, "pause");

  const resumed = await runManager(continuousScript, workerRequest, environment, "ASKLAKE_KAFKA_CONTINUOUS_RESULT");
  assert.equal(resumed.containerId, "continuous-2");
  assert.notEqual(resumed.workerAttemptId, started.workerAttemptId);
  assert.equal(resumed.started, true);
  assert.equal(existsSync(reportFile), false, "A new worker attempt must clear the previous report.");

  const stop = await continuousAction("stop", workerRequest, environment);
  assert.equal(stop.containerState, "stopRequested");
  assert.equal(killRequests.at(-1), "continuous-2");
  const stoppedStatus = await continuousAction("status", workerRequest, environment);
  assert.equal(stoppedStatus.containerState, "exited");
  assert.equal(stoppedStatus.requestedAction, "stop");

  const thirdAttempt = await runManager(continuousScript, workerRequest, environment, "ASKLAKE_KAFKA_CONTINUOUS_RESULT");
  assert.equal(thirdAttempt.containerId, "continuous-3");
  const terminate = await continuousAction("terminate", workerRequest, environment);
  assert.equal(terminate.containerState, "terminateRequested");
  assert.equal(killRequests.at(-1), "continuous-3");
  const terminatedStatus = await continuousAction("status", workerRequest, environment);
  assert.equal(terminatedStatus.containerState, "exited");
  assert.equal(terminatedStatus.requestedAction, null);

  const persistedState = JSON.parse(readFileSync(
    path.join(reportDir, `kafka-continuous-${jobId}.state.json`),
    "utf8",
  ));
  assert.equal(persistedState.submissionId, "continuous-3");
  assert.equal(persistedState.workerAttemptId, thirdAttempt.workerAttemptId);

  const maintenanceRunId = "maintenance-artifact-contract";
  const maintenance = await runManager(maintenanceScript, {
    ...workerRequest,
    action: "run",
    kind: "inspect_quarantine",
    limit: 25,
    runId: maintenanceRunId,
  }, environment, "ASKLAKE_KAFKA_MAINTENANCE_RESULT");
  assert.deepEqual(maintenance.records, [{ offset: 7, partition: 0, topic: "reviews.rest.contract" }]);
  assert.equal(maintenance.runId, maintenanceRunId);
  assert.equal(maintenance.total, 1);
  assert.equal(maintenanceCreateCount, 1);
  const maintenanceState = JSON.parse(readFileSync(
    path.join(reportDir, `kafka-continuous-maintenance-${maintenanceRunId}.state.json`),
    "utf8",
  ));
  assert.equal(maintenanceState.driverState, "FINISHED");
  assert.equal(maintenanceState.submissionId, "maintenance-1");
  const maintenanceSubmission = createRequests.find(
    (item) => String(item.appArgs?.[0]).endsWith("/kafka_continuous_maintenance.py"),
  );
  assert(maintenanceSubmission);
  assert.equal(
    JSON.parse(maintenanceSubmission.environmentVariables.ASKLAKE_MAINTENANCE_ICEBERG_TARGET).tableUri,
    workerRequest.icebergTarget.tableUri,
  );
  assert.equal(maintenanceSubmission.environmentVariables.ASKLAKE_MAINTENANCE_JOB_ID, jobId);
  assert.equal(
    maintenanceSubmission.environmentVariables.ASKLAKE_MAINTENANCE_SCHEMA_FINGERPRINT,
    workerRequest.schemaFingerprint,
  );

  const orphanRunId = "maintenance-orphan";
  const orphanSubmissionId = "maintenance-orphan-submission";
  submissions.set(orphanSubmissionId, {
    body: {},
    forceRunning: true,
    isMaintenance: true,
    killed: false,
    polls: 0,
  });
  writeFileSync(
    path.join(reportDir, `kafka-continuous-maintenance-${orphanRunId}.state.json`),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      driverState: "RUNNING",
      events: [],
      kind: "compaction",
      runId: orphanRunId,
      runner: "rest",
      submissionId: orphanSubmissionId,
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    "utf8",
  );
  const cleanup = await runManager(maintenanceScript, {
    action: "cleanup",
    runId: orphanRunId,
  }, environment, "ASKLAKE_KAFKA_MAINTENANCE_RESULT");
  assert.equal(cleanup.cleaned, true);
  assert.equal(cleanup.submissionId, orphanSubmissionId);
  assert.equal(killRequests.at(-1), orphanSubmissionId);

  const invalidProductionEnvironment = { ...environment, ASKLAKE_SPARK_RUNNER: "docker" };
  await assert.rejects(
    runManager(
      continuousScript,
      { ...workerRequest, action: "status" },
      invalidProductionEnvironment,
      "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
    ),
    /Production Spark execution requires ASKLAKE_SPARK_RUNNER=rest/,
  );
  await assert.rejects(
    runManager(
      maintenanceScript,
      { action: "cleanup", runId: orphanRunId },
      invalidProductionEnvironment,
      "ASKLAKE_KAFKA_MAINTENANCE_RESULT",
    ),
    /Production Spark execution requires ASKLAKE_SPARK_RUNNER=rest/,
  );

  assert.equal(existsSync(dockerCallMarker), false, "Production continuous and maintenance paths must make zero Docker calls.");
  assert.equal(createRequests.filter((item) => String(item.appArgs?.[0]).endsWith("/kafka_continuous_stream.py")).length, 3);
  assert.equal(createRequests.filter((item) => String(item.appArgs?.[0]).endsWith("/kafka_continuous_maintenance.py")).length, 1);
  for (const request of createRequests) {
    const serialized = JSON.stringify(request);
    assert.equal(serialized.includes(minioAccessSentinel), false, "REST bodies must not serialize MinIO access keys.");
    assert.equal(serialized.includes(minioSecretSentinel), false, "REST bodies must not serialize MinIO secret keys.");
    assert.equal(request.environmentVariables?.MINIO_ACCESS_KEY, undefined);
    assert.equal(request.environmentVariables?.MINIO_SECRET_KEY, undefined);
  }

  console.log("Kafka continuous REST verified: lifecycle, restart state, maintenance cleanup, credential-free bodies, and zero Docker calls.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDir, { force: true, recursive: true });
}

function continuousAction(action, base, environment) {
  return runManager(
    continuousScript,
    { ...base, action },
    environment,
    "ASKLAKE_KAFKA_CONTINUOUS_RESULT",
  );
}

function runManager(script, payload, environment, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: backendDir,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${path.basename(script)} failed (${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        const prefix = `${marker}=`;
        const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(prefix));
        assert(line, `${path.basename(script)} did not emit ${marker}.`);
        resolve(JSON.parse(line.slice(prefix.length)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function publishMaintenanceArtifact(submission) {
  const runtimePath = String(submission.environmentVariables?.ASKLAKE_MAINTENANCE_RESULT_FILE || "");
  const runId = String(submission.environmentVariables?.ASKLAKE_MAINTENANCE_RUN_ID || "");
  assert(runtimePath && runId);
  const hostPath = path.join(reportDir, path.posix.basename(runtimePath));
  writeFileSync(hostPath, JSON.stringify({
    endedAt: "2026-07-12T00:00:00Z",
    records: [{ offset: 7, partition: 0, topic: "reviews.rest.contract" }],
    runId,
    total: 1,
  }), "utf8");
}

function installDockerSentinel(directory) {
  const shellScript = path.join(directory, "docker");
  writeFileSync(shellScript, "#!/bin/sh\nprintf 'called\\n' >> \"$ASKLAKE_DOCKER_CALL_MARKER\"\nexit 97\n", "utf8");
  chmodSync(shellScript, 0o755);
  writeFileSync(
    path.join(directory, "docker.cmd"),
    "@echo off\r\necho called>>\"%ASKLAKE_DOCKER_CALL_MARKER%\"\r\nexit /b 97\r\n",
    "utf8",
  );
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
