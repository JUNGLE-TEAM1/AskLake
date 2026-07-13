import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { spawnSync } from "node:child_process";

if (process.env.ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK !== "true") {
  throw new Error("Set ASKLAKE_RUN_KAFKA_CONTINUOUS_SOAK=true for the opt-in soak harness.");
}

const inputPath = String(process.env.ASKLAKE_CONTINUOUS_SOAK_INPUT || "").trim();
const requestedCount = optionalPositiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_COUNT);
const syntheticCount = requestedCount || 1000;
const rate = positiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_RATE, 500);
const batchSize = positiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_BATCH_SIZE, 100);
const malformedPercent = Math.min(Math.max(Number(process.env.ASKLAKE_CONTINUOUS_SOAK_MALFORMED_PERCENT || 1), 0), 100);
const schemaChangeAt = positiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE_AT, Math.floor((requestedCount || 1000) / 2));
const injectSchemaChange = process.env.ASKLAKE_CONTINUOUS_SOAK_SCHEMA_CHANGE !== "false";
const faultMode = String(process.env.ASKLAKE_CONTINUOUS_SOAK_FAULT || (process.env.ASKLAKE_CONTINUOUS_SOAK_KILL_WORKER === "true" ? "worker" : "none")).toLowerCase();
if (!["none", "worker", "backend", "kafka", "minio"].includes(faultMode)) throw new Error(`Unsupported ASKLAKE_CONTINUOUS_SOAK_FAULT: ${faultMode}`);
const faultAfter = positiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_FAULT_AFTER || process.env.ASKLAKE_CONTINUOUS_SOAK_KILL_AFTER, Math.floor((requestedCount || 1000) / 2));
const faultDurationMs = positiveInt(process.env.ASKLAKE_CONTINUOUS_SOAK_FAULT_DURATION_MS, 5000);
const verifyCompaction = process.env.ASKLAKE_CONTINUOUS_SOAK_COMPACT === "true";
if (verifyCompaction) {
  throw new Error("ASKLAKE_CONTINUOUS_SOAK_COMPACT is unavailable for Iceberg targets until the Phase 5 Iceberg maintenance job is implemented.");
}
const baseUrl = process.env.ASKLAKE_CONTINUOUS_E2E_BASE_URL || "http://127.0.0.1:8080";
const composeFile = process.env.ASKLAKE_CONTINUOUS_COMPOSE_FILE || "../deploy/docker-compose.prod.yml";
const envFile = process.env.ASKLAKE_CONTINUOUS_ENV_FILE || "../deploy/.env";
const suffix = Date.now().toString(36);
const topic = `asklake.continuous.soak.${suffix}`;
const target = `continuous_soak_${suffix}`;
let jobId = "";
let producedCount = 0;
let peakLag = 0;
let peakThroughput = 0;
let recoveryMs = null;
let faultInjected = false;
let streamStopped = false;
let pausedService = "";
const startedAt = Date.now();

try {
  rpk(["topic", "create", topic]);
  const created = await post("/api/etl/jobs", jobPayload());
  jobId = created.job.id;
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "startContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", "worker startup");
  if (inputPath) await produceInputFile();
  else await produceSynthetic();
  if (producedCount === 0) throw new Error("The soak input did not contain any records.");
  await waitFor(async () => {
    const job = await getJob();
    observe(job.continuousRuntime);
    return (job.continuousRuntime?.consumedCount || 0) >= producedCount ? job : null;
  }, "all produced records", 900000);
  const finalJob = await waitFor(async () => {
    const job = await getJob();
    observe(job.continuousRuntime);
    return (job.continuousRuntime?.lastBatchInputRows || 0) > 0 ? job : null;
  }, "non-empty batch metrics", 30000);
  const runtime = finalJob.continuousRuntime;
  const reconciled = runtime.storedCount + runtime.quarantinedCount - (runtime.replayedCount || 0);
  const dataset = await waitFor(async () => {
    const list = await datasets();
    return list.find((item) => item.name === target) || null;
  }, "Catalog materialization", 120000);
  const logs = await request(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/logs?tail=100`);
  const report = {
    inputPath: inputPath || null,
    producedCount,
    consumedCount: runtime.consumedCount,
    storedCount: runtime.storedCount,
    quarantinedCount: runtime.quarantinedCount,
    replayedCount: runtime.replayedCount || 0,
    missingCount: Math.max(producedCount - reconciled, 0),
    duplicateCount: Math.max(reconciled - producedCount, 0),
    peakLag,
    peakThroughputRowsPerSecond: peakThroughput,
    recoveryMs,
    faultMode,
    elapsedMs: Date.now() - startedAt,
    catalogMaterializationCount: dataset.materializationRuns?.length || 0,
    workerLogLineCount: logs.lines?.length || 0,
    compaction: null,
    topic,
    target,
  };
  if (report.missingCount || report.duplicateCount || runtime.consumedCount !== producedCount) {
    throw new Error(`Soak reconciliation failed: ${JSON.stringify(report)}`);
  }
  console.log(`ASKLAKE_CONTINUOUS_SOAK_RESULT=${JSON.stringify(report)}`);
} finally {
  if (pausedService) {
    try { compose(["unpause", pausedService]); } catch { /* Best-effort fault cleanup. */ }
  }
  if (jobId && !streamStopped) await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" }).catch(() => undefined);
}

function jobPayload() {
  return {
    id: `continuous-soak-${suffix}`,
    jobName: `continuous_soak_${suffix}`,
    sourceType: "Stream / Kafka",
    sourceLabel: `Kafka ${topic}`,
    sourceConfig: [["Broker / Endpoint", "redpanda:9092"], ["TOPIC / QUEUE NAME", topic], ["Consumer Group ID", `asklake-soak-${suffix}`]],
    schemaColumns: [
      { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
      { included: true, nullable: false, sourceName: "review", targetName: "review", type: "String" },
      { included: true, nullable: false, sourceName: "created_at", targetName: "created_at", type: "Timestamp" },
    ],
    scheduleLabel: "스케줄링 건너뛰기",
    targetDataset: target,
    targetLayer: "BRONZE",
    targetFormat: "parquet",
    storagePath: `s3a://asklake-output/${target}/bronze`,
    owner: "data-team-01",
    executionMode: "continuous",
    continuousConfig: {
      initialOffsetPolicy: "earliest",
      triggerIntervalSeconds: 2,
      maxOffsetsPerTrigger: Math.max(batchSize, 100),
      schemaEvolutionPolicy: {
        additiveNullable: "allow",
        missingRequired: "quarantine",
        incompatibleType: "quarantine",
        unknownField: "preserve",
      },
    },
  };
}

async function produceSynthetic() {
  for (let start = 0; start < syntheticCount; start += batchSize) {
    const size = Math.min(batchSize, syntheticCount - start);
    const records = Array.from({ length: size }, (_, relative) => syntheticRecord(start + relative));
    await produceBatch(records);
  }
}

async function produceInputFile() {
  const file = createReadStream(inputPath);
  const input = inputPath.endsWith(".gz") ? file.pipe(createGunzip()) : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  let records = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (requestedCount && producedCount + records.length >= requestedCount) break;
    records.push(normalizeInputRecord(line, producedCount + records.length));
    if (records.length >= batchSize) {
      await produceBatch(records);
      records = [];
    }
  }
  if (records.length) await produceBatch(records);
}

function syntheticRecord(index) {
  if (shouldInjectMalformed(index)) return "{malformed-json";
  const event = { event_id: `soak-${suffix}-${index}`, review: `review ${index}`, created_at: "2026-07-11T00:00:00Z" };
  if (injectSchemaChange && index >= schemaChangeAt) event.language = "ko";
  return JSON.stringify(event);
}

function normalizeInputRecord(line, index) {
  if (shouldInjectMalformed(index)) return "{malformed-json";
  let source;
  try {
    source = JSON.parse(line);
  } catch {
    return line;
  }
  const timestamp = source.created_at || source.timestamp || source.raw_timestamp;
  const numericTimestamp = Number(timestamp);
  const createdAt = typeof timestamp === "string" && Number.isNaN(numericTimestamp)
    ? timestamp
    : new Date(Number.isFinite(numericTimestamp) ? numericTimestamp : Date.now()).toISOString();
  const event = {
    event_id: String(source.event_id || source.id || `${source.asin || source.parent_asin || "review"}-${index}`),
    review: source.review ?? source.text ?? source.raw_text ?? source.title ?? "",
    created_at: createdAt,
  };
  if (injectSchemaChange && index >= schemaChangeAt) event.language = source.language || "ko";
  return JSON.stringify(event);
}

async function produceBatch(records) {
  rpk(["topic", "produce", topic], `${records.join("\n")}\n`);
  producedCount += records.length;
  await maybeInjectFault();
  await sleep(Math.ceil((records.length / rate) * 1000));
  observe((await getJob()).continuousRuntime);
}

async function maybeInjectFault() {
  if (faultMode === "none" || faultInjected || producedCount < faultAfter) return;
  faultInjected = true;
  const failureStarted = Date.now();
  if (faultMode === "worker") {
    run("docker", ["kill", `asklake-kafka-stream-${jobId.toLowerCase()}`]);
    await waitFor(async () => (await getJob()).continuousRuntime?.status === "failed", "worker failure");
    await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "resumeContinuous" });
    await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", "worker recovery");
  } else if (faultMode === "backend") {
    compose(["restart", "backend"]);
    await waitFor(backendIsHealthy, "backend restart recovery", 120000);
    await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", "runtime hydrate after backend restart");
  } else {
    pausedService = faultMode === "kafka" ? "redpanda" : "minio";
    compose(["pause", pausedService]);
    await sleep(faultDurationMs);
    compose(["unpause", pausedService]);
    pausedService = "";
    await sleep(3000);
    const runtime = (await getJob()).continuousRuntime;
    if (runtime?.status === "failed") {
      await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "resumeContinuous" });
      await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", `${faultMode} fault recovery`);
    }
  }
  recoveryMs = Date.now() - failureStarted;
}

function shouldInjectMalformed(index) {
  const bucket = (Math.imul(index + 1, 2654435761) >>> 0) % 10000;
  return bucket < malformedPercent * 100;
}

function observe(runtime) {
  peakLag = Math.max(peakLag, Number(runtime?.lag || 0));
  peakThroughput = Math.max(peakThroughput, Number(runtime?.throughputRowsPerSecond || 0));
}

function rpk(args, input = "") { run("docker", ["compose", "--env-file", envFile, "-f", composeFile, "exec", "-T", "redpanda", "rpk", ...args], input); }
function compose(args) { run("docker", ["compose", "--env-file", envFile, "-f", composeFile, ...args]); }
function run(command, args, input = "") {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
}
async function getJob() { return request(`/api/etl/jobs/${encodeURIComponent(jobId)}`); }
async function backendIsHealthy() {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}
async function datasets() {
  const response = await request("/api/catalog/datasets");
  return Array.isArray(response) ? response : response.datasets ?? [];
}
async function post(path, body) { return request(path, { method: "POST", body: JSON.stringify(body) }); }
async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { "Content-Type": "application/json", "X-AskLake-Role": "admin", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}
async function waitFor(predicate, label, timeout = 240000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function positiveInt(value, fallback) { return optionalPositiveInt(value) || fallback; }
function optionalPositiveInt(value) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
