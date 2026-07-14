import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

const count = positiveInteger(process.env.ASKLAKE_KAFKA_EXPERIMENT_COUNT || "100", "ASKLAKE_KAFKA_EXPERIMENT_COUNT");
const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const minioAccessKey = process.env.MINIO_ACCESS_KEY || "m3admin";
const minioSecretKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
const topic = process.env.ASKLAKE_KAFKA_EXPERIMENT_TOPIC || `reviews.raw.correctness.${suffix}`;
const consumerGroupId = process.env.ASKLAKE_KAFKA_EXPERIMENT_GROUP || `asklake-correctness-${suffix}`;
const datasetId = process.env.ASKLAKE_KAFKA_EXPERIMENT_DATASET_ID || `ds_reviews_correctness_${suffix}`;
const datasetName = process.env.ASKLAKE_KAFKA_EXPERIMENT_DATASET_NAME || `reviews_correctness_${suffix}`;
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const targetPrefix = process.env.ASKLAKE_KAFKA_EXPERIMENT_PREFIX || `experiments/kafka-correctness/${suffix}/silver`;

const kafka = new Kafka({ brokers: [broker], clientId: `asklake-correctness-${suffix}`, retry: { retries: 2 } });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
const s3 = new S3Client({
  endpoint: minioEndpoint,
  forcePathStyle: true,
  region: "us-east-1",
  credentials: { accessKeyId: minioAccessKey, secretAccessKey: minioSecretKey },
});
const experimentStartedAt = Date.now();

try {
  await assertHealthyBackend();
  await admin.connect();
  await producer.connect();
  await createFreshTopic();

  const producedAt = new Date().toISOString();
  const records = buildRecords(producedAt);
  const produceStartedAt = Date.now();
  await producer.send({
    topic,
    messages: records.map((record) => ({ key: record.event_id, value: JSON.stringify(record) })),
  });
  const produceMs = Date.now() - produceStartedAt;

  const request = ingestRequest(false);
  const ingestStartedAt = Date.now();
  const result = await postJson("/api/etl/kafka/reviews/ingest", request);
  const ingestMs = Date.now() - ingestStartedAt;

  assert(result.status === "success", `ingest status must be success: ${JSON.stringify(result)}`);
  assert(result.consumedCount === count, `consumedCount must be ${count}, received ${result.consumedCount}`);
  assert(result.storedCount === count, `storedCount must be ${count}, received ${result.storedCount}`);
  assert(result.failedCount === 0, `failedCount must be 0, received ${result.failedCount}`);
  assert(result.targetLayer === "SILVER", `targetLayer must be SILVER, received ${result.targetLayer}`);
  assert(!result.storageLocation.includes("kafka-landing"), `legacy landing path must not be used: ${result.storageLocation}`);
  assert(result.snapshot?.partitions?.length === 1, "snapshot must contain exactly one partition");
  assert(result.snapshot.partitions[0].startOffset === "0", `snapshot startOffset must be 0: ${JSON.stringify(result.snapshot)}`);
  assert(result.snapshot.partitions[0].endOffset === String(count), `snapshot endOffset must be ${count}: ${JSON.stringify(result.snapshot)}`);

  const targetRecords = await readJsonLines(result.storageLocation);
  assert(targetRecords.length === count, `MinIO data.jsonl must contain ${count} rows, received ${targetRecords.length}`);
  assert(new Set(targetRecords.map((record) => record.event_id)).size === count, "event_id values must be unique");
  assert(new Set(targetRecords.map((record) => record.offset)).size === count, "payload offset values must be unique");

  for (let index = 0; index < count; index += 1) {
    const expected = records[index];
    const actual = targetRecords.find((record) => record.event_id === expected.event_id);
    assert(actual, `MinIO target is missing ${expected.event_id}`);
    assert(actual.offset === expected.offset, `${expected.event_id} payload offset must be ${expected.offset}, received ${actual.offset}`);
    assert(actual.normalized_review === expected.review.trim().toLowerCase(), `${expected.event_id} transform output is invalid`);
  }

  const offsets = await admin.fetchOffsets({ groupId: consumerGroupId, topics: [topic] });
  const committedOffset = offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset;
  assert(committedOffset === String(count), `consumer group offset must be ${count}, received ${committedOffset}`);

  const catalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  const catalogDataset = catalogPayload.dataset || catalogPayload;
  assert(catalogDataset.id === datasetId, `Catalog dataset id must be ${datasetId}`);
  assert(catalogDataset.layer === "SILVER", `Catalog layer must be SILVER, received ${catalogDataset.layer}`);
  assert(catalogDataset.storageLocation === result.storageLocation, "Catalog storageLocation must match the MinIO target object");

  const emptyResult = await postJson("/api/etl/kafka/reviews/ingest", ingestRequest(true));
  assert(emptyResult.consumedCount === 0, `second run consumedCount must be 0, received ${emptyResult.consumedCount}`);
  assert(emptyResult.storedCount === 0, `second run storedCount must be 0, received ${emptyResult.storedCount}`);
  assert(emptyResult.snapshot?.partitions?.[0]?.startOffset === String(count), "second snapshot must start at the committed offset");
  assert(emptyResult.snapshot?.partitions?.[0]?.endOffset === String(count), "second snapshot must be empty");

  const finalCatalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  const finalCatalogDataset = finalCatalogPayload.dataset || finalCatalogPayload;
  assert(String(finalCatalogDataset.rows) === String(count), `empty snapshot must not change Catalog row count: ${finalCatalogDataset.rows}`);
  assert(
    finalCatalogDataset.storageLocation === result.storageLocation,
    `empty snapshot must not replace the last non-empty Catalog storageLocation: ${finalCatalogDataset.storageLocation}`,
  );

  console.log(JSON.stringify({
    experiment: "kafka-direct-ingest-correctness",
    status: "PASS",
    implementationCommit: process.env.ASKLAKE_IMPLEMENTATION_COMMIT || null,
    topic,
    consumerGroupId,
    datasetId,
    snapshotId: result.snapshot.snapshotId,
    storageLocation: result.storageLocation,
    producedCount: count,
    consumedCount: result.consumedCount,
    storedCount: result.storedCount,
    uniqueEventIdCount: count,
    committedOffset,
    secondRunConsumedCount: emptyResult.consumedCount,
    finalCatalogLocation: finalCatalogDataset.storageLocation,
    timing: { produceMs, ingestMs, totalMs: Date.now() - experimentStartedAt },
  }, null, 2));
} catch (error) {
  console.error(`Kafka correctness experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

function buildRecords(producedAt) {
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    const review = `  REVIEW ${String(sequence).padStart(3, "0")} WORKS  `;
    return {
      schema_version: "1.0",
      event_id: `correctness-${suffix}-${String(sequence).padStart(6, "0")}`,
      source: "asklake-kafka-correctness-experiment",
      offset: sequence,
      review,
      created_at: new Date(Date.parse(producedAt) + index).toISOString(),
      raw: { experiment: "kafka-direct-ingest-correctness", produced_at: producedAt, sequence },
    };
  });
}

function ingestRequest(allowEmpty) {
  return {
    broker,
    topic,
    consumerGroupId,
    datasetId,
    datasetName,
    maxMessages: count,
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty,
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
  if (topics.includes(topic)) {
    throw new Error(`topic already exists; use a new ASKLAKE_KAFKA_EXPERIMENT_SUFFIX: ${topic}`);
  }
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 1 }],
    waitForLeaders: true,
  });
}

async function readJsonLines(storageLocation) {
  const { bucket, key } = parseS3Location(storageLocation);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body.transformToString();
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
  return requestJson(pathname, { method: "GET" });
}

async function postJson(pathname, body) {
  return requestJson(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
  if (!response.ok) throw new Error(`${options.method} ${pathname} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
