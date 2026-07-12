import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const clientScript = path.join(scriptsDir, "spark-rest-client.mjs");
const submissions = new Map();
let createCount = 0;

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/v1/submissions/create") {
      const body = JSON.parse(await readBody(request));
      assert.equal(body.action, "CreateSubmissionRequest");
      assert.equal(body.mainClass, "org.apache.spark.deploy.SparkSubmit");
      assert.deepEqual(body.appArgs, ["/opt/asklake/scripts/spark_job_run.py"]);
      createCount += 1;
      const submissionId = createCount === 1 ? "driver-success" : "driver-failed";
      submissions.set(submissionId, 0);
      return json(response, 200, { success: true, submissionId });
    }
    const statusMatch = request.url?.match(/^\/v1\/submissions\/status\/([^/]+)$/);
    if (request.method === "GET" && statusMatch) {
      const submissionId = decodeURIComponent(statusMatch[1]);
      const pollCount = (submissions.get(submissionId) || 0) + 1;
      submissions.set(submissionId, pollCount);
      const driverState = submissionId === "driver-success"
        ? pollCount === 1 ? "RUNNING" : "FINISHED"
        : "FAILED";
      return json(response, 200, { driverState, success: true, submissionId });
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
  const request = {
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
  const success = await runClient(request);
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /"state":"FINISHED"/);
  assert.equal(submissions.get("driver-success"), 2);

  const failure = await runClient(request);
  assert.notEqual(failure.code, 0, "Terminal Spark driver failure must fail the REST client.");
  assert.match(failure.stderr, /driver-failed ended in state FAILED/);
  assert.equal(submissions.get("driver-failed"), 1);

  console.log("Spark REST client verified: create, running, finished, and terminal failure states.");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function runClient(payload) {
  return new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
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
