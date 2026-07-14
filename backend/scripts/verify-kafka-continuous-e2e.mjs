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
const backendRestart = process.env.ASKLAKE_CONTINUOUS_E2E_BACKEND_RESTART === "true";
let jobId = "";
let dashboardId = "";
let widgetId = "";
let sessionCookie = process.env.ASKLAKE_CONTINUOUS_E2E_SESSION_COOKIE || "";

try {
  await authenticateIfConfigured();
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
  await waitFor(async () => (await datasets()).some((dataset) => (
    dataset.id === `ds_${target}`
    && dataset.queryEngineStatus === "available"
    && dataset.queryEngineTable?.format === "iceberg"
  )), "Iceberg Catalog materialization");
  await waitFor(async () => (await getJob()).continuousRuntime?.storedCount >= 2, "retained backlog consumption");
  const datasetId = `ds_${target}`;
  const initialFreshness = await get(`/api/datasets/${encodeURIComponent(datasetId)}/freshness`);
  assert(initialFreshness.isContinuous === true, "Kafka Continuous dataset freshness must be marked continuous.");
  assert(initialFreshness.latestRevision >= 1, "The first durable Kafka publication must advance dataset freshness.");
  ({ dashboardId, widgetId } = await createPublishedDashboard(datasetId));
  const initialRuntime = await get(`/api/dashboards/${encodeURIComponent(dashboardId)}/published`);
  const initialWidget = findRuntimeWidget(initialRuntime, widgetId);
  assert(initialWidget?.liveRefresh === true, "The published Kafka widget must opt into live refresh.");
  assert(initialWidget.appliedRevision >= initialFreshness.latestRevision, "The initial widget result must store its applied revision.");
  const initialWidgetValue = metricValue(initialWidget);
  assert(initialWidgetValue === 2, `The initial published widget must count two stored rows, received ${initialWidgetValue}.`);

  produce(2, 2);
  produceRecoverableUnknown();
  await waitFor(async () => (await getJob()).continuousRuntime?.consumedCount >= 6, "new Kafka event consumption");
  const updatedFreshness = await waitFor(async () => {
    const freshness = await get(`/api/datasets/${encodeURIComponent(`ds_${target}`)}/freshness`);
    return freshness.latestRevision > initialFreshness.latestRevision ? freshness : null;
  }, "dashboard freshness revision advancement");
  const refreshedWidgets = await post(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/widgets/query`,
    { widgetIds: [widgetId] },
  );
  const refreshedWidget = refreshedWidgets.widgets?.[0];
  assert(refreshedWidget?.appliedRevision === updatedFreshness.latestRevision, "Widget result must advance to the new dataset revision.");
  assert(metricValue(refreshedWidget) === 3, "The refreshed widget must count the one newly stored valid row without reloading in the browser.");
  assert(refreshedWidget.calculationVersion?.length === 64, "Widget result must persist a calculation version hash.");
  const ruleRuntime = (await getJob()).continuousRuntime;
  assert(ruleRuntime.ruleFingerprint?.length === 64, "Continuous runtime must expose the canonical Rule fingerprint.");
  assert(ruleRuntime.ruleMetrics.transformQuarantinedCount === 1, "Transform quarantine counters must be durable.");
  assert(ruleRuntime.ruleMetrics.qualityWarnCount === 1, "Quality warn counters must be durable.");
  const sessions = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/sessions`);
  const activeSession = sessions.find((session) => session.status === "running") || sessions[0];
  assert(activeSession?.dagSteps?.length === 7, "Continuous session history must expose the seven-stage Streaming DAG.");
  assert(activeSession.dagSteps[0].status === "running", "An active session DAG must keep Source in the running state.");
  const batches = await get(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/sessions/${encodeURIComponent(activeSession.sessionId)}/batches?limit=100`);
  assert(batches.length > 0, "Continuous session history must persist published micro-batches.");
  assert(batches.every((batch) => batch.status === "success" && batch.dagSteps?.length === 7), "Every published micro-batch must expose a successful seven-stage DAG.");
  assert(batches.every((batch) => batch.icebergSnapshotId && batch.icebergTableUri), "Every stored micro-batch must expose Iceberg commit identity.");
  assert(batches.every((batch) => batch.sourceBoundary?.kind === "kafka_continuous_batch"), "Every stored micro-batch must expose its checkpoint source boundary.");
  assert(batches.every((batch) => batch.dagSteps.find((step) => step.id === "catalog")?.status === "success"), "Catalog stages must be acknowledged after materialization.");
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
  if (backendRestart) {
    restartBackend();
    await waitFor(async () => {
      try {
        return (await getJob()).continuousRuntime?.status === "running";
      } catch {
        return false;
      }
    }, "backend restart reconciliation");
    const afterBackendRestart = await getJob();
    assert(afterBackendRestart.continuousRuntime.consumedCount === 6, "Backend restart must preserve consumed count.");
    assert(afterBackendRestart.continuousRuntime.storedCount === 3, "Backend restart must not duplicate published rows.");
    assert(afterBackendRestart.continuousRuntime.quarantinedCount === 3, "Backend restart must preserve quarantine evidence.");
    assert(afterBackendRestart.continuousRuntime.ruleMetrics.transformQuarantinedCount === 1, "Backend restart must preserve Rule counters.");
  }
  await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" });
  await waitFor(async () => (await getJob()).continuousRuntime?.status === "stopped", "stop before replay");
  const policyReplay = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, {});
  assert(policyReplay.result.storedCount === 0 && policyReplay.result.failedCount === 3, "Default replay must reapply schema policy and canonical Rules.");
  assert(policyReplay.result.ruleRejectedCount === 1, "Rule quarantine replay must not bypass the failing Rule.");
  const replay = await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, { approveUnknownFields: true });
  assert(replay.result.storedCount === 1 && replay.result.failedCount === 2, "Managed unknown-field approval must recover only the schema-policy quarantine row.");
  assert(replay.result.catalogApplied === true && replay.result.icebergCommit?.snapshotId, "Replay must verify its Iceberg append before Catalog publication.");
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
  const compaction = await post(
    `/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/compactions`,
    { targetFileSizeMb: 128 },
  );
  assert(compaction.status === "success", "Iceberg data-file rewrite must complete successfully.");
  assert(compaction.result?.queryEngineVerified === true, "Trino must verify the maintained Iceberg snapshot.");
  assert(compaction.result?.icebergSnapshotId, "Maintenance must expose the verified Iceberg snapshot ID.");
  const catalogTableUri = dataset?.queryEngineTable
    ? `iceberg://${dataset.queryEngineTable.catalog}/${dataset.queryEngineTable.schema}/${dataset.queryEngineTable.table}`
    : "";
  assert(compaction.result?.tableUri === catalogTableUri, "Maintenance must target the Catalog Iceberg table.");
  assert(compaction.result?.operations?.some((item) => item.operation === "rewrite_data_files"), "Compaction must use Iceberg rewrite_data_files.");
  console.log("verify-kafka-continuous-e2e: ok");
} finally {
  if (jobId) await post(`/api/etl/jobs/${encodeURIComponent(jobId)}/commands`, { command: "stopContinuous" }).catch(() => undefined);
  if (dashboardId) await del(`/api/dashboards/${encodeURIComponent(dashboardId)}`).catch(() => undefined);
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

async function authenticateIfConfigured() {
  if (sessionCookie) return;
  const email = process.env.ASKLAKE_CONTINUOUS_E2E_EMAIL || "";
  const password = process.env.ASKLAKE_CONTINUOUS_E2E_PASSWORD || "";
  if (!email && !password) return;
  assert(email && password, "Set both ASKLAKE_CONTINUOUS_E2E_EMAIL and ASKLAKE_CONTINUOUS_E2E_PASSWORD.");
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`E2E login failed (${response.status}): ${await response.text()}`);
  const setCookie = response.headers.get("set-cookie") || "";
  sessionCookie = setCookie.split(";", 1)[0];
  assert(sessionCookie.includes("="), "E2E login did not return a session cookie.");
}

async function createPublishedDashboard(datasetId) {
  const created = await post("/api/dashboards", {
    title: `Kafka Continuous E2E ${suffix}`,
    source: "catalog",
    datasetId,
  });
  const createdDashboardId = created.dashboard.id;
  dashboardId = createdDashboardId;
  const draft = await post(`/api/dashboards/${encodeURIComponent(createdDashboardId)}/draft/ensure`, {});
  const pageId = draft.pages?.[0]?.id;
  assert(pageId, "Dashboard draft must contain a page.");
  await post(`/api/dashboards/${encodeURIComponent(createdDashboardId)}/draft/pages/${encodeURIComponent(pageId)}/widgets`, {
    type: "metric",
    title: "Stored Kafka rows",
    datasetId,
    config: { aggregation: "count", valueKey: "event_id" },
  });
  await post(`/api/dashboards/${encodeURIComponent(createdDashboardId)}/publish`, {});
  const runtime = await get(`/api/dashboards/${encodeURIComponent(createdDashboardId)}/published`);
  const publishedWidget = Object.values(runtime.widgetsByPageId || {})
    .flat()
    .find((widget) => widget.datasetId === datasetId && widget.title === "Stored Kafka rows");
  assert(publishedWidget?.id, "Published dashboard must contain the Kafka metric widget.");
  widgetId = publishedWidget.id;
  return { dashboardId: createdDashboardId, widgetId: publishedWidget.id };
}

function findRuntimeWidget(runtime, expectedWidgetId) {
  return Object.values(runtime.widgetsByPageId || {})
    .flat()
    .find((widget) => widget.id === expectedWidgetId);
}

function metricValue(widget) {
  const valueKey = widget?.config?.valueKey;
  return Number(widget?.data?.[0]?.[valueKey]);
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

function restartBackend() {
  run("docker", ["compose", "--env-file", envFile, "-f", composeFile, "restart", "backend"]);
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
async function del(path) { return request(path, { method: "DELETE" }); }
async function expectStatus(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, { headers: authHeaders() });
  if (response.status !== expectedStatus) throw new Error(`GET ${path} expected ${expectedStatus}, received ${response.status}: ${await response.text()}`);
}
async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const authHint = response.status === 401 && !sessionCookie
      ? " Set ASKLAKE_CONTINUOUS_E2E_EMAIL/PASSWORD or ASKLAKE_CONTINUOUS_E2E_SESSION_COOKIE for production auth."
      : "";
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload)}${authHint}`);
  }
  return payload;
}

function authHeaders() {
  return sessionCookie ? { Cookie: sessionCookie } : { "X-AskLake-Role": "admin" };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function assert(condition, message) { if (!condition) throw new Error(message); }
