import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const port = Number(process.env.ASKLAKE_VERIFY_SPARK_PORT || 18088);
const sourceBucket = process.env.ASKLAKE_VERIFY_SPARK_BUCKET || "m3-raw";
const sourceKey = process.env.ASKLAKE_VERIFY_SPARK_KEY || "nyc_taxi/csv/2019-Nov.csv";
const rowLimit = process.env.ASKLAKE_VERIFY_SPARK_ROW_LIMIT || "1000";

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
    rag: false,
    retryPolicy: { failureAction: "retry_then_fail", maxRetries: 0, retryIntervalMinutes: 5, timeoutMinutes: 60 },
    retryPolicySummary: "수동 재시도",
    ruleSummary: "Spark run smoke",
    transformOutputColumns: [
      ["vendorid", "integer"],
      ["tpep_pickup_datetime", "timestamp"],
      ["tpep_dropoff_datetime", "timestamp"],
      ["passenger_count", "integer"],
      ["trip_distance", "double"],
      ["total_amount", "double"],
    ],
    transformSteps: [
      {
        enabled: true,
        id: "spark-transform-distance",
        input: "trip_distance",
        kind: "cast",
        label: "Cast Decimal: trip_distance -> trip_distance",
        onError: "Set Null",
        operation: "Cast Decimal",
        output: "trip_distance",
        params: "double",
      },
    ],
    qualityInvalidRows: [],
    qualityRules: [
      {
        enabled: true,
        failureAction: "Warn",
        id: "spark-quality-total-amount",
        kind: "range",
        severity: "Warning",
        targetColumn: "total_amount",
        validationType: "Range Check",
      },
    ],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "manual",
    schemaColumns: [
      { nullable: true, sourceName: "VendorID", targetName: "vendorid", type: "Integer" },
      { nullable: true, sourceName: "tpep_pickup_datetime", targetName: "tpep_pickup_datetime", type: "Timestamp" },
      { nullable: true, sourceName: "tpep_dropoff_datetime", targetName: "tpep_dropoff_datetime", type: "Timestamp" },
      { nullable: true, sourceName: "passenger_count", targetName: "passenger_count", type: "Integer" },
      { nullable: true, sourceName: "trip_distance", targetName: "trip_distance", type: "Float" },
      { nullable: true, sourceName: "total_amount", targetName: "total_amount", type: "Float" },
    ],
    schemaSampleRows: [["1", "2019-11-01 00:00:00", "2019-11-01 00:03:00", "1", "0.7", "8.3"]],
    schemaSummary: "Spark 실제 실행 검증용 CSV schema",
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
    targetFormat: "Parquet",
    targetLayer: "GOLD",
  });

  const command = await postJson(`/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`, { command: "run" });
  const run = command.run;
  const parquetFiles = listParquetFiles(run?.outputPath);
  const result = {
    dagSteps: command.dagSteps?.map((step) => `${step.title}:${step.status}`),
    errorSummary: run?.errorSummary,
    inputRows: run?.inputRows,
    jobId: create.job.id,
    jobStatus: command.job.status,
    outputExists: Boolean(run?.outputPath && existsSync(run.outputPath)),
    outputPath: run?.outputPath,
    outputRows: run?.outputRows,
    parquetFiles: parquetFiles.length,
    runStatus: run?.status,
  };

  console.log(JSON.stringify(result, null, 2));
  assert(run?.status === "success", `Spark run did not succeed: ${run?.errorSummary}`);
  assert(result.outputExists, `Spark output path was not copied to host: ${run?.outputPath}`);
  assert(parquetFiles.length > 0, `Spark output path has no parquet files: ${run?.outputPath}`);
  assert(command.job.status === "scheduled", `Job did not return to scheduled status: ${command.job.status}`);
  assert(command.dagSteps?.every((step) => step.status === "success"), "DAG steps were not all successful.");
  assert(command.dagSteps?.some((step) => step.id === "transform"), "DAG should include a transform step.");
  assert(command.dagSteps?.some((step) => step.id === "quality"), "DAG should include a quality step.");
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
