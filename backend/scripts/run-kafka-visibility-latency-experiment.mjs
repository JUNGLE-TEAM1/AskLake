import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

const durationSeconds = positiveInteger(process.env.ASKLAKE_KAFKA_VISIBILITY_DURATION_SECONDS || "600", "ASKLAKE_KAFKA_VISIBILITY_DURATION_SECONDS");
const produceIntervalMs = positiveInteger(process.env.ASKLAKE_KAFKA_VISIBILITY_PRODUCE_INTERVAL_MS || "1000", "ASKLAKE_KAFKA_VISIBILITY_PRODUCE_INTERVAL_MS");
const intervalsSeconds = parseIntervals(process.env.ASKLAKE_KAFKA_VISIBILITY_INTERVALS_SECONDS || "5,30");
const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const totalMessages = Math.floor((durationSeconds * 1000) / produceIntervalMs);
const kafka = new Kafka({ brokers: [broker], clientId: `asklake-visibility-${suffix}`, retry: { retries: 2 } });
const admin = kafka.admin();
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
const s3 = new S3Client({
  endpoint: minioEndpoint,
  forcePathStyle: true,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || "m3admin",
    secretAccessKey: process.env.MINIO_SECRET_KEY || "wishuponastar",
  },
});

const conditions = intervalsSeconds.map(createCondition);
let progressTimer;

try {
  await assertHealthyBackend();
  await admin.connect();
  await producer.connect();
  for (const condition of conditions) await createFreshTopic(condition.topic);

  const experimentStartedAt = Date.now();
  console.error(`[visibility] started suffix=${suffix}, duration=${durationSeconds}s, messages=${totalMessages}, intervals=${intervalsSeconds.join("/")}s`);
  progressTimer = setInterval(() => {
    const elapsed = Math.min(durationSeconds, Math.floor((Date.now() - experimentStartedAt) / 1000));
    console.error(`[visibility] ${elapsed}/${durationSeconds}s produced=${conditions[0].producedCount} ingested=${conditions.map((item) => `${item.intervalSeconds}s:${item.storedCount}`).join(",")}`);
  }, 30000);

  await Promise.all([
    produceLoop(experimentStartedAt),
    scheduleLoop(experimentStartedAt),
  ]);

  clearInterval(progressTimer);
  progressTimer = undefined;
  const summaries = [];
  for (const condition of conditions) summaries.push(await finalizeCondition(condition));
  const status = summaries.every((summary) => summary.correctness.pass) ? "PASS" : "FAIL";
  const report = {
    experiment: "kafka-micro-batch-visibility-latency",
    status,
    implementationCommit: process.env.ASKLAKE_IMPLEMENTATION_COMMIT || null,
    suffix,
    durationSeconds,
    produceIntervalMs,
    messagesPerCondition: totalMessages,
    timingDefinition: "For each Kafka message: API result timing.catalogPublishedAt minus the producer acknowledgement observed by this runner.",
    passMeaning: "Every produced message is stored exactly once, Kafka lag is zero, and Catalog cumulative rows match the produced count. Latency values describe local micro-batch visibility, not an SLO.",
    conditions: summaries,
  };
  console.log(JSON.stringify(report, null, 2));
  if (status !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(`Kafka visibility latency experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (progressTimer) clearInterval(progressTimer);
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

function createCondition(intervalSeconds) {
  const label = `interval-${intervalSeconds}s`;
  return {
    intervalSeconds,
    label,
    topic: `reviews.raw.visibility.${suffix}.${label}`,
    consumerGroupId: `asklake-visibility-${suffix}-${label}`,
    datasetId: `ds_reviews_visibility_${suffix}_${label}`,
    datasetName: `reviews_visibility_${suffix}_${label}`,
    targetPrefix: `experiments/kafka-visibility/${suffix}/${label}/silver`,
    ackAtBySequence: new Float64Array(totalMessages + 1),
    seen: new Uint8Array(totalMessages + 1),
    producedCount: 0,
    storedCount: 0,
    duplicateCount: 0,
    unexpectedIdCount: 0,
    transformMismatchCount: 0,
    visibilityMs: [],
    runs: [],
  };
}

async function produceLoop(startedAt) {
  for (let sequence = 1; sequence <= totalMessages; sequence += 1) {
    await sleepUntil(startedAt + ((sequence - 1) * produceIntervalMs));
    const createdAt = new Date().toISOString();
    await producer.sendBatch({
      topicMessages: conditions.map((condition) => {
        const record = buildRecord(condition, sequence, createdAt);
        return { topic: condition.topic, messages: [{ key: record.event_id, value: JSON.stringify(record) }] };
      }),
    });
    const acknowledgedAt = Date.now();
    for (const condition of conditions) {
      condition.ackAtBySequence[sequence] = acknowledgedAt;
      condition.producedCount = sequence;
    }
  }
}

async function scheduleLoop(startedAt) {
  const finalAt = startedAt + (durationSeconds * 1000);
  const nextDueAt = new Map(conditions.map((condition) => [condition.intervalSeconds, startedAt + (condition.intervalSeconds * 1000)]));
  const lastTriggeredAt = new Map(conditions.map((condition) => [condition.intervalSeconds, startedAt]));
  while (true) {
    const nearest = Math.min(...nextDueAt.values());
    if (nearest > finalAt) break;
    await sleepUntil(nearest);
    const due = conditions.filter((condition) => nextDueAt.get(condition.intervalSeconds) === nearest);
    await Promise.all(due.map((condition) => ingestCondition(condition)));
    for (const condition of due) {
      lastTriggeredAt.set(condition.intervalSeconds, nearest);
      nextDueAt.set(condition.intervalSeconds, nearest + (condition.intervalSeconds * 1000));
    }
  }
  await sleepUntil(finalAt);
  const finalFlush = conditions.filter((condition) => lastTriggeredAt.get(condition.intervalSeconds) < finalAt);
  await Promise.all(finalFlush.map((condition) => ingestCondition(condition)));
}

async function ingestCondition(condition) {
  const latestAck = condition.ackAtBySequence[condition.producedCount] || Date.now();
  const result = await postJson("/api/etl/kafka/reviews/ingest", {
    broker,
    topic: condition.topic,
    consumerGroupId: condition.consumerGroupId,
    datasetId: condition.datasetId,
    datasetName: condition.datasetName,
    maxMessages: Math.max(100, totalMessages),
    timeoutMs: 10000,
    offsetPolicy: "earliest",
    allowEmpty: true,
    registerCatalog: true,
    storageMode: "s3",
    landingEndpoint: minioEndpoint,
    targetBucket,
    targetPrefix: condition.targetPrefix,
    targetLayer: "SILVER",
    targetFormat: "jsonl",
    producerAckAt: new Date(latestAck).toISOString(),
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
  assert(result.status === "success", `${condition.label}: ingest must succeed`);
  assert(result.failedCount === 0, `${condition.label}: ingest must have zero failed rows`);

  const catalogPublishedAt = Date.parse(result.timing?.catalogPublishedAt || "");
  assert(Number.isFinite(catalogPublishedAt), `${condition.label}: catalogPublishedAt is missing`);
  const range = result.snapshot?.partitions?.find((partition) => Number(partition.partition) === 0);
  assert(range, `${condition.label}: partition 0 snapshot range is missing`);
  const startSequence = Number(range.startOffset) + 1;
  const endSequence = Number(range.endOffset);
  const expectedCount = Math.max(0, endSequence - startSequence + 1);
  assert(result.storedCount === expectedCount, `${condition.label}: snapshot range and stored count differ`);

  if (result.storedCount > 0) {
    const rows = await readS3Rows(result.storageLocation);
    assert(rows.length === result.storedCount, `${condition.label}: MinIO row count differs from stored count`);
    for (const row of rows) {
      const sequence = sequenceFromEventId(row.event_id, condition);
      if (sequence < 1 || sequence > totalMessages) {
        condition.unexpectedIdCount += 1;
        continue;
      }
      if (condition.seen[sequence]) condition.duplicateCount += 1;
      else condition.seen[sequence] = 1;
      if (typeof row.review !== "string" || row.normalized_review !== row.review.trim().toLowerCase()) {
        condition.transformMismatchCount += 1;
      }
      const acknowledgedAt = condition.ackAtBySequence[sequence];
      assert(acknowledgedAt > 0, `${condition.label}: producer acknowledgement is missing for sequence ${sequence}`);
      condition.visibilityMs.push(catalogPublishedAt - acknowledgedAt);
    }
  }

  condition.storedCount += result.storedCount;
  condition.runs.push({
    run: condition.runs.length + 1,
    snapshotId: result.snapshot.snapshotId,
    startOffset: Number(range.startOffset),
    endOffset: Number(range.endOffset),
    storedCount: result.storedCount,
    catalogRowsReported: Number(result.catalogDataset?.rows || 0),
    catalogPublishedAt: result.timing.catalogPublishedAt,
    offsetCommittedAt: result.timing.offsetCommittedAt,
  });
}

async function finalizeCondition(condition) {
  const offsets = await admin.fetchOffsets({ groupId: condition.consumerGroupId, topics: [condition.topic] });
  const committedOffset = Number(offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset || -1);
  const topicOffsets = await admin.fetchTopicOffsets(condition.topic);
  const logEndOffset = Number(topicOffsets.find((partition) => partition.partition === 0)?.high || -1);
  const catalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(condition.datasetId)}`);
  const catalog = catalogPayload.dataset || catalogPayload;
  const catalogRows = Number(catalog.rows || 0);
  const uniqueCount = condition.seen.reduce((sum, value) => sum + value, 0);
  const missingCount = totalMessages - uniqueCount;
  const correctness = {
    pass: condition.producedCount === totalMessages
      && condition.storedCount === totalMessages
      && condition.visibilityMs.length === totalMessages
      && missingCount === 0
      && condition.duplicateCount === 0
      && condition.unexpectedIdCount === 0
      && condition.transformMismatchCount === 0
      && committedOffset === logEndOffset
      && logEndOffset === totalMessages
      && catalogRows === totalMessages,
    producedCount: condition.producedCount,
    storedCount: condition.storedCount,
    visibilitySampleCount: condition.visibilityMs.length,
    uniqueCount,
    missingCount,
    duplicateCount: condition.duplicateCount,
    unexpectedIdCount: condition.unexpectedIdCount,
    transformMismatchCount: condition.transformMismatchCount,
    committedOffset,
    logEndOffset,
    finalLag: logEndOffset - committedOffset,
    catalogRows,
    catalogRowsMatch: catalogRows === totalMessages,
  };
  return {
    intervalSeconds: condition.intervalSeconds,
    topic: condition.topic,
    consumerGroupId: condition.consumerGroupId,
    datasetId: condition.datasetId,
    batchRunCount: condition.runs.length,
    visibilityLatencyMs: summarize(condition.visibilityMs),
    visibilityLatencySeconds: summarize(condition.visibilityMs.map((value) => value / 1000)),
    latencyHistogramBySecond: histogram(condition.visibilityMs),
    firstRuns: condition.runs.slice(0, 3),
    lastRuns: condition.runs.slice(-3),
    correctness,
  };
}

function buildRecord(condition, sequence, createdAt) {
  return {
    schema_version: "1.0",
    event_id: `visibility-${suffix}-${condition.label}-${String(sequence).padStart(6, "0")}`,
    source: "asklake-kafka-visibility-experiment",
    offset: sequence,
    review: `  VISIBILITY REVIEW ${String(sequence).padStart(6, "0")}  `,
    created_at: createdAt,
    raw: { experiment: "kafka-micro-batch-visibility-latency", interval_seconds: condition.intervalSeconds, sequence },
  };
}

function sequenceFromEventId(eventId, condition) {
  const prefix = `visibility-${suffix}-${condition.label}-`;
  const value = String(eventId || "");
  const sequence = value.startsWith(prefix) ? Number(value.slice(prefix.length)) : 0;
  return Number.isInteger(sequence) ? sequence : 0;
}

async function readS3Rows(location) {
  const match = String(location).match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`invalid S3 location: ${location}`);
  const response = await s3.send(new GetObjectCommand({ Bucket: match[1], Key: match[2] }));
  const body = await response.Body.transformToString();
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function createFreshTopic(topic) {
  const topics = await admin.listTopics();
  if (topics.includes(topic)) throw new Error(`topic already exists; use a new suffix: ${topic}`);
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
}

function summarize(values) {
  assert(values.length > 0, "latency samples must not be empty");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    min: round(sorted[0]),
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function histogram(values) {
  const buckets = new Map();
  for (const value of values) {
    const second = Math.max(0, Math.floor(value / 1000));
    buckets.set(`${second}-${second + 1}s`, (buckets.get(`${second}-${second + 1}s`) || 0) + 1);
  }
  return Object.fromEntries([...buckets.entries()].sort((left, right) => Number(left[0].split("-")[0]) - Number(right[0].split("-")[0])));
}

function parseIntervals(value) {
  const intervals = String(value).split(",").map((item) => positiveInteger(item.trim(), "visibility interval"));
  assert(new Set(intervals).size === intervals.length, "visibility intervals must be unique");
  return intervals.sort((left, right) => left - right);
}

async function sleepUntil(epochMs) {
  const remaining = epochMs - Date.now();
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
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

function round(value) {
  return Math.round(value * 100) / 100;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
