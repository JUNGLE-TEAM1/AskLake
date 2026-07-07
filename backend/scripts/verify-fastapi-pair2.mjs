import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_FASTAPI_SMOKE_PORT || 18084);
const baseUrl = process.env.ASKLAKE_FASTAPI_SMOKE_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_FASTAPI_SMOKE_START_SERVER !== "false";
const shouldSeed = process.env.ASKLAKE_FASTAPI_SMOKE_SEED !== "false";
const seedDatasetId = "ds_orders_clean";
const env = {
  ...process.env,
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
  if (shouldSeed) seedPair2DemoData();
  if (shouldStartServer) serverProcess = startFastApiServer();

  await waitForHealth();

  const listBefore = await get("/api/catalog/datasets");
  assert(Array.isArray(listBefore.datasets), "Catalog list response should include datasets array.");
  const sourceDataset = listBefore.datasets.find((dataset) => dataset.id === seedDatasetId);
  assert(sourceDataset, `Catalog list should include ${seedDatasetId}.`);

  const detail = await get(`/api/catalog/datasets/${seedDatasetId}`);
  assert(detail.name === "orders_clean", "Dataset detail should return the seed dataset.");

  const lineage = await get(`/api/catalog/datasets/${seedDatasetId}/lineage`);
  assert(lineage.datasetId === seedDatasetId, "Lineage response should be scoped to the seed dataset.");
  assert(lineage.datasets.length >= 2, "Lineage graph should include upstream and current dataset nodes.");

  const query = "SELECT order_id, status, total_amount FROM orders_clean WHERE total_amount > 100000 ORDER BY order_id LIMIT 2";
  const previewRun = await post("/api/query/runs", {
    baseDatasetId: seedDatasetId,
    datasetId: seedDatasetId,
    limit: 100,
    mode: "preview",
    query,
    referenceDatasetIds: [],
    validationKey: `${seedDatasetId}:${query}`,
  });
  assert(previewRun.runId, "SQL preview should return runId.");
  assert(JSON.stringify(previewRun.columns) === JSON.stringify(["order_id", "status", "total_amount"]), "SQL preview should return projected columns from DuckDB.");
  assert(previewRun.rowCount === 2, "SQL preview should execute WHERE/ORDER BY/LIMIT in DuckDB.");
  assert(JSON.stringify(previewRun.rows[0]) === JSON.stringify(["ORD-1001", "paid", "128000"]), "SQL preview should return DuckDB query rows.");

  const joinQuery = "SELECT o.order_id, c.segment FROM orders_clean o JOIN customers_clean c ON o.customer_id = c.customer_id WHERE c.is_vip = true ORDER BY o.order_id LIMIT 3";
  const joinRun = await post("/api/query/runs", {
    baseDatasetId: seedDatasetId,
    datasetId: seedDatasetId,
    limit: 100,
    mode: "preview",
    query: joinQuery,
    referenceDatasetIds: ["ds_customers_clean"],
    validationKey: `${seedDatasetId}:${joinQuery}`,
  });
  assert(JSON.stringify(joinRun.columns) === JSON.stringify(["order_id", "segment"]), "DuckDB join preview should return projected join columns.");
  assert(joinRun.rowCount === 3, "DuckDB join preview should execute against selected reference datasets.");
  assert(JSON.stringify(joinRun.rows[0]) === JSON.stringify(["ORD-1001", "VIP"]), "DuckDB join preview should return joined rows.");

  const literalQuery = "SELECT 'from ignored_table' AS note, order_id FROM orders_clean ORDER BY order_id LIMIT 1";
  const literalRun = await post("/api/query/runs", {
    baseDatasetId: seedDatasetId,
    datasetId: seedDatasetId,
    limit: 10,
    mode: "preview",
    query: literalQuery,
    referenceDatasetIds: [],
    validationKey: `${seedDatasetId}:${literalQuery}`,
  });
  assert(JSON.stringify(literalRun.columns) === JSON.stringify(["note", "order_id"]), "SQL scope validation should ignore FROM text inside string literals.");
  assert(JSON.stringify(literalRun.rows[0]) === JSON.stringify(["from ignored_table", "ORD-1001"]), "DuckDB preview should execute safe string literal queries.");

  const mutationError = await postExpectError("/api/query/runs", {
    datasetId: seedDatasetId,
    mode: "preview",
    query: "DROP TABLE orders_clean",
  }, 403);
  assert(mutationError.error?.code === "FORBIDDEN", "SQL mutation should be rejected by backend guard.");

  const fileRelationError = await postExpectError("/api/query/runs", {
    datasetId: seedDatasetId,
    mode: "preview",
    query: "SELECT * FROM 'C:/tmp/not-selected.parquet'",
  }, 422);
  assert(fileRelationError.error?.code === "VALIDATION_ERROR", "DuckDB file path relation sources should be rejected by backend guard.");

  const derivedName = `orders_clean_smoke_${Date.now()}`;
  const derivedDataset = await post("/api/catalog/derived-datasets", {
    dataset: {
      description: "Pair2 FastAPI smoke에서 생성한 SQL 결과 Lake Dataset",
      layer: "GOLD",
      name: derivedName,
      rag: true,
      refreshPolicy: "manual",
      tags: ["#sql-derived", "#smoke"],
    },
    previewLimit: previewRun.previewLimit,
    query: previewRun.query,
    referenceDatasetIds: previewRun.referenceDatasetIds,
    sourceDatasetId: seedDatasetId,
    sourceRunId: previewRun.runId,
    validationKey: previewRun.validationKey,
  });
  assert(derivedDataset.id, "Derived dataset response should include id.");
  assert(derivedDataset.sourceRunId === previewRun.runId, "Derived dataset should keep sourceRunId.");
  assert(derivedDataset.storageFormat === "jsonl", "Derived dataset should expose jsonl storage format.");
  assert(derivedDataset.storageLocation, "Derived dataset should expose storageLocation.");
  assert(derivedDataset.storageSizeBytes > 0, "Derived dataset storage size should be greater than zero.");
  assert(
    JSON.stringify(derivedDataset.sampleRows) === JSON.stringify(previewRun.rows),
    "Derived dataset sampleRows should match SQL preview rows.",
  );
  if (shouldStartServer) {
    assert(existsSync(derivedDataset.storageLocation), `Materialized file should exist: ${derivedDataset.storageLocation}`);
  }

  const listAfter = await get("/api/catalog/datasets");
  assert(
    listAfter.datasets.some((dataset) => dataset.id === derivedDataset.id),
    "Catalog list should include the newly created derived dataset.",
  );

  const derivedLineage = await get(`/api/catalog/datasets/${derivedDataset.id}/lineage`);
  assert(derivedLineage.datasetId === derivedDataset.id, "Derived lineage should be scoped to the derived dataset.");
  assert(
    derivedLineage.edges.some((edge) => edge.toDatasetId === derivedDataset.id),
    "Derived lineage should include edges into the derived dataset.",
  );

  console.log("verify-fastapi-pair2: ok");
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

function seedPair2DemoData() {
  const result = spawnSync(pythonBin, ["-m", "app.seed.seed_pair2_demo"], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("Pair2 demo seed failed.");
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

async function postExpectError(route, body, statusCode) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
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
