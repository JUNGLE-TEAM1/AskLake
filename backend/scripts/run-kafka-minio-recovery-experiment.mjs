import { execFileSync } from "node:child_process";
import { GetObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

if (process.env.ASKLAKE_ALLOW_MINIO_OUTAGE !== "true") {
  throw new Error("Set ASKLAKE_ALLOW_MINIO_OUTAGE=true to allow this experiment to stop the local MinIO container.");
}

const count = positiveInteger(process.env.ASKLAKE_KAFKA_EXPERIMENT_COUNT || "100", "ASKLAKE_KAFKA_EXPERIMENT_COUNT");
const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const minioAccessKey = process.env.MINIO_ACCESS_KEY || "m3admin";
const minioSecretKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
const minioContainer = process.env.ASKLAKE_MINIO_CONTAINER || "asklake-source-minio";
const topic = process.env.ASKLAKE_KAFKA_EXPERIMENT_TOPIC || `reviews.raw.minio-recovery.${suffix}`;
const consumerGroupId = process.env.ASKLAKE_KAFKA_EXPERIMENT_GROUP || `asklake-minio-recovery-${suffix}`;
const datasetId = process.env.ASKLAKE_KAFKA_EXPERIMENT_DATASET_ID || `ds_reviews_minio_recovery_${suffix}`;
const datasetName = process.env.ASKLAKE_KAFKA_EXPERIMENT_DATASET_NAME || `reviews_minio_recovery_${suffix}`;
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const targetPrefix = process.env.ASKLAKE_KAFKA_EXPERIMENT_PREFIX || `experiments/kafka-minio-recovery/${suffix}/silver`;

const kafka = new Kafka({ brokers: [broker], clientId: `asklake-minio-recovery-${suffix}`, retry: { retries: 2 } });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
const s3 = new S3Client({
  endpoint: minioEndpoint,
  forcePathStyle: true,
  region: "us-east-1",
  credentials: { accessKeyId: minioAccessKey, secretAccessKey: minioSecretKey },
});
const experimentStartedAt = Date.now();
let minioStoppedByExperiment = false;

try {
  await assertHealthyBackend();
  assertMinioRunning();
  await admin.connect();
  await producer.connect();
  await createFreshTopic();

  const records = buildRecords(new Date().toISOString());
  await producer.send({
    topic,
    messages: records.map((record) => ({ key: record.event_id, value: JSON.stringify(record) })),
  });

  stopMinio();
  minioStoppedByExperiment = true;

  const failed = await postFailure("/api/etl/kafka/reviews/ingest", ingestRequest());
  assert(failed.status === 502, `MinIO outage must fail ingest with 502, received ${failed.status}: ${JSON.stringify(failed.payload)}`);
  const failedBridge = failed.payload?.error?.details?.bridge;
  const failedSnapshot = failedBridge?.snapshot;
  assert(failedSnapshot?.snapshotId, `MinIO outage must preserve snapshot diagnostics: ${JSON.stringify(failed.payload)}`);
  assert(failedBridge?.failedStage, `MinIO outage must preserve a failed stage: ${JSON.stringify(failedBridge)}`);
  assert(/ECONNREFUSED|connect/i.test(String(failedBridge?.message || "")), `Failure must be caused by the stopped MinIO endpoint: ${JSON.stringify(failedBridge)}`);

  const offsetAfterFailure = await committedOffset();
  assert(offsetAfterFailure === "-1", `Failed MinIO write must not commit the group offset, received ${offsetAfterFailure}`);

  startMinio();
  minioStoppedByExperiment = false;
  await waitForMinio();

  const retried = await postJson("/api/etl/kafka/reviews/ingest", ingestRequest());
  assert(retried.status === "success", `Retry status must be success: ${JSON.stringify(retried)}`);
  assert(retried.snapshot?.snapshotId === failedSnapshot.snapshotId, `Retry must reuse the failed snapshot identity: ${JSON.stringify(retried.snapshot)}`);
  assert(retried.consumedCount === count, `Retry consumedCount must be ${count}, received ${retried.consumedCount}`);
  assert(retried.storedCount === count, `Retry storedCount must be ${count}, received ${retried.storedCount}`);
  assert(retried.failedCount === 0, `Retry failedCount must be 0, received ${retried.failedCount}`);

  const targetRecords = await readJsonLines(retried.storageLocation);
  assert(targetRecords.length === count, `MinIO target must contain ${count} rows, received ${targetRecords.length}`);
  assert(new Set(targetRecords.map((record) => record.event_id)).size === count, "MinIO target must have no duplicate event_id values");
  assert(targetRecords.every((record) => record.normalized_review === record.review.trim().toLowerCase()), "Every target row must contain the normalized transform output");

  const offsetAfterRetry = await committedOffset();
  assert(offsetAfterRetry === String(count), `Successful retry must commit offset ${count}, received ${offsetAfterRetry}`);

  const catalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  const catalogDataset = catalogPayload.dataset || catalogPayload;
  const recoveredRuns = (catalogDataset.materializationRuns || []).filter(
    (run) => run.storageLocation === retried.storageLocation && Number(run.rowCount) === count,
  );
  assert(catalogDataset.rows === String(count), `Catalog rows must be ${count}, received ${catalogDataset.rows}`);
  assert(catalogDataset.storageLocation === retried.storageLocation, "Catalog must point to the recovered MinIO object");
  assert(recoveredRuns.length === 1, `Retry must leave one recovered materialization run, received ${recoveredRuns.length}`);

  console.log(JSON.stringify({
    experiment: "kafka-minio-outage-recovery",
    status: "PASS",
    implementationCommit: process.env.ASKLAKE_IMPLEMENTATION_COMMIT || null,
    topic,
    consumerGroupId,
    datasetId,
    snapshotId: failedSnapshot.snapshotId,
    failedStage: failedBridge.failedStage,
    offsetAfterFailure,
    offsetAfterRetry,
    storageLocation: retried.storageLocation,
    producedCount: count,
    recoveredStoredCount: retried.storedCount,
    uniqueEventIdCount: count,
    recoveredMaterializationRuns: recoveredRuns.length,
    timing: { totalMs: Date.now() - experimentStartedAt },
  }, null, 2));
} catch (error) {
  console.error(`Kafka MinIO recovery experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (minioStoppedByExperiment) {
    try {
      startMinio();
      await waitForMinio();
    } catch (error) {
      console.error(`MinIO restart after experiment failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

function buildRecords(producedAt) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const review = `  RECOVERY REVIEW ${String(sequence).padStart(3, "0")}  `;
    return {
      schema_version: "1.0",
      event_id: `minio-recovery-${suffix}-${String(sequence).padStart(6, "0")}`,
      source: "asklake-kafka-minio-recovery-experiment",
      offset: sequence,
      review,
      created_at: new Date(Date.parse(producedAt) + index).toISOString(),
      raw: { experiment: "kafka-minio-outage-recovery", produced_at: producedAt, sequence },
    };
  });
}

function ingestRequest() {
  return {
    broker,
    topic,
    consumerGroupId,
    datasetId,
    datasetName,
    maxMessages: count,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: false,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: minioEndpoint,
    targetBucket,
    targetPrefix,
    targetLayer: "SILVER",
    targetFormat: "jsonl",
    transformSteps: [{
      enabled: true,
      id: "normalize-review",
      input: "review",
      kind: "trim",
      label: "Normalize review",
      onError: "Fail Run",
      operation: "Trim / Lowercase",
      output: "normalized_review",
      params: "",
    }],
    qualityRules: [],
  };
}

async function createFreshTopic() {
  const topics = await admin.listTopics();
  if (topics.includes(topic)) throw new Error(`topic already exists; use a new ASKLAKE_KAFKA_EXPERIMENT_SUFFIX: ${topic}`);
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });
}

async function committedOffset() {
  const offsets = await admin.fetchOffsets({ groupId: consumerGroupId, topics: [topic] });
  return offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset || "-1";
}

async function readJsonLines(storageLocation) {
  const { bucket, key } = parseS3Location(storageLocation);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body.transformToString();
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForMinio() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: targetBucket }));
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`MinIO did not become ready at ${minioEndpoint}`);
}

function assertMinioRunning() {
  const running = docker(["inspect", "-f", "{{.State.Running}}", minioContainer]).trim();
  if (running !== "true") throw new Error(`MinIO container is not running: ${minioContainer}`);
}

function stopMinio() {
  docker(["stop", minioContainer]);
}

function startMinio() {
  docker(["start", minioContainer]);
}

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseS3Location(value) {
  const match = String(value || "").match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`invalid S3 storage location: ${value}`);
  return { bucket: match[1], key: match[2] };
}

async function assertHealthyBackend() {
  const health = await getJson("/api/health");
  assert(health.ok === true, `backend health must be ok: ${JSON.stringify(health)}`);
}

async function getJson(pathname) {
  const result = await requestJson(pathname, { method: "GET" });
  if (!result.response.ok) throw new Error(`GET ${pathname} failed ${result.response.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function postJson(pathname, body) {
  const result = await requestJson(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.response.ok) throw new Error(`POST ${pathname} failed ${result.response.status}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function postFailure(pathname, body) {
  const result = await requestJson(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { payload: result.payload, status: result.response.status };
}

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method} ${pathname} returned non-JSON ${response.status}: ${text}`);
  }
  return { payload, response };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
