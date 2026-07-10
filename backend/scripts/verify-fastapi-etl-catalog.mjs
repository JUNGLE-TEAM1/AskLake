import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_FASTAPI_ETL_SMOKE_PORT || 18085);
const baseUrl = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_START_SERVER !== "false";
const airflowPort = Number(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK_PORT || 18086);
const airflowBaseUrl = process.env.AIRFLOW_API_BASE_URL || `http://127.0.0.1:${airflowPort}`;
const airflowDagId = process.env.AIRFLOW_DAG_ID || "asklake_etl_job";
const shouldStartAirflowMock = !process.env.AIRFLOW_API_BASE_URL && process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK !== "false";
const airflowSyncPollIntervalMs = positiveNumber(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_POLL_INTERVAL_MS, 1000);
const airflowSyncTimeoutMs = positiveNumber(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_TIMEOUT_MS, 600000);
const configuredSparkOutputMode = process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local";
const expectSparkFailure = process.env.ASKLAKE_FASTAPI_ETL_EXPECT_SPARK_FAILURE === "true";
const env = {
  ...process.env,
  AIRFLOW_API_BASE_URL: airflowBaseUrl,
  AIRFLOW_DAG_ID: airflowDagId,
  AIRFLOW_EXECUTION_API_TOKEN: process.env.AIRFLOW_EXECUTION_API_TOKEN || "asklake-local-airflow-execution",
  AIRFLOW_REQUEST_TIMEOUT_SECONDS: process.env.AIRFLOW_REQUEST_TIMEOUT_SECONDS || "5",
  AIRFLOW_UI_BASE_URL: process.env.AIRFLOW_UI_BASE_URL || airflowBaseUrl,
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE
    || (configuredSparkOutputMode.toLowerCase() === "s3a" ? "org.apache.hadoop:hadoop-aws:3.4.1" : "none"),
  ASKLAKE_SPARK_OUTPUT_MODE: configuredSparkOutputMode,
  ASKLAKE_SPARK_RUN_ROW_LIMIT: process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "2",
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "smoke-lake"),
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let airflowServer = null;
const mockAirflowRuns = new Map();

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (airflowServer) await closeServer(airflowServer);
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartAirflowMock) airflowServer = await startMockAirflowServer();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();
  await assertInternalExecutionAuth();

  const suffix = Date.now().toString(36);
  const targetDataset = `fastapi_etl_catalog_smoke_${suffix}`;
  const sparkOutputMode = String(env.ASKLAKE_SPARK_OUTPUT_MODE || "local").toLowerCase();
  const targetStoragePath = sparkOutputMode === "s3a"
    ? `s3a://${process.env.ASKLAKE_FASTAPI_ETL_OUTPUT_BUCKET || "asklake-output"}/phase2/${targetDataset}`
    : "";
  const create = await post("/api/etl/jobs", {
    id: `fastapi-etl-catalog-${suffix}`,
    jobName: `FastAPI ETL Catalog Smoke ${suffix}`,
    owner: "admin",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    permissionSummary: "admin",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "FastAPI ETL catalog payload smoke",
    transformOutputColumns: [["customer_id", "string"], ["amount", "double"]],
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: expectSparkFailure ? [{
      enabled: true,
      failureAction: "Fail Run",
      id: "phase2-negative-amount",
      kind: "range",
      params: "",
      severity: "Error",
      targetColumn: "amount",
      validationType: "Range Check",
    }] : [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "customer_id", targetName: "customer_id", type: "String" },
      { included: true, nullable: false, sourceName: "amount", targetName: "amount", type: "Float" },
    ],
    schemaSampleRows: [["C-001", expectSparkFailure ? "-42.5" : "42.5"], ["C-002", "17.25"]],
    schemaSummary: "FastAPI ETL catalog payload smoke schema",
    sourceConfig: [["Endpoint", "sample://inline"], ["__Sample Row Limit", "2"]],
    sourceLabel: "inline sample rows",
    sourceType: "REST API",
    targetDataset,
    compression: "Snappy",
    partition: "none",
    storagePath: targetStoragePath,
    storageType: sparkOutputMode === "s3a" ? "S3" : "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  assert(create.job?.id, "ETL job create response should include job.id.");
  assert(create.catalogTarget?.id, "ETL job create response should include catalogTarget.id.");

  const command = await post(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  assert(command.action === "etl.run.requested", "ETL run command should return the run requested action.");
  assert(command.run?.status === "queued", `Airflow submit should create a queued run: ${command.run?.errorSummary}`);
  assert(command.run?.airflowDagId === airflowDagId, "Run summary should include the configured Airflow DAG id.");
  assert(command.run?.airflowDagRunId, "Run summary should include the Airflow DAG Run id.");
  assert(command.run?.airflowState === "queued", "Initial Airflow state should be queued.");
  assert(command.run?.airflowRunUrl?.includes(command.run.airflowDagRunId), "Run summary should include an Airflow UI URL.");
  assert(!command.dataset, "Airflow submit is asynchronous and should not create a catalog dataset in the command response.");
  assert(command.dagSteps?.some((step) => step.id === "airflow-submit"), "Command response should include an Airflow submit DAG step.");

  const syncedJob = await waitForTerminalJob(create.job.id);
  const latestRun = syncedJob.runHistory?.[0];
  if (expectSparkFailure) {
    assert(latestRun?.status === "failed", `Spark quality failure should fail the AskLake Run: ${latestRun?.status}`);
    assert(latestRun?.airflowState === "failed", "Spark quality failure should fail the Airflow DAG Run.");
    assert(latestRun?.taskStates?.spark_process_write?.airflowState === "failed", "Spark task should expose failed state.");
    assert(latestRun?.taskStates?.sparkResult?.status === "failed", "Failed Spark manifest should be preserved.");
    assert(latestRun?.taskStates?.sparkResult?.failedStage === "Quality", "Spark manifest should identify the Quality stage.");
    assert(syncedJob.status === "failed", "Job should expose failed status after Spark quality failure.");
    console.log("verify-fastapi-etl-catalog: expected Spark failure ok");
    return;
  }
  assert(latestRun?.status === "success", `Airflow sync should update the run to success: ${latestRun?.syncError}`);
  assert(latestRun?.airflowState === "success", "Synced run should keep the Airflow success state.");
  assert(latestRun?.taskStates?.publish_run_result?.airflowState === "success", "Synced run should include task instance states.");
  if (!shouldStartAirflowMock) {
    assert(latestRun?.taskStates?.sparkResult?.status === "success", "Synced run should preserve the Spark result manifest.");
    assert(Number(latestRun?.taskStates?.sparkResult?.outputRows) === 2, "Spark should write the two input rows.");
    await assertPhysicalParquet(latestRun?.outputPath);
  }
  assert(syncedJob.status === "scheduled", "Job should return to scheduled after a successful Airflow sync.");
  assert(syncedJob.dagSteps?.some((step) => step.id === "publish_run_result" && step.status === "success"), "Synced job should expose Airflow task DAG steps.");

  console.log("verify-fastapi-etl-catalog: ok");
}

async function assertInternalExecutionAuth() {
  const response = await fetch(`${baseUrl}/api/internal/airflow/spark-runs/not-a-run/execute`, {
    body: JSON.stringify({ command: "run", jobId: "not-a-job" }),
    headers: {
      Authorization: "Bearer invalid-phase2-token",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = await readPayload(response);
  assert(response.status === 401, `Internal Spark execution endpoint should reject an invalid token: ${response.status}`);
  assert(payload?.error?.code === "AIRFLOW_EXECUTION_UNAUTHORIZED", "Internal Spark execution auth should return the expected error code.");
}

async function assertPhysicalParquet(outputPath) {
  assert(outputPath, "Spark success should persist an output path.");
  const match = String(outputPath).match(/^s3a?:\/\/([^/]+)\/(.+)$/i);
  if (match) {
    const client = new S3Client({
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || "m3admin",
        secretAccessKey: process.env.MINIO_SECRET_KEY || "wishuponastar",
      },
      endpoint: process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000",
      forcePathStyle: true,
      region: process.env.MINIO_REGION || "us-east-1",
    });
    const listed = await client.send(new ListObjectsV2Command({ Bucket: match[1], Prefix: match[2] }));
    assert(
      listed.Contents?.some((entry) => entry.Key?.endsWith(".parquet")),
      `MinIO output prefix has no Parquet object: ${outputPath}`,
    );
    return;
  }
  assert(existsSync(outputPath), `Spark output path does not exist: ${outputPath}`);
  assert(hasParquetFile(outputPath), `Spark output path has no Parquet file: ${outputPath}`);
}

function hasParquetFile(dir) {
  return readdirSync(dir, { withFileTypes: true }).some((entry) => (
    entry.isDirectory()
      ? hasParquetFile(path.join(dir, entry.name))
      : entry.name.endsWith(".parquet")
  ));
}

function startMockAirflowServer() {
  const server = http.createServer(async (request, response) => {
    try {
      await handleMockAirflowRequest(request, response);
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(airflowPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

async function handleMockAirflowRequest(request, response) {
  const url = new URL(request.url || "/", airflowBaseUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "POST" && url.pathname === "/auth/token") {
    writeJson(response, 200, { access_token: "mock-airflow-token" });
    return;
  }

  if (parts[0] !== "api" || parts[1] !== "v2" || parts[2] !== "dags" || parts[3] !== airflowDagId || parts[4] !== "dagRuns") {
    writeJson(response, 404, { detail: `Unhandled mock Airflow route: ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "POST" && parts.length === 5) {
    const payload = await readRequestJson(request);
    const dagRunId = String(payload.dag_run_id || `mock_run_${Date.now()}`);
    const run = {
      conf: payload.conf || {},
      dag_id: airflowDagId,
      dag_run_id: dagRunId,
      state: "queued",
    };
    mockAirflowRuns.set(dagRunId, run);
    writeJson(response, 200, run);
    return;
  }

  const dagRunId = parts[5];
  const run = mockAirflowRuns.get(dagRunId);
  if (!run) {
    writeJson(response, 404, { detail: `DAG Run not found: ${dagRunId}` });
    return;
  }

  if (request.method === "GET" && parts.length === 6) {
    writeJson(response, 200, { ...run, state: "success" });
    return;
  }

  if (request.method === "GET" && parts.length === 7 && parts[6] === "taskInstances") {
    writeJson(response, 200, {
      task_instances: [
        mockTask("receive_asklake_run", dagRunId),
        mockTask("validate_spark_request", dagRunId),
        mockTask("spark_process_write", dagRunId),
        mockTask("publish_run_result", dagRunId),
      ],
    });
    return;
  }

  writeJson(response, 404, { detail: `Unhandled mock Airflow route: ${request.method} ${url.pathname}` });
}

function mockTask(taskId, dagRunId) {
  return {
    dag_id: airflowDagId,
    dag_run_id: dagRunId,
    state: "success",
    task_id: taskId,
  };
}

function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function ensureFastApiPythonDependencies() {
  const result = spawnSync(pythonBin, [
    "-c",
    "import duckdb, fastapi, psycopg, pydantic_settings, sqlalchemy, uvicorn",
  ], {
    cwd: backendDir,
    env,
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const lastOutputLine = output.split("\n").filter(Boolean).at(-1);
    throw new Error(
      [
        "FastAPI Python dependencies are not installed for this interpreter.",
        `python: ${pythonBin}`,
        "Run `cd backend && python3 -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON to a prepared interpreter.",
        lastOutputLine,
      ].filter(Boolean).join("\n"),
    );
  }
}

function startFastApiServer() {
  const child = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[fastapi] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[fastapi] ${chunk}`));
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok && health.database?.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
}

async function waitForTerminalJob(jobId) {
  const deadline = Date.now() + airflowSyncTimeoutMs;
  let latestJob = null;
  let latestRun = null;
  while (Date.now() < deadline) {
    latestJob = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
    latestRun = latestJob.runHistory?.[0];
    if (["success", "failed", "canceled"].includes(latestRun?.status)) return latestJob;
    await sleep(airflowSyncPollIntervalMs);
  }
  throw new Error(
    `AskLake did not sync the Airflow run within ${airflowSyncTimeoutMs}ms: ` +
    `${latestRun?.airflowDagRunId || "unknown run"} (${latestRun?.airflowState || latestRun?.status || "unknown"})` +
    `${latestRun?.syncError ? `, syncError=${latestRun.syncError}` : ""}`,
  );
}

async function get(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return readResponse(response);
}

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function readResponse(response) {
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function readPayload(response) {
  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
