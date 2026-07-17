import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const defaultRunDir = path.join(
  backendDir,
  "tmp",
  "synthetic-commerce",
  "commerce-250mb-seed-20260711",
);
const runDir = path.resolve(process.env.ASKLAKE_SYNTHETIC_COMMERCE_DIR || defaultRunDir);
const bucket = process.env.ASKLAKE_SYNTHETIC_COMMERCE_BUCKET
  || process.env.MINIO_BUCKET
  || "m3-raw";
const region = process.env.ASKLAKE_SYNTHETIC_COMMERCE_REGION
  || process.env.MINIO_REGION
  || "us-east-1";
const endpoint = process.env.ASKLAKE_SYNTHETIC_COMMERCE_ENDPOINT
  || process.env.MINIO_ENDPOINT
  || "http://127.0.0.1:9000";
const endpointInDocker = process.env.MINIO_ENDPOINT_IN_DOCKER || "http://m3-minio:9000";
const accessKeyId = process.env.ASKLAKE_SYNTHETIC_COMMERCE_ACCESS_KEY
  || process.env.MINIO_ACCESS_KEY
  || process.env.MINIO_ROOT_USER
  || "m3admin";
const secretAccessKey = process.env.ASKLAKE_SYNTHETIC_COMMERCE_SECRET_KEY
  || process.env.MINIO_SECRET_KEY
  || process.env.MINIO_ROOT_PASSWORD
  || "wishuponastar";
const port = positiveInteger(process.env.ASKLAKE_PREFIX_SPARK_E2E_PORT, 18089);
const timeoutMs = positiveInteger(
  process.env.ASKLAKE_PREFIX_SPARK_E2E_TIMEOUT_MS,
  20 * 60 * 1000,
);
const reportDir = path.resolve(
  process.env.ASKLAKE_PREFIX_SPARK_E2E_REPORT_DIR
    || path.join(backendDir, "tmp", "prefix-spark-e2e-reports"),
);
const localOutputDir = path.resolve(
  process.env.ASKLAKE_PREFIX_SPARK_E2E_OUTPUT_DIR
    || path.join(backendDir, "tmp", "prefix-spark-e2e-output"),
);
const env = {
  ...process.env,
  ASKLAKE_RESET_METADATA_ON_START: "true",
  ASKLAKE_SPARK_HADOOP_AWS_PACKAGE: process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE
    || "org.apache.hadoop:hadoop-aws:3.4.1",
  ASKLAKE_SPARK_LOCAL_OUTPUT_DIR: localOutputDir,
  ASKLAKE_SPARK_OUTPUT_MODE: "local",
  ASKLAKE_SPARK_REPORT_DIR: reportDir,
  ASKLAKE_SPARK_RUN_ROW_LIMIT: "0",
  MINIO_ACCESS_KEY: accessKeyId,
  MINIO_BUCKET: bucket,
  MINIO_ENDPOINT: endpoint,
  MINIO_ENDPOINT_IN_DOCKER: endpointInDocker,
  MINIO_REGION: region,
  MINIO_SECRET_KEY: secretAccessKey,
  PORT: String(port),
};
const s3 = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region,
});

let server;
let logTail = "";

try {
  const expected = loadExpectedDataset();
  await assertUploadedPrefix(expected);
  const sample = await readFirstJsonlRecord(expected.representativeLocalPath);
  server = startServer();
  await waitForHealth();

  const connectorResult = await postJson("/api/etl/sources/test", {
    sourceConfig: sourceConfig(expected),
    sourceType: "File / S3",
  });
  const datasetSummary = connectorResult.datasetSummary;
  assert(datasetSummary?.selectionKind === "prefix", "Source test did not return a prefix dataset summary.");
  assert(datasetSummary.schemaCompatible === true, "Source test did not verify compatible schemas.");
  assert(Number(datasetSummary.fileCount) === expected.fileCount, metricMismatch(
    "Preview fileCount",
    expected.fileCount,
    datasetSummary.fileCount,
  ));
  assert(Number(datasetSummary.totalBytes) === expected.bytes, metricMismatch(
    "Preview totalBytes",
    expected.bytes,
    datasetSummary.totalBytes,
  ));
  assert(
    datasetSummary.representativeObject === expected.representativeKey,
    metricMismatch("Preview representativeObject", expected.representativeKey, datasetSummary.representativeObject),
  );
  const connectorSchema = connectorResult.draftPatch?.schema?.columns;
  assert(Array.isArray(connectorSchema) && connectorSchema.length > 0, "Source test did not return an approved schema.");
  const schemaColumns = connectorSchema;
  const testedSourceConfig = restoreCredentialFields(
    connectorResult.draftPatch?.source?.sourceConfig,
    sourceConfig(expected),
  );

  const suffix = `${Date.now().toString(36)}_${process.pid}`;
  const targetDataset = `prefix_click_events_${suffix}`;
  const create = await postJson("/api/etl/jobs", {
    compression: "Snappy",
    id: `prefix-click-events-${suffix}`,
    jobName: `Prefix click_events E2E ${suffix}`,
    owner: "admin",
    partition: "event_type",
    permissionRoles: [
      { access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" },
    ],
    permissionSummary: "admin",
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    rag: false,
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
    ruleSummary: "Same-schema JSONL prefix full read",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    scheduleLabel: "manual",
    schemaColumns,
    schemaSampleRows: connectorResult.draftPatch?.schema?.sampleRows
      || [schemaColumns.map((column) => nestedValue(sample, column.sourceName))],
    schemaSummary: `click_events JSONL prefix · ${expected.fileCount} files`,
    sourceConfig: testedSourceConfig,
    sourceLabel: connectorResult.draftPatch?.source?.sourceLabel
      || `s3://${bucket}/${expected.sourcePrefix}`,
    sourceType: "File / S3",
    storagePath: "",
    storageType: "Local",
    targetDataset,
    targetFormat: "Parquet",
    targetLayer: "SILVER",
    transformOutputColumns: schemaColumns.map((column) => [
      column.targetName,
      column.type.toLowerCase(),
    ]),
    transformSteps: [],
  });
  assert(create.job?.id, "Job creation did not return job.id.");
  assert(create.catalogTarget?.id, "Job creation did not return catalogTarget.id.");

  const command = await postJson(
    `/api/etl/jobs/${encodeURIComponent(create.job.id)}/commands`,
    { command: "run" },
  );
  assert(command.run?.runId, "Spark command did not return runId.");
  assert(command.run?.status === "running", `Spark command did not start: ${command.run?.status}`);

  const completedJob = await waitForJobCompletion(create.job.id, command.run.runId);
  const run = completedJob.runHistory?.find((item) => item.runId === command.run.runId);
  const report = loadSparkReport(command.run.runId);
  const parquetFiles = listParquetFiles(run?.outputPath);

  assert(run?.status === "success", `Spark run failed at ${run?.failedStage}: ${run?.errorSummary}`);
  assert(report.status === "success", `Spark report is not successful: ${report.error || report.status}`);
  assert(Number(report.inputFileCount) === expected.fileCount, metricMismatch(
    "inputFileCount",
    expected.fileCount,
    report.inputFileCount,
  ));
  assert(Number(report.inputBytes) === expected.bytes, metricMismatch(
    "inputBytes",
    expected.bytes,
    report.inputBytes,
  ));
  assert(Number(report.inputRows) === expected.rows, metricMismatch(
    "inputRows",
    expected.rows,
    report.inputRows,
  ));
  assert(Number(report.outputRows) === expected.rows, metricMismatch(
    "outputRows",
    expected.rows,
    report.outputRows,
  ));
  assertSparkSampleRowsMatchSchema(report);
  assert(Number(report.outputFileCount) >= 2, `Expected at least two Parquet outputs, got ${report.outputFileCount}.`);
  assert(parquetFiles.length >= 2, `Physical output has fewer than two Parquet files: ${run?.outputPath}`);
  assert(
    parquetFiles.length === Number(report.outputFileCount),
    metricMismatch("physicalParquetFiles", report.outputFileCount, parquetFiles.length),
  );
  assert(parseRowCount(run?.inputRows) === expected.rows, metricMismatch(
    "run.inputRows",
    expected.rows,
    run?.inputRows,
  ));
  assert(parseRowCount(run?.outputRows) === expected.rows, metricMismatch(
    "run.outputRows",
    expected.rows,
    run?.outputRows,
  ));
  assert(completedJob.status === "scheduled", `Completed job did not return to scheduled: ${completedJob.status}`);

  const catalog = await getJson("/api/catalog/datasets");
  const dataset = catalog.find((item) => item.id === create.catalogTarget.id);
  assert(dataset, `Catalog did not register ${create.catalogTarget.id}.`);
  assert(dataset.status === "available", `Catalog dataset is not available: ${dataset.status}`);
  assert(dataset.sourceRunId === run.runId, "Catalog sourceRunId does not match the successful Spark run.");
  assert(dataset.storageFormat === "parquet", `Catalog storageFormat is not parquet: ${dataset.storageFormat}`);
  assert(dataset.storageLocation === run.outputPath, "Catalog storageLocation does not match physical output.");
  const catalogColumns = new Set((dataset.schema || []).map((column) => column?.[0]));
  assert(
    catalogColumns.has("properties_position"),
    "Catalog schema must include flattened properties.position as properties_position.",
  );

  const countQuery = `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(targetDataset)}`;
  const countResult = await postJson("/api/query/runs", queryRequest(
    dataset.id,
    countQuery,
    `${dataset.id}:prefix-count:${run.runId}`,
  ));
  const sqlCount = Number(countResult.rows?.[0]?.[0]);
  assert(sqlCount === expected.rows, metricMismatch("SQL COUNT(*)", expected.rows, sqlCount));

  const groupQuery = [
    "SELECT event_type, COUNT(*) AS event_count",
    `FROM ${quoteIdentifier(targetDataset)}`,
    "GROUP BY event_type",
    "ORDER BY event_count DESC, event_type",
  ].join(" ");
  const groupResult = await postJson("/api/query/runs", queryRequest(
    dataset.id,
    groupQuery,
    `${dataset.id}:prefix-event-groups:${run.runId}`,
  ));
  const eventCounts = new Map(
    (groupResult.rows || []).map(([eventType, count]) => [eventType, Number(count)]),
  );
  assertMeaningfulEventDistribution(eventCounts, expected.rows);

  console.log(JSON.stringify({
    bucket,
    catalogDatasetId: dataset.id,
    eventTypeCounts: Object.fromEntries(eventCounts),
    inputBytes: Number(report.inputBytes),
    inputFileCount: Number(report.inputFileCount),
    inputRows: Number(report.inputRows),
    jobId: create.job.id,
    outputFileCount: Number(report.outputFileCount),
    outputPath: run.outputPath,
    outputRows: Number(report.outputRows),
    runId: run.runId,
    sourcePrefix: `s3://${bucket}/${expected.sourcePrefix}`,
    sqlCount,
    status: "prefix_spark_catalog_sql_e2e_ok",
  }, null, 2));
} catch (error) {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), 2000).unref();
  }
}

function loadExpectedDataset() {
  const manifestPath = path.join(runDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Synthetic-commerce manifest could not be read: ${manifestPath}: ${error.message}`);
  }
  if (manifest?.generator_version !== 2 || !manifest.run_id) {
    throw new Error(`Synthetic-commerce v2 manifest is required: ${manifestPath}`);
  }
  const dataset = manifest.datasets?.click_events;
  if (!dataset || !Array.isArray(dataset.files) || dataset.files.length < 2) {
    throw new Error("manifest.datasets.click_events must contain at least two part files.");
  }
  const keyPrefix = normalizeKeyPrefix(
    process.env.ASKLAKE_SYNTHETIC_COMMERCE_KEY_PREFIX
      || `synthetic-commerce/${manifest.run_id}/`,
  );
  const sourcePrefix = `${keyPrefix}${normalizeDatasetPrefix(dataset.prefix || "click_events/")}`;
  const representative = dataset.files[0];
  const representativeLocalPath = path.resolve(runDir, representative.path);
  if (!existsSync(representativeLocalPath)) {
    throw new Error(`Representative local part is missing: ${representativeLocalPath}`);
  }
  const files = dataset.files.map((file) => ({
    bytes: Number(file.bytes),
    key: `${keyPrefix}${normalizeManifestPath(file.path)}`,
    rows: Number(file.rows),
  }));
  const fileBytes = files.reduce((total, file) => total + file.bytes, 0);
  const fileRows = files.reduce((total, file) => total + file.rows, 0);
  if (fileBytes !== Number(dataset.bytes) || fileRows !== Number(dataset.rows)) {
    throw new Error("click_events dataset totals do not equal its manifest file totals.");
  }
  if (Number(manifest.resolved_counts?.click_events) !== fileRows) {
    throw new Error("manifest resolved click_events count does not equal click_events dataset rows.");
  }
  return {
    bytes: fileBytes,
    fileCount: files.length,
    files,
    representativeKey: files[0].key,
    representativeLocalPath,
    rows: fileRows,
    runId: manifest.run_id,
    schemaFingerprint: createHash("sha256")
      .update(JSON.stringify(clickEventSchema().map((column) => [column.sourceName, column.type])))
      .digest("hex"),
    sourcePrefix,
  };
}

async function assertUploadedPrefix(expected) {
  const listed = await listObjects(expected.sourcePrefix);
  const dataObjects = listed.filter((object) => isJsonlDataObject(object.Key));
  const byKey = new Map(dataObjects.map((object) => [object.Key, Number(object.Size || 0)]));
  for (const file of expected.files) {
    assert(byKey.has(file.key), `Uploaded click_events part is missing: s3://${bucket}/${file.key}`);
    assert(byKey.get(file.key) === file.bytes, metricMismatch(
      `remote bytes ${file.key}`,
      file.bytes,
      byKey.get(file.key),
    ));
  }
  const unexpected = [...byKey].filter(([key]) => !expected.files.some((file) => file.key === key));
  assert(unexpected.length === 0, `Uploaded prefix contains unexpected JSONL files: ${unexpected.map(([key]) => key).join(", ")}`);
  assert(dataObjects.length === expected.fileCount, metricMismatch(
    "uploaded data file count",
    expected.fileCount,
    dataObjects.length,
  ));
  const uploadedBytes = dataObjects.reduce((total, object) => total + Number(object.Size || 0), 0);
  assert(uploadedBytes === expected.bytes, metricMismatch(
    "uploaded data bytes",
    expected.bytes,
    uploadedBytes,
  ));
}

function sourceConfig(expected) {
  return [
    ["Storage Provider", "MinIO / S3 compatible"],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Bucket / Stage Name", bucket],
    ["Path / Prefix", expected.sourcePrefix],
    ["Access Key", accessKeyId],
    ["Secret Key", secretAccessKey],
    ["Use Path Style", "true"],
    ["File Type", "JSONL"],
    ["__Selection Kind", "prefix"],
    ["__Dataset Format", "JSONL"],
    ["__Source Unit Count", String(expected.fileCount)],
    ["__Source Total Bytes", String(expected.bytes)],
    ["__Excluded File Count", "0"],
    ["__Representative Object", expected.representativeKey],
    ["__Sample Object", expected.representativeKey],
    ["__Selected Object", ""],
    ["__Schema Compatible", "true"],
    ["__Schema Fingerprint", expected.schemaFingerprint],
    ["__Schema Sample Scope", "full"],
    ["__Schema Sample Scope Label", "전체 prefix"],
    ["__Execution Row Limit", "0"],
  ];
}

function restoreCredentialFields(testedFields, originalFields) {
  const restored = Array.isArray(testedFields) ? testedFields.map((field) => [...field]) : [];
  for (const label of ["Access Key", "Secret Key"]) {
    const value = originalFields.find(([fieldLabel]) => fieldLabel === label)?.[1] || "";
    const index = restored.findIndex(([fieldLabel]) => fieldLabel === label);
    if (index >= 0) restored[index] = [label, value];
    else restored.push([label, value]);
  }
  return restored;
}

function clickEventSchema() {
  return [
    schemaColumn("event_id", "String"),
    schemaColumn("user_id", "String"),
    schemaColumn("session_id", "String"),
    schemaColumn("event_time", "String"),
    schemaColumn("event_type", "String"),
    schemaColumn("product_id", "String"),
    schemaColumn("page_url", "String"),
    schemaColumn("device_type", "String"),
    schemaColumn("referrer", "String"),
    schemaColumn("properties.position", "Long", "properties_position"),
  ];
}

function schemaColumn(name, type, targetName = name) {
  return {
    included: true,
    nullable: false,
    sourceName: name,
    targetName,
    type,
  };
}

function nestedValue(row, fieldPath) {
  return String(fieldPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((value, key) => value?.[key], row);
}

function queryRequest(datasetId, query, validationKey) {
  return {
    baseDatasetId: datasetId,
    datasetId,
    limit: 100,
    mode: "preview",
    query,
    referenceDatasetIds: [],
    validationKey,
  };
}

function assertMeaningfulEventDistribution(eventCounts, expectedRows) {
  const impressions = eventCounts.get("product_impression") || 0;
  const clicks = eventCounts.get("product_click") || 0;
  const carts = eventCounts.get("add_to_cart") || 0;
  const purchases = eventCounts.get("purchase_click") || 0;
  const groupedRows = [...eventCounts.values()].reduce((total, count) => total + count, 0);
  assert(groupedRows === expectedRows, metricMismatch("GROUP BY row sum", expectedRows, groupedRows));
  assert(impressions > 0 && clicks > 0 && carts > 0 && purchases > 0, "Event GROUP BY must contain all four funnel stages.");
  assert(
    impressions >= clicks && clicks >= carts && carts >= purchases,
    `Funnel event counts are not monotonic: ${JSON.stringify(Object.fromEntries(eventCounts))}`,
  );
  assert(impressions > purchases, "Event distribution must show funnel drop-off.");
}

function assertSparkSampleRowsMatchSchema(report) {
  const schemaNames = (report.schema || []).map((field) => field?.name);
  const eventTypeIndex = schemaNames.indexOf("event_type");
  const positionIndex = schemaNames.indexOf("properties_position");
  const sample = report.sampleRows?.[0] || [];
  assert(eventTypeIndex >= 0 && positionIndex >= 0, "Spark report schema is missing click-event fields.");
  assert(
    ["product_impression", "product_click", "add_to_cart", "purchase_click"].includes(sample[eventTypeIndex]),
    `Spark sampleRows do not follow report schema order at event_type: ${safeJson(sample)}`,
  );
  assert(/^\d+$/.test(String(sample[positionIndex] ?? "")), `Spark sample properties_position is invalid: ${sample[positionIndex]}`);
}

function startServer() {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", captureLog);
  child.stderr.on("data", captureLog);
  return child;
}

function captureLog(chunk) {
  logTail = `${logTail}${String(chunk)}`.slice(-16_000);
}

function loadSparkReport(runId) {
  const reportPath = path.join(reportDir, `${runId}.json`);
  assert(existsSync(reportPath), `Spark report is missing: ${reportPath}`);
  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Spark report is invalid JSON: ${reportPath}: ${error.message}`);
  }
}

function listParquetFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.name.endsWith(".parquet")) files.push(entryPath);
    }
  };
  walk(directory);
  return files.sort();
}

async function readFirstJsonlRecord(filePath) {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ crlfDelay: Infinity, input });
  try {
    for await (const line of lines) {
      if (line.trim()) return JSON.parse(line);
    }
  } finally {
    lines.close();
    input.destroy();
  }
  throw new Error(`Representative JSONL part is empty: ${filePath}`);
}

async function listObjects(prefix) {
  const objects = [];
  let continuationToken;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      Prefix: prefix,
    }));
    objects.push(...(listed.Contents || []));
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function isJsonlDataObject(key) {
  const name = String(key || "").replace(/\/+$/, "").split("/").at(-1) || "";
  const lower = name.toLowerCase();
  return Boolean(name)
    && !name.startsWith("_")
    && !name.startsWith(".")
    && !["manifest.json", "_success"].includes(lower)
    && (lower.endsWith(".jsonl") || lower.endsWith(".ndjson"));
}

async function getJson(route) {
  return readResponse(route, await fetch(apiUrl(route)));
}

async function postJson(route, body) {
  return readResponse(route, await fetch(apiUrl(route), {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  }));
}

async function readResponse(route, response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { unparsed: text.slice(0, 1000) };
  }
  if (!response.ok) {
    throw new Error(`${route} failed ${response.status}: ${safeJson(payload)}`);
  }
  return payload;
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(apiUrl("/api/health"));
      if (response.ok) return;
      lastError = new Error(`health ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError || new Error("Backend health timeout.");
}

async function waitForJobCompletion(jobId, runId) {
  const deadline = Date.now() + timeoutMs;
  let latestJob;
  while (Date.now() < deadline) {
    latestJob = await getJson(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
    const run = latestJob.runHistory?.find((item) => item.runId === runId);
    if (["success", "failed", "canceled"].includes(run?.status)) return latestJob;
    await sleep(2000);
  }
  const latestRun = latestJob?.runHistory?.find((item) => item.runId === runId);
  throw new Error(`Prefix Spark run timed out: ${safeJson({
    jobStatus: latestJob?.status,
    runStatus: latestRun?.status,
  })}`);
}

function apiUrl(route) {
  return `http://127.0.0.1:${port}${route}`;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`${message}\nBackend log tail:\n${redactSecrets(logTail)}`);
  }
}

function metricMismatch(name, expected, actual) {
  return `${name} mismatch: expected=${expected} actual=${actual}`;
}

function parseRowCount(value) {
  const match = String(value ?? "").replaceAll(",", "").match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeManifestPath(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) {
    throw new Error(`Unsafe manifest file path: ${value}`);
  }
  return normalized;
}

function normalizeDatasetPrefix(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) {
    throw new Error(`Unsafe dataset prefix: ${value}`);
  }
  return `${normalized}/`;
}

function normalizeKeyPrefix(value) {
  const normalized = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) {
    throw new Error(`Unsafe S3 key prefix: ${value}`);
  }
  return `${normalized}/`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeJson(value) {
  return redactSecrets(JSON.stringify(value));
}

function redactSecrets(value) {
  let text = String(value || "");
  for (const secret of [accessKeyId, secretAccessKey]) {
    if (secret) text = text.split(secret).join("<redacted>");
  }
  return text.replace(/(secret|password|credential|access[_ -]?key)(["'=:\s]+)[^\s,}"']+/gi, "$1$2<redacted>");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
