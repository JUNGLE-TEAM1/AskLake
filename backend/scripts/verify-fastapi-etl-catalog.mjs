import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_FASTAPI_ETL_SMOKE_PORT || 18085);
const baseUrl = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_ETL_SMOKE_START_SERVER !== "false";
const env = {
  ...process.env,
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "none",
  ASKLAKE_SPARK_OUTPUT_MODE: process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local",
  ASKLAKE_SPARK_RUN_ROW_LIMIT: process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "2",
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "smoke-lake"),
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;

try {
  await runSmoke();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (serverProcess) serverProcess.kill("SIGTERM");
}

async function runSmoke() {
  ensureFastApiPythonDependencies();
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
    partition: "none",
    storagePath: "",
    storageType: "Local",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  assert(create.job?.id, "ETL job create response should include job.id.");
  assert(create.catalogTarget?.id, "ETL job create response should include catalogTarget.id.");

  const command = await post(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  const datasetId = command.dataset?.id;
  assert(command.run?.status === "success", `Spark run should succeed: ${command.run?.errorSummary}`);
  assert(datasetId === create.catalogTarget.id, "Run response dataset should match the create catalog target.");
  assert(command.dataset?.storageFormat === undefined, "ETL command schema should keep the existing public dataset shape.");
  assert(command.dataset?.size && !String(command.dataset.size).includes("/"), "ETL command dataset size should be display text, not a path.");

  const catalogDataset = await get(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  assert(catalogDataset.sourceRunId === command.run.runId, "Catalog dataset should keep sourceRunId from the ETL run.");
  assert(catalogDataset.storageFormat === "parquet", "Catalog dataset should expose parquet storage format.");
  assert(catalogDataset.storageLocation === command.run.outputPath, "Catalog storageLocation should match run outputPath.");
  assert(catalogDataset.storageSizeBytes > 0, "Catalog storageSizeBytes should be greater than zero.");
  assert(catalogDataset.size && !catalogDataset.size.includes("/"), "Catalog size should be display text, not a path.");
  assert(catalogDataset.lineageGraph?.datasets?.length >= 3, "Catalog payload should include stored source/job/target lineage.");
  if (shouldStartServer) {
    assert(existsSync(catalogDataset.storageLocation), `ETL storage path should exist: ${catalogDataset.storageLocation}`);
  }

  const sqlPreview = await post("/api/query/runs", {
    baseDatasetId: datasetId,
    datasetId,
    limit: 10,
    mode: "preview",
    query: `SELECT customer_id, amount FROM ${targetDataset} WHERE amount > 20 ORDER BY customer_id`,
    referenceDatasetIds: [],
    validationKey: `${datasetId}:duckdb-parquet`,
  });
  assert(JSON.stringify(sqlPreview.columns) === JSON.stringify(["customer_id", "amount"]), "DuckDB SQL preview should project ETL parquet columns.");
  assert(sqlPreview.rowCount === 1, "DuckDB SQL preview should execute filters against ETL parquet storage.");
  assert(JSON.stringify(sqlPreview.rows[0]) === JSON.stringify(["C-001", "42.5"]), "DuckDB SQL preview should read the ETL storageLocation parquet data.");

  const lineage = await get(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/lineage`);
  const engines = lineage.datasets.map((dataset) => dataset.engine);
  assert(lineage.datasetId === datasetId, "Lineage response should be scoped to the ETL dataset.");
  assert(engines.includes("SOURCE"), "ETL lineage should include SOURCE node.");
  assert(engines.includes("SPARK"), "ETL lineage should include SPARK node.");
  assert(engines.includes("ICEBERG"), "ETL lineage should include ICEBERG node.");
  assert(lineage.edges.length >= 4, "ETL lineage should include column edges across source/job/target.");

  const dashboard = await post("/api/dashboards", {
    datasetId,
    owner: "admin",
    source: "catalog",
    title: `ETL Catalog Smoke Dashboard ${suffix}`,
  });
  const dashboardId = dashboard.dashboard?.id;
  assert(dashboardId, "Dashboard create response should include dashboard.id.");

  const draft = await post(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`, {});
  const pageId = draft.pages?.[0]?.id;
  assert(pageId, "Draft runtime should include a default page.");

  const widget = await post(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}/widgets`, {
    config: {
      columns: ["customer_id", "amount"],
    },
    datasetId,
    title: "ETL catalog table",
    type: "table",
  });
  assert(widget.id, "Draft widget create response should include widget id.");

  const draftAfterWidget = await post(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`, {});
  const createdWidget = Object.values(draftAfterWidget.widgetsByPageId ?? {})
    .flat()
    .find((item) => item.id === widget.id);
  assert(createdWidget, "Draft runtime should include the created dataset widget.");
  assert(createdWidget.datasetId === datasetId, "Widget should keep the ETL catalog datasetId.");
  assert(createdWidget.data?.length === 2, "Widget data should snapshot ETL catalog sample rows.");
  assert(createdWidget.data[0]?.customer_id === "C-001", "Widget data should use catalog schema names.");
  assert(createdWidget.data[0]?.amount === 42.5, "Widget data should coerce numeric catalog values.");

  console.log("verify-fastapi-etl-catalog: ok");
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
