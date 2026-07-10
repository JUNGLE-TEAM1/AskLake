import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_FASTAPI_ETL_SMOKE_PORT || 18085);
const baseUrl = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_START_SERVER !== "false";
const airflowPort = Number(process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK_PORT || 18086);
const airflowBaseUrl = process.env.AIRFLOW_API_BASE_URL || `http://127.0.0.1:${airflowPort}`;
const airflowDagId = process.env.AIRFLOW_DAG_ID || "asklake_etl_job";
const airflowInternalToken = process.env.AIRFLOW_INTERNAL_TOKEN || "asklake-etl-smoke-token";
const shouldStartAirflowMock = !process.env.AIRFLOW_API_BASE_URL && process.env.ASKLAKE_FASTAPI_ETL_AIRFLOW_MOCK !== "false";
const env = {
  ...process.env,
  AIRFLOW_API_BASE_URL: airflowBaseUrl,
  AIRFLOW_DAG_ID: airflowDagId,
  AIRFLOW_INTERNAL_TOKEN: airflowInternalToken,
  AIRFLOW_REQUEST_TIMEOUT_SECONDS: process.env.AIRFLOW_REQUEST_TIMEOUT_SECONDS || "5",
  AIRFLOW_UI_BASE_URL: process.env.AIRFLOW_UI_BASE_URL || airflowBaseUrl,
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "none",
  ASKLAKE_SPARK_OUTPUT_MODE: process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local",
  ASKLAKE_SPARK_RUN_ROW_LIMIT: process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "2",
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "smoke-lake"),
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;
let airflowServer = null;
let smokeJobId = "";
let smokeDatasetId = "";
let smokeRunId = "";
let smokeOutputPath = "";
const mockAirflowRuns = new Map();

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanupSmokeResources();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (airflowServer) await closeServer(airflowServer);
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
  if (shouldStartAirflowMock) airflowServer = await startMockAirflowServer();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();

  const suffix = Date.now().toString(36);
  const targetDataset = `fastapi_etl_catalog_smoke_${suffix}`;
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
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "customer_id", targetName: "customer_id", type: "String" },
      { included: true, nullable: false, sourceName: "amount", targetName: "amount", type: "Float" },
    ],
    schemaSampleRows: [["C-001", "42.5"], ["C-002", "17.25"]],
    schemaSummary: "FastAPI ETL catalog payload smoke schema",
    sourceConfig: [["Endpoint", "sample://inline"], ["__Sample Row Limit", "2"]],
    sourceLabel: "inline sample rows",
    sourceType: "REST API",
    targetDataset,
    compression: "Snappy",
    partition: "customer_id/amount",
    storagePath: "",
    storageType: "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  assert(create.job?.id, "ETL job create response should include job.id.");
  assert(create.job?.partition === "customer_id/amount", "ETL job should preserve multi-column partition metadata.");
  assert(create.catalogTarget?.id, "ETL job create response should include catalogTarget.id.");
  smokeJobId = create.job.id;
  smokeDatasetId = create.catalogTarget.id;

  const command = await post(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  assert(command.action === "etl.run.requested", "ETL run command should return the run requested action.");
  assert(command.run?.status === "queued", `Airflow submit should create a queued run: ${command.run?.errorSummary}`);
  assert(command.run?.airflowDagId === airflowDagId, "Run summary should include the configured Airflow DAG id.");
  assert(command.run?.airflowDagRunId, "Run summary should include the Airflow DAG Run id.");
  assert(command.run?.airflowState === "queued", "Initial Airflow state should be queued.");
  assert(command.run?.airflowRunUrl?.includes(command.run.airflowDagRunId), "Run summary should include an Airflow UI URL.");
  smokeRunId = command.run.runId;
  assert(!command.dataset, "Airflow submit is asynchronous and should not create a catalog dataset in the command response.");
  assert(command.dagSteps?.some((step) => step.id === "airflow-submit"), "Command response should include an Airflow submit DAG step.");

  const executionPath = `/api/etl/internal/airflow/jobs/${encodeURIComponent(create.job.id)}/runs/${encodeURIComponent(command.run.airflowDagRunId)}/execute`;
  const execution = await postInternal(executionPath, { command: "run" });
  assert(execution.status === "success", `Airflow worker should execute the real Spark path: ${execution.error}`);
  assert(execution.datasetId === create.catalogTarget.id, "Spark success should persist the target Catalog dataset.");
  assert(execution.outputRows === 2, `Spark execution should persist the two inline rows: ${execution.outputRows}`);
  smokeOutputPath = execution.outputPath;

  const repeatedExecution = await postInternal(executionPath, { command: "run" });
  assert(repeatedExecution.datasetId === execution.datasetId, "Airflow task retry should reuse the persisted materialization.");
  assert(repeatedExecution.outputPath === execution.outputPath, "Airflow task retry should not launch a second Spark output.");

  const syncedJob = await get(`/api/etl/jobs/${encodeURIComponent(create.job.id)}`);
  const latestRun = syncedJob.runHistory?.[0];
  assert(latestRun?.status === "success", `Airflow sync should update the run to success: ${latestRun?.syncError}`);
  assert(latestRun?.airflowState === "success", "Synced run should keep the Airflow success state.");
  assert(latestRun?.taskStates?.catalog_update?.airflowState === "success", "Synced run should include task instance states.");
  assert(syncedJob.status === "scheduled", "Job should return to scheduled after a successful Airflow sync.");
  assert(syncedJob.dagSteps?.some((step) => step.id === "catalog_update" && step.status === "success"), "Synced job should expose Airflow task DAG steps.");

  const catalog = await get("/api/catalog/datasets");
  const materialized = catalog.datasets?.find((dataset) => dataset.id === create.catalogTarget.id);
  assert(materialized, "Successful Airflow/Spark execution should be visible in Catalog hydrate.");
  assert(materialized.sourceRunId === command.run.runId, "Catalog dataset should point to the successful Airflow run.");
  assert(materialized.materializationRuns?.length === 1, "Idempotent Airflow execution should create one materialization run.");
  const sourceLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.layer === "SOURCE");
  const processLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.layer === "PROCESS");
  const targetLineageNode = materialized.lineageGraph?.datasets?.find((dataset) => dataset.id === create.catalogTarget.id);
  assert(
    JSON.stringify(sourceLineageNode?.columns?.map((column) => column.name)) === JSON.stringify(["customer_id", "amount"]),
    "ETL lineage source node should contain source columns without Spark-generated metadata.",
  );
  assert(sourceLineageNode?.engine === "REST API", "ETL lineage source engine should match the source connector or file format.");
  assert(
    !materialized.lineageGraph?.edges?.some((edge) => edge.fromDatasetId === sourceLineageNode?.id && edge.toColumnId.includes("asklake")),
    "Spark-generated metadata columns should not have source lineage edges.",
  );
  assert(processLineageNode?.engine === "SPARK", "ETL lineage should represent the Spark job as a PROCESS node.");
  assert(targetLineageNode?.engine === "PARQUET", "ETL lineage target engine should match the persisted Spark output format.");

  await del(`/api/catalog/datasets/${encodeURIComponent(materialized.id)}/materialization-runs/${encodeURIComponent(command.run.runId)}`);
  const jobAfterMaterializationDelete = await get(`/api/etl/jobs/${encodeURIComponent(create.job.id)}`);
  assert(
    jobAfterMaterializationDelete.runHistory?.find((run) => run.runId === command.run.runId)?.status === "success",
    "Deleting an append result should not rewrite the historical Spark run as failed.",
  );

  console.log("verify-fastapi-etl-catalog: ok");
}

async function cleanupSmokeResources() {
  if (smokeJobId) {
    const client = new pg.Client({
      connectionString: env.DATABASE_URL || "postgresql://asklake:asklake_dev@127.0.0.1:54328/asklake",
    });
    try {
      await client.connect();
      await client.query("BEGIN");
      if (smokeDatasetId) await client.query("DELETE FROM catalog_datasets WHERE id = $1", [smokeDatasetId]);
      await client.query("DELETE FROM etl_runs WHERE job_id = $1", [smokeJobId]);
      await client.query("DELETE FROM etl_jobs WHERE id = $1", [smokeJobId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`Smoke cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (smokeOutputPath && !smokeOutputPath.startsWith("s3")) {
    rmSync(smokeOutputPath, { force: true, recursive: true });
  }
  if (smokeRunId) {
    const reportDir = process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs");
    for (const suffix of [".json", ".manifest.json", "-source.jsonl"]) {
      rmSync(path.join(reportDir, `${smokeRunId}${suffix}`), { force: true });
    }
  }
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
        mockTask("spark_source_read", dagRunId),
        mockTask("transform_quality_write", dagRunId),
        mockTask("catalog_update", dagRunId),
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
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
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

async function postInternal(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      "X-AskLake-Airflow-Token": airflowInternalToken,
    },
    method: "POST",
  });
  return readResponse(response);
}

async function del(route) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE" });
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
