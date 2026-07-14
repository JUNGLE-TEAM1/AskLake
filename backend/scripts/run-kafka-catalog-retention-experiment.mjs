import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Kafka, Partitioners } from "kafkajs";

process.env.KAFKAJS_NO_PARTITIONER_WARNING = process.env.KAFKAJS_NO_PARTITIONER_WARNING || "1";

const suffix = process.env.ASKLAKE_KAFKA_EXPERIMENT_SUFFIX || Date.now().toString(36);
const broker = process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
const baseUrl = process.env.ASKLAKE_API_BASE_URL || "http://127.0.0.1:8080";
const minioEndpoint = process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000";
const targetBucket = process.env.ASKLAKE_KAFKA_EXPERIMENT_BUCKET || "asklake-output";
const batchCount = 60;
const rowsPerBatch = 10;
const totalRows = batchCount * rowsPerBatch;
const topic = `reviews.raw.catalog-retention.${suffix}`;
const consumerGroupId = `asklake-catalog-retention-${suffix}`;
const datasetId = `ds_reviews_catalog_retention_${suffix}`;
const datasetName = `reviews_catalog_retention_${suffix}`;
const targetPrefix = `experiments/kafka-catalog-retention/${suffix}/silver`;
const kafka = new Kafka({ brokers: [broker], clientId: `asklake-catalog-retention-${suffix}`, retry: { retries: 2 } });
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

try {
  await assertHealthyBackend();
  await admin.connect();
  await producer.connect();
  await createFreshTopic();
  await produceRows();

  let expectedSizeBytes = 0;
  const storageLocations = [];
  const checkpoints = [];
  for (let runNumber = 1; runNumber < batchCount; runNumber += 1) {
    const result = await postJson("/api/etl/kafka/reviews/ingest", ingestRequest());
    assert(result.storedCount === rowsPerBatch, `run ${runNumber}: expected ${rowsPerBatch} stored rows`);
    const objectSize = await s3ObjectSize(result.storageLocation);
    expectedSizeBytes += objectSize;
    storageLocations.push(result.storageLocation);
    const catalog = await getCatalog();
    assertCatalogAggregate(catalog, runNumber * rowsPerBatch, expectedSizeBytes, runNumber);
    assert(catalog.materializationRuns.length === Math.min(runNumber, 50), `run ${runNumber}: retained history count mismatch`);
    if ([1, 49, 50, 51, 59].includes(runNumber)) checkpoints.push(checkpoint(runNumber, catalog));
  }

  const failed = await requestJson("/api/etl/kafka/reviews/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ingestRequest(), testFailAfterCatalogPublish: true }),
  }, false);
  assert(failed.status === 502, `run 60 post-Catalog hook must fail with 502, received ${failed.status}`);
  const failedSnapshot = failed.payload?.error?.details?.bridge?.snapshot;
  assert(failedSnapshot?.snapshotId, "run 60 failure must expose the durable snapshot");
  assert(Number(failedSnapshot.partitions?.[0]?.startOffset) === 590 && Number(failedSnapshot.partitions?.[0]?.endOffset) === 600, "run 60 snapshot must cover offsets 590..600");
  const failedLocation = snapshotLocation(failedSnapshot.snapshotId);
  expectedSizeBytes += await s3ObjectSize(failedLocation);
  storageLocations.push(failedLocation);
  const catalogAfterPublishFailure = await getCatalog();
  assertCatalogAggregate(catalogAfterPublishFailure, totalRows, expectedSizeBytes, "post-Catalog failure");
  assert(await committedOffset() === 590, "post-Catalog failure must leave Kafka committed offset at 590");

  const retried = await postJson("/api/etl/kafka/reviews/ingest", ingestRequest());
  assert(retried.snapshot.snapshotId === failedSnapshot.snapshotId, "retry must reuse the same durable snapshot");
  assert(retried.storedCount === rowsPerBatch, "retry must re-read the final 10 rows");
  assert(retried.storageLocation === failedLocation, "retry must overwrite the same target object");
  const catalogAfterRetry = await getCatalog();
  assertCatalogAggregate(catalogAfterRetry, totalRows, expectedSizeBytes, "retry");
  assert(catalogAfterRetry.materializationRuns.length === 50, "retry must keep retained history capped at 50");
  assert(await committedOffset() === totalRows, "successful retry must commit offset 600");
  checkpoints.push(checkpoint(60, catalogAfterRetry));

  const empty = await postJson("/api/etl/kafka/reviews/ingest", { ...ingestRequest(), allowEmpty: true });
  assert(empty.storedCount === 0, "empty snapshot must store zero rows");
  await assertS3ObjectMissing(empty.storageLocation);
  const catalogAfterEmpty = await getCatalog();
  assertCatalogAggregate(catalogAfterEmpty, totalRows, expectedSizeBytes, "empty snapshot");
  assert(catalogAfterEmpty.storageLocation === failedLocation, "empty snapshot must retain the last non-empty location");
  assert(catalogAfterEmpty.materializationRuns[0]?.rowCount === 0, "empty snapshot must remain visible in retained history");

  const physical = await verifyPhysicalRows(storageLocations);
  assert(physical.rowCount === totalRows && physical.uniqueCount === totalRows, "MinIO snapshots must contain 600 unique rows");
  const logEndOffset = await topicEndOffset();
  const finalCommittedOffset = await committedOffset();
  assert(logEndOffset === totalRows && finalCommittedOffset === totalRows, "Kafka offsets must finish at 600");

  console.log(JSON.stringify({
    experiment: "kafka-catalog-retention-regression",
    status: "PASS",
    suffix,
    topic,
    consumerGroupId,
    datasetId,
    batches: batchCount,
    rowsPerBatch,
    producedRows: totalRows,
    minioRows: physical.rowCount,
    uniqueRows: physical.uniqueCount,
    catalogRows: Number(catalogAfterEmpty.rows),
    catalogStorageSizeBytes: Number(catalogAfterEmpty.storageSizeBytes),
    retainedMaterializationRuns: catalogAfterEmpty.materializationRuns.length,
    committedOffset: finalCommittedOffset,
    logEndOffset,
    finalLag: logEndOffset - finalCommittedOffset,
    retry: {
      snapshotId: failedSnapshot.snapshotId,
      catalogRowsAfterFailure: Number(catalogAfterPublishFailure.rows),
      committedOffsetAfterFailure: 590,
      catalogRowsAfterRetry: Number(catalogAfterRetry.rows),
    },
    emptySnapshot: {
      storedCount: empty.storedCount,
      catalogRows: Number(catalogAfterEmpty.rows),
      representativeLocationRetained: catalogAfterEmpty.storageLocation === failedLocation,
    },
    checkpoints,
  }, null, 2));
} catch (error) {
  console.error(`Kafka Catalog retention experiment FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await producer.disconnect().catch(() => undefined);
  await admin.disconnect().catch(() => undefined);
}

function ingestRequest() {
  return {
    broker,
    topic,
    consumerGroupId,
    datasetId,
    datasetName,
    maxMessages: rowsPerBatch,
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
    transformSteps: [],
    qualityRules: [],
  };
}

async function createFreshTopic() {
  const topics = await admin.listTopics();
  if (topics.includes(topic)) throw new Error(`topic already exists; use a new suffix: ${topic}`);
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true });
}

async function produceRows() {
  const baseTime = Date.now();
  const records = Array.from({ length: totalRows }, (_, index) => {
    const sequence = index + 1;
    return {
      schema_version: "1.0",
      event_id: `catalog-retention-${suffix}-${String(sequence).padStart(6, "0")}`,
      source: "asklake-kafka-catalog-retention-experiment",
      offset: sequence,
      review: `Catalog retention review ${sequence}`,
      created_at: new Date(baseTime + index).toISOString(),
      raw: { experiment: "kafka-catalog-retention-regression", sequence },
    };
  });
  await producer.send({ topic, messages: records.map((record) => ({ key: record.event_id, value: JSON.stringify(record) })) });
}

async function getCatalog() {
  const payload = await getJson(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
  return payload.dataset || payload;
}

function assertCatalogAggregate(catalog, expectedRows, expectedSizeBytes, label) {
  assert(Number(catalog.rows) === expectedRows, `${label}: Catalog rows ${catalog.rows} must equal ${expectedRows}`);
  assert(Number(catalog.storageSizeBytes) === expectedSizeBytes, `${label}: Catalog size ${catalog.storageSizeBytes} must equal ${expectedSizeBytes}`);
}

function checkpoint(runNumber, catalog) {
  return {
    runNumber,
    rows: Number(catalog.rows),
    storageSizeBytes: Number(catalog.storageSizeBytes),
    retainedMaterializationRuns: catalog.materializationRuns.length,
  };
}

function snapshotLocation(snapshotId) {
  return `s3://${targetBucket}/${targetPrefix}/snapshots/${snapshotId}/data.jsonl`;
}

async function s3ObjectSize(location) {
  const [bucket, key] = parseS3Location(location);
  const response = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  return Number(response.ContentLength || 0);
}

async function assertS3ObjectMissing(location) {
  try {
    await s3ObjectSize(location);
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return;
    throw error;
  }
  throw new Error(`empty snapshot must not create a data object: ${location}`);
}

async function verifyPhysicalRows(locations) {
  const eventIds = new Set();
  let rowCount = 0;
  for (const location of locations) {
    const [bucket, key] = parseS3Location(location);
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await response.Body.transformToString();
    for (const line of body.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      rowCount += 1;
      eventIds.add(row.event_id);
    }
  }
  return { rowCount, uniqueCount: eventIds.size };
}

function parseS3Location(location) {
  const match = String(location).match(/^s3:\/\/([^/]+)\/(.+)$/);
  assert(match, `invalid S3 location: ${location}`);
  return [match[1], match[2]];
}

async function committedOffset() {
  const offsets = await admin.fetchOffsets({ groupId: consumerGroupId, topics: [topic] });
  return Number(offsets[0]?.partitions?.find((partition) => partition.partition === 0)?.offset || -1);
}

async function topicEndOffset() {
  const offsets = await admin.fetchTopicOffsets(topic);
  return Number(offsets.find((partition) => partition.partition === 0)?.high || -1);
}

async function assertHealthyBackend() {
  const health = await getJson("/api/health");
  assert(health.ok === true, `backend health must be ok: ${JSON.stringify(health)}`);
}

async function getJson(pathname) {
  const response = await requestJson(pathname, { method: "GET" });
  return response.payload;
}

async function postJson(pathname, body) {
  const response = await requestJson(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.payload;
}

async function requestJson(pathname, options, requireOk = true) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${options.method} ${pathname} returned non-JSON ${response.status}: ${text}`);
  }
  if (requireOk && !response.ok) throw new Error(`${options.method} ${pathname} failed ${response.status}: ${JSON.stringify(payload)}`);
  return { status: response.status, payload };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
