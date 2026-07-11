import { spawnSync } from "node:child_process";

if (process.env.ASKLAKE_RUN_KAFKA_CONTINUOUS_E2E !== "true") {
  throw new Error("Set ASKLAKE_RUN_KAFKA_CONTINUOUS_E2E=true after starting deploy/docker-compose.prod.yml.");
}

const composeFile = process.env.ASKLAKE_CONTINUOUS_COMPOSE_FILE || "../deploy/docker-compose.prod.yml";
const envFile = process.env.ASKLAKE_CONTINUOUS_ENV_FILE || "../deploy/.env";
const baseUrl = process.env.ASKLAKE_CONTINUOUS_E2E_BASE_URL || "http://127.0.0.1:8080";
const suffix = Date.now().toString(36);
const topic = `asklake.continuous.verify.${suffix}`;
const group = `asklake-continuous-verify-${suffix}`;
const target = `continuous_verify_${suffix}`;
let jobId = "";

try {
  rpk(["topic", "create", topic]);
  produce(2, 0);
  produceMalformed();
  const created = await post("/api/etl/jobs", jobPayload());
  jobId = created.job.id;
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "startContinuous" });
  await expectStatus(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine?limit=1`, 409);
  await waitFor(async () => (await datasets()).some((dataset) => dataset.id === `ds_${target}`), "Catalog materialization");
  await waitFor(async () => (await getJob()).continuousRuntime?.storedCount >= 2, "retained backlog consumption");

  produce(2, 2);
  produceRecoverableUnknown();
  await waitFor(async () => (await getJob()).continuousRuntime?.consumedCount >= 6, "new Kafka event consumption");
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "pauseContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "paused", "pause");

  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "resumeContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", "resume");
  killWorker();
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "failed", "worker failure detection");
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "resumeContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "running", "checkpoint restart");

  const afterRestart = await getJob();
  assert(afterRestart.continuousRuntime.consumedCount === 6, "Restart must preserve consumed count.");
  assert(afterRestart.continuousRuntime.storedCount === 4, "Restart must not duplicate completed batch rows or reset counters.");
  assert(afterRestart.continuousRuntime.quarantinedCount === 2, "Malformed and schema-policy quarantine counts must survive restart.");
  assert(afterRestart.continuousRuntime.lagAvailable === true, "Restart must preserve the last valid partition lag observation.");
  assert(Object.keys(afterRestart.continuousRuntime.partitionProgress || {}).length > 0, "Restart must preserve partition progress while idle.");
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "stopped", "stop before replay");
  const replay = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, {});
  assert(replay.result.storedCount === 1 && replay.result.failedCount === 1, "Replay must recover only the schema-policy quarantine row.");
  const afterReplay = await getJob();
  assert(afterReplay.continuousRuntime.storedCount === 5, "Replay must increment durable target rows.");
  assert(afterReplay.continuousRuntime.replayedCount === 1, "Replay must be counted separately from historical quarantine.");
  assert(afterReplay.continuousRuntime.storedCount + afterReplay.continuousRuntime.quarantinedCount - afterReplay.continuousRuntime.replayedCount === 6, "Replay counters must reconcile to consumed rows.");
  const replayAgain = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, {});
  assert(replayAgain.result.storedCount === 0 && replayAgain.result.skippedCount === 1, "Replay must be idempotent by partition and offset.");
  const quarantine = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine?limit=10`);
  assert(quarantine.records.some((record) => record.replayStatus === "replayed"), "Quarantine inspection must expose replay status.");
  const dataset = (await datasets()).find((item) => item.id === `ds_${target}`);
  assert(dataset?.materializationRuns?.some((run) => run.runId === replay.runId), "Replay must append a Catalog materialization run.");
  console.log("verify-kafka-continuous-e2e: ok");
} finally {
  if (jobId) await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" }).catch(() => undefined);
}

function jobPayload() {
  return {
    id: `continuous-e2e-${suffix}`,
    jobName: `continuous_e2e_${suffix}`,
    sourceType: "Stream / Kafka",
    sourceLabel: `Kafka ${topic}`,
    sourceConfig: [["Broker / Endpoint", "redpanda:9092"], ["TOPIC / QUEUE NAME", topic], ["Consumer Group ID", group]],
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
      maxOffsetsPerTrigger: 100,
      schemaEvolutionPolicy: { additiveNullable: "allow", missingRequired: "quarantine", incompatibleType: "quarantine", unknownField: "quarantine" },
    },
  };
}

function produce(count, offsetStart) {
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({
    event_id: `continuous-${suffix}-${offsetStart + index}`,
    review: `continuous review ${offsetStart + index}`,
    created_at: "2026-07-11T00:00:00Z",
  })).join("\n") + "\n";
  rpk(["topic", "produce", topic], lines);
}

function produceMalformed() {
  rpk(["topic", "produce", topic], "{not-json}\n");
}

function produceRecoverableUnknown() {
  rpk(["topic", "produce", topic], `${JSON.stringify({
    event_id: `continuous-${suffix}-unknown`,
    review: "recoverable schema policy row",
    created_at: "2026-07-11T00:00:00Z",
    language: "ko",
  })}\n`);
}

function killWorker() {
  const name = `asklake-kafka-stream-${jobId.toLowerCase()}`;
  run("docker", ["kill", name]);
}

function rpk(args, input = "") {
  run("docker", ["compose", "--env-file", envFile, "-f", composeFile, "exec", "-T", "redpanda", "rpk", ...args], input);
}

function run(command, args, input = "") {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
}

async function getJob() { return get(`/api/etl/jobs/${encodeURIComponent(jobId)}`); }
async function datasets() {
  const response = await get("/api/catalog/datasets");
  return Array.isArray(response) ? response : response.datasets ?? [];
}
async function get(path) { return request(path); }
async function post(path, body) { return request(path, { method: "POST", body: JSON.stringify(body) }); }
async function expectStatus(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "X-AskLake-Role": "admin" } });
  if (response.status !== expectedStatus) throw new Error(`GET ${path} expected ${expectedStatus}, received ${response.status}: ${await response.text()}`);
}
async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", "X-AskLake-Role": "admin", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function assert(condition, message) { if (!condition) throw new Error(message); }
