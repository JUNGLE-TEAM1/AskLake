import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";

const baseUrl = process.env.ASKLAKE_RECORD_PARSING_E2E_BASE_URL || "http://127.0.0.1:8080";
const timeoutMs = positiveNumber(process.env.ASKLAKE_RECORD_PARSING_E2E_TIMEOUT_MS, 10 * 60 * 1000);
const pollIntervalMs = positiveNumber(process.env.ASKLAKE_RECORD_PARSING_E2E_POLL_INTERVAL_MS, 2000);
const keepResources = process.env.ASKLAKE_RECORD_PARSING_E2E_KEEP_RESOURCES === "true";
const objectBucket = process.env.ASKLAKE_RECORD_PARSING_BUCKET || "m3-raw";
const objectKey = process.env.ASKLAKE_RECORD_PARSING_OBJECT_KEY
  || "asklake-fixtures/txt/click-events-whitespace-100.log";
const outputBucket = process.env.ASKLAKE_SPARK_OUTPUT_BUCKET || process.env.MINIO_BUCKET || "asklake-output";
const endpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
const region = process.env.MINIO_REGION || "us-east-1";
const accessKeyId = process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
const secretAccessKey = process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
const fieldNames = [
  "event_time",
  "event_id",
  "customer_id",
  "session_id",
  "event_type",
  "page_path",
  "element_id",
  "device",
  "region",
  "latency_ms",
];

const s3 = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region,
});

let createdJobId = "";
let createdDatasetId = "";
let outputPrefix = "";
let completed = false;

try {
  await verifyHealth();
  const sourceConfig = buildSourceConfig();
  const source = await post("/api/etl/sources/test", {
    sourceConfig,
    sourceType: "File / S3",
  });
  assert(source.status === "success", `Source test failed: ${source.message}`);
  const rawLines = (source.previewRows ?? []).map((row) => String(row?.[1] ?? ""));
  assert(rawLines.length === 100, `Expected 100 source rows, got ${rawLines.length}.`);
  assert(
    JSON.stringify(source.previewColumns) === JSON.stringify(["line_number", "value"]),
    `Raw TXT preview must remain unstructured before step 1.5: ${JSON.stringify(source.previewColumns)}`,
  );

  const inferred = await preview(rawLines, {
    columns: [],
    delimiterKind: "whitespace",
    delimiterPattern: "\\s+",
    enabled: true,
    expectedFieldCount: 0,
    header: false,
  });
  assert(inferred.recordParsing?.expectedFieldCount === 10, `Expected 10 inferred fields, got ${inferred.recordParsing?.expectedFieldCount}.`);
  assert(inferred.totalRows === 100 && inferred.validRows === 100, `Expected 100/100 valid preview rows, got ${inferred.validRows}/${inferred.totalRows}.`);
  assert(inferred.invalidRows?.length === 0, `Preview found invalid rows: ${JSON.stringify(inferred.invalidRows)}`);

  const namedParsing = {
    ...inferred.recordParsing,
    columns: fieldNames.map((name, position) => ({
      inferredType: inferred.recordParsing.columns[position]?.inferredType || "String",
      name,
      position,
    })),
  };
  const structured = await preview(rawLines, namedParsing);
  assert(structured.canApply === true, "Named record parsing preview should be applicable.");
  assert(structured.validRows === 100 && structured.invalidRows.length === 0, "Named preview must keep all 100 rows valid.");
  assert(
    JSON.stringify(structured.columns.map((column) => column.targetName)) === JSON.stringify(fieldNames),
    `Named preview columns drifted: ${JSON.stringify(structured.columns)}`,
  );
  assert(structured.sampleRows[0]?.length === 10, "Structured preview must expose 10 values per row.");

  const suffix = `${Date.now().toString(36)}-${process.pid}`;
  const targetDataset = `click_events_whitespace_e2e_${suffix}`.replace(/-/g, "_");
  const targetRoot = `s3a://${outputBucket}/record-parsing-e2e/${targetDataset}`;
  const create = await post("/api/etl/jobs", {
    compression: "Snappy",
    id: `record-parsing-e2e-${suffix}`,
    jobName: `Record Parsing E2E ${suffix}`,
    owner: "admin",
    partition: "",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    permissionSummary: "admin",
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    rag: false,
    recordParsing: structured.recordParsing,
    retryPolicy: {
      backoffMultiplier: 2,
      backoffStrategy: "exponential",
      failureAction: "retry_then_fail",
      initialRetryDelayMinutes: 1,
      maxRetries: 0,
      maxRetryDelayMinutes: 30,
      retryIntervalMinutes: 1,
      timeoutMinutes: 60,
    },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    ruleSummary: "Whitespace 10-field record parsing",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    scheduleLabel: "manual",
    schemaColumns: structured.columns,
    schemaSampleRows: structured.sampleRows,
    schemaSummary: "공백 구분 click log 10개 필드",
    sourceConfig,
    sourceLabel: `s3://${objectBucket}/${objectKey}`,
    sourceType: "File / S3",
    storagePath: targetRoot,
    storageType: "S3",
    targetDataset,
    targetFormat: "Parquet",
    targetLayer: "BRONZE",
    transformOutputColumns: structured.columns.map((column) => [column.targetName, column.type.toLowerCase()]),
    transformSteps: [],
  });
  createdJobId = create.job?.id || "";
  createdDatasetId = create.catalogTarget?.id || "";
  assert(createdJobId, "Create response did not include job.id.");
  assert(createdDatasetId, "Create response did not include catalogTarget.id.");
  assert(create.job.recordParsing?.expectedFieldCount === 10, "Job did not persist the 10-field parsing contract.");
  assert(create.job.recordParsing?.delimiterPattern === "\\s+", "Job did not persist the whitespace delimiter contract.");

  const command = await post(`/api/etl/jobs/${encodeURIComponent(createdJobId)}/commands`, { command: "run" });
  assert(command.action === "etl.run.requested", `Unexpected run action: ${command.action}`);
  assert(command.run?.runId, "Run command did not return runId.");
  console.log(`record parsing E2E submitted: job=${createdJobId}, run=${command.run.runId}`);

  const terminalJob = await waitForTerminalJob(createdJobId);
  const latestRun = terminalJob.runHistory?.find((run) => run.runId === command.run.runId) || terminalJob.runHistory?.[0];
  assert(latestRun?.status === "success", `Spark run failed at ${latestRun?.failedStage}: ${latestRun?.errorSummary || latestRun?.syncError || latestRun?.status}`);
  assert(rowCount(latestRun.outputRows) === 100, `Spark output row count must be 100, got ${latestRun.outputRows}.`);
  assert(latestRun.taskStates?.sparkResult?.status === "success", "Spark result manifest was not persisted as success.");
  assert(Number(latestRun.taskStates?.sparkResult?.inputRows) === 100, `Spark input row count must be 100, got ${latestRun.taskStates?.sparkResult?.inputRows}.`);
  assert(Number(latestRun.taskStates?.sparkResult?.outputRows) === 100, `Spark manifest output row count must be 100, got ${latestRun.taskStates?.sparkResult?.outputRows}.`);

  const dataset = await get(`/api/catalog/datasets/${encodeURIComponent(createdDatasetId)}`);
  const catalogColumns = (dataset.schema ?? []).map((column) => Array.isArray(column) ? column[0] : column.name);
  for (const name of fieldNames) {
    assert(catalogColumns.includes(name), `Catalog schema is missing parsed field: ${name}.`);
  }
  assert(dataset.sourceRunId === latestRun.runId, "Catalog dataset must point to the successful parsing run.");
  assert(dataset.storageFormat === "parquet", `Expected parquet catalog output, got ${dataset.storageFormat}.`);
  outputPrefix = s3Prefix(latestRun.outputPath);
  await assertParquetOutput(outputPrefix);

  completed = true;
  console.log(JSON.stringify({
    catalogDatasetId: createdDatasetId,
    catalogFields: catalogColumns,
    inferredFieldCount: structured.recordParsing.expectedFieldCount,
    invalidPreviewRows: structured.invalidRows.length,
    jobId: createdJobId,
    outputPath: latestRun.outputPath,
    outputRows: rowCount(latestRun.outputRows),
    sourceObject: `s3://${objectBucket}/${objectKey}`,
    sourceRows: rawLines.length,
    status: "ok",
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (completed && !keepResources) {
    await cleanup().catch((error) => {
      console.error(`Record parsing E2E cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}

function buildSourceConfig() {
  return [
    ["Storage Provider", "MinIO / S3 compatible"],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Bucket / Stage Name", objectBucket],
    ["Path / Prefix", objectKey],
    ["Access Key", accessKeyId],
    ["Secret Key", secretAccessKey],
    ["Use Path Style", "true"],
    ["__Selected Object", objectKey],
    ["__Sample Object", objectKey],
    ["__Schema Sample Scope", "full"],
    ["__Schema Sample Scope Label", "전체 오브젝트"],
  ];
}

async function preview(rawLines, recordParsing) {
  return post("/api/etl/record-parsing/preview", { rawLines, recordParsing });
}

async function verifyHealth() {
  const health = await get("/api/health");
  assert(health.ok && health.database?.ok, `AskLake health check failed: ${JSON.stringify(health)}`);
}

async function waitForTerminalJob(jobId) {
  const deadline = Date.now() + timeoutMs;
  let latestRun = null;
  while (Date.now() < deadline) {
    const job = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
    latestRun = job.runHistory?.[0];
    if (["success", "failed", "canceled"].includes(latestRun?.status)) return job;
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for record parsing E2E: ${JSON.stringify(latestRun)}`);
}

async function assertParquetOutput(prefix) {
  assert(prefix, "Spark output path is not an S3 path.");
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: outputBucket, Prefix: prefix }));
  assert(listed.Contents?.some((entry) => entry.Key?.endsWith(".parquet")), `No Parquet object found at s3://${outputBucket}/${prefix}.`);
}

async function cleanup() {
  if (outputPrefix) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: outputBucket, Prefix: outputPrefix }));
    const objects = (listed.Contents ?? []).flatMap((entry) => entry.Key ? [{ Key: entry.Key }] : []);
    if (objects.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: outputBucket, Delete: { Objects: objects, Quiet: true } }));
    }
  }
  if (!createdJobId) return;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL || "postgresql://asklake:asklake_dev@127.0.0.1:54328/asklake",
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (createdDatasetId) await client.query("DELETE FROM catalog_datasets WHERE id = $1", [createdDatasetId]);
    await client.query("DELETE FROM etl_runs WHERE job_id = $1", [createdJobId]);
    await client.query("DELETE FROM etl_jobs WHERE id = $1", [createdJobId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function s3Prefix(value) {
  const match = String(value || "").match(/^s3a?:\/\/([^/]+)\/(.+)$/i);
  if (!match || match[1] !== outputBucket) return "";
  return match[2];
}

async function get(route) {
  return readResponse(await fetch(`${baseUrl}${route}`));
}

async function post(route, body) {
  return readResponse(await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }));
}

async function readResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rowCount(value) {
  const match = String(value ?? "").replaceAll(",", "").match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
