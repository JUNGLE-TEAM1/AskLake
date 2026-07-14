import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

const profile = parseProfile(process.env.ASKLAKE_KAFKA_THROUGHPUT_PROFILE || "100:3,1000:3,10000:2");
const warmupCount = positiveInteger(process.env.ASKLAKE_KAFKA_THROUGHPUT_WARMUP_COUNT || "100", "ASKLAKE_KAFKA_THROUGHPUT_WARMUP_COUNT");
const producerBatchSize = positiveInteger(process.env.ASKLAKE_KAFKA_THROUGHPUT_PRODUCER_BATCH_SIZE || "1000", "ASKLAKE_KAFKA_THROUGHPUT_PRODUCER_BATCH_SIZE");
const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const kafka = new Kafka({ brokers: [broker], clientId: `asklake-throughput-${suffix}`, retry: { retries: 2 } });
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
const runs = [];

try {
  await assertHealthyBackend();
  await admin.connect();
  await producer.connect();
  runs.push(await executeRun(warmupCount, "warmup", true));
  for (const { count, repetitions } of profile) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      runs.push(await executeRun(count, `count-${count}-run-${repetition}`, false));
    }
  }
  const measured = runs.filter((run) => !run.warmup);
  const summaryByCount = Object.fromEntries(profile.map(({ count }) => [
    String(count),
    summarizeRuns(measured.filter((run) => run.count === count)),
  ]));
  console.log(JSON.stringify({
    experiment: "kafka-python-throughput",
    status: "PASS",
    implementationCommit: process.env.ASKLAKE_IMPLEMENTATION_COMMIT || null,
    suffix,
    warmupCount,
    producerBatchSize,
    profile,
    passMeaning: "All measured runs have zero missing IDs, zero duplicate IDs, zero transform mismatches, committed end offset, and final lag zero. Performance values are a baseline, not an SLO.",
    runs,
    summaryByCount,
  }, null, 2));
} catch (error) {
  console.error(`Kafka throughput experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

async function executeRun(count, label, warmup) {
  const runnerMemory = createRunnerMemoryTracker();
  const topic = `reviews.raw.throughput.${suffix}.${label}`;
  const consumerGroupId = `asklake-throughput-${suffix}-${label}`;
  const datasetId = `ds_reviews_throughput_${suffix}_${label}`;
  const datasetName = `reviews_throughput_${suffix}_${label}`;
  const targetPrefix = `experiments/kafka-throughput/${suffix}/${label}/silver`;
  await createFreshTopic(topic);
  const baseTime = Date.now();
  const produceStartedAt = performance.now();
  for (let start = 1; start <= count; start += producerBatchSize) {
    const end = Math.min(count, start + producerBatchSize - 1);
    await producer.send({
      topic,
      messages: Array.from({ length: end - start + 1 }, (_, index) => buildRecord(start + index, label, baseTime))
        .map((record) => ({ key: record.event_id, value: JSON.stringify(record) })),
    });
    runnerMemory.capture();
  }
  const produceMs = roundMs(performance.now() - produceStartedAt);
  const producerAckAt = new Date().toISOString();
  const requestStartedAt = performance.now();
  const result = await postJson("/api/etl/kafka/reviews/ingest", {
    broker,
    topic,
    consumerGroupId,
    datasetId,
    datasetName,
    maxMessages: count,
    timeoutMs: Math.max(10000, Math.ceil(count / 10)),
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
  const requestMs = roundMs(performance.now() - requestStartedAt);
  assert(result.engine === "python-confluent-kafka", `${label}: Python engine must handle the request`);
  assert(result.consumedCount === count && result.storedCount === count && result.failedCount === 0, `${label}: expected ${count} clean rows`);
  const verification = await verifyS3JsonlStream(result.storageLocation, { count, label, runnerMemory });
  assert(verification.rowCount === count, `${label}: MinIO must contain ${count} rows`);
  assert(
    verification.missingCount === 0
      && verification.duplicateCount === 0
      && verification.unexpectedIdCount === 0
      && verification.offsetMismatchCount === 0
      && verification.transformMismatchCount === 0,
    `${label}: correctness mismatch`,
  );
  const committed = await committedOffset(consumerGroupId, topic);
  assert(committed === String(count), `${label}: committed offset must be ${count}, received ${committed}`);
  const topicOffsets = await admin.fetchTopicOffsets(topic);
  const logEndOffset = topicOffsets.find((partition) => partition.partition === 0)?.high || "-1";
  const finalLag = Number(logEndOffset) - Number(committed);
  assert(finalLag === 0, `${label}: final lag must be 0, received ${finalLag}`);
  const catalogPayload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  const catalog = catalogPayload.dataset || catalogPayload;
  assert(String(catalog.rows) === String(count), `${label}: Catalog rows must be ${count}`);
  assert(catalog.storageLocation === result.storageLocation, `${label}: Catalog location must match MinIO`);

  const timing = result.timing;
  const stageMs = {
    producerToSnapshot: duration(timing.producerAckAt, timing.snapshotCapturedAt),
    snapshotToConsume: duration(timing.snapshotCapturedAt, timing.consumeEndedAt),
    transform: duration(timing.consumeEndedAt, timing.transformEndedAt),
    minioWrite: duration(timing.transformEndedAt, timing.minioWriteEndedAt),
    catalogPublish: duration(timing.minioWriteEndedAt, timing.catalogPublishedAt),
    offsetCommit: duration(timing.catalogPublishedAt, timing.offsetCommittedAt),
    ingestPipeline: duration(timing.snapshotCapturedAt, timing.offsetCommittedAt),
    endToEnd: duration(timing.producerAckAt, timing.offsetCommittedAt),
  };
  const dataBytes = verification.dataBytes;
  const pipelineSeconds = Math.max(stageMs.ingestPipeline / 1000, 0.001);
  runnerMemory.capture();
  return {
    label,
    warmup,
    count,
    topic,
    consumerGroupId,
    datasetId,
    snapshotId: result.snapshot.snapshotId,
    storageLocation: result.storageLocation,
    dataBytes,
    produceMs,
    requestMs,
    rowsPerSecond: roundMetric(count / pipelineSeconds),
    megabytesPerSecond: roundMetric((dataBytes / 1024 / 1024) / pipelineSeconds),
    processCpuMs: Number(result.timingDetail?.resource?.processCpuMs || 0),
    processMaxRssBytes: Number(result.timingDetail?.resource?.processMaxRssBytes || 0),
    runnerObservedPeakRssBytes: runnerMemory.peakRssBytes,
    runnerObservedPeakHeapUsedBytes: runnerMemory.peakHeapUsedBytes,
    missingCount: verification.missingCount,
    duplicateCount: verification.duplicateCount,
    unexpectedIdCount: verification.unexpectedIdCount,
    offsetMismatchCount: verification.offsetMismatchCount,
    transformMismatchCount: verification.transformMismatchCount,
    committedOffset: committed,
    logEndOffset,
    finalLag,
    stageMs,
  };
}

function buildRecord(sequence, label, baseTime) {
  return {
    schema_version: "1.0",
    event_id: `throughput-${suffix}-${label}-${String(sequence).padStart(8, "0")}`,
    source: "asklake-kafka-throughput-experiment",
    offset: sequence,
    review: `  THROUGHPUT REVIEW ${String(sequence).padStart(6, "0")}  `,
    created_at: new Date(baseTime + sequence - 1).toISOString(),
    raw: { experiment: "kafka-python-throughput", sequence, label },
  };
}

async function createFreshTopic(topic) {
  const topics = await admin.listTopics();
  if (topics.includes(topic)) throw new Error(`topic already exists; use a new suffix: ${topic}`);
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
}

async function committedOffset(groupId, topic) {
  const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
  return offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset || "-1";
}

async function verifyS3JsonlStream(location, { count, label, runnerMemory }) {
  const match = String(location).match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`invalid S3 location: ${location}`);
  const response = await s3.send(new GetObjectCommand({ Bucket: match[1], Key: match[2] }));
  assert(response.Body && response.Body[Symbol.asyncIterator], `${label}: S3 response body must be streamable`);
  const decoder = new TextDecoder();
  const seen = new Uint8Array(count);
  const expectedPrefix = `throughput-${suffix}-${label}-`;
  let buffered = "";
  let dataBytes = 0;
  let rowCount = 0;
  let seenCount = 0;
  let duplicateCount = 0;
  let unexpectedIdCount = 0;
  let offsetMismatchCount = 0;
  let transformMismatchCount = 0;

  const verifyLine = (line) => {
    if (!line) return;
    rowCount += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label}: invalid JSONL at row ${rowCount}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const eventId = String(row.event_id || "");
    const sequenceText = eventId.startsWith(expectedPrefix) ? eventId.slice(expectedPrefix.length) : "";
    const sequence = /^\d+$/.test(sequenceText) ? Number(sequenceText) : 0;
    if (sequence < 1 || sequence > count) {
      unexpectedIdCount += 1;
    } else if (seen[sequence - 1]) {
      duplicateCount += 1;
    } else {
      seen[sequence - 1] = 1;
      seenCount += 1;
    }
    if (Number(row.offset) !== sequence) offsetMismatchCount += 1;
    if (typeof row.review !== "string" || row.normalized_review !== row.review.trim().toLowerCase()) {
      transformMismatchCount += 1;
    }
  };

  for await (const chunk of response.Body) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    dataBytes += bytes.byteLength;
    buffered += decoder.decode(bytes, { stream: true });
    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      verifyLine(buffered.slice(0, newlineIndex).replace(/\r$/, ""));
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf("\n");
    }
    runnerMemory.capture();
  }
  buffered += decoder.decode();
  verifyLine(buffered.replace(/\r$/, ""));
  return {
    dataBytes,
    rowCount,
    missingCount: count - seenCount,
    duplicateCount,
    unexpectedIdCount,
    offsetMismatchCount,
    transformMismatchCount,
  };
}

function summarizeRuns(matchingRuns) {
  const fields = ["rowsPerSecond", "megabytesPerSecond", "processCpuMs", "processMaxRssBytes", "runnerObservedPeakRssBytes", "runnerObservedPeakHeapUsedBytes", "produceMs", "requestMs"];
  const stageFields = Object.keys(matchingRuns[0].stageMs);
  return {
    metrics: Object.fromEntries(fields.map((field) => [field, summarize(matchingRuns.map((run) => run[field]))])),
    stageMs: Object.fromEntries(stageFields.map((field) => [field, summarize(matchingRuns.map((run) => run.stageMs[field]))])),
  };
}

function createRunnerMemoryTracker() {
  const tracker = {
    peakRssBytes: 0,
    peakHeapUsedBytes: 0,
    capture() {
      const usage = process.memoryUsage();
      tracker.peakRssBytes = Math.max(tracker.peakRssBytes, usage.rss);
      tracker.peakHeapUsedBytes = Math.max(tracker.peakHeapUsedBytes, usage.heapUsed);
    },
  };
  tracker.capture();
  return tracker;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    min: sorted[0],
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: roundMetric(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
}

function parseProfile(value) {
  return String(value).split(",").map((entry) => {
    const [count, repetitions] = entry.split(":");
    return {
      count: positiveInteger(count, "throughput count"),
      repetitions: positiveInteger(repetitions, "throughput repetitions"),
    };
  });
}

function duration(from, to) {
  const result = Date.parse(to) - Date.parse(from);
  assert(Number.isFinite(result) && result >= 0, `invalid timing range: ${from} -> ${to}`);
  return result;
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

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
