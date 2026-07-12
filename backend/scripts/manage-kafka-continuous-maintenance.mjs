import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.resolve(process.env.ASKLAKE_SPARK_HOST_SCRIPTS_DIR || path.join(backendDir, "scripts"));
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const masterUrl = process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077";
const request = JSON.parse(readFileSync(0, "utf8").trim() || "{}");

try {
  const result = request.action === "cleanup" ? cleanupMaintenance(request) : runMaintenanceWithSpark(request);
  console.log(`ASKLAKE_KAFKA_MAINTENANCE_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_MAINTENANCE_ERROR=${JSON.stringify({ code: "KAFKA_CONTINUOUS_MAINTENANCE_FAILED", message: error?.message || String(error), status: 502 })}`);
  process.exitCode = 1;
}

function runMaintenanceWithSpark(input) {
  ensureSparkServer();
  return runMaintenance(input);
}

function cleanupMaintenance(input) {
  const runId = required(input.runId, "runId");
  const containerName = maintenanceName(runId);
  const execution = spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  if (execution.status !== 0 && !String(execution.stderr || "").includes("No such container")) {
    throw new Error(`Maintenance container cleanup failed.\n${execution.stdout}\n${execution.stderr}`);
  }
  return { cleaned: execution.status === 0, containerName, runId };
}

function runMaintenance(input) {
  const packages = [
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
  ].filter((value) => value && value !== "none").join(",");
  const args = [
    "run", "--rm", "--network", network,
    "--name", maintenanceName(input.runId),
    "--label", "asklake.role=kafka-continuous-maintenance",
    "--label", `asklake.maintenance-run-id=${required(input.runId, "runId")}`,
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${scriptsDir}:/work/scripts:ro`,
    "-v", `${ivyDir}:/tmp/.ivy2`,
    "-e", `ASKLAKE_MAINTENANCE_KIND=${required(input.kind, "kind")}`,
    "-e", `ASKLAKE_MAINTENANCE_RUN_ID=${required(input.runId, "runId")}`,
    "-e", `ASKLAKE_MAINTENANCE_OUTPUT_PATH=${required(input.outputPath, "outputPath")}`,
    "-e", `ASKLAKE_MAINTENANCE_SCHEMA_COLUMNS=${JSON.stringify(input.schemaColumns || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_SCHEMA_POLICY=${JSON.stringify(input.schemaEvolutionPolicy || {})}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_CONTRACT_VERSION=${input.ruleContractVersion || "1.0"}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_FINGERPRINT=${input.ruleFingerprint || ""}`,
    "-e", `ASKLAKE_MAINTENANCE_RULE_OUTPUT_SCHEMA=${JSON.stringify(input.ruleOutputSchema || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_RULES=${JSON.stringify(input.rules || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_APPROVE_UNKNOWN_FIELDS=${Boolean(input.approveUnknownFields)}`,
    "-e", `ASKLAKE_MAINTENANCE_OFFSETS=${JSON.stringify(input.offsets || [])}`,
    "-e", `ASKLAKE_MAINTENANCE_TARGET_MB=${input.targetFileSizeMb || 256}`,
    "-e", `ASKLAKE_MAINTENANCE_LIMIT=${input.limit || 100}`,
    "-e", `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://minio:9000"}`,
    "-e", `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || ""}`,
    "-e", `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || ""}`,
    "-e", "HOME=/tmp",
    image,
    "/opt/spark/bin/spark-submit", "--master", masterUrl,
    "--conf", "spark.jars.ivy=/tmp/.ivy2",
    "--packages", packages,
    "/work/scripts/kafka_continuous_maintenance.py",
  ];
  const execution = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (execution.status !== 0) throw new Error(`Maintenance Spark task failed.\n${execution.stdout}\n${execution.stderr}`);
  const marker = "ASKLAKE_CONTINUOUS_MAINTENANCE_RESULT=";
  const line = String(execution.stdout || "").split(/\r?\n/).reverse().find((item) => item.startsWith(marker));
  if (!line) throw new Error("Maintenance result marker was not emitted.");
  return JSON.parse(line.slice(marker.length));
}

function ensureSparkServer() {
  const result = spawnSync(process.execPath, [path.join(backendDir, "scripts", "start-spark-server.mjs")], { cwd: backendDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Spark server could not be started.\n${result.stdout}\n${result.stderr}`);
}

function required(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${name} is required`);
  return String(value);
}

function maintenanceName(runId) {
  const safe = String(runId).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return `asklake-kafka-maint-${safe}`.slice(0, 120);
}
