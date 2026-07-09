import { spawn } from "node:child_process";

const port = Number(process.env.ASKLAKE_VERIFY_PORT || 18083);
const baseUrl = `http://127.0.0.1:${port}`;
const restFixturePort = Number(process.env.ASKLAKE_SOURCE_REST_PORT || 19083);
const restFixtureUrl = `http://127.0.0.1:${restFixturePort}`;
const env = {
  ...process.env,
  ASKLAKE_RESET_METADATA_ON_START: "true",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "wishuponastar",
  PORT: String(port),
};

const child = spawn(process.execPath, ["src/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
const restFixture = spawn(process.execPath, ["scripts/source-rest-fixture-server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, ASKLAKE_SOURCE_REST_PORT: String(restFixturePort) },
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
child.stderr.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));

try {
  await waitForHealth();
  await waitForRestFixture();
  await assertGet("/api/etl/jobs", []);
  await assertGet("/api/catalog/datasets", []);

  const minio = await post("/api/etl/sources/test", {
    sourceType: "File / S3",
    sourceConfig: [
      ["Storage Provider", "MinIO"],
      ["Endpoint URL", env.MINIO_ENDPOINT],
      ["Region", "us-east-1"],
      ["Bucket / Stage Name", "m3-raw"],
      ["Path / Prefix", process.env.ASKLAKE_VERIFY_MINIO_PREFIX || "asklake-fixtures/csv/"],
      ["Access Key", env.MINIO_ACCESS_KEY],
      ["Secret Key", env.MINIO_SECRET_KEY],
      ["Use Path Style", "true"],
    ],
  });
  assert(minio.status === "success", "MinIO source test should succeed.");
  assert(minio.draftPatch.schema.columns.length > 0, "MinIO schema inference should produce columns.");

  const rest = await post("/api/etl/sources/test", {
    sourceType: "REST API",
    sourceConfig: [
      ["Method", "GET"],
      ["Endpoint URL", `${restFixtureUrl}/events`],
      ["Accept", "application/json"],
    ],
  });
  assert(rest.status === "success", "REST source test should succeed.");
  assert(rest.draftPatch.schema.columns.length > 0, "REST schema inference should produce columns.");

  const firstColumn = minio.draftPatch.schema.columns[0]?.targetName ?? minio.draftPatch.schema.columns[0]?.sourceName;
  const transformSteps = [{
    enabled: true,
    id: "verify-transform-1",
    input: firstColumn,
    kind: "trim",
    label: `Lowercase + Trim: ${firstColumn} -> ${firstColumn}_normalized`,
    onError: "Warn",
    operation: "Lowercase + Trim",
    output: `${firstColumn}_normalized`,
    params: "lower(), trim()",
  }];
  const transformOutputColumns = [
    ...minio.draftPatch.schema.columns.map((column) => [column.targetName, column.type]),
    [`${firstColumn}_normalized`, "string"],
  ];
  const qualityRules = [{
    enabled: true,
    failureAction: "Warn",
    id: "verify-quality-1",
    kind: "notNull",
    severity: "Warning",
    targetColumn: firstColumn,
    validationType: "Not Null",
  }];

  await assertPostFails("/api/etl/jobs", {
    id: "pair_a_verify_all_excluded",
    jobName: "pair_a_verify_all_excluded_pipeline",
    owner: "data-team-01",
    permissionSummary: "verify",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "schema rejected",
    transformOutputColumns: [],
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: minio.draftPatch.schema.columns.map((column) => ({ ...column, included: false })),
    schemaFingerprint: "all-excluded",
    schemaSampleRows: minio.draftPatch.schema.sampleRows,
    schemaSummary: "all excluded schema should fail",
    sourceConfig: minio.draftPatch.source.sourceConfig,
    sourceLabel: minio.draftPatch.source.sourceLabel,
    sourceType: minio.draftPatch.source.sourceType,
    targetDataset: "pair_a_verify_all_excluded_gold",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  }, 400, "All-excluded schema should be rejected.");

  const createRequest = {
    id: "pair_a_verify",
    jobName: "pair_a_verify_pipeline",
    owner: "data-team-01",
    permissionSummary: "verify",
    rag: true,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 3, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "3회 재시도 · 1분부터 2배 지수 백오프 · 최대 30분 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "schema verified",
    transformOutputColumns,
    transformSteps,
    qualityInvalidRows: [],
    qualityRules,
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: minio.draftPatch.schema.columns,
    schemaFingerprint: minio.draftPatch.schema.schemaFingerprint,
    schemaSampleRows: minio.draftPatch.schema.sampleRows,
    schemaSummary: minio.draftPatch.schema.summary,
    sourceConfig: minio.draftPatch.source.sourceConfig,
    sourceLabel: minio.draftPatch.source.sourceLabel,
    sourceType: minio.draftPatch.source.sourceType,
    targetDataset: "pair_a_verify_gold",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  };
  const created = await post("/api/etl/jobs", createRequest);
  assert(created.job && created.catalogTarget, "Create job should return { job, catalogTarget }.");
  assert(created.job.transformSteps?.length === 1, "Created job should preserve transform steps.");
  assert(created.job.qualityRules?.length === 1, "Created job should preserve quality rules.");
  await assertPostFails("/api/etl/jobs", createRequest, 409, "Duplicate pending target dataset should be rejected.");

  const jobs = await get("/api/etl/jobs");
  const datasets = await get("/api/catalog/datasets");
  assert(jobs.length === 1, "Backend hydrate jobs should contain the created job only.");
  assert(
    !datasets.some((dataset) => dataset.id === created.catalogTarget.id || dataset.name === createRequest.targetDataset),
    "Catalog should not expose the pending target dataset until a job run succeeds.",
  );

  console.log("verify-backend: ok");
} finally {
  child.kill("SIGTERM");
  restFixture.kill("SIGTERM");
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok) return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Backend did not become healthy.");
}

async function assertGet(path, expected) {
  const actual = await get(path);
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${path} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return readResponse(response);
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function waitForRestFixture() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${restFixtureUrl}/health`);
      if (response.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`REST source fixture did not become healthy at ${restFixtureUrl}/health.`);
}

async function assertPostFails(path, body, status, message) {
  const response = await fetch(`${baseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (response.status !== status) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`${message} Expected ${status}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
}

async function readResponse(response) {
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
