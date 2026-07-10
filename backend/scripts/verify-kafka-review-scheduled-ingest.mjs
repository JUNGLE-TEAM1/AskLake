import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";
const pythonBin = process.env.ASKLAKE_FASTAPI_PYTHON || "python3";
const port = Number(process.env.ASKLAKE_KAFKA_SCHEDULE_VERIFY_PORT || 18088);
const baseUrl = process.env.ASKLAKE_KAFKA_SCHEDULE_VERIFY_BASE_URL || `http://127.0.0.1:${port}`;
const shouldStartServer = process.env.ASKLAKE_KAFKA_SCHEDULE_VERIFY_START_SERVER !== "false";
const suffix = Date.now().toString(36);
const topic = process.env.ASKLAKE_KAFKA_SCHEDULE_VERIFY_TOPIC || `reviews.raw.verify.${suffix}`;
const minimalTopic = `reviews.raw.minimal.${suffix}`;
const groupId = `asklake-verify-${suffix}`;
const targetDataset = `reviews_raw_verify_${suffix}`;
const fixtureMessageCount = 100;
const env = {
  ...process.env,
  ASKLAKE_KAFKA_BROKER: process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092",
  ASKLAKE_RECREATE_REVIEW_TOPIC: "true",
  ASKLAKE_REVIEW_KAFKA_TOPIC: topic,
  DATABASE_URL: process.env.DATABASE_URL || "postgresql+psycopg://asklake:asklake_dev@127.0.0.1:54328/asklake",
  KAFKAJS_NO_PARTITIONER_WARNING: "1",
  MINIO_ACCESS_KEY: process.env.MINIO_ACCESS_KEY || "m3admin",
  MINIO_ENDPOINT: process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000",
  MINIO_SECRET_KEY: process.env.MINIO_SECRET_KEY || "wishuponastar",
  PYTHONPATH: [backendDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};

let serverProcess = null;

try {
  ensureFastApiPythonDependencies();
  seedReviewTopic();
  if (shouldStartServer) serverProcess = startFastApiServer();
  await waitForHealth();
  await verifyScheduledKafkaIngest();
  await verifyMinimalReviewContractIngest();
  await verifyTransformAndQualityIngest();
  await verifyFailRunLeavesOffsetsForRetry();
  console.log("verify-kafka-review-scheduled-ingest: ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (serverProcess) serverProcess.kill("SIGTERM");
}

async function verifyScheduledKafkaIngest() {
  const create = await post("/api/etl/jobs", kafkaJobPayload());
  assert(create.job?.id, "Kafka scheduled job create response should include job.id.");
  assert(create.job.sourceType === "Stream / Kafka", "Job sourceType should be Kafka.");
  assert(create.job.targetFormat === "jsonl", "Job targetFormat should be jsonl.");
  assert(create.job.storagePath === `s3://asklake-output/${targetDataset}/bronze`, "Job storagePath should point to the direct target path.");

  const tick = await post("/api/etl/schedules/run-due", {
    force: false,
    jobId: create.job.id,
    kafkaOnly: true,
  });
  assert(tick.checkedCount === 1, "Schedule tick should inspect one job.");
  assert(tick.triggeredCount === 1, `Schedule tick should trigger the due Kafka job: ${JSON.stringify(tick)}`);

  const item = tick.items?.[0];
  assert(item.reason === "due", `Schedule tick reason should be due: ${item?.reason}`);
  assert(item.response?.run?.status === "success", "Scheduled Kafka run should succeed.");
  assert(item.response?.run?.inputRows === `${fixtureMessageCount}행`, `Scheduled Kafka run should consume ${fixtureMessageCount} rows: ${item.response?.run?.inputRows}`);
  assert(item.response?.run?.taskStates?.kafkaSnapshot?.partitions?.[0]?.endOffset === String(fixtureMessageCount), "Job run should retain Kafka snapshot metadata.");
  assert(item.response?.dataset?.storageFormat === "jsonl", "Catalog dataset should expose jsonl storage format.");
  assert(item.response?.dataset?.materializationRuns?.[0]?.sourceKind === "kafka", "Catalog materialization run should retain sourceKind kafka.");
  assert(item.response?.dataset?.layer === "BRONZE", "Catalog dataset should retain the selected target layer.");
  assert(!item.response?.dataset?.storageLocation?.includes("kafka-landing"), "Kafka job should not write to the legacy landing path.");
  assert(item.response?.dataset?.storageLocation === item.response?.run?.outputPath, "Catalog storageLocation should match run outputPath.");

  const jobAfterFirstTick = await get(`/api/etl/jobs/${encodeURIComponent(create.job.id)}`);
  assert(jobAfterFirstTick.schedulePolicy?.nextRunUtc !== "2026-07-09T00:00:00Z", "Schedule tick should advance nextRunUtc after a due run.");

  const secondTick = await post("/api/etl/schedules/run-due", {
    force: false,
    jobId: create.job.id,
    kafkaOnly: true,
  });
  assert(secondTick.triggeredCount === 0, `Second tick should not retrigger before the advanced nextRunUtc: ${JSON.stringify(secondTick)}`);
  assert(secondTick.items?.[0]?.reason === "not_due", `Second tick should report not_due: ${secondTick.items?.[0]?.reason}`);
}

async function verifyMinimalReviewContractIngest() {
  await produceMinimalReviewEvents();
  const result = await post("/api/etl/kafka/reviews/ingest", {
    broker: env.ASKLAKE_KAFKA_BROKER,
    topic: minimalTopic,
    consumerGroupId: `asklake-minimal-${suffix}`,
    datasetId: `ds_reviews_raw_minimal_${suffix}`,
    datasetName: `reviews_raw_minimal_${suffix}`,
    maxMessages: 10,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: false,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: env.MINIO_ENDPOINT,
    targetBucket: "asklake-output",
    targetPrefix: `verify/${minimalTopic}/bronze`,
    targetLayer: "BRONZE",
    targetFormat: "jsonl",
  });

  assert(result.status === "success", "Minimal review ingest should succeed.");
  assert(result.consumedCount === 2, `Minimal review ingest should consume 2 messages: ${result.consumedCount}`);
  assert(result.storedCount === 2, `Minimal review ingest should store 2 messages: ${result.storedCount}`);
  assert(result.snapshot?.partitions?.length === 1, "Kafka ingest should return a partition snapshot.");
  assert(result.snapshot.partitions[0].startOffset === "0", `Snapshot should begin at offset 0: ${JSON.stringify(result.snapshot)}`);
  assert(result.snapshot.partitions[0].endOffset === "2", `Snapshot should end at offset 2: ${JSON.stringify(result.snapshot)}`);
  assert(result.targetLayer === "BRONZE", "Minimal ingest should retain the target layer.");
  assert(!result.storageLocation.includes("kafka-landing"), "Minimal ingest should not write to the legacy landing path.");
  assert(result.catalogDataset?.storageLocation === result.storageLocation, "Minimal review catalog storage location should match direct target output.");

  const emptyResult = await post("/api/etl/kafka/reviews/ingest", {
    broker: env.ASKLAKE_KAFKA_BROKER,
    topic: minimalTopic,
    consumerGroupId: `asklake-minimal-${suffix}`,
    datasetId: `ds_reviews_raw_minimal_${suffix}`,
    datasetName: `reviews_raw_minimal_${suffix}`,
    maxMessages: 10,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: true,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: env.MINIO_ENDPOINT,
    targetBucket: "asklake-output",
    targetPrefix: `verify/${minimalTopic}/bronze`,
    targetLayer: "BRONZE",
    targetFormat: "jsonl",
  });
  assert(emptyResult.consumedCount === 0, `Committed offsets should prevent duplicate consume: ${emptyResult.consumedCount}`);
  assert(emptyResult.snapshot.partitions[0].startOffset === "2", `Next snapshot should start at committed offset 2: ${JSON.stringify(emptyResult.snapshot)}`);
  assert(emptyResult.snapshot.partitions[0].endOffset === "2", `Next snapshot should be empty: ${JSON.stringify(emptyResult.snapshot)}`);
}

async function verifyTransformAndQualityIngest() {
  const transformTopic = `reviews.raw.transform.${suffix}`;
  await produceReviewEvents(transformTopic, [
    { event_id: `transform-${suffix}-1`, offset: 1, review: "  GREAT REVIEW  ", created_at: "2026-07-09T02:00:00Z", raw: { email: "valid@example.com" } },
    { event_id: `transform-${suffix}-2`, offset: 2, review: "  DROP ME  ", created_at: "2026-07-09T02:01:00Z", raw: { email: "invalid-email" } },
  ]);
  const result = await post("/api/etl/kafka/reviews/ingest", {
    broker: env.ASKLAKE_KAFKA_BROKER,
    topic: transformTopic,
    consumerGroupId: `asklake-transform-${suffix}`,
    datasetId: `ds_reviews_transform_${suffix}`,
    datasetName: `reviews_transform_${suffix}`,
    maxMessages: 10,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: false,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: env.MINIO_ENDPOINT,
    targetBucket: "asklake-output",
    targetPrefix: `verify/${transformTopic}/silver`,
    targetLayer: "SILVER",
    targetFormat: "jsonl",
    transformSteps: [{ enabled: true, id: "lower-review", input: "review", kind: "trim", label: "lower", onError: "Fail Run", operation: "Trim / Lowercase", output: "normalized_review", params: "" }],
    qualityRules: [{ enabled: true, failureAction: "Quarantine", id: "valid-email", kind: "regex", severity: "Error", targetColumn: "raw.email", validationType: "Regex Match" }],
  });

  assert(result.status === "success", "Transform and quality ingest should succeed.");
  assert(result.storedCount === 1, `Quality quarantine should retain one target row: ${result.storedCount}`);
  assert(result.transform?.appliedStepCount === 2, `Transform should run for both rows: ${JSON.stringify(result.transform)}`);
  assert(result.quality?.invalidRowCount === 1, `Quality should mark one invalid row: ${JSON.stringify(result.quality)}`);
  assert(result.quality?.quarantinedCount === 1, `Quality should quarantine one invalid row: ${JSON.stringify(result.quality)}`);
  assert(result.quality?.quarantineLocation?.endsWith("quarantine.jsonl"), "Quality quarantine should have a snapshot-local object.");
  assert(result.catalogDataset?.layer === "SILVER", "Transform test should retain the selected SILVER target.");

  const targetBody = await readS3Object(result.storageLocation);
  const targetRecords = targetBody.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert(targetRecords.length === 1, "Direct target object should contain only the valid row.");
  assert(targetRecords[0].normalized_review === "great review", `Transform output should be written to direct target: ${targetBody}`);
  const quarantineBody = await readS3Object(result.quality.quarantineLocation);
  assert(quarantineBody.includes(`transform-${suffix}-2`), "Quarantine object should contain the rejected Kafka row.");
}

async function verifyFailRunLeavesOffsetsForRetry() {
  const failureTopic = `reviews.raw.fail.${suffix}`;
  const failureGroup = `asklake-fail-${suffix}`;
  const baseRequest = {
    broker: env.ASKLAKE_KAFKA_BROKER,
    topic: failureTopic,
    consumerGroupId: failureGroup,
    datasetId: `ds_reviews_fail_${suffix}`,
    datasetName: `reviews_fail_${suffix}`,
    maxMessages: 10,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: false,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: env.MINIO_ENDPOINT,
    targetBucket: "asklake-output",
    targetPrefix: `verify/${failureTopic}/silver`,
    targetLayer: "SILVER",
    targetFormat: "jsonl",
  };
  await produceReviewEvents(failureTopic, [
    { event_id: `failure-${suffix}-1`, offset: 1, review: "Fail run review", created_at: "2026-07-09T03:00:00Z", raw: { email: "invalid-email" } },
  ]);
  const failed = await postError("/api/etl/kafka/reviews/ingest", {
    ...baseRequest,
    qualityRules: [{ enabled: true, failureAction: "Fail Run", id: "failure-email", kind: "regex", severity: "Error", targetColumn: "raw.email", validationType: "Regex Match" }],
  });
  assert(failed.status === 502, `Fail Run should return bridge failure: ${JSON.stringify(failed)}`);
  const failedSnapshot = failed.payload?.error?.details?.bridge?.snapshot;
  assert(failed.payload?.error?.details?.bridge?.failedStage === "quality", `Failure should report quality stage: ${JSON.stringify(failed)}`);
  assert(failedSnapshot?.partitions?.[0]?.startOffset === "0", "Failed snapshot should begin at the first message.");
  assert(await groupOffset(failureTopic, failureGroup) === "-1", "Fail Run must not commit the consumer group offset.");

  const retried = await post("/api/etl/kafka/reviews/ingest", { ...baseRequest, qualityRules: [] });
  assert(retried.consumedCount === 1, `Retry should read the uncommitted Kafka message: ${JSON.stringify(retried)}`);
  assert(retried.snapshot?.snapshotId === failedSnapshot.snapshotId, "Retry should reuse the same snapshot identity for the unchanged offset range.");
  assert(await groupOffset(failureTopic, failureGroup) === "1", "Successful retry should commit the snapshot end offset.");

  const jobFailureTopic = `reviews.raw.job-fail.${suffix}`;
  const jobFailureGroup = `asklake-job-fail-${suffix}`;
  await produceReviewEvents(jobFailureTopic, [
    { event_id: `job-failure-${suffix}-1`, offset: 1, review: "Job failure review", created_at: "2026-07-09T03:01:00Z", raw: { email: "invalid-email" } },
  ]);
  const jobCreate = await post("/api/etl/jobs", kafkaFailureJobPayload(jobFailureTopic, jobFailureGroup));
  const jobCommand = await post(`/api/etl/jobs/${encodeURIComponent(jobCreate.job.id)}/commands`, { command: "run" });
  assert(jobCommand.run?.status === "failed", `Kafka Job failure should persist a failed run: ${JSON.stringify(jobCommand)}`);
  assert(jobCommand.job?.status === "failed", "Kafka Job should expose failed status after quality Fail Run.");
  assert(jobCommand.run?.taskStates?.kafkaSnapshot?.partitions?.[0]?.startOffset === "0", "Failed Job Run should retain its snapshot metadata.");
  assert(jobCommand.dagSteps?.some((step) => step.id === "quality" && step.status === "failed"), "Kafka Job DAG should mark the quality stage as failed.");
  assert(await groupOffset(jobFailureTopic, jobFailureGroup) === "-1", "Failed Kafka Job must not commit its consumer group offset.");
}

async function readS3Object(location) {
  const match = String(location || "").match(/^s3:\/\/([^/]+)\/(.+)$/);
  assert(match, `Expected an S3 location: ${location}`);
  const client = new S3Client({
    credentials: { accessKeyId: env.MINIO_ACCESS_KEY, secretAccessKey: env.MINIO_SECRET_KEY },
    endpoint: env.MINIO_ENDPOINT,
    forcePathStyle: true,
    region: "us-east-1",
  });
  const response = await client.send(new GetObjectCommand({ Bucket: match[1], Key: match[2] }));
  return response.Body.transformToString();
}

async function produceMinimalReviewEvents() {
  const { Kafka } = await import("kafkajs");
  const kafka = new Kafka({
    brokers: [env.ASKLAKE_KAFKA_BROKER],
    clientId: "asklake-minimal-review-producer",
    retry: { retries: 2 },
  });
  const admin = kafka.admin();
  const producer = kafka.producer();
  const records = [
    {
      event_id: `minimal-${suffix}-1`,
      offset: 1,
      review: "Minimal review contract message one.",
      created_at: "2026-07-09T00:00:00Z",
    },
    {
      event_id: `minimal-${suffix}-2`,
      offset: 2,
      review: "Minimal review contract message two.",
      created_at: "2026-07-09T00:01:00Z",
    },
  ];

  try {
    await admin.connect();
    await createFreshTopic(admin, minimalTopic);
    await producer.connect();
    await producer.send({
      topic: minimalTopic,
      messages: records.map((record) => ({
        key: record.event_id,
        value: JSON.stringify(record),
      })),
    });
  } finally {
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }
}

async function produceReviewEvents(targetTopic, records) {
  const { Kafka } = await import("kafkajs");
  const kafka = new Kafka({ brokers: [env.ASKLAKE_KAFKA_BROKER], clientId: "asklake-transform-review-producer", retry: { retries: 2 } });
  const admin = kafka.admin();
  const producer = kafka.producer();
  try {
    await admin.connect();
    await createFreshTopic(admin, targetTopic);
    await producer.connect();
    await producer.send({ topic: targetTopic, messages: records.map((record) => ({ key: record.event_id, value: JSON.stringify(record) })) });
  } finally {
    await producer.disconnect().catch(() => undefined);
    await admin.disconnect().catch(() => undefined);
  }
}

async function groupOffset(topicName, groupId) {
  const { Kafka } = await import("kafkajs");
  const kafka = new Kafka({ brokers: [env.ASKLAKE_KAFKA_BROKER], clientId: "asklake-offset-verify", retry: { retries: 2 } });
  const admin = kafka.admin();
  try {
    await admin.connect();
    const offsets = await admin.fetchOffsets({ groupId, topics: [topicName] });
    return offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset ?? "-1";
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function createFreshTopic(admin, targetTopic) {
  const topics = await admin.listTopics();
  if (topics.includes(targetTopic)) {
    await admin.deleteTopics({ topics: [targetTopic], timeout: 5000 });
    await sleep(750);
  }
  await admin.createTopics({
    topics: [{ topic: targetTopic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });
}

function kafkaJobPayload() {
  return {
    id: `kafka-review-schedule-verify-${suffix}`,
    jobName: `Kafka Review Schedule Verify ${suffix}`,
    owner: "AskLake",
    permissionRoles: [{ access: ["조회", "쿼리 실행"], checked: true, name: "Data Engineer Group" }],
    permissionSummary: "Data Engineer Group",
    rag: false,
    retryPolicy: { backoffMultiplier: 2, backoffStrategy: "exponential", failureAction: "retry_then_fail", initialRetryDelayMinutes: 1, maxRetries: 0, maxRetryDelayMinutes: 30, retryIntervalMinutes: 1, timeoutMinutes: 60 },
    retryPolicySummary: "재시도 없음 · 재시도 후 실패 처리",
    runLimitSummary: "60분 초과 시 Run 실패 처리",
    ruleSummary: "Kafka scheduled review ingest verify",
    transformOutputColumns: [],
    transformSteps: [],
    qualityInvalidRows: [],
    qualityRules: [],
    qualityScore: 100,
    qualityStatus: "pass",
    scheduleLabel: "매시간 00분",
    scheduleSummary: "반복 실행 · 매시간 00분 · Asia/Seoul · 저장 후 다음 예약부터 시작",
    nextRunUtc: "2026-07-09T00:00:00Z",
    overlapPolicy: "skip_if_running",
    timezone: "Asia/Seoul",
    schemaColumns: [
      { included: true, nullable: false, sourceName: "schema_version", targetName: "schema_version", type: "String" },
      { included: true, nullable: false, sourceName: "event_id", targetName: "event_id", type: "String" },
      { included: true, nullable: false, sourceName: "source", targetName: "source", type: "String" },
      { included: true, nullable: false, sourceName: "offset", targetName: "offset", type: "Integer" },
      { included: true, nullable: false, sourceName: "review", targetName: "review", type: "String" },
      { included: true, nullable: false, sourceName: "created_at", targetName: "created_at", type: "Timestamp" },
      { included: true, nullable: false, sourceName: "raw", targetName: "raw", type: "Object" },
    ],
    schemaSampleRows: [],
    schemaSummary: "Kafka review event schema",
    sourceConfig: [
      ["Stream Type", "Apache Kafka"],
      ["Broker / Endpoint", env.ASKLAKE_KAFKA_BROKER],
      ["TOPIC / QUEUE NAME", topic],
      ["CONSUMER GROUP ID", groupId],
      ["Batch Max Messages", "100"],
      ["Timeout Ms", "10000"],
      ["Offset Policy", "Earliest (Start from beginning)"],
      ["Message Format", "JSON (Auto-infer Schema)"],
      ["Authentication", "None"],
    ],
    sourceLabel: topic,
    sourceType: "Stream / Kafka",
    storagePath: `s3://asklake-output/${targetDataset}/bronze`,
    storageType: "S3",
    targetDataset,
    targetFormat: "jsonl",
    targetLayer: "BRONZE",
  };
}

function kafkaFailureJobPayload(jobTopic, jobGroup) {
  const payload = kafkaJobPayload();
  const jobDataset = `reviews_job_fail_${suffix}`;
  return {
    ...payload,
    id: `kafka-review-fail-verify-${suffix}`,
    jobName: `Kafka Review Failure Verify ${suffix}`,
    qualityRules: [{ enabled: true, failureAction: "Fail Run", id: "job-failure-email", kind: "regex", severity: "Error", targetColumn: "raw.email", validationType: "Regex Match" }],
    sourceConfig: payload.sourceConfig.map(([key, value]) => {
      if (key === "TOPIC / QUEUE NAME") return [key, jobTopic];
      if (key === "CONSUMER GROUP ID") return [key, jobGroup];
      return [key, value];
    }),
    sourceLabel: jobTopic,
    storagePath: `s3://asklake-output/${jobDataset}/silver`,
    targetDataset: jobDataset,
    targetLayer: "SILVER",
  };
}

function ensureFastApiPythonDependencies() {
  const result = spawnSync(pythonBin, ["-c", "import fastapi, psycopg, pydantic_settings, sqlalchemy, uvicorn"], {
    cwd: backendDir,
    env,
    stdio: "pipe",
    text: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const lastOutputLine = output.split("\n").filter(Boolean).at(-1);
    throw new Error([
      "FastAPI Python dependencies are not installed for this interpreter.",
      `python: ${pythonBin}`,
      "Run `cd backend && python -m pip install -r requirements.txt`, or set ASKLAKE_FASTAPI_PYTHON.",
      lastOutputLine,
    ].filter(Boolean).join("\n"));
  }
}

function seedReviewTopic() {
  const result = spawnSync(process.execPath, ["scripts/seed-kafka-review-fixture.mjs"], {
    cwd: backendDir,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Kafka review fixture seed failed with exit code ${result.status}.`);
}

function startFastApiServer() {
  const child = spawn(pythonBin, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: backendDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[fastapi] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[fastapi] ${chunk}`));
  return child;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok && health.database?.ok) return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`FastAPI health check did not pass at ${baseUrl}/api/health.`);
}

async function get(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return readResponse(response);
}

async function post(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return readResponse(response);
}

async function postError(route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  return { payload: text ? JSON.parse(text) : null, status: response.status };
}

async function readResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
