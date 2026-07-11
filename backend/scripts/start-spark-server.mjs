import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1";
const network = process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default";
const masterName = process.env.ASKLAKE_SPARK_MASTER_CONTAINER || "asklake-spark-master";
const workerName = process.env.ASKLAKE_SPARK_WORKER_CONTAINER || "asklake-spark-worker";
const publishUi = process.env.ASKLAKE_SPARK_PUBLISH_UI !== "false";
const sampleHostDir = path.resolve(process.env.ASKLAKE_LOCAL_SAMPLE_DIR || path.join(os.tmpdir(), "asklake-1gb-samples"));
const sampleContainerDir = process.env.ASKLAKE_SAMPLE_CONTAINER_DIR || "/opt/asklake-samples";
const reportHostDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const reportContainerDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";
const outputVolumeName = process.env.ASKLAKE_SPARK_OUTPUT_VOLUME || "asklake-spark-output";
const outputContainerDir = process.env.ASKLAKE_SPARK_OUTPUT_CONTAINER_DIR || "/work/output";
const workerCores = process.env.ASKLAKE_SPARK_WORKER_CORES || "4";
const workerMemory = process.env.ASKLAKE_SPARK_WORKER_MEMORY || "10g";
mkdirSync(sampleHostDir, { recursive: true });
mkdirSync(reportHostDir, { recursive: true });

ensureOutputVolumeWritable();
ensureMaster();
ensureWorker();
console.log(`Spark standalone server ready: spark://${masterName}:7077`);
console.log("Spark master UI: http://127.0.0.1:18080");
console.log("Spark worker UI: http://127.0.0.1:18081");
console.log(`Spark sample mount: ${sampleHostDir} -> ${sampleContainerDir}`);
console.log(`Spark report mount: ${reportHostDir} -> ${reportContainerDir}`);

function ensureMaster() {
  if (containerNeedsCreate(masterName)) {
    run("docker", createMasterArgs());
  } else {
    run("docker", ["start", masterName], { allowFailure: true });
  }
}

function ensureWorker() {
  if (containerNeedsCreate(workerName)) {
    run("docker", createWorkerArgs());
  } else {
    run("docker", ["start", workerName], { allowFailure: true });
  }
}

function createMasterArgs() {
  return [
      "run",
      "-d",
      "--name",
      masterName,
      "--network",
      network,
      ...hostGatewayArgs(),
      "--label",
      "asklake.role=spark-master",
      ...sampleMountArgs(),
      ...reportMountArgs(),
      ...outputMountArgs(),
      ...uiPortArgs("18080", "8080"),
      image,
      "/opt/spark/bin/spark-class",
      "org.apache.spark.deploy.master.Master",
      "--host",
      masterName,
      "--port",
      "7077",
      "--webui-port",
      "8080",
  ];
}

function createWorkerArgs() {
  return [
      "run",
      "-d",
      "--name",
      workerName,
      "--network",
      network,
      ...hostGatewayArgs(),
      "--label",
      "asklake.role=spark-worker",
      ...sampleMountArgs(),
      ...reportMountArgs(),
      ...outputMountArgs(),
      ...uiPortArgs("18081", "8081"),
      image,
      "/opt/spark/bin/spark-class",
      "org.apache.spark.deploy.worker.Worker",
      `spark://${masterName}:7077`,
      "--cores",
      workerCores,
      "--memory",
      workerMemory,
      "--webui-port",
      "8081",
  ];
}

function containerNeedsCreate(name) {
  const inspect = run("docker", ["inspect", name], { allowFailure: true, quiet: true });
  if (inspect.status !== 0) return true;
  const [metadata] = JSON.parse(inspect.stdout || "[]");
  const expectedSource = normalizePath(sampleHostDir);
  const expectedReportSource = normalizePath(reportHostDir);
  const sampleMounted = metadata?.Mounts?.some((mount) => normalizePath(mount.Source) === expectedSource && mount.Destination === sampleContainerDir);
  const reportMounted = metadata?.Mounts?.some((mount) => normalizePath(mount.Source) === expectedReportSource && mount.Destination === reportContainerDir);
  const outputMounted = metadata?.Mounts?.some((mount) => mount.Name === outputVolumeName && mount.Destination === outputContainerDir);
  const hostGatewayMapped = (metadata?.HostConfig?.ExtraHosts ?? []).some((entry) => (
    String(entry || "").startsWith("host.docker.internal:")
  ));
  const args = (metadata?.Args ?? []).map(String);
  const workerResourceMatches = name !== workerName || (
    args.includes("--cores")
    && args.includes(workerCores)
    && args.includes("--memory")
    && args.includes(workerMemory)
  );
  if (sampleMounted && reportMounted && outputMounted && hostGatewayMapped && workerResourceMatches) return false;
  run("docker", ["rm", "-f", name], { allowFailure: true });
  return true;
}

function hostGatewayArgs() {
  return ["--add-host", "host.docker.internal:host-gateway"];
}

function uiPortArgs(hostPort, containerPort) {
  return publishUi ? ["-p", `${hostPort}:${containerPort}`] : [];
}

function sampleMountArgs() {
  return ["-v", `${sampleHostDir}:${sampleContainerDir}:ro`];
}

function reportMountArgs() {
  return ["-v", `${reportHostDir}:${reportContainerDir}`];
}

function outputMountArgs() {
  return ["-v", `${outputVolumeName}:${outputContainerDir}`];
}

function ensureOutputVolumeWritable() {
  run("docker", [
    "run",
    "--rm",
    "-v",
    `${outputVolumeName}:${outputContainerDir}`,
    "alpine:3.20",
    "sh",
    "-c",
    `mkdir -p ${outputContainerDir} && chmod -R 777 ${outputContainerDir}`,
  ]);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  return result;
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}
