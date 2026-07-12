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
const publicationFault = process.env.ASKLAKE_CONTINUOUS_E2E_PUBLICATION_FAULT === "true";
let jobId = "";

try {
  rpk(["topic", "create", topic]);
  produce(2, 0);
  produceMalformed();
  const created = await post("/api/etl/jobs", jobPayload());
  jobId = created.job.id;
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "startContinuous" });
  await expectStatus(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine?limit=1`, 409);
  if (publicationFault) {
    await waitFor(async () => (await getJob()).continuousRuntime?.status === "failed", "injected pre-manifest failure");
    await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "resumeContinuous" });
  }
  await waitFor(async () => (await datasets()).some((dataset) => dataset.id === `ds_${target}`), "Catalog materialization");
  await waitFor(async () => (await getJob()).continuousRuntime?.storedCount >= 2, "retained backlog consumption");

  produce(2, 2);
  produceRecoverableUnknown();
  await waitFor(async () => (await getJob()).continuousRuntime?.consumedCount >= 6, "new Kafka event consumption");
  const ruleRuntime = (await getJob()).continuousRuntime;
  assert(ruleRuntime.ruleFingerprint?.length === 64, "Continuous runtime must expose the canonical Rule fingerprint.");
  assert(ruleRuntime.ruleMetrics.transformQuarantinedCount === 1, "Transform quarantine counters must be durable.");
  assert(ruleRuntime.ruleMetrics.qualityWarnCount === 1, "Quality warn counters must be durable.");
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
  assert(afterRestart.continuousRuntime.storedCount === 3, "Restart must not duplicate completed batch rows or reset counters.");
  assert(afterRestart.continuousRuntime.quarantinedCount === 3, "Schema and Rule quarantine counts must survive restart.");
  assert(afterRestart.continuousRuntime.ruleMetrics.transformQuarantinedCount === 1, "Restart must not duplicate Rule counters.");
  assert(afterRestart.continuousRuntime.lagAvailable === true, "Restart must preserve the last valid partition lag observation.");
  assert(Object.keys(afterRestart.continuousRuntime.partitionProgress || {}).length > 0, "Restart must preserve partition progress while idle.");
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "stopped", "stop before replay");
  const policyReplay = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, {});
  assert(policyReplay.result.storedCount === 0 && policyReplay.result.failedCount === 3, "Default replay must reapply schema policy and canonical Rules.");
  assert(policyReplay.result.ruleRejectedCount === 1, "Rule quarantine replay must not bypass the failing Rule.");
  const replay = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, { approveUnknownFields: true });
  assert(replay.result.storedCount === 1 && replay.result.failedCount === 2, "Managed unknown-field approval must recover only the schema-policy quarantine row.");
  assert(replay.result.policyOverride === "approve_unknown_fields", "Replay override must be explicit in the maintenance result.");
  const afterReplay = await getJob();
  assert(afterReplay.continuousRuntime.storedCount === 4, "Replay must increment durable target rows.");
  assert(afterReplay.continuousRuntime.replayedCount === 1, "Replay must be counted separately from historical quarantine.");
  assert(afterReplay.continuousRuntime.storedCount + afterReplay.continuousRuntime.quarantinedCount - afterReplay.continuousRuntime.replayedCount === 6, "Replay counters must reconcile to consumed rows.");
  const replayAgain = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, { approveUnknownFields: true });
  assert(replayAgain.result.storedCount === 0 && replayAgain.result.skippedCount === 1, "Replay must be idempotent by partition and offset.");
  const quarantine = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine?limit=10`);
  assert(quarantine.records.some((record) => record.replayStatus === "replayed"), "Quarantine inspection must expose replay status.");
  assert(quarantine.records.some((record) => record.ruleId === "cast-rating" && record.stage === "transform"), "Quarantine inspection must identify the failing canonical Rule.");
  const dataset = (await datasets()).find((item) => item.id === `ds_${target}`);
  assert(dataset?.materializationRuns?.some((run) => run.runId === replay.runId), "Replay must append a Catalog materialization run.");
  assert(dataset?.materializationRuns?.some((run) => run.ruleFingerprint?.length === 64), "Catalog materialization must retain Rule execution identity.");
  const compaction = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/compactions`, { targetFileSizeMb: 128 });
  assert(compaction.result.inputRows === 4, "The standard non-recursive Spark reader must read stream and replay batch_id partitions together.");
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
      { included: true, nullable: true, sourceName: "rating", sourceType: "String", targetName: "rating", type: "Double" },
    ],
    ruleContractVersion: "1.0",
    rules: [
      {
        contractVersion: "1.0", enabled: true, failureDisposition: "keep", id: "cast-rating",
        inputColumns: ["rating"], kind: "transform", onError: "quarantine", operation: "cast",
        outputColumns: ["rating"], outputType: "Double", parameters: { targetType: "Double" },
      },
      {
        contractVersion: "1.0", enabled: true, failureDisposition: "keep", id: "normalize-review",
        inputColumns: ["review"], kind: "transform", onError: "warn", operation: "lowercase_trim",
        outputColumns: ["review_normalized"], outputType: "String", parameters: {},
      },
      {
        contractVersion: "1.0", enabled: true, failureDisposition: "keep", id: "review-prefix",
        inputColumns: ["review_normalized"], kind: "quality", onError: "warn", operation: "regex",
        outputColumns: [], parameters: { pattern: "^continuous review" }, severity: "warning",
      },
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
    rating: offsetStart + index === 2 ? "invalid" : String(5 - (index % 2)),
    ...(offsetStart + index === 3 ? { review: "unexpected review" } : {}),
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
    rating: "4",
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
