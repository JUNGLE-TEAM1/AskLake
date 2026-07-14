import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

const count = positiveInteger(process.env.ASKLAKE_KAFKA_EXPERIMENT_COUNT || "100", "ASKLAKE_KAFKA_EXPERIMENT_COUNT");
const counts = countList(process.env.ASKLAKE_KAFKA_LATENCY_COUNTS || String(count));
const measuredRuns = positiveInteger(process.env.ASKLAKE_KAFKA_LATENCY_MEASURED_RUNS || "3", "ASKLAKE_KAFKA_LATENCY_MEASURED_RUNS");
const warmupRuns = nonNegativeInteger(process.env.ASKLAKE_KAFKA_LATENCY_WARMUP_RUNS || "1", "ASKLAKE_KAFKA_LATENCY_WARMUP_RUNS");
const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const minioAccessKey = process.env.MINIO_ACCESS_KEY || "m3admin";
const minioSecretKey = process.env.MINIO_SECRET_KEY || "wishuponastar";
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const kafka = new Kafka({ brokers: [broker], clientId: `asklake-stage-latency-${suffix}`, retry: { retries: 2 } });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
const s3 = new S3Client({
  endpoint: minioEndpoint,
  forcePathStyle: true,
  region: "us-east-1",
  credentials: { accessKeyId: minioAccessKey, secretAccessKey: minioSecretKey },
});
const allRuns = [];

try {
  await assertHealthyBackend();
  await admin.connect();
  await producer.connect();

  for (const runCount of counts) {
    for (let sequence = 0; sequence < warmupRuns + measuredRuns; sequence += 1) {
      const run = await executeRun(sequence, sequence < warmupRuns, runCount);
      allRuns.push(run);
    }
  }

  const measured = allRuns.filter((run) => !run.warmup);
  const summaryByCount = Object.fromEntries(counts.map((runCount) => {
    const matchingRuns = measured.filter((run) => run.count === runCount);
    return [String(runCount), summarizeRuns(matchingRuns)];
  }));
  console.log(JSON.stringify({
    experiment: "kafka-stage-latency",
    status: "PASS",
    implementationCommit: process.env.ASKLAKE_IMPLEMENTATION_COMMIT || null,
    countsPerRun: counts,
    warmupRuns,
    measuredRuns,
    timingSemantics: {
      snapshotToConsumeEndMs: "snapshotCapturedAt -> consumeEndedAt; durable snapshot handoff and consumer setup are included.",
      otherStages: "Adjacent stage-boundary timestamps are subtracted. Values are local wall-clock observations, not distributed traces.",
    },
    runs: allRuns,
    summaryByCount,
  }, null, 2));
} catch (error) {
  console.error(`Kafka stage latency experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

async function executeRun(sequence, warmup, runCount) {
  const label = `count-${runCount}-${warmup ? "warmup" : "measure"}-${sequence + 1}`;
  const topic = `reviews.raw.stage-latency.${suffix}.${label}`;
  const consumerGroupId = `asklake-stage-latency-${suffix}-${label}`;
  const datasetId = `ds_reviews_stage_latency_${suffix}_${label}`;
  const datasetName = `reviews_stage_latency_${suffix}_${label}`;
  const targetPrefix = `experiments/kafka-stage-latency/${suffix}/${label}/silver`;
  await createFreshTopic(topic);

  const records = buildRecords(topic, new Date().toISOString(), runCount);
  await producer.send({
    topic,
    messages: records.map((record) => ({ key: record.event_id, value: JSON.stringify(record) })),
  });
  const producerAckAt = new Date().toISOString();
  const result = await postJson("/api/etl/kafka/reviews/ingest", {
    broker,
    topic,
    consumerGroupId,
    datasetId,
    datasetName,
    maxMessages: runCount,
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
    producerAckAt,
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
  });

  assert(result.status === "success", `${label}: ingest must succeed`);
  assert(result.consumedCount === runCount && result.storedCount === runCount && result.failedCount === 0, `${label}: expected ${runCount} clean rows`);
  const timing = result.timing;
  assert(timing && typeof timing === "object", `${label}: timing metadata is missing`);
  assert(timing.producerAckAt === producerAckAt, `${label}: producerAckAt must round-trip through the bridge`);
  const durationsMs = timingDurations(timing, label);
  const diagnosticDurationsMs = diagnosticDurations(result, producerAckAt, label);

  const targetBody = await readS3Text(result.storageLocation);
  const targetRows = targetBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert(targetRows.length === runCount, `${label}: MinIO target must contain ${runCount} rows`);
  assert(new Set(targetRows.map((row) => row.event_id)).size === runCount, `${label}: MinIO target must not contain duplicate event IDs`);

  const metadata = JSON.parse(await readS3Text(result.metadataLocation));
  assert(JSON.stringify(metadata.timing) === JSON.stringify(timing), `${label}: MinIO metadata timing must match the API response`);
  assert(
    (metadata.timingDetail?.readerPreparation?.adminSetOffsetsMs ?? metadata.timingDetail?.readerPreparation?.consumerAssignMs)
      === (result.timingDetail?.readerPreparation?.adminSetOffsetsMs ?? result.timingDetail?.readerPreparation?.consumerAssignMs),
    `${label}: MinIO reader offset-position timing must match the API response`,
  );
  assert(
    (metadata.timingDetail?.commit?.adminSetOffsetsMs ?? metadata.timingDetail?.commit?.consumerCommitMs)
      === (result.timingDetail?.commit?.adminSetOffsetsMs ?? result.timingDetail?.commit?.consumerCommitMs),
    `${label}: MinIO offset-commit timing must match the API response`,
  );
  const catalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  const catalog = catalogPayload.dataset || catalogPayload;
  assert(String(catalog.rows) === String(runCount), `${label}: Catalog rows must be ${runCount}`);
  assert(catalog.storageLocation === result.storageLocation, `${label}: Catalog must point to this MinIO object`);

  return {
    label,
    warmup,
    count: runCount,
    topic,
    consumerGroupId,
    datasetId,
    snapshotId: result.snapshot.snapshotId,
    storageLocation: result.storageLocation,
    metadataLocation: result.metadataLocation,
    storedCount: result.storedCount,
    dataBytes: Buffer.byteLength(targetBody, "utf8"),
    timing,
    durationsMs,
    diagnosticDurationsMs,
    timingDetail: result.timingDetail,
  };
}

function buildRecords(topic, producedAt, runCount) {
  return Array.from({ length: runCount }, (_, index) => {
    const sequence = index + 1;
    return {
      schema_version: "1.0",
      event_id: `stage-latency-${suffix}-${topic.split(".").at(-1)}-${String(sequence).padStart(6, "0")}`,
      source: "asklake-kafka-stage-latency-experiment",
      offset: sequence,
      review: `  STAGE LATENCY REVIEW ${String(sequence).padStart(3, "0")}  `,
      created_at: new Date(Date.parse(producedAt) + index).toISOString(),
      raw: { experiment: "kafka-stage-latency", produced_at: producedAt, sequence },
    };
  });
}

function diagnosticDurations(result, producerAckAt, label) {
  const detail = result.timingDetail;
  const capture = detail?.capture;
  const reader = detail?.readerPreparation;
  const consume = detail?.consume;
  const commit = detail?.commit;
  assert(capture && reader && consume && commit, `${label}: detailed timing sections are missing`);
  const difference = (from, to, key) => {
    const start = Date.parse(from || "");
    const end = Date.parse(to || "");
    assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, `${label}: invalid diagnostic timestamps for ${key}`);
    return end - start;
  };
  const numeric = (value, key) => {
    assert(Number.isFinite(Number(value)) && Number(value) >= 0, `${label}: ${key} must be a non-negative duration`);
    return Number(value);
  };
  return {
    producerToFastapiReceivedMs: difference(producerAckAt, capture.fastapiReceivedAt, "producerToFastapiReceivedMs"),
    fastapiToCaptureBridgeStartMs: difference(capture.fastapiReceivedAt, capture.captureBridgeStartedAt, "fastapiToCaptureBridgeStartMs"),
    captureBridgeToRuntimeStartMs: difference(capture.captureBridgeStartedAt, capture.runtimeStartedAt || capture.nodeStartedAt, "captureBridgeToRuntimeStartMs"),
    captureAdminConnectMs: numeric(capture.adminConnectMs ?? 0, "captureAdminConnectMs"),
    captureFetchTopicOffsetsMs: numeric(capture.fetchTopicOffsetsMs, "captureFetchTopicOffsetsMs"),
    captureFetchGroupOffsetsMs: numeric(capture.fetchGroupOffsetsMs, "captureFetchGroupOffsetsMs"),
    captureSnapshotComputeMs: numeric(capture.snapshotComputeMs, "captureSnapshotComputeMs"),
    readerAdminConnectMs: numeric(reader.adminConnectMs ?? 0, "readerAdminConnectMs"),
    readerOffsetPositionMs: numeric(reader.adminSetOffsetsMs ?? reader.consumerAssignMs, "readerOffsetPositionMs"),
    readerAdminDisconnectMs: numeric(reader.adminDisconnectMs ?? 0, "readerAdminDisconnectMs"),
    consumerConnectMs: numeric(consume.consumerConnectMs ?? 0, "consumerConnectMs"),
    consumerSubscribeMs: numeric(consume.consumerSubscribeMs ?? 0, "consumerSubscribeMs"),
    consumerGroupJoinMs: numeric(consume.groupJoinLastPayload?.duration || 0, "consumerGroupJoinMs"),
    consumerFetchMs: numeric(consume.fetchLastPayload?.duration || 0, "consumerFetchMs"),
    firstToLastMessageMs: difference(consume.firstMessageReadAt, consume.lastMessageReadAt, "firstToLastMessageMs"),
    consumeSnapshotMs: numeric(consume.consumeSnapshotMs, "consumeSnapshotMs"),
    commitAdminConnectMs: numeric(commit.adminConnectMs ?? 0, "commitAdminConnectMs"),
    commitOffsetMs: numeric(commit.adminSetOffsetsMs ?? commit.consumerCommitMs, "commitOffsetMs"),
    commitAdminDisconnectMs: numeric(commit.adminDisconnectMs ?? 0, "commitAdminDisconnectMs"),
  };
}

function timingDurations(timing, label) {
  const keys = ["producerAckAt", "snapshotCapturedAt", "consumeEndedAt", "transformEndedAt", "minioWriteEndedAt", "catalogPublishedAt", "offsetCommittedAt"];
  const values = keys.map((key) => {
    const value = timing[key];
    const milliseconds = Date.parse(value || "");
    assert(Number.isFinite(milliseconds), `${label}: ${key} must be an ISO timestamp`);
    return milliseconds;
  });
  for (let index = 1; index < values.length; index += 1) {
    assert(values[index] >= values[index - 1], `${label}: timing order is invalid at ${keys[index]}`);
  }
  const duration = (from, to) => values[keys.indexOf(to)] - values[keys.indexOf(from)];
  return {
    producerToSnapshotCaptureMs: duration("producerAckAt", "snapshotCapturedAt"),
    snapshotToConsumeEndMs: duration("snapshotCapturedAt", "consumeEndedAt"),
    consumeToTransformEndMs: duration("consumeEndedAt", "transformEndedAt"),
    transformToMinioWriteEndMs: duration("transformEndedAt", "minioWriteEndedAt"),
    minioToCatalogPublishedMs: duration("minioWriteEndedAt", "catalogPublishedAt"),
    catalogToOffsetCommitMs: duration("catalogPublishedAt", "offsetCommittedAt"),
    producerToCatalogPublishedMs: duration("producerAckAt", "catalogPublishedAt"),
    producerToOffsetCommitMs: duration("producerAckAt", "offsetCommittedAt"),
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: Math.round((sorted.reduce((sum, value) => sum + value, 0) / sorted.length) * 100) / 100,
  };
}

function summarizeRuns(runs) {
  const fields = [...Object.keys(runs[0].durationsMs), ...Object.keys(runs[0].diagnosticDurationsMs)];
  return Object.fromEntries(fields.map((key) => [
    key,
    summarize(runs.map((run) => run.durationsMs[key] ?? run.diagnosticDurationsMs[key])),
  ]));
}

async function createFreshTopic(topic) {
  const topics = await admin.listTopics();
  if (topics.includes(topic)) throw new Error(`topic already exists; use a new ASKLAKE_KAFKA_EXPERIMENT_SUFFIX: ${topic}`);
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
}

async function readS3Text(location) {
  const { bucket, key } = parseS3Location(location);
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return response.Body.transformToString();
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
  return requestJson(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`);
  return number;
}

function countList(value) {
  const values = String(value).split(",").map((item) => positiveInteger(item.trim(), "ASKLAKE_KAFKA_LATENCY_COUNTS"));
  return [...new Set(values)];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
