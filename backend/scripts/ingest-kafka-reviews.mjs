import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { closeMetadataStore, getDataset, saveDataset } from "../src/metadataStore.mjs";
import { formatBytes, inferSchemaColumns, normalizeColumnName, parseSourceSample, schemaFingerprint } from "../src/profile.mjs";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiPayload = readJsonPayload();
const broker = stringOption("broker", process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092");
const topic = stringOption("topic", process.env.ASKLAKE_REVIEW_KAFKA_TOPIC || "reviews.raw");
const maxMessages = positiveInt(apiPayload.maxMessages ?? process.env.ASKLAKE_REVIEW_INGEST_LIMIT, 100);
const timeoutMs = positiveInt(apiPayload.timeoutMs ?? process.env.ASKLAKE_REVIEW_INGEST_TIMEOUT_MS, 10000);
const runId = stringOption("runId", process.env.ASKLAKE_REVIEW_INGEST_RUN_ID || makeRunId());
const consumerGroupId = stringOption("consumerGroupId", process.env.ASKLAKE_REVIEW_CONSUMER_GROUP || `asklake-review-ingest-${runId}`);
const offsetPolicy = stringOption("offsetPolicy", process.env.ASKLAKE_REVIEW_OFFSET_POLICY || "earliest").toLowerCase();
const allowEmpty = booleanOption("allowEmpty", process.env.ASKLAKE_REVIEW_ALLOW_EMPTY || "false");
const registerCatalog = booleanOption("registerCatalog", process.env.ASKLAKE_REVIEW_REGISTER_CATALOG || "true");
const datasetName = stringOption("datasetName", process.env.ASKLAKE_REVIEW_DATASET_NAME || "reviews_raw");
const datasetId = stringOption("datasetId", process.env.ASKLAKE_REVIEW_DATASET_ID || `ds_${normalizeColumnName(datasetName)}`);
const landingMode = stringOption("storageMode", process.env.ASKLAKE_REVIEW_LANDING_MODE || "local").toLowerCase();
const landingRoot = path.resolve(stringOption("localLandingDir", process.env.ASKLAKE_REVIEW_LOCAL_LANDING_DIR || path.join(backendDir, "tmp", "kafka-landing")));
const s3Endpoint = stringOption("landingEndpoint", process.env.ASKLAKE_REVIEW_LANDING_ENDPOINT || process.env.MINIO_ENDPOINT || "http://127.0.0.1:19000");
const s3Bucket = stringOption("landingBucket", process.env.ASKLAKE_REVIEW_LANDING_BUCKET || process.env.MINIO_BUCKET || "m3-raw");
const s3Prefix = normalizePrefix(stringOption("landingPrefix", process.env.ASKLAKE_REVIEW_LANDING_PREFIX || "kafka-landing"));
const s3DataKey = `${s3Prefix}${safePathSegment(topic)}/${runId}/data.jsonl`;
const s3MetadataKey = `${s3Prefix}${safePathSegment(topic)}/${runId}/metadata.json`;
const targetDir = path.join(landingRoot, safePathSegment(topic), runId);
const dataPath = path.join(targetDir, "data.jsonl");
const metadataPath = path.join(targetDir, "metadata.json");
const startedAt = new Date().toISOString();
const requiredFields = ["event_id", "offset", "review", "created_at"];

try {
  const result = await ingestReviews();
  console.log(`ASKLAKE_KAFKA_REVIEW_INGEST_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_REVIEW_INGEST_ERROR=${JSON.stringify({
    code: "KAFKA_REVIEW_INGEST_FAILED",
    message: error?.message || String(error),
    status: 502,
  })}`);
  process.exitCode = 1;
} finally {
  await closeMetadataStore().catch(() => undefined);
}

async function ingestReviews() {
  const { Kafka } = await import("kafkajs");
  const kafka = new Kafka({
    brokers: [broker],
    clientId: "asklake-review-ingest",
    retry: { retries: 2 },
  });
  const consumer = kafka.consumer({ groupId: consumerGroupId });
  const records = [];
  const invalidRecords = [];

  await consumer.connect();
  try {
    await consumer.subscribe({ fromBeginning: offsetPolicy !== "latest", topic });
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
        void consumer.stop().catch(() => undefined);
      };
      const timer = setTimeout(finish, timeoutMs);
      consumer.run({
        eachMessage: async ({ message, partition, topic: messageTopic }) => {
          if (settled || records.length >= maxMessages) return;
          const value = message.value?.toString("utf8") ?? "";
          const parsed = parseReviewMessage(value, {
            key: message.key?.toString("utf8") ?? "",
            offset: message.offset,
            partition,
            topic: messageTopic,
          });
          if (parsed.valid) records.push(parsed.record);
          else invalidRecords.push(parsed.error);
          if (records.length >= maxMessages) {
            clearTimeout(timer);
            finish();
          }
        },
      }).catch((error) => {
        invalidRecords.push({ message: error?.message || String(error), reason: "consumer_run_failed" });
        clearTimeout(timer);
        finish();
      });
    });
  } finally {
    await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
  }

  if (records.length === 0 && !allowEmpty) {
    throw new Error(`No valid review messages consumed from ${topic} at ${broker}.`);
  }

  const jsonl = records.map((record) => JSON.stringify(record)).join("\n");
  const dataBody = records.length > 0 ? `${jsonl}\n` : "";
  const localLocation = writeLocalLanding(dataBody);

  const endedAt = new Date().toISOString();
  const parsedSample = parseSourceSample("reviews.raw.jsonl", jsonl, { maxRows: Math.min(records.length, 20) });
  const inferredSchemaColumns = inferSchemaColumns(parsedSample);
  const schemaColumns = standardReviewSchema();
  const metadata = {
    broker,
    consumedCount: records.length,
    consumerGroupId,
    dataPath,
    datasetId: registerCatalog ? datasetId : null,
    datasetName: registerCatalog ? datasetName : null,
    endedAt,
    failedCount: invalidRecords.length,
    invalidRecords: invalidRecords.slice(0, 10),
    maxMessages,
    metadataPath,
    offsetPolicy,
    runId,
    inferredSchema: inferredSchemaColumns.map((column) => [column.targetName, column.type]),
    sampleRows: records.slice(0, 10).map(reviewSampleRow),
    schema: schemaColumns.map((column) => [column.targetName, column.type]),
    schemaFingerprint: schemaFingerprint(schemaColumns),
    startedAt,
    status: "success",
    storageFormat: "jsonl",
    storageLocation: localLocation,
    storageSizeBytes: statSync(dataPath).size,
    storedCount: records.length,
    timeoutMs,
    topic,
  };
  if (landingMode === "s3") {
    const s3Location = await writeS3Landing(dataBody, metadata);
    metadata.storageLocation = s3Location.dataLocation;
    metadata.metadataLocation = s3Location.metadataLocation;
    metadata.storageMode = "s3";
  } else {
    metadata.metadataLocation = metadataPath;
    metadata.storageMode = "local";
  }
  if (registerCatalog) {
    const dataset = await registerCatalogDataset(metadata);
    metadata.catalogDataset = {
      id: dataset.id,
      materializationRuns: dataset.materializationRuns?.length ?? 0,
      name: dataset.name,
      rows: dataset.rows,
      storageLocation: dataset.storageLocation,
    };
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  if (landingMode === "s3") await writeS3Metadata(metadata);
  return metadata;
}

function writeLocalLanding(dataBody) {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(dataPath, dataBody, "utf8");
  return dataPath;
}

async function writeS3Landing(dataBody, metadata) {
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.ASKLAKE_REVIEW_LANDING_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || "m3admin",
      secretAccessKey: process.env.ASKLAKE_REVIEW_LANDING_SECRET_KEY || process.env.MINIO_SECRET_KEY || "wishuponastar",
    },
    endpoint: s3Endpoint,
    forcePathStyle: String(process.env.ASKLAKE_REVIEW_LANDING_FORCE_PATH_STYLE || "true").toLowerCase() !== "false",
    region: process.env.ASKLAKE_REVIEW_LANDING_REGION || process.env.MINIO_REGION || "us-east-1",
  });
  await ensureBucket(client, s3Bucket);
  await client.send(new PutObjectCommand({
    Body: Buffer.from(dataBody, "utf8"),
    Bucket: s3Bucket,
    ContentType: "application/x-ndjson",
    Key: s3DataKey,
  }));
  const dataLocation = `s3://${s3Bucket}/${s3DataKey}`;
  const metadataLocation = `s3://${s3Bucket}/${s3MetadataKey}`;
  await putS3Json(client, s3MetadataKey, { ...metadata, metadataLocation, storageLocation: dataLocation, storageMode: "s3" });
  return { dataLocation, metadataLocation };
}

async function writeS3Metadata(metadata) {
  const client = s3LandingClient();
  await putS3Json(client, s3MetadataKey, metadata);
}

async function putS3Json(client, key, value) {
  await client.send(new PutObjectCommand({
    Body: `${JSON.stringify(value, null, 2)}\n`,
    Bucket: s3Bucket,
    ContentType: "application/json",
    Key: key,
  }));
}

function s3LandingClient() {
  return new S3Client({
    credentials: {
      accessKeyId: process.env.ASKLAKE_REVIEW_LANDING_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || "m3admin",
      secretAccessKey: process.env.ASKLAKE_REVIEW_LANDING_SECRET_KEY || process.env.MINIO_SECRET_KEY || "wishuponastar",
    },
    endpoint: s3Endpoint,
    forcePathStyle: String(process.env.ASKLAKE_REVIEW_LANDING_FORCE_PATH_STYLE || "true").toLowerCase() !== "false",
    region: process.env.ASKLAKE_REVIEW_LANDING_REGION || process.env.MINIO_REGION || "us-east-1",
  });
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function registerCatalogDataset(metadata) {
  const previous = await getDataset(datasetId);
  const schema = standardReviewSchema().map((column) => [column.targetName, column.type]);
  const run = {
    createdAt: metadata.endedAt,
    jobId: "kafka-review-ingest",
    rowCount: metadata.storedCount,
    runId: metadata.runId,
    sourceKind: "kafka",
    sourceLabel: metadata.topic,
    status: metadata.status,
    storageLocation: metadata.storageLocation,
    storageSizeBytes: metadata.storageSizeBytes,
  };
  const materializationRuns = appendMaterializationRun(previous?.materializationRuns, run);
  const aggregate = aggregateRuns(materializationRuns);
  const payload = {
    description: "Kafka reviews.raw 원본 리뷰 이벤트 landing dataset",
    downstream: ["SQL 분석", "리뷰 분석"],
    freshness: "latest",
    id: datasetId,
    layer: "RAW",
    lastUpdated: aggregate.lastUpdated || metadata.endedAt,
    lineageGraph: reviewLineageGraph(schema),
    materializationRuns,
    name: datasetName,
    nextRefresh: "-",
    owner: process.env.ASKLAKE_REVIEW_DATASET_OWNER || "AskLake",
    quality: metadata.failedCount > 0 ? `적재 완료 · 실패 ${metadata.failedCount}건` : "원본 적재 완료",
    rag: false,
    rows: String(aggregate.rowCount),
    sampleRows: metadata.sampleRows,
    schema,
    size: formatBytes(aggregate.storageSizeBytes),
    source: `Kafka ${metadata.topic}`,
    sourceRunId: aggregate.latestRunId || metadata.runId,
    status: "available",
    storageFormat: metadata.storageFormat,
    storageLocation: aggregate.latestStorageLocation || metadata.storageLocation,
    storageSizeBytes: aggregate.storageSizeBytes,
    tags: ["#kafka", "#reviews", "#raw"],
    upstream: [`Kafka topic: ${metadata.topic}`],
  };
  await saveDataset(payload);
  return payload;
}

function appendMaterializationRun(previousRuns, nextRun) {
  const runs = Array.isArray(previousRuns) ? previousRuns.filter((run) => run && typeof run === "object") : [];
  const filtered = runs.filter((run) => run.runId !== nextRun.runId);
  return [nextRun, ...filtered].slice(0, 50);
}

function aggregateRuns(runs) {
  const successfulRuns = runs.filter((run) => run.status === "success");
  const rowCount = successfulRuns.reduce((sum, run) => sum + Number(run.rowCount || 0), 0);
  const storageSizeBytes = successfulRuns.reduce((sum, run) => sum + Number(run.storageSizeBytes || 0), 0);
  const latest = successfulRuns[0] || runs[0] || {};
  return {
    lastUpdated: latest.createdAt || "",
    latestRunId: latest.runId || "",
    latestStorageLocation: latest.storageLocation || "",
    rowCount,
    storageSizeBytes,
  };
}

function reviewLineageGraph(schema) {
  const sourceNode = {
    columns: schema.map(([name, type]) => ({ id: `source_${name}`, name, type })),
    engine: "KAFKA",
    id: "source_reviews_raw_topic",
    layer: "SOURCE",
    name: "Kafka reviews.raw",
  };
  const datasetNode = {
    columns: schema.map(([name, type]) => ({ id: `dataset_${name}`, name, type })),
    engine: "JSONL",
    id: datasetId,
    layer: "RAW",
    name: datasetName,
  };
  return {
    datasetId,
    datasets: [sourceNode, datasetNode],
    edges: schema.map(([name]) => ({
      fromColumnId: `source_${name}`,
      fromDatasetId: sourceNode.id,
      toColumnId: `dataset_${name}`,
      toDatasetId: datasetNode.id,
    })),
  };
}

function parseReviewMessage(value, context) {
  try {
    const record = JSON.parse(value);
    for (const field of requiredFields) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        return { error: { ...context, field, reason: "missing_required_field" }, valid: false };
      }
    }
    if (record.schema_version !== undefined && record.schema_version !== "1.0") {
      return { error: { ...context, reason: "unsupported_schema_version", schemaVersion: record.schema_version }, valid: false };
    }
    if (record.raw !== undefined && (typeof record.raw !== "object" || Array.isArray(record.raw))) {
      return { error: { ...context, reason: "invalid_raw_payload" }, valid: false };
    }
    const numericOffset = Number(record.offset);
    if (!Number.isFinite(numericOffset)) {
      return { error: { ...context, offset: record.offset, reason: "invalid_offset" }, valid: false };
    }
    return {
      record: {
        schema_version: record.schema_version || "1.0",
        event_id: String(record.event_id),
        source: record.source || "review-dataset",
        offset: numericOffset,
        review: String(record.review),
        created_at: String(record.created_at),
        raw: record.raw || { ...record },
      },
      valid: true,
    };
  } catch (error) {
    return { error: { ...context, message: error?.message || String(error), reason: "invalid_json" }, valid: false };
  }
}

function standardReviewSchema() {
  return [
    { nullable: false, sourceName: "schema_version", targetName: "schema_version", type: "String" },
    { nullable: false, role: "Identifier", sourceName: "event_id", targetName: "event_id", type: "String" },
    { nullable: false, sourceName: "source", targetName: "source", type: "String" },
    { nullable: false, sourceName: "offset", targetName: "offset", type: "Integer" },
    { nullable: false, sourceName: "review", targetName: "review", type: "String" },
    { nullable: false, role: "Event Time", sourceName: "created_at", targetName: "created_at", type: "Timestamp" },
    { nullable: false, sourceName: "raw", targetName: "raw", type: "Object" },
  ];
}

function reviewSampleRow(record) {
  return [
    String(record.schema_version ?? ""),
    String(record.event_id ?? ""),
    String(record.source ?? ""),
    String(record.offset ?? ""),
    String(record.review ?? ""),
    String(record.created_at ?? ""),
    JSON.stringify(record.raw ?? {}),
  ];
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run_${timestamp}_${Math.random().toString(16).slice(2, 8)}`;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safePathSegment(value) {
  return String(value ?? "topic")
    .trim()
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "topic";
}

function normalizePrefix(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
  return normalized && !normalized.endsWith("/") ? `${normalized}/` : normalized;
}

function readJsonPayload() {
  try {
    const text = readFileSync(0, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function stringOption(key, fallback) {
  const value = apiPayload[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanOption(key, fallback) {
  const value = apiPayload[key];
  if (typeof value === "boolean") return value;
  const text = String(value ?? fallback ?? "").trim().toLowerCase();
  return !["false", "0", "no", "off"].includes(text);
}
