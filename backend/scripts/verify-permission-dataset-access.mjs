import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_PERMISSION_DATASET_PORT || 18087);
const baseUrl = process.env.ASKLAKE_PERMISSION_DATASET_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_PERMISSION_DATASET_START_SERVER !== "false";
const shouldSeed = process.env.ASKLAKE_PERMISSION_DATASET_SEED !== "false";
const seedDatasetId = "ds_orders_clean";
const viewerHeaders = {
  "X-AskLake-Role": "viewer",
  "X-AskLake-User": "Blocked Dataset Viewer",
};
const env = {
  ...process.env,
  LOCAL_LAKE_STORAGE_DIR: process.env.LOCAL_LAKE_STORAGE_DIR || path.join(backendDir, "tmp", "permission-dataset-lake"),
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

  await cleanupPrincipalGrants(viewerHeaders["X-AskLake-User"]);

  const blockedList = await get("/api/catalog/datasets", viewerHeaders);
  assert(!blockedList.datasets.some((dataset) => dataset.id === seedDatasetId), "Viewer without view grant should not see the seed dataset.");

  const blockedDetail = await getExpectError(`/api/catalog/datasets/${seedDatasetId}`, 403, viewerHeaders);
  assert(blockedDetail.error?.code === "FORBIDDEN", "Viewer without view grant should be denied from dataset detail.");

  const adminPermissions = await get("/api/admin/permissions");
  const seedResource = adminPermissions.resources.find((resource) => resource.resourceType === "dataset" && resource.resourceId === seedDatasetId);
  assert(seedResource, `Admin permissions should include ${seedDatasetId}.`);

  const viewGrantResponse = await post("/api/admin/permissions", {
    actions: ["view"],
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    resourceId: seedDatasetId,
    resourceType: "dataset",
  });
  const viewGrant = findGrant(viewGrantResponse, seedResource, viewerHeaders["X-AskLake-User"]);
  assert(viewGrant?.id, "View grant should be persisted.");

  const visibleList = await get("/api/catalog/datasets", viewerHeaders);
  assert(visibleList.datasets.some((dataset) => dataset.id === seedDatasetId), "Viewer with view grant should see the seed dataset.");

  const visibleDetail = await get(`/api/catalog/datasets/${seedDatasetId}`, viewerHeaders);
  assert(visibleDetail.id === seedDatasetId, "Viewer with view grant should hydrate dataset detail.");

  const blockedQuery = await postExpectError("/api/query/runs", {
    datasetId: seedDatasetId,
    limit: 10,
    mode: "preview",
    query: "SELECT order_id FROM orders_clean LIMIT 1",
  }, 403, viewerHeaders);
  assert(blockedQuery.error?.code === "FORBIDDEN", "Viewer without query grant should be denied from SQL preview.");

  await patch(`/api/admin/permissions/${viewGrant.id}`, {
    actions: ["view", "query"],
  });

  const query = "SELECT order_id FROM orders_clean ORDER BY order_id LIMIT 1";
  const previewRun = await post("/api/query/runs", {
    baseDatasetId: seedDatasetId,
    datasetId: seedDatasetId,
    limit: 10,
    mode: "preview",
    query,
    referenceDatasetIds: [],
    validationKey: `${seedDatasetId}:${query}`,
  }, viewerHeaders);
  assert(previewRun.runId, "Viewer with query grant should execute SQL preview.");

  const derivedDatasetName = `permission_dataset_smoke_${Date.now()}`;
  const derivedDataset = await post("/api/catalog/derived-datasets", {
    dataset: {
      description: "Permission dataset access smoke derived dataset",
      layer: "GOLD",
      name: derivedDatasetName,
      rag: false,
      refreshPolicy: "manual",
      tags: ["#permission-smoke"],
    },
    previewLimit: previewRun.previewLimit,
    query: previewRun.query,
    referenceDatasetIds: previewRun.referenceDatasetIds,
    sourceDatasetId: seedDatasetId,
    sourceRunId: previewRun.runId,
    validationKey: previewRun.validationKey,
  });
  const runId = derivedDataset.materializationRuns?.[0]?.runId;
  assert(runId, "Derived dataset should include a materialization run for delete permission smoke.");

  const deleteGrantResponse = await post("/api/admin/permissions", {
    actions: ["delete"],
    principalId: viewerHeaders["X-AskLake-User"],
    principalType: "user",
    resourceId: derivedDataset.id,
    resourceType: "dataset",
  });
  const derivedResource = deleteGrantResponse.resources.find((resource) => resource.resourceType === "dataset" && resource.resourceId === derivedDataset.id);
  const deleteGrant = findGrant(deleteGrantResponse, derivedResource, viewerHeaders["X-AskLake-User"]);
  assert(deleteGrant?.id, "Delete grant should be persisted for derived dataset.");

  const deleteResponse = await del(`/api/catalog/datasets/${encodeURIComponent(derivedDataset.id)}/materialization-runs/${encodeURIComponent(runId)}`, viewerHeaders);
  assert(deleteResponse.deletedRunId === runId, "Viewer with delete grant should delete the materialization run.");

  await del(`/api/admin/permissions/${viewGrant.id}`);
  await del(`/api/admin/permissions/${deleteGrant.id}`);

  console.log("verify-permission-dataset-access: ok");
}

async function cleanupPrincipalGrants(principalId) {
  const permissions = await get("/api/admin/permissions");
  const grantIds = permissions.resources
    .flatMap((resource) => resource.grants)
    .filter((grant) => grant.principalId === principalId && grant.id)
    .map((grant) => grant.id);
  for (const grantId of grantIds) {
    await del(`/api/admin/permissions/${grantId}`);
  }
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
    throw new Error([
      "FastAPI Python dependencies are not installed for this interpreter.",
      `python: ${pythonBin}`,
      "Run `cd backend && python3 -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON to a prepared interpreter.",
      lastOutputLine,
    ].filter(Boolean).join("\n"));
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

async function get(route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return readResponse(response);
}

async function post(route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

async function patch(route, body, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readResponse(response);
}

async function del(route, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE", headers });
  return readResponse(response);
}

async function getExpectError(route, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, { headers });
  return readErrorResponse(response, route, statusCode);
}

async function postExpectError(route, body, statusCode, headers = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readErrorResponse(response, route, statusCode);
}

async function readErrorResponse(response, route, statusCode) {
  const payload = await readPayload(response);
  assert(response.status === statusCode, `${route} expected ${statusCode}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function findGrant(permissions, resource, principalId) {
  return permissions.resources
    .find((item) => item.resourceType === resource?.resourceType && item.resourceId === resource?.resourceId)
    ?.grants.find((grant) => grant.principalId === principalId);
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
