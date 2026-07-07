import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const port = Number(process.env.ASKLAKE_VERIFY_SPARK_PORT || 18088);
const sourceBucket = process.env.ASKLAKE_VERIFY_SPARK_BUCKET || "m3-raw";
const sourceKey = process.env.ASKLAKE_VERIFY_SPARK_KEY || "nyc_taxi/csv/2019-Nov.csv";
const rowLimit = process.env.ASKLAKE_VERIFY_SPARK_ROW_LIMIT || "3";

const env = {
  ...process.env,
  ASKLAKE_RESET_METADATA_ON_START: "true",
  ASKLAKE_SPARK_OUTPUT_MODE: process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local",
  ASKLAKE_SPARK_RUN_ROW_LIMIT: process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || rowLimit,
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000",
  MINIO_ENDPOINT_IN_DOCKER: process.env.MINIO_ENDPOINT_IN_DOCKER || "http://m3-minio:9000",
  MINIO_REGION: process.env.MINIO_REGION || "us-east-1",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar",
  PORT: String(port),
};

const server = spawn(process.execPath, ["src/server.mjs"], {
  cwd: process.cwd(),
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

const logs = [];
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));

try {
  await waitForHealth();
  const suffix = Date.now().toString(36);
  const create = await postJson(`/api/etl/jobs`, {
    id: `spark-actual-${suffix}`,
    jobName: `Spark 실제 실행 검증 ${suffix}`,
    owner: "admin",
    permissionSummary: "admin",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "Spark run smoke",
    transformOutputColumns: [
      ["event_time", "timestamp"],
      ["event_type", "string"],
      ["product_id", "integer"],
      ["category_id", "integer"],
      ["item_price", "double"],
      ["user_id", "integer"],
    ],
    transformSteps: [
      {
        enabled: true,
        id: "spark-transform-price",
        input: "item_price",
        kind: "cast",
        label: "Cast Decimal: item_price -> item_price",
        onError: "Set Null",
        operation: "Cast Decimal",
        output: "item_price",
        params: "double",
      },
    ],
    qualityInvalidRows: [],
    qualityRules: [
      {
        enabled: true,
        failureAction: "Warn",
        id: "spark-quality-price",
        kind: "range",
        severity: "Warning",
        targetColumn: "item_price",
        validationType: "Range Check",
      },
    ],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "event_time", targetName: "event_time", type: "Timestamp" },
      { included: true, nullable: false, sourceName: "event_type", targetName: "event_type", type: "String" },
      { included: true, nullable: false, sourceName: "product_id", targetName: "product_id", type: "Integer" },
      { included: true, nullable: false, sourceName: "category_id", targetName: "category_id", type: "Integer" },
      { included: false, nullable: true, sourceName: "brand", targetName: "brand", type: "String" },
      { included: true, nullable: false, sourceName: "price", targetName: "item_price", type: "Float" },
      { included: true, nullable: false, sourceName: "user_id", targetName: "user_id", type: "Integer" },
    ],
    schemaSampleRows: [["2019-11-01 00:00:00 UTC", "view", "1003461", "2053013555631882655", "xiaomi", "489.07", "520088904"]],
    schemaSummary: "Spark 실제 실행 검증용 ecommerce CSV schema",
    sourceConfig: [
      ["Endpoint", env.MINIO_ENDPOINT],
      ["Bucket / Stage Name", sourceBucket],
      ["Path / Prefix", sourceKey],
      ["File Type", "CSV"],
      ["__Schema Sample Scope", "current"],
      ["__Schema Sample Scope Label", "현재 샘플"],
      ["__Sample Row Limit", rowLimit],
      ["__Sample Requested Bytes", "65536"],
      ["__Source Unit Count", "1"],
    ],
    sourceLabel: `${sourceBucket}/${sourceKey}`,
    sourceType: "File / S3",
    targetDataset: `spark_actual_verify_${suffix}`,
    compression: "Snappy",
    partition: "year/month/region",
    storagePath: `s3a://asklake-output/spark_actual_verify_${suffix}/gold/`,
    storageType: "S3",
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  const datasetsAfterCreate = await getJson("/api/catalog/datasets");
  assert(datasetsAfterCreate.length === 0, "Catalog should stay empty before the Spark run succeeds.");

  const command = await postJson(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  assert(command.job.status === "running", `Job command should return running status: ${command.job.status}`);
  assert(command.run?.status === "running", `Run command should return running run: ${command.run?.status}`);

  const completedJob = await waitForJobCompletion(create.job.id, command.run.runId);
  const run = completedJob.runHistory?.find((item) => item.runId === command.run.runId);
  const datasetsAfterRun = await getJson("/api/catalog/datasets");
  const parquetFiles = listParquetFiles(run?.outputPath);
  const datasetSchema = datasetsAfterRun[0]?.schema ?? [];
  const schemaTypes = new Map(datasetSchema.map(([name, type]) => [name, type]));
  const schemaNames = datasetSchema.map(([name]) => name);
  const result = {
    catalogDatasets: datasetsAfterRun.length,
    dagSteps: completedJob.dagSteps?.map((step) => `${step.title}:${step.status}`),
    errorSummary: run?.errorSummary,
    inputRows: run?.inputRows,
    jobId: create.job.id,
    jobStatus: completedJob.status,
    runDagSteps: completedJob.dagStepsByRunId?.[run?.runId]?.length ?? 0,
    outputExists: Boolean(run?.outputPath && existsSync(run.outputPath)),
    outputPath: run?.outputPath,
    outputRows: run?.outputRows,
    parquetFiles: parquetFiles.length,
    runStatus: run?.status,
    schemaNames,
  };

  console.log(JSON.stringify(result, null, 2));
  assert(run?.status === "success", `Spark run did not succeed: ${run?.errorSummary}`);
  assert(result.outputExists, `Spark output path was not copied to host: ${run?.outputPath}`);
  assert(parquetFiles.length > 0, `Spark output path has no parquet files: ${run?.outputPath}`);
  assert(completedJob.status === "scheduled", `Job did not return to scheduled status: ${completedJob.status}`);
  assert(datasetsAfterRun.length === 1, "Catalog should contain the dataset after the Spark run succeeds.");
  assert(schemaNames.includes("item_price"), `Approved target column was not written to catalog schema: ${schemaNames.join(", ")}`);
  assert(!schemaNames.includes("price"), `Original source column should have been aliased away: ${schemaNames.join(", ")}`);
  assert(!schemaNames.includes("brand"), `Excluded schema column should not be in output schema: ${schemaNames.join(", ")}`);
  assert(String(schemaTypes.get("item_price") || "").includes("double"), `item_price should be cast to double: ${schemaTypes.get("item_price")}`);
  assert(completedJob.dagSteps?.every((step) => step.status === "success"), "DAG steps were not all successful.");
  assert(completedJob.dagStepsByRunId?.[run.runId]?.length === completedJob.dagSteps.length, "Job should preserve DAG steps under the server runId.");
  assert(completedJob.permissionRoles?.length === 1, "Job should preserve permissionRoles from the create request.");
  assert(completedJob.storagePath?.includes(`spark_actual_verify_${suffix}`), "Job should preserve target storagePath from the create request.");
  assert(completedJob.dagSteps?.some((step) => step.id === "transform"), "DAG should include a transform step.");
  assert(completedJob.dagSteps?.some((step) => step.id === "quality"), "DAG should include a quality step.");
} finally {
  server.kill();
  setTimeout(() => server.kill("SIGKILL"), 2000).unref();
}

function apiUrl(pathname) {
  return `http://127.0.0.1:${port}${pathname}`;
}

function assert(condition, message) {
  if (!condition) {
    const logTail = logs.join("").slice(-4000);
    throw new Error(`${message}\n${logTail}`);
  }
}

function listParquetFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  const found = [];
  const walk = (current) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const itemPath = path.join(current, item.name);
      if (item.isDirectory()) walk(itemPath);
      else if (item.name.endsWith(".parquet")) found.push(itemPath);
    }
  };
  walk(dir);
  return found;
}

async function getJson(pathname) {
  const response = await fetch(apiUrl(pathname));
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postJson(pathname, body) {
  const response = await fetch(apiUrl(pathname), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitForJobCompletion(jobId, runId) {
  const deadline = Date.now() + 180000;
  let latestJob;
  while (Date.now() < deadline) {
    latestJob = await getJson(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
    const run = latestJob.runHistory?.find((item) => item.runId === runId);
    if (latestJob.status !== "running" && run?.status !== "running") return latestJob;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Spark run did not finish before timeout: ${JSON.stringify({
    jobStatus: latestJob?.status,
    runStatus: latestJob?.runHistory?.find((item) => item.runId === runId)?.status,
  })}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 60000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(apiUrl("/api/health"));
      if (response.ok) return;
      lastError = new Error(`health ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("backend health timeout");
}
