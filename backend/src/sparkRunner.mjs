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
  const packageArgs = sparkPackageArgs(source, output);
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
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
    `ASKLAKE_SPARK_TRANSFORM_STEPS=${JSON.stringify(job.transformSteps ?? [])}`,
    "-e",
    `ASKLAKE_SPARK_QUALITY_RULES=${JSON.stringify(job.qualityRules ?? [])}`,
    "-e",
    `ASKLAKE_SPARK_SCHEMA_COLUMNS=${JSON.stringify(job.schemaColumns ?? [])}`,
    "-e",
    `ASKLAKE_SPARK_REPORT_FILE=${dockerReportPath}`,
    "-e",
    `ASKLAKE_SPARK_APP_NAME=asklake-${command}-${job.id}`,
    "-e",
    "HOME=/tmp",
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master",
    process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077",
    "--conf",
    "spark.jars.ivy=/tmp/.ivy2",
    ...packageArgs,
    "/work/scripts/spark_job_run.py",
  ];

  let result = runSparkSubmitContainer(dockerArgs);
  let report = normalizeSparkReport(readSparkReport(reportPath, result.stdout), output);
  if (report.status !== "success" && shouldRetryDockerWait(result)) {
    rmSync(reportPath, { force: true });
    result = runSparkSubmitContainer(dockerArgs);
    report = normalizeSparkReport(readSparkReport(reportPath, result.stdout), output);
  }
  if (report.status === "success") {
    copySparkOutputToHost(output);
  }
  if (report.status !== "success") {
    return {
      ...report,
      error: report.error || result.stderr || result.stdout || "Spark job failed.",
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

function sparkPackageArgs(source, output) {
  if (process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE === "none") return [];
  if (!usesS3A(source.path) && !usesS3A(output.sparkPath)) return [];
  return [
    "--packages",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
  ];
}

function usesS3A(value) {
  return /^s3a?:\/\//i.test(String(value || ""));
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

function sparkSourceFromJob(job, runId) {
  const sourceType = job.sourceType || "";
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  if (sourceType === "File / S3") {
    const bucket = fieldValue(sourceConfig, "Bucket / Stage Name") || process.env.MINIO_BUCKET || "m3-raw";
    const prefix = normalizeSourcePath(fieldValue(sourceConfig, "Path / Prefix"));
    if (/^s3a?:\/\//i.test(prefix)) {
      return {
        format: inferFormat(sourceConfig, prefix, "csv"),
        path: toS3APath(prefix),
      };
    }
    return {
      format: inferFormat(sourceConfig, prefix, "csv"),
      path: `s3a://${bucket}/${prefix}`,
    };
  }
  if (sourceType === "Data Lake") {
    return {
      format: "parquet",
      path: toS3APath(fieldValue(sourceConfig, "Path") || "s3://m3-raw/nyc_taxi/yellow_parquet/"),
    };
  }

  const samplePath = isConnectorSampleSource(sourceType)
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

function isConnectorSampleSource(sourceType) {
  return ["mongodb", "postgresql", "database", "rest api", "stream / kafka", "kafka json"].includes(
    String(sourceType || "").trim().toLowerCase(),
  );
}

function writeSampleRowsSource(job, runId) {
  const rows = Array.isArray(job.schemaSampleRows) ? job.schemaSampleRows : [];
  const columns = Array.isArray(job.schemaColumns) ? job.schemaColumns : [];
  if (rows.length === 0 || columns.length === 0) return "";
  return writeRowsSource(runId, columns, rows);
}

function hasSchemaSampleRows(job) {
  return (
    Array.isArray(job.schemaSampleRows) &&
    job.schemaSampleRows.length > 0 &&
    Array.isArray(job.schemaColumns) &&
    job.schemaColumns.length > 0
  );
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
    if (hasSchemaSampleRows(job)) return "";
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
  const bucket = fieldValue(job.sourceConfig ?? [], "Bucket / Stage Name") || process.env.MINIO_BUCKET || "m3-raw";
  const layer = normalizeColumnName(job.targetLayer || "gold") || "gold";
  const dataset = normalizeColumnName(job.target || job.name || "asklake_dataset");
  const prefix = normalizePrefix(process.env.ASKLAKE_SPARK_OUTPUT_PREFIX || "asklake-output");
  if ((process.env.ASKLAKE_SPARK_OUTPUT_MODE || "local").toLowerCase() === "s3a") {
    const sparkPath = `s3a://${bucket}/${prefix}${layer}/${dataset}/${runId}`;
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

function sparkRowLimitFromJob(job) {
  const sourceConfig = Array.isArray(job.sourceConfig) ? job.sourceConfig : [];
  const configuredLimit = fieldValue(sourceConfig, "__Sample Row Limit");
  if (configuredLimit && Number(configuredLimit) > 0) return configuredLimit;
  const scope = fieldValue(sourceConfig, "__Schema Sample Scope");
  if (scope === "slice1gb") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "10000";
  if (scope === "full") return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "100000";
  return process.env.ASKLAKE_SPARK_RUN_ROW_LIMIT || "10000";
}

function inferFormat(sourceConfig, prefix, fallback) {
  const sampleObject = fieldValue(sourceConfig, "__Sample Object");
  const fileType = String(fieldValue(sourceConfig, "File Type") || "").toLowerCase();
  const probe = `${sampleObject} ${prefix} ${fileType}`.toLowerCase();
  if (probe.includes(".jsonl") || probe.includes("jsonl") || probe.includes("ndjson")) return "jsonl";
  if (probe.includes(".json") || probe.includes("json")) return "json";
  if (probe.includes(".parquet") || probe.includes("parquet")) return "parquet";
  if (probe.includes(".txt") || probe.includes(".text") || probe.includes("txt")) return "txt";
  if (probe.includes(".tsv") || probe.includes("tsv")) return "csv";
  if (probe.includes(".csv") || probe.includes("csv")) return "csv";
  return fallback;
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
    outputPath: report.outputPath === output.sparkPath ? output.displayPath : report.outputPath,
    sparkOutputPath: output.sparkPath,
  };
}

function copySparkOutputToHost(output) {
  if (!output.relativePath || !output.hostPath) return;
  ensureWritableDir(path.dirname(output.hostPath));
  const hostParent = path.dirname(output.hostPath);
  const leaf = path.basename(output.hostPath);
  const tmpLeaf = `${leaf}.tmp`;
  const script = [
    `test -d /from/${shellQuote(output.relativePath)}`,
    `rm -rf /to/${shellQuote(tmpLeaf)}`,
    `cp -r /from/${shellQuote(output.relativePath)} /to/${shellQuote(tmpLeaf)}`,
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
    throw sparkError(`Spark output was written but could not be copied to host.\n${result.stdout}\n${result.stderr}`);
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
