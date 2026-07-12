import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldValue, normalizeColumnName } from "./profile.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const sparkHostScriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || scriptsDir);
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const localOutputDir = path.resolve(process.env.ASKLAKE_SPARK_LOCAL_OUTPUT_DIR || path.join(backendDir, "tmp", "spark-output"));
const sampleHostDir = path.resolve(process.env.ASKLAKE_LOCAL_SAMPLE_DIR || path.join(os.tmpdir(), "asklake-1gb-samples"));
const sampleContainerDir = process.env.ASKLAKE_SAMPLE_CONTAINER_DIR || "/opt/asklake-samples";
const outputVolumeName = process.env.ASKLAKE_SPARK_OUTPUT_VOLUME || "asklake-spark-output";
const outputContainerDir = process.env.ASKLAKE_SPARK_OUTPUT_CONTAINER_DIR || "/work/output";

export function runSparkPipeline(job, command, runId) {
  ensureSparkServer();
  ensureWritableDir(ivyDir);
  ensureWritableDir(reportDir);
  ensureWritableDir(localOutputDir);
  ensureWritableDir(sampleHostDir);

  const source = sparkSourceFromJob(job, runId);
  const output = sparkOutputPath(job, runId);
  const reportPath = path.join(reportDir, `${runId}.json`);
  const dockerReportPath = `${reportContainerDir}/${runId}.json`;
  const manifestPath = path.join(reportDir, `${runId}.manifest.json`);
  const dockerManifestPath = `${reportContainerDir}/${runId}.manifest.json`;
  const packageArgs = sparkPackageArgs(source, output);
  writeSparkJobManifest(manifestPath, job, source);
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${sparkHostScriptsDir}:/work/scripts:ro`,
    "-v",
    `${ivyDir}:/tmp/.ivy2`,
    "-v",
    `${reportDir}:${reportContainerDir}`,
    "-v",
    `${sampleHostDir}:${sampleContainerDir}:ro`,
    "-v",
    `${outputVolumeName}:${outputContainerDir}`,
    "-e",
    `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://m3-minio:9000"}`,
    "-e",
    `MINIO_ACCESS_KEY=${fieldValue(job.sourceConfig ?? [], "Access Key") || minioAccessKey()}`,
    "-e",
    `MINIO_SECRET_KEY=${fieldValue(job.sourceConfig ?? [], "Secret Key") || minioSecretKey()}`,
    "-e",
    `MINIO_REGION=${process.env.MINIO_REGION || "us-east-1"}`,
    "-e",
    `ASKLAKE_SPARK_SOURCE_PATH=${source.path}`,
    "-e",
    `ASKLAKE_SPARK_SOURCE_FORMAT=${source.format}`,
    "-e",
    `ASKLAKE_SPARK_OUTPUT_PATH=${output.sparkPath}`,
    "-e",
    `ASKLAKE_SPARK_RUN_ROW_LIMIT=${sparkRowLimitFromJob(job)}`,
    "-e",
    `ASKLAKE_SPARK_RUN_ID=${runId}`,
    "-e",
    `ASKLAKE_SPARK_JOB_MANIFEST_FILE=${dockerManifestPath}`,
    "-e",
    `ASKLAKE_SPARK_REPORT_FILE=${dockerReportPath}`,
    "-e",
    `ASKLAKE_SPARK_APP_NAME=asklake-${command}-${job.id}`,
    "-e",
    "HOME=/tmp",
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master",
    process.env.ASKLAKE_SPARK_MASTER_URL
      || `spark://${process.env.ASKLAKE_SPARK_MASTER_CONTAINER || "asklake-spark-master"}:7077`,
    "--driver-memory",
    process.env.ASKLAKE_SPARK_DRIVER_MEMORY || "4g",
    "--executor-memory",
    process.env.ASKLAKE_SPARK_EXECUTOR_MEMORY || "8g",
    "--conf",
    "spark.jars.ivy=/tmp/.ivy2",
    "--conf",
    `spark.executor.cores=${process.env.ASKLAKE_SPARK_EXECUTOR_CORES || "4"}`,
    "--conf",
    `spark.cores.max=${process.env.ASKLAKE_SPARK_CORES_MAX || "4"}`,
    "--conf",
    `spark.sql.shuffle.partitions=${process.env.ASKLAKE_SPARK_SQL_SHUFFLE_PARTITIONS || "32"}`,
    ...packageArgs,
    "/work/scripts/spark_job_run.py",
  ];

  let result = runSparkSubmitContainer(dockerArgs);
  let report = readSparkReport(reportPath, result.stdout);
  if (report.status !== "success" && shouldRetryDockerWait(result)) {
    rmSync(reportPath, { force: true });
    result = runSparkSubmitContainer(dockerArgs);
    report = readSparkReport(reportPath, result.stdout);
  }
  if (report.status === "success") {
    copySparkOutputToHost(output);
    copySparkReportArtifactsToHost(report);
  }
  report = normalizeSparkReport(report, output);
  if (report.status !== "success") {
    const spawnError = result.error?.message || "";
    return {
      ...report,
      error: report.error || result.stderr || result.stdout || spawnError || "Spark job failed.",
      sparkExitCode: result.status ?? 1,
      stderr: tail(result.stderr),
      stdout: tail(result.stdout),
      status: "failed",
    };
  }

  return {
    ...report,
    sparkExitCode: 0,
    stderr: tail(result.stderr),
    stdout: tail(result.stdout),
  };
}

function writeSparkJobManifest(manifestPath, job, source) {
  writeFileSync(manifestPath, `${JSON.stringify(sparkJobManifest(job, source), null, 2)}\n`, "utf8");
}

export function sparkJobManifest(job, source) {
  return {
    createdAt: new Date().toISOString(),
    partitionColumns: job.partition || "",
    qualityRules: job.qualityRules ?? [],
    schemaColumns: job.schemaColumns ?? [],
    sourceCollection: sourceCollectionFromConfig(
      job.sourceConfig ?? [],
      job.sourceIncrementalSince,
      job.sourceIncrementalBefore,
      job.sourceWindowContractVersion,
      job.sourceWindowRebaseline,
    ),
    sourceParsing: sourceParsingFromConfig(job.sourceConfig ?? []),
    sqlExecution: source?.sqlExecution ?? null,
    targetFormat: normalizeTargetFormat(job.targetFormat),
    transformSteps: job.transformSteps ?? [],
  };
}

function sparkPackageArgs(source, output) {
  if (process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE === "none") return [];
  if (!sourceUsesS3(source) && !usesS3A(output.sparkPath)) return [];
  return [
    "--packages",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
  ];
}

function usesS3A(value) {
  return /^s3a?:\/\//i.test(String(value || ""));
}

function sourceUsesS3(source) {
  if (usesS3A(source?.path)) return true;
  return (source?.sqlExecution?.datasets ?? []).some((dataset) =>
    (dataset.storageSegments ?? []).some((segment) => usesS3A(segment.location))
  );
}

function runSparkSubmitContainer(dockerArgs) {
  return spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function shouldRetryDockerWait(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return result.status !== 0 && /error waiting for container: unexpected EOF/i.test(text);
}

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "start-spark-server.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ASKLAKE_SPARK_REPORT_CONTAINER_DIR: reportContainerDir,
      ASKLAKE_SPARK_REPORT_DIR: reportDir,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
  }
}

export function sparkSourceFromJob(job, runId) {
  const sourceType = job.sourceType || "";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  if (String(sourceType).trim().toLowerCase() === "sql result") {
    const sqlExecution = normalizeSqlExecutionContract(job.sqlExecution);
    return {
      format: "sql",
      path: `catalog://${sqlExecution.baseDatasetId}`,
      sqlExecution,
    };
  }
  if (sourceType === "File / S3") {
    const bucket = normalizeBucketName(fieldValue(sourceConfig, "Bucket / Stage Name") || process.env.MINIO_BUCKET || "m3-raw");
    const prefix = normalizeBucketRelativePath(
      normalizeSourcePath(fieldValue(sourceConfig, "Path / Prefix")),
      bucket,
    );
    if (/^s3a?:\/\//i.test(prefix)) {
      return {
        format: inferFormat(sourceConfig, prefix, "csv"),
        path: toS3APath(prefix),
      };
    }
    return {
      format: inferFormat(sourceConfig, prefix, "csv"),
      path: prefix ? `s3a://${bucket}/${prefix}` : `s3a://${bucket}/`,
    };
  }
  if (sourceType === "Data Lake") {
    return {
      format: "parquet",
      path: toS3APath(fieldValue(sourceConfig, "Path") || "s3://m3-raw/nyc_taxi/yellow_parquet/"),
    };
  }

  const samplePath = hasInlineSampleEndpoint(job)
    ? writeSampleRowsSource(job, runId) || writeConnectorSampleRowsSource(job, runId)
    : isConnectorSampleSource(sourceType)
      ? writeConnectorSampleRowsSource(job, runId) || writeSampleRowsSource(job, runId)
      : writeSampleRowsSource(job, runId) || writeConnectorSampleRowsSource(job, runId);
  if (samplePath) {
    return {
      format: "jsonl",
      path: `file://${reportContainerDir}/${path.basename(samplePath)}`,
    };
  }

  throw sparkError(`Spark execution requires File / S3, Data Lake, or a connector sample with schema rows. Unsupported sourceType=${sourceType}`);
}

function normalizeSqlExecutionContract(value) {
  if (!value || typeof value !== "object") {
    throw sparkError("SQL Result execution requires a backend-resolved sqlExecution contract.");
  }
  if (Number(value.version) !== 1 || value.validatedReadOnly !== true) {
    throw sparkError("SQL Result execution requires a validated read-only sqlExecution v1 contract.");
  }

  const sourceRunId = requiredSqlExecutionString(value.sourceRunId, "sourceRunId");
  const baseDatasetId = requiredSqlExecutionString(value.baseDatasetId, "baseDatasetId");
  const query = requiredSqlExecutionString(value.query, "query");
  const referenceDatasetIds = Array.isArray(value.referenceDatasetIds)
    ? value.referenceDatasetIds.map((item) => requiredSqlExecutionString(item, "referenceDatasetIds[]"))
    : [];
  const datasets = Array.isArray(value.datasets)
    ? value.datasets.map((dataset, datasetIndex) => normalizeSqlDatasetInput(dataset, datasetIndex))
    : [];
  if (datasets.length === 0) {
    throw sparkError("sqlExecution.datasets must include the selected Catalog dataset inputs.");
  }

  const datasetIds = new Set(datasets.map((dataset) => dataset.datasetId));
  for (const datasetId of [baseDatasetId, ...referenceDatasetIds]) {
    if (!datasetIds.has(datasetId)) {
      throw sparkError(`sqlExecution is missing the physical input for Catalog dataset ${datasetId}.`);
    }
  }

  return {
    baseDatasetId,
    datasets,
    query,
    referenceDatasetIds,
    sourceRunId,
    validatedReadOnly: true,
    version: 1,
  };
}

function normalizeSqlDatasetInput(value, datasetIndex) {
  if (!value || typeof value !== "object") {
    throw sparkError(`sqlExecution.datasets[${datasetIndex}] must be an object.`);
  }
  const datasetId = requiredSqlExecutionString(value.datasetId, `datasets[${datasetIndex}].datasetId`);
  const name = requiredSqlExecutionString(value.name, `datasets[${datasetIndex}].name`);
  const storageSegments = Array.isArray(value.storageSegments)
    ? value.storageSegments.map((segment, segmentIndex) => normalizeSqlStorageSegment(segment, datasetIndex, segmentIndex))
    : [];
  if (storageSegments.length === 0) {
    throw sparkError(`Catalog dataset ${datasetId} has no physical storage segments.`);
  }
  return { datasetId, name, storageSegments };
}

function normalizeSqlStorageSegment(value, datasetIndex, segmentIndex) {
  if (!value || typeof value !== "object") {
    throw sparkError(`sqlExecution.datasets[${datasetIndex}].storageSegments[${segmentIndex}] must be an object.`);
  }
  const format = requiredSqlExecutionString(
    value.format,
    `datasets[${datasetIndex}].storageSegments[${segmentIndex}].format`,
  ).toLowerCase();
  if (!new Set(["csv", "json", "jsonl", "parquet"]).has(format)) {
    throw sparkError(`Unsupported SQL Job storage format: ${format}.`);
  }
  return {
    format,
    location: sparkSqlStorageLocation(requiredSqlExecutionString(
      value.location,
      `datasets[${datasetIndex}].storageSegments[${segmentIndex}].location`,
    )),
  };
}

function requiredSqlExecutionString(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw sparkError(`sqlExecution.${fieldName} is required.`);
  return normalized;
}

function sparkSqlStorageLocation(value) {
  if (usesS3A(value)) return toS3APath(value);

  const normalizedFileValue = String(value).replace(/\\/g, "/");
  const allowedContainerPrefixes = [outputContainerDir, sampleContainerDir]
    .map((containerDir) => `file://${String(containerDir).replace(/\/+$/g, "")}/`);
  if (allowedContainerPrefixes.some((prefix) => normalizedFileValue.startsWith(prefix))) {
    return normalizedFileValue;
  }

  let hostPath = value;
  if (/^file:\/\//i.test(value)) {
    try {
      hostPath = fileURLToPath(value);
    } catch {
      throw sparkError(`SQL Job storage location is not a valid file URI: ${value}`);
    }
  }

  for (const [hostRoot, containerRoot] of [
    [localOutputDir, outputContainerDir],
    [sampleHostDir, sampleContainerDir],
  ]) {
    const resolved = path.resolve(hostPath);
    const relative = path.relative(hostRoot, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      const containerPath = [String(containerRoot).replace(/\/+$/g, ""), relative.replace(/\\/g, "/")]
        .filter(Boolean)
        .join("/");
      return `file://${containerPath}`;
    }
  }

  throw sparkError(`SQL Job local storage is outside the Spark-mounted data roots: ${value}`);
}

function isConnectorSampleSource(sourceType) {
  return ["mongodb", "postgresql", "database", "rest api", "stream / kafka", "kafka json"].includes(
    String(sourceType || "").trim().toLowerCase(),
  );
}

function hasInlineSampleEndpoint(job) {
  const sourceConfig = Array.isArray(job?.sourceConfig) ? job.sourceConfig : [];
  const endpoint = fieldValue(sourceConfig, "Endpoint URL") || fieldValue(sourceConfig, "Endpoint");
  return /^sample:\/\//i.test(endpoint);
}

function writeSampleRowsSource(job, runId) {
  const rows = Array.isArray(job.schemaSampleRows) ? job.schemaSampleRows : [];
  const columns = Array.isArray(job.schemaColumns) ? job.schemaColumns : [];
  if (rows.length === 0 || columns.length === 0) return "";
  return writeRowsSource(runId, columns, rows);
}

function writeConnectorSampleRowsSource(job, runId) {
  const sourceType = job.sourceType || "";
  if (!isConnectorSampleSource(sourceType)) return "";

  const result = spawnSync(process.execPath, [path.join(scriptsDir, "export-connector-sample.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
    input: JSON.stringify({
      sourceConfig: Array.isArray(job.sourceConfig) ? job.sourceConfig : [],
      sourceType,
    }),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`Connector sample export failed for ${sourceType}.\n${result.stdout}\n${result.stderr}`);
  }

  const marker = String(result.stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_CONNECTOR_SAMPLE="));
  if (!marker) return "";
  const sample = JSON.parse(marker.slice("ASKLAKE_CONNECTOR_SAMPLE=".length));
  const rows = Array.isArray(sample.rows) ? sample.rows : [];
  const columns = Array.isArray(sample.columns) ? sample.columns : [];
  if (rows.length === 0 || columns.length === 0) return "";
  return writeRowsSource(runId, columns, rows);
}

function writeRowsSource(runId, columns, rows) {
  const outputColumns = columns.map((column, index) => ({
    index,
    sourceName: String(column?.sourceName || ""),
    targetName: String(column?.targetName || column?.sourceName || `column_${index + 1}`),
  }));
  const filePath = path.join(reportDir, `${runId}-source.jsonl`);
  const content = rows.map((row, rowIndex) => {
    const item = { row_id: String(rowIndex + 1) };
    outputColumns.forEach((column) => {
      const value = sourceRowValue(row, column);
      setSourceField(item, column.targetName, value);
      setSourceField(item, normalizeColumnName(column.targetName), value);
      setSourceField(item, column.sourceName, value);
      setSourceField(item, normalizeColumnName(column.sourceName), value);
    });
    return JSON.stringify(item);
  }).join("\n");
  writeFileSync(filePath, `${content}\n`, "utf8");
  return filePath;
}

function sourceRowValue(row, column) {
  if (Array.isArray(row)) return row[column.index] ?? "";
  if (!row || typeof row !== "object") return "";
  const names = [
    column.sourceName,
    column.targetName,
    normalizeColumnName(column.sourceName),
    normalizeColumnName(column.targetName),
  ].filter(Boolean);
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name] ?? "";
  }
  return "";
}

function setSourceField(item, name, value) {
  const key = String(name || "").trim();
  if (!key || Object.prototype.hasOwnProperty.call(item, key)) return;
  item[key] = value;
}

function sparkOutputPath(job, runId) {
  const layer = normalizeColumnName(job.targetLayer || "gold") || "gold";
  const dataset = normalizeColumnName(job.target || job.name || "asklake_dataset");
  const prefix = normalizePrefix(process.env.ASKLAKE_SPARK_OUTPUT_PREFIX || "asklake-output");
  const outputMode = (process.env.ASKLAKE_SPARK_OUTPUT_MODE || "auto").toLowerCase();
  const configuredTarget = String(job.storagePath || "").trim();
  const useObjectStorage = outputMode === "s3a"
    || (outputMode === "auto" && /^s3a?:\/\//i.test(configuredTarget));
  if (useObjectStorage) {
    // storagePath is the configured destination root. targetPath is the latest
    // observed Run output and must not become the next Run's parent directory.
    const targetBase = /^s3a?:\/\//i.test(configuredTarget)
      ? toS3APath(configuredTarget).replace(/\/+$/, "")
      : `s3a://${process.env.ASKLAKE_SPARK_OUTPUT_BUCKET || "asklake-output"}/${prefix}${layer}/${dataset}`;
    const sparkPath = targetBase.endsWith(`/${runId}`) ? targetBase : `${targetBase}/${runId}`;
    return { displayPath: sparkPath, sparkPath };
  }

  const relativePath = path.join(layer, dataset, runId);
  return {
    hostPath: path.join(localOutputDir, relativePath),
    relativePath: relativePath.replace(/\\/g, "/"),
    displayPath: path.join(localOutputDir, relativePath),
    sparkPath: `file://${outputContainerDir}/${relativePath.replace(/\\/g, "/")}`,
  };
}

export function sparkRowLimitFromJob(job) {
  if (String(job?.sourceType || "").trim().toLowerCase() === "sql result") return "0";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  const configuredLimit = fieldValue(sourceConfig, "__Execution Row Limit") || fieldValue(sourceConfig, "Execution Row Limit");
  if (configuredLimit && Number(configuredLimit) > 0) return configuredLimit;
  const scope = fieldValue(sourceConfig, "__Schema Sample Scope");
  if (scope === "slice1gb") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "10000";
  if (scope === "full") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "0";
  return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "0";
}

function inferFormat(sourceConfig, prefix, fallback) {
  const sampleObject = fieldValue(sourceConfig, "__Sample Object");
  const fileType = String(fieldValue(sourceConfig, "File Type") || "").toLowerCase();
  const parserMode = String(fieldValue(sourceConfig, "Parser Mode") || "").toLowerCase();
  const delimitedFields = fieldValue(sourceConfig, "Delimited Fields");
  const probe = `${sampleObject} ${prefix} ${fileType}`.toLowerCase();
  if (probe.includes(".jsonl") || probe.includes("jsonl") || probe.includes("ndjson")) return "jsonl";
  if (probe.includes(".json") || probe.includes("json")) return "json";
  if (probe.includes(".parquet") || probe.includes("parquet")) return "parquet";
  if (parserMode === "delimited" || delimitedFields || probe.includes(".log") || probe.includes("delimited")) return "csv";
  if (probe.includes(".txt") || probe.includes(".text") || probe.includes("txt")) return "txt";
  if (probe.includes(".tsv") || probe.includes("tsv")) return "csv";
  if (probe.includes(".csv") || probe.includes("csv")) return "csv";
  return fallback;
}

export function sourceParsingFromConfig(sourceConfig) {
  const fields = parseDelimitedFields(fieldValue(sourceConfig, "Delimited Fields"));
  const delimiter = decodeDelimiter(fieldValue(sourceConfig, "Delimiter"))
    || decodeDelimiter(fieldValue(sourceConfig, "__Detected Delimiter"));
  const header = parseHeader(
    fieldValue(sourceConfig, "Header"),
    fieldValue(sourceConfig, "__Detected Header"),
  );
  const quote = decodeSingleCharacter(fieldValue(sourceConfig, "Quote Character"), '"', "");
  const escape = decodeSingleCharacter(fieldValue(sourceConfig, "Escape Character"), "", "");
  const mode = String(fieldValue(sourceConfig, "Parser Mode") || "auto").trim().toLowerCase();
  const rowDelimiter = decodeRowDelimiter(fieldValue(sourceConfig, "Row Delimiter"))
    || decodeRowDelimiter(fieldValue(sourceConfig, "__Detected Row Delimiter"));
  if (mode !== "delimited" && fields.length === 0 && !delimiter) return null;
  return {
    delimiter: delimiter || null,
    encoding: fieldValue(sourceConfig, "Encoding") || "UTF-8",
    escape,
    fields,
    header,
    mode: mode === "raw" ? "raw" : "delimited",
    quote,
    rowDelimiter,
  };
}

export function sourceCollectionFromConfig(
  sourceConfig,
  incrementalSince = undefined,
  incrementalBefore = undefined,
  windowContractVersion = undefined,
  sourceWindowRebaseline = false,
) {
  const scope = String(fieldValue(sourceConfig, "Collection Scope") || "file").trim().toLowerCase() === "folder"
    ? "folder"
    : "file";
  const collectionMode = String(fieldValue(sourceConfig, "Collection Mode") || "incremental").trim().toLowerCase();
  const mode = scope === "folder" && collectionMode !== "full" ? "incremental" : "full";
  const boundedWindowVersion = mode === "incremental" && Number(windowContractVersion) === 1 ? 1 : null;
  return {
    filePattern: scope === "folder" ? fieldValue(sourceConfig, "File Pattern") || null : null,
    incrementalBefore: mode === "incremental" && incrementalBefore ? String(incrementalBefore) : null,
    incrementalSince: mode === "incremental" && incrementalSince ? String(incrementalSince) : null,
    mode,
    rebaseline: boundedWindowVersion === 1 && sourceWindowRebaseline === true,
    recursive: scope === "folder" && parseConfigBoolean(fieldValue(sourceConfig, "Recursive")),
    scope,
    windowContractVersion: boundedWindowVersion,
  };
}

function normalizeTargetFormat(value) {
  const format = String(value || "parquet").trim().toLowerCase();
  return format === "parquet" ? "parquet" : format;
}

function parseDelimitedFields(value) {
  if (!String(value || "").trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 200).map((field, index) => ({
      name: String(field?.name || `column_${index + 1}`).trim(),
      nullable: field?.nullable !== false,
      type: String(field?.type || "String"),
    }));
  } catch {
    throw sparkError("Delimited Fields must be valid JSON before Spark execution.");
  }
}

function decodeDelimiter(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "auto") return "";
  const aliases = { "\\t": "\t", comma: ",", pipe: "|", semicolon: ";", space: " ", tab: "\t" };
  const decoded = aliases[raw.toLowerCase()] ?? raw;
  if (Array.from(decoded).length !== 1) throw sparkError("Spark CSV delimiter must be exactly one character.");
  return decoded;
}

function decodeSingleCharacter(value, fallback, noneValue = fallback) {
  const raw = String(value || "");
  if (!raw) return fallback;
  if (raw.toLowerCase() === "none") return noneValue;
  const decoded = raw === "\\t" ? "\t" : raw === "\\\\" ? "\\" : raw;
  if (Array.from(decoded).length !== 1) throw sparkError("Spark quote and escape values must be one character or none.");
  return decoded;
}

function decodeRowDelimiter(value) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (!normalized || normalized === "auto") return null;
  const aliases = { "\\n": "\n", "\\r": "\r", "\\r\\n": "\r\n", cr: "\r", crlf: "\r\n", lf: "\n", newline: "\n" };
  const decoded = aliases[normalized];
  if (!decoded) throw sparkError("Spark row delimiter must be auto, \\n, \\r, or \\r\\n.");
  return decoded;
}

function parseConfigBoolean(value) {
  return ["true", "1", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseHeader(value, detectedValue) {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (["true", "yes", "1", "header", "treat first row as header"].includes(normalized)) return true;
  if (["false", "no", "0", "none", "no header"].includes(normalized)) return false;
  return ["true", "yes", "1"].includes(String(detectedValue || "true").trim().toLowerCase());
}

function toS3APath(value) {
  return String(value).replace(/^s3:\/\//, "s3a://");
}

function normalizePrefix(value) {
  const cleaned = String(value ?? "").replace(/^\/+/, "");
  if (!cleaned) return "";
  return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function normalizeSourcePath(value) {
  return String(value ?? "").replace(/^\/+/, "");
}

function normalizeBucketName(value) {
  return String(value ?? "")
    .replace(/^s3a?:\/\//i, "")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeBucketRelativePath(value, bucket) {
  const normalized = String(value ?? "").replace(/^\/+/, "");
  if (!normalized || /^s3a?:\/\//i.test(normalized)) return normalized;
  const normalizedBucket = normalizeBucketName(bucket);
  if (!normalizedBucket) return normalized;
  if (normalized === normalizedBucket) return "";
  const bucketPrefix = `${normalizedBucket}/`;
  return normalized.startsWith(bucketPrefix) ? normalized.slice(bucketPrefix.length) : normalized;
}

function readSparkReport(reportPath, stdout) {
  if (existsSync(reportPath)) {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  }
  const marker = String(stdout || "").split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_SPARK_JOB_RESULT="));
  if (marker) return JSON.parse(marker.slice("ASKLAKE_SPARK_JOB_RESULT=".length));
  return { status: "failed" };
}

function normalizeSparkReport(report, output) {
  if (!report || typeof report !== "object") return report;
  return {
    ...report,
    outputPath: normalizeSparkOutputDisplayPath(report.outputPath, output),
    sparkOutputPath: output.sparkPath,
    quality: normalizeSparkReportQuality(report.quality, output),
  };
}

function copySparkOutputToHost(output) {
  if (!output.relativePath || !output.hostPath) return;
  copySparkVolumeRelativePathToHost(output.relativePath, output.hostPath, "Spark output");
}

function copySparkReportArtifactsToHost(report) {
  const quarantinePath = report?.quality?.quarantine?.path;
  const quarantineArtifact = localOutputArtifactFromSparkPath(quarantinePath);
  if (quarantineArtifact) {
    copySparkVolumeRelativePathToHost(
      quarantineArtifact.relativePath,
      quarantineArtifact.hostPath,
      "Spark quarantine output",
    );
  }
}

function normalizeSparkReportQuality(quality, output) {
  if (!quality || typeof quality !== "object") return quality;
  const quarantine = quality.quarantine && typeof quality.quarantine === "object"
    ? {
      ...quality.quarantine,
      path: normalizeSparkOutputDisplayPath(quality.quarantine.path, output),
    }
    : quality.quarantine;
  return {
    ...quality,
    quarantine,
  };
}

function normalizeSparkOutputDisplayPath(value, output) {
  if (value === output.sparkPath) return output.displayPath;
  const artifact = localOutputArtifactFromSparkPath(value);
  return artifact?.hostPath ?? value;
}

function localOutputArtifactFromSparkPath(value) {
  const text = String(value || "");
  const prefix = `file://${outputContainerDir.replace(/\/+$/g, "")}/`;
  if (!text.startsWith(prefix)) return null;
  const relativePath = text.slice(prefix.length).replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("\0")) return null;
  const hostPath = path.resolve(localOutputDir, ...relativePath.split("/").filter(Boolean));
  assertWithinLocalOutput(hostPath);
  return {
    hostPath,
    relativePath,
  };
}

function copySparkVolumeRelativePathToHost(relativePath, hostPath, label) {
  assertWithinLocalOutput(hostPath);
  ensureWritableDir(path.dirname(hostPath));
  const hostParent = path.dirname(hostPath);
  const leaf = path.basename(hostPath);
  const tmpLeaf = `${leaf}.tmp`;
  const script = [
    `test -d /from/${shellQuote(relativePath)}`,
    `rm -rf /to/${shellQuote(tmpLeaf)}`,
    `cp -r /from/${shellQuote(relativePath)} /to/${shellQuote(tmpLeaf)}`,
    `rm -rf /to/${shellQuote(leaf)}`,
    `mv /to/${shellQuote(tmpLeaf)} /to/${shellQuote(leaf)}`,
  ].join(" && ");
  const result = spawnSync("docker", [
    "run",
    "--rm",
    "-v",
    `${outputVolumeName}:/from:ro`,
    "-v",
    `${hostParent}:/to`,
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/bin/sh",
    "-c",
    script,
  ], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`${label} was written but could not be copied to host.\n${result.stdout}\n${result.stderr}`);
  }
}

function assertWithinLocalOutput(hostPath) {
  const resolved = path.resolve(hostPath);
  const relative = path.relative(localOutputDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw sparkError(`Refusing to copy Spark artifact outside local output directory: ${resolved}`);
  }
}

function ensureWritableDir(dir) {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
}

function minioAccessKey() {
  return process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
}

function minioSecretKey() {
  return process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function tail(value) {
  const text = String(value || "");
  return text.length > 4000 ? text.slice(-4000) : text;
}

function sparkError(message) {
  const error = new Error(message);
  error.code = "SPARK_RUN_FAILED";
  error.status = 500;
  return error;
}
