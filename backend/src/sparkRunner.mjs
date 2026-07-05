import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldValue, normalizeColumnName } from "./profile.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const ivyDir = path.join(backendDir, "tmp", "spark-ivy");
const reportDir = path.join(backendDir, "tmp", "spark-runs");
const localOutputDir = path.join(backendDir, "tmp", "spark-output");
const outputVolumeName = process.env.ASKLAKE_SPARK_OUTPUT_VOLUME || "asklake-spark-output";
const outputContainerDir = process.env.ASKLAKE_SPARK_OUTPUT_CONTAINER_DIR || "/work/output";

export function runSparkPipeline(job, command, runId) {
  ensureSparkServer();
  mkdirSync(ivyDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(localOutputDir, { recursive: true });

  const source = sparkSourceFromJob(job);
  const output = sparkOutputPath(job, runId);
  const reportPath = path.join(reportDir, `${runId}.json`);
  const dockerReportPath = `/work/reports/${runId}.json`;
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
    "-v",
    `${scriptsDir}:/work/scripts:ro`,
    "-v",
    `${ivyDir}:/tmp/.ivy2`,
    "-v",
    `${reportDir}:/work/reports`,
    "-v",
    `${outputVolumeName}:${outputContainerDir}`,
    "-e",
    `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://m3-minio:9000"}`,
    "-e",
    `MINIO_ACCESS_KEY=${minioAccessKey()}`,
    "-e",
    `MINIO_SECRET_KEY=${minioSecretKey()}`,
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
    "--packages",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
    "/work/scripts/spark_job_run.py",
  ];

  const result = spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const report = normalizeSparkReport(readSparkReport(reportPath, result.stdout), output);
  if (result.status === 0 && report.status === "success") {
    copySparkOutputToHost(output);
  }
  if (result.status !== 0 || report.status !== "success") {
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

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(scriptsDir, "start-spark-server.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw sparkError(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
  }
}

function sparkSourceFromJob(job) {
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

  throw sparkError(`Spark execution is currently wired for File / S3 and Data Lake jobs. Unsupported sourceType=${sourceType}`);
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
  mkdirSync(path.dirname(output.hostPath), { recursive: true });
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
