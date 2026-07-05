import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const ivyDir = path.join(backendDir, "tmp", "spark-ivy");
const localSampleDir = path.resolve(process.env.ASKLAKE_LOCAL_SAMPLE_DIR || path.join(os.tmpdir(), "asklake-1gb-samples"));
const sampleContainerDir = process.env.ASKLAKE_SAMPLE_CONTAINER_DIR || "/opt/asklake-samples";
const localManifestPath = path.join(localSampleDir, "manifest.json");
const useLocalSamples = process.env.ASKLAKE_USE_LOCAL_SAMPLES !== "false" && existsSync(localManifestPath);
mkdirSync(ivyDir, { recursive: true });

const samplePaths = {
  ASKLAKE_CSV_PATH: `file://${sampleContainerDir}/csv`,
  ASKLAKE_JSONL_PATH: `file://${sampleContainerDir}/jsonl`,
  ASKLAKE_JSON_PATH: `file://${sampleContainerDir}/json`,
  ASKLAKE_PARQUET_PATH: `file://${sampleContainerDir}/parquet`,
  ASKLAKE_TXT_PATH: `file://${sampleContainerDir}/txt`,
};
const hasExplicitDataPath = Object.keys(samplePaths).some((name) => process.env[name]);
if (!useLocalSamples && !hasExplicitDataPath) {
  console.error(`1GB sample manifest not found: ${localManifestPath}`);
  console.error("Run `npm run minio:prepare-samples` first, then `npm run spark:start`, then `npm run spark:validate`.");
  process.exit(1);
}

if (useLocalSamples) {
  ensureSparkWorkerHasSampleMount();
}

const defaultPathEnvArgs = Object.entries(samplePaths)
  .flatMap(([name, value]) => {
    const resolvedValue = process.env[name] || (useLocalSamples ? value : undefined);
    return resolvedValue ? ["-e", `${name}=${resolvedValue}`] : [];
  });
const optionalEnvArgs = [
  ...defaultPathEnvArgs,
  ...(process.env.ASKLAKE_CSV_SAMPLING_RATIO ? ["-e", `ASKLAKE_CSV_SAMPLING_RATIO=${process.env.ASKLAKE_CSV_SAMPLING_RATIO}`] : []),
];
const sampleMountArgs = useLocalSamples ? ["-v", `${localSampleDir}:${sampleContainerDir}:ro`] : [];
const dockerArgs = [
  "run",
  "--rm",
  "--network",
  process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
  "-v",
  `${scriptsDir}:/work/scripts:ro`,
  "-v",
  `${ivyDir}:/tmp/.ivy2`,
  ...sampleMountArgs,
  "-e",
  `MINIO_ENDPOINT=${process.env.MINIO_ENDPOINT_IN_DOCKER || "http://m3-minio:9000"}`,
  "-e",
  `MINIO_ACCESS_KEY=${process.env.MINIO_ACCESS_KEY || "m3admin"}`,
  "-e",
  `MINIO_SECRET_KEY=${process.env.MINIO_SECRET_KEY || "wishuponastar"}`,
  "-e",
  `ASKLAKE_SAMPLE_BUCKET=${process.env.ASKLAKE_SAMPLE_BUCKET || "m3-raw"}`,
  "-e",
  `ASKLAKE_SAMPLE_PREFIX=${process.env.ASKLAKE_SAMPLE_PREFIX || "asklake-test-samples"}`,
  "-e",
  `ASKLAKE_SPARK_FULL_COUNT=${process.env.ASKLAKE_SPARK_FULL_COUNT || "false"}`,
  "-e",
  "HOME=/tmp",
  ...optionalEnvArgs,
  process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
  "/opt/spark/bin/spark-submit",
  "--master",
  process.env.ASKLAKE_SPARK_MASTER_URL || "spark://asklake-spark-master:7077",
  "--conf",
  "spark.jars.ivy=/tmp/.ivy2",
  "--packages",
  process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
  "/work/scripts/spark_validate.py",
];

const result = spawnSync("docker", dockerArgs, {
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (result.status === 0) {
  if (result.stdout) process.stdout.write(result.stdout);
} else {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
process.exit(result.status ?? 1);

function ensureSparkWorkerHasSampleMount() {
  const workerName = process.env.ASKLAKE_SPARK_WORKER_CONTAINER || "asklake-spark-worker";
  const inspect = spawnSync("docker", ["inspect", workerName, "--format", "{{json .Mounts}}"], { encoding: "utf8" });
  if (inspect.status !== 0) {
    console.error(`Spark worker container not found: ${workerName}`);
    console.error("Run `npm run spark:start` after preparing 1GB samples.");
    process.exit(1);
  }
  const mounts = JSON.parse(inspect.stdout || "[]");
  const expectedSource = normalizePath(localSampleDir);
  const mounted = mounts.some((mount) => normalizePath(mount.Source) === expectedSource && mount.Destination === sampleContainerDir);
  if (!mounted) {
    console.error(`Spark worker does not have the 1GB sample mount: ${localSampleDir} -> ${sampleContainerDir}`);
    console.error("Run `npm run spark:start` so the Spark master/worker are recreated with the sample mount.");
    process.exit(1);
  }
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}
