import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const reportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const masterUrl = process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077";
const payload = readPayload();

try {
  const result = manage(payload);
  console.log(`ASKLAKE_KAFKA_CONTINUOUS_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_CONTINUOUS_ERROR=${JSON.stringify({
    code: "KAFKA_CONTINUOUS_WORKER_FAILED",
    message: error?.message || String(error),
    status: 502,
  })}`);
  process.exitCode = 1;
}

function manage(request) {
  const jobId = required(request.jobId, "jobId");
  const action = required(request.action, "action");
  const containerName = workerName(jobId);
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(ivyDir, { recursive: true });

  if (action === "start") return startWorker(request, containerName);
  if (action === "pause" || action === "stop") return stopWorker(jobId, action, containerName);
  if (action === "status") return workerStatus(jobId, containerName);
  throw new Error(`Unsupported continuous worker action: ${action}`);
}

function startWorker(request, containerName) {
  const jobId = required(request.jobId, "jobId");
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) {
    return { containerName, containerState: "running", jobId, report: readReport(jobId), started: false };
  }
  if (existing) runDocker(["rm", "-f", containerName], true);

  ensureSparkServer();
  const report = readReport(jobId);
  if (report?.status === "paused" || report?.status === "stopped") clearCommand(jobId);
  const packages = sparkPackages();
  const args = [
    "run", "-d", "--name", containerName, "--network", network,
    "--add-host", "host.docker.internal:host-gateway",
    "--label", "asklake.role=kafka-continuous-worker",
    "--label", `asklake.job-id=${jobId}`,
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    "-v", `${reportDir}:${reportContainerDir}`,
    "-e", `ASKLAKE_CONTINUOUS_JOB_ID=${jobId}`,
    "-e", `ASKLAKE_CONTINUOUS_BROKER=${required(request.broker, "broker")}`,
    "-e", `ASKLAKE_CONTINUOUS_TOPIC=${required(request.topic, "topic")}`,
    "-e", `ASKLAKE_CONTINUOUS_CONSUMER_GROUP_ID=${required(request.consumerGroupId, "consumerGroupId")}`,
    "-e", `ASKLAKE_CONTINUOUS_OUTPUT_PATH=${required(request.outputPath, "outputPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_CHECKPOINT_PATH=${required(request.checkpointPath, "checkpointPath")}`,
    "-e", `ASKLAKE_CONTINUOUS_OFFSET_POLICY=${request.initialOffsetPolicy || "earliest"}`,
    "-e", `ASKLAKE_CONTINUOUS_TRIGGER_SECONDS=${positiveInt(request.triggerIntervalSeconds, 30)}`,
    "-e", `ASKLAKE_CONTINUOUS_MAX_OFFSETS=${positiveInt(request.maxOffsetsPerTrigger, 10000)}`,
    "-e", `ASKLAKE_CONTINUOUS_INITIAL_COUNTS=${JSON.stringify(request.initialCounts || {})}`,
    "-e", `ASKLAKE_CONTINUOUS_SCHEMA_COLUMNS=${JSON.stringify(request.schemaColumns || [])}`,
    "-e", `ASKLAKE_CONTINUOUS_REPORT_FILE=${reportContainerDir}/${reportFileName(jobId)}`,
    "-e", `ASKLAKE_CONTINUOUS_COMMAND_FILE=${reportContainerDir}/${commandFileName(jobId)}`,
    "-e", `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://minio:9000"}`,
    "-e", `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ""}`,
    "-e", `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ""}`,
    "-e", `MINIO_REGION=${process.env.MINIO_REGION || "us-east-1"}`,
    "-e", "HOME=/tmp",
    image,
    "/opt/spark/bin/spark-submit", "--master", masterUrl,
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    "--conf", "spark.sql.streaming.stopGracefullyOnShutdown=true",
    "--packages", packages,
    "/work/scripts/kafka_continuous_stream.py",
  ];
  const containerId = runDocker(args).trim();
  return { containerId, containerName, containerState: "starting", jobId, report: readReport(jobId), started: true };
}

function stopWorker(jobId, action, containerName) {
  writeFileSync(commandFile(jobId), `${JSON.stringify({ action, requestedAt: new Date().toISOString() })}\n`, "utf8");
  const existing = inspectContainer(containerName);
  if (existing?.State?.Running) runDocker(["kill", "--signal=SIGTERM", containerName], true);
  return { containerName, containerState: existing?.State?.Running ? `${action}Requested` : "not_running", jobId, report: readReport(jobId) };
}

function workerStatus(jobId, containerName) {
  const existing = inspectContainer(containerName);
  return {
    containerName,
    containerState: existing?.State?.Running ? "running" : existing ? "exited" : "missing",
    exitCode: existing?.State?.ExitCode ?? null,
    jobId,
    report: readReport(jobId),
  };
}

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(backendDir, "scripts", "start-spark-server.mjs")], {
    cwd: backendDir,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
}

function sparkPackages() {
  const kafkaPackage = process.env.ASKLAKE_SPARK_KAFKA_PACKAGE || "org.apache.spark:spark-sql-kafka-0-10_2.13:4.0.1";
  const hadoopPackage = process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1";
  return [kafkaPackage, hadoopPackage].filter((value) => value && value !== "none").join(",");
}

function inspectContainer(name) {
  const result = runDocker(["inspect", name], true);
  if (!result) return null;
  try { return JSON.parse(result)[0] || null; } catch { return null; }
}

function runDocker(args, allowFailure = false) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) throw new Error(`docker ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.status === 0 ? result.stdout || "" : "";
}

function reportFileName(jobId) { return `kafka-continuous-${safeSegment(jobId)}.json`; }
function commandFileName(jobId) { return `kafka-continuous-${safeSegment(jobId)}.command.json`; }
function reportFile(jobId) { return path.join(reportDir, reportFileName(jobId)); }
function commandFile(jobId) { return path.join(reportDir, commandFileName(jobId)); }
function clearCommand(jobId) { if (existsSync(commandFile(jobId))) writeFileSync(commandFile(jobId), "", "utf8"); }
function readReport(jobId) {
  try { return existsSync(reportFile(jobId)) ? JSON.parse(readFileSync(reportFile(jobId), "utf8")) : null; } catch { return null; }
}
function workerName(jobId) { return `asklake-kafka-stream-${safeSegment(jobId)}`; }
function safeSegment(value) { return String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "job"; }
function required(value, name) { if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`); return String(value); }
function positiveInt(value, fallback) { const parsed = Number.parseInt(value, 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }
function readPayload() { const raw = readFileSync(0, "utf8").trim(); return raw ? JSON.parse(raw) : {}; }
