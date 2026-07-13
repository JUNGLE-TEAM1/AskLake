import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSubmission, waitForSparkRestDriver } from "./spark-rest-client.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const clientScript = path.join(scriptsDir, "spark-rest-client.mjs");
const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "asklake-spark-rest-client-"));
const submissions = new Map();
const killedSubmissions = [];
let createCount = 0;

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/v1/submissions/create") {
      const body = JSON.parse(await readBody(request));
      assert.equal(body.mainClass, "org.apache.spark.deploy.SparkSubmit");
      assert.deepEqual(body.appArgs, ["/opt/asklake/scripts/spark_job_run.py"]);
      createCount += 1;
      const submissionId = [
        "driver-success",
        "driver-failed",
        "driver-timeout",
        "driver-orphan",
      ][createCount - 1] || `driver-${createCount}`;
      submissions.set(submissionId, 0);
      return json(response, 200, { success: true, submissionId });
    }
    const statusMatch = request.url?.match(/^\/v1\/submissions\/status\/([^/]+)$/);
    if (request.method === "GET" && statusMatch) {
      const submissionId = decodeURIComponent(statusMatch[1]);
      const pollCount = (submissions.get(submissionId) || 0) + 1;
      submissions.set(submissionId, pollCount);
      const driverState = submissionId === "driver-success"
        ? pollCount === 1 ? "UNKNOWN" : pollCount === 2 ? "RUNNING" : "FINISHED"
        : submissionId === "driver-failed"
          ? "FAILED"
          : killedSubmissions.includes(submissionId)
            ? "KILLED"
            : "UNKNOWN";
      return json(response, 200, { driverState, success: true, submissionId });
    }
    const killMatch = request.url?.match(/^\/v1\/submissions\/kill\/([^/]+)$/);
    if (request.method === "POST" && killMatch) {
      const submissionId = decodeURIComponent(killMatch[1]);
      killedSubmissions.push(submissionId);
      return json(response, 200, { success: true, submissionId });
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
  const baseRequest = {
    pollIntervalMs: 250,
    restUrl: `http://127.0.0.1:${address.port}`,
    submission: {
      action: "CreateSubmissionRequest",
      appArgs: ["/opt/asklake/scripts/spark_job_run.py"],
      appResource: "",
      clientSparkVersion: "4.0.1",
      environmentVariables: {},
      mainClass: "org.apache.spark.deploy.SparkSubmit",
      sparkProperties: { "spark.master": "spark://spark-master:7077" },
    },
    timeoutMs: 5_000,
  };

  assert.throws(
    () => validateSubmission({
      ...baseRequest.submission,
      environmentVariables: { MINIO_SECRET_KEY: "must-not-be-serialized" },
    }),
    /inherit application credentials from the worker environment/,
  );

  const successStateFile = stateFile("success");
  const success = await runClient({ ...baseRequest, stateFile: successStateFile });
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /"state":"FINISHED"/);
  assert.equal(submissions.get("driver-success"), 3, "UNKNOWN must be polled rather than treated as terminal.");
  assert.equal(readState(successStateFile).driverState, "FINISHED");

  const resumed = await runClient({ ...baseRequest, stateFile: successStateFile });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(createCount, 1, "A persisted submission identity must be resumed without a duplicate create.");

  await assert.rejects(
    waitForSparkRestDriver({
      onStatus: () => { throw new Error("state artifact write failed"); },
      pollIntervalMs: 250,
      restUrl: baseRequest.restUrl,
      submissionId: "driver-success",
      timeoutMs: 1_000,
    }),
    /state artifact write failed/,
    "Local status persistence failures must not be swallowed as retriable HTTP errors.",
  );

  const failureStateFile = stateFile("failure");
  const failure = await runClient({ ...baseRequest, stateFile: failureStateFile });
  assert.notEqual(failure.code, 0, "Terminal Spark driver failure must fail the REST client.");
  assert.match(failure.stderr, /driver-failed ended in state FAILED/);
  assert.equal(readState(failureStateFile).driverState, "FAILED");

  const timeoutStateFile = stateFile("timeout");
  const timeout = await runClient({ ...baseRequest, stateFile: timeoutStateFile, timeoutMs: 1_000 });
  assert.notEqual(timeout.code, 0, "A submission that remains UNKNOWN must eventually time out.");
  assert.match(timeout.stderr, /driver-timeout timed out in state UNKNOWN/);
  assert.deepEqual(killedSubmissions, ["driver-timeout"], "Timed out submissions must use Spark REST kill.");
  assert(readState(timeoutStateFile).killRequestedAt, "Timeout cleanup must remain visible in state.");

  const orphanStateFile = stateFile("orphan");
  const orphan = spawnClient({ ...baseRequest, stateFile: orphanStateFile });
  await waitFor(
    () => existsSync(orphanStateFile) && readState(orphanStateFile).submissionId === "driver-orphan",
    "create-time submission state",
  );
  orphan.child.kill("SIGKILL");
  await orphan.completed;

  const mismatchedRecovery = await runClient({
    operation: "kill-state",
    restUrl: "http://127.0.0.1:1",
    stateFile: orphanStateFile,
  });
  assert.notEqual(mismatchedRecovery.code, 0);
  assert.match(mismatchedRecovery.stderr, /does not match the configured control plane/);
  assert.deepEqual(killedSubmissions, ["driver-timeout"]);

  const recovery = await runClient({
    operation: "kill-state",
    restUrl: baseRequest.restUrl,
    stateFile: orphanStateFile,
  });
  assert.equal(recovery.code, 0, recovery.stderr);
  assert.match(recovery.stdout, /ASKLAKE_SPARK_REST_RECOVERY=/);
  assert.deepEqual(killedSubmissions, ["driver-timeout", "driver-orphan"]);
  assert(readState(orphanStateFile).killRequestedAt, "Recovered submissions must preserve kill state.");

  console.log(
    "Spark REST client verified: credential guard, durable identity, resume state, create/status/kill, timeout, and orphan recovery.",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryDir, { force: true, recursive: true });
}

function stateFile(name) {
  return path.join(temporaryDir, `${name}.state.json`);
}

function readState(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function runClient(payload) {
  return spawnClient(payload).completed;
}

function spawnClient(payload) {
  const child = spawn(process.execPath, [clientScript], {
    cwd: scriptsDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
  child.stdin.end(JSON.stringify(payload));
  return { child, completed };
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
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
