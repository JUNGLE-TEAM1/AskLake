import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { closeMetadataStore, getDataset, saveDataset } from "../src/metadataStore.mjs";
import { kafkaSecurityOptions, loadKafkaJs } from "../src/kafka-codecs.mjs";
import { defaultOutputBucket, isMinioProvider, resolveObjectStorageConfig, s3ClientOptions } from "../src/objectStorageConfig.mjs";
import { formatBytes, inferSchemaColumns, normalizeColumnName, parseSourceSample, schemaFingerprint } from "../src/profile.mjs";
import {
  buildKafkaTargetSchema,
  getKafkaRecordValue,
  parseKafkaSnapshotRecord,
  projectKafkaTargetRecord,
  standardKafkaReviewSchema,
} from "../src/kafkaTargetProjection.mjs";
import { canonicalRulesFromLegacy } from "../src/ruleCompiler.mjs";
import { applySnapshotRules, supportsSnapshotRules } from "../src/snapshotRuleRuntime.mjs";
import { runSparkPipeline } from "../src/sparkRunner.mjs";

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
const targetLayer = stringOption("targetLayer", process.env.ASKLAKE_REVIEW_TARGET_LAYER || "BRONZE").toUpperCase();
const targetFormat = stringOption("targetFormat", process.env.ASKLAKE_REVIEW_TARGET_FORMAT || "jsonl").toLowerCase();
const targetDescription = stringOption("targetDescription", process.env.ASKLAKE_REVIEW_TARGET_DESCRIPTION || "Kafka snapshot direct target dataset");
const transformSteps = objectArrayOption("transformSteps");
const qualityRules = objectArrayOption("qualityRules");
const suppliedRules = objectArrayOption("rules");
const configuredSchemaColumns = objectArrayOption("schemaColumns");
const recordParsing = objectOption("recordParsing");
const configuredOutputSchema = tupleArrayOption("outputSchema");
const canonicalRules = apiPayload.ruleContractVersion || suppliedRules.length > 0
  ? suppliedRules
  : canonicalRulesFromLegacy(
      transformSteps,
      qualityRules,
      standardKafkaReviewSchema(),
      transformSteps
        .filter((step) => step?.enabled !== false && step?.output)
        .map((step) => [String(step.output), "String"]),
    );
const testFailAfterTargetWrite = process.env.ASKLAKE_ENABLE_KAFKA_TEST_HOOKS === "true"
  && booleanOption("testFailAfterTargetWrite", false);
const suppliedSnapshot = isSnapshotPayload(apiPayload.snapshot) ? apiPayload.snapshot : null;
const snapshotOnly = booleanOption("snapshotOnly", false);
const commitOnly = booleanOption("commitOnly", false);
const deferOffsetCommit = booleanOption("deferOffsetCommit", false);
const icebergTarget = objectOption("icebergTarget");
const jobId = stringOption("jobId", "kafka-review-ingest");
const expectedSchemaFingerprint = stringOption("schemaFingerprint", "");
const expectedRuleFingerprint = stringOption("ruleFingerprint", "");
const landingMode = stringOption("storageMode", process.env.ASKLAKE_REVIEW_LANDING_MODE || "local").toLowerCase();
const targetRoot = path.resolve(stringOption("localLandingDir", process.env.ASKLAKE_REVIEW_TARGET_LOCAL_DIR || path.join(backendDir, "tmp", "kafka-target")));
const defaultStorage = resolveObjectStorageConfig();
const s3Endpoint = stringOption("landingEndpoint", process.env.ASKLAKE_REVIEW_LANDING_ENDPOINT || defaultStorage.endpoint);
const s3Bucket = stringOption("targetBucket", apiPayload.landingBucket || process.env.ASKLAKE_REVIEW_TARGET_BUCKET || defaultOutputBucket());
const s3Prefix = normalizePrefix(stringOption("targetPrefix", apiPayload.landingPrefix || process.env.ASKLAKE_REVIEW_TARGET_PREFIX || `${normalizeColumnName(datasetName)}/${targetLayer.toLowerCase()}`));
let s3DataKey = "";
let s3MetadataKey = "";
let s3QuarantineKey = "";
let targetDir = "";
let dataPath = "";
let metadataPath = "";
let activeSnapshot = null;
const startedAt = new Date().toISOString();

try {
  const result = await ingestReviews();
  console.log(`ASKLAKE_KAFKA_REVIEW_INGEST_RESULT=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`ASKLAKE_KAFKA_REVIEW_INGEST_ERROR=${JSON.stringify({
    code: "KAFKA_REVIEW_INGEST_FAILED",
    broker,
    consumerGroupId,
    endedAt: new Date().toISOString(),
    failedStage: error?.failedStage || "Kafka ingest",
    message: error?.message || String(error),
    quality: error?.quality,
    runId,
    snapshot: activeSnapshot,
    status: 502,
    startedAt,
    topic,
    transform: error?.transform,
  })}`);
  process.exitCode = 1;
} finally {
  await closeMetadataStore().catch(() => undefined);
}

async function ingestReviews() {
  if (commitOnly) return commitSnapshotOffsetsOnly();
  if (!["RAW", "BRONZE", "SILVER"].includes(targetLayer)) {
    throw new Error(`Kafka direct target layer must be RAW, BRONZE, or SILVER: ${targetLayer}`);
  }
  if (!icebergTarget && targetFormat !== "jsonl") {
    throw new Error(`Kafka direct target currently supports jsonl only: ${targetFormat}`);
  }
  if (!supportsSnapshotRules(canonicalRules)) {
    throw pipelineError("transform", "Kafka Snapshot received an unsupported canonical Rule operation.");
  }
  const { Kafka } = await loadKafkaJs();
  const kafka = new Kafka({
    ...await kafkaSecurityOptions(),
    brokers: [broker],
    clientId: "asklake-review-ingest",
    retry: { retries: 2 },
  });
  const snapshot = suppliedSnapshot || await captureKafkaSnapshot(kafka);
  activeSnapshot = snapshot;
  if (snapshotOnly) return { snapshot, status: "snapshot" };
  configureTargetOutput(snapshot.snapshotId);
  const consumer = kafka.consumer({ groupId: snapshotReaderGroupId(snapshot) });
  let consumerStarted = false;

  await prepareSnapshotReader(kafka, snapshot);
  await consumer.connect();
  try {
    consumerStarted = true;
    const consumed = await consumeKafkaSnapshot(consumer, snapshot);

    if (consumed.records.length === 0 && !allowEmpty) {
      throw new Error(`No valid review messages consumed from ${topic} at ${broker}.`);
    }

    const processed = applySnapshotRules(consumed.records, canonicalRules);
    const quarantined = [
      ...consumed.invalidRecords.map((item) => ({ ...item, stage: "parse" })),
      ...processed.quarantined,
    ];
    const schemaColumns = buildKafkaTargetSchema({
      outputSchema: configuredOutputSchema,
      records: processed.records,
      rules: canonicalRules,
      schemaColumns: configuredSchemaColumns,
    });
    const projectedRecords = processed.records.map((record) => projectKafkaTargetRecord(record, schemaColumns));
    const jsonl = projectedRecords.map((record) => JSON.stringify(record)).join("\n");
    const dataBody = projectedRecords.length > 0 ? `${jsonl}\n` : "";
    mkdirSync(targetDir, { recursive: true });
    const sparkResult = icebergTarget && projectedRecords.length > 0
      ? writeIcebergTarget(projectedRecords, schemaColumns, snapshot)
      : null;
    const localLocation = icebergTarget?.tableUri || writeLocalTarget(dataBody);

    const endedAt = new Date().toISOString();
    const parsedSample = parseSourceSample("reviews.raw.jsonl", jsonl, { maxRows: Math.min(consumed.records.length, 20) });
    const inferredSchemaColumns = inferSchemaColumns(parsedSample);
    const metadata = {
      broker,
      consumedCount: consumed.records.length,
      consumerGroupId,
      dataPath: icebergTarget ? null : dataPath,
      datasetId: registerCatalog ? datasetId : null,
      datasetName: registerCatalog ? datasetName : null,
      endedAt,
      failedCount: consumed.invalidRecords.length + processed.transform.errorCount,
      invalidRecords: consumed.invalidRecords.slice(0, 10),
      maxMessages,
      metadataPath,
      offsetPolicy,
      runId,
      ruleContractVersion: "1.0",
      snapshot,
      inferredSchema: inferredSchemaColumns.map((column) => [column.targetName, column.type]),
      sampleRows: projectedRecords.slice(0, 10).map((record) => reviewSampleRow(record, schemaColumns)),
      schema: sparkResult?.schema ?? schemaColumns.map((column) => [column.targetName, column.type]),
      schemaFingerprint: expectedSchemaFingerprint || schemaFingerprint(schemaColumns),
      startedAt,
      status: "success",
      storageFormat: icebergTarget ? "iceberg" : "jsonl",
      storageLocation: localLocation,
      storageSizeBytes: icebergTarget ? 0 : statSync(dataPath).size,
      storedCount: projectedRecords.length,
      targetBucket: s3Bucket,
      targetFormat,
      targetLayer,
      targetPrefix: s3Prefix.replace(/\/$/, ""),
      timeoutMs,
      topic,
      transform: processed.transform,
      quality: processed.quality,
      ...(expectedRuleFingerprint ? { ruleFingerprint: expectedRuleFingerprint } : {}),
      ...(sparkResult ? {
        icebergCommit: sparkResult.icebergCommit,
        outputPath: sparkResult.outputPath,
        outputRows: sparkResult.outputRows,
        sourceBoundary: sparkResult.sourceBoundary,
        warehouseLocation: sparkResult.warehouseLocation,
      } : {}),
    };
    if (landingMode === "s3") {
      if (icebergTarget) {
        metadata.metadataLocation = `s3://${s3Bucket}/${s3MetadataKey}`;
        metadata.storageMode = "s3";
        await writeS3Metadata(metadata);
      } else {
        const s3Location = await writeS3Landing(dataBody, metadata);
        metadata.storageLocation = s3Location.dataLocation;
        metadata.metadataLocation = s3Location.metadataLocation;
        metadata.storageMode = "s3";
      }
      if (quarantined.length > 0) {
        metadata.quality.quarantineLocation = await writeS3Quarantine(quarantined);
      }
    } else {
      metadata.metadataLocation = metadataPath;
      metadata.storageMode = "local";
      if (quarantined.length > 0) {
        metadata.quality.quarantineLocation = writeLocalQuarantine(quarantined);
      }
    }
    if (testFailAfterTargetWrite) {
      throw pipelineError("catalog", "Test-only failure after Kafka target write.");
    }
    if (registerCatalog) {
      const dataset = await registerCatalogDataset(metadata);
      metadata.catalogDataset = {
        id: dataset.id,
        layer: dataset.layer,
        materializationRuns: dataset.materializationRuns?.length ?? 0,
        name: dataset.name,
        rows: dataset.rows,
        storageLocation: dataset.storageLocation,
      };
    }
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (landingMode === "s3") await writeS3Metadata(metadata);

    if (deferOffsetCommit) {
      metadata.offsetCommit = { status: "pending" };
    } else {
      await commitKafkaSnapshot(kafka, snapshot);
      metadata.offsetCommit = { committedAt: new Date().toISOString(), status: "success" };
    }
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    if (landingMode === "s3") await writeS3Metadata(metadata);
    return metadata;
  } finally {
    if (consumerStarted) await consumer.stop().catch(() => undefined);
    await consumer.disconnect().catch(() => undefined);
  }
}

async function commitSnapshotOffsetsOnly() {
  if (!suppliedSnapshot) {
    throw pipelineError("offset commit", "Kafka offset commit requires a persisted snapshot.");
  }
  activeSnapshot = suppliedSnapshot;
  const { Kafka } = await loadKafkaJs();
  const kafka = new Kafka({
    ...await kafkaSecurityOptions(),
    brokers: [broker],
    clientId: "asklake-review-ingest-offset-commit",
    retry: { retries: 2 },
  });
  await commitKafkaSnapshot(kafka, suppliedSnapshot);
  const offsetCommit = { committedAt: new Date().toISOString(), status: "success" };
  let metadataUpdate = null;
  const metadata = objectOption("metadata");
  if (metadata) {
    configureTargetOutput(suppliedSnapshot.snapshotId);
    const finalMetadata = { ...metadata, offsetCommit };
    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(metadataPath, `${JSON.stringify(finalMetadata, null, 2)}\n`, "utf8");
      if (landingMode === "s3") await writeS3Metadata(finalMetadata);
      metadataUpdate = { status: "success" };
    } catch (error) {
      metadataUpdate = {
        message: String(error?.message || error).slice(0, 500),
        status: "warning",
      };
    }
  }
  return {
    metadataUpdate,
    offsetCommit,
    runId,
    snapshot: suppliedSnapshot,
    status: "success",
  };
}

function writeIcebergTarget(records, schemaColumns, snapshot) {
  const sourceBoundary = kafkaSnapshotSourceBoundary(snapshot);
  const result = runSparkPipeline({
    cleanupSource: true,
    id: jobId,
    icebergTarget,
    partitionColumns: Array.isArray(icebergTarget.partitionColumns) ? icebergTarget.partitionColumns : [],
    qualityRules: [],
    ruleContractVersion: "1.0",
    ruleFingerprint: expectedRuleFingerprint || null,
    ruleOutputSchema: schemaColumns.map((column) => [column.targetName, column.type]),
    rules: [],
    schemaColumns: schemaColumns.map((column) => ({
      ...column,
      included: true,
      sourceName: column.targetName,
      targetName: column.targetName,
    })),
    schemaFingerprint: expectedSchemaFingerprint || schemaFingerprint(schemaColumns),
    schemaSampleRows: records,
    sourceBoundary,
    sourceConfig: [],
    sourceType: "Kafka Snapshot Staging",
    storagePath: `s3a://${s3Bucket}/${s3Prefix.replace(/\/$/, "")}`,
    target: datasetName,
    targetLayer,
    transformOutputColumns: schemaColumns.map((column) => [column.targetName, column.type]),
    transformSteps: [],
  }, "run", runId);
  if (!result || result.status !== "success" || !result.icebergCommit) {
    throw pipelineError(
      result?.failedStage || "Iceberg commit",
      result?.error || "Kafka Snapshot Spark Iceberg commit failed.",
    );
  }
  return result;
}

function kafkaSnapshotSourceBoundary(snapshot) {
  return {
    capturedAt: snapshot.capturedAt,
    consumerGroupId: snapshot.consumerGroupId,
    kind: "kafka_snapshot",
    partitions: snapshot.partitions.map((partition) => ({
      endOffset: String(partition.endOffset),
      partition: Number(partition.partition),
      startOffset: String(partition.startOffset),
    })),
    snapshotId: snapshot.snapshotId,
    topic: snapshot.topic,
  };
}

function configureTargetOutput(snapshotId) {
  const objectId = safePathSegment(snapshotId);
  s3DataKey = `${s3Prefix}snapshots/${objectId}/data.${targetFormat}`;
  s3MetadataKey = `${s3Prefix}snapshots/${objectId}/metadata.json`;
  s3QuarantineKey = `${s3Prefix}snapshots/${objectId}/quarantine.jsonl`;
  targetDir = path.join(targetRoot, safePathSegment(datasetName), targetLayer.toLowerCase(), "snapshots", objectId);
  dataPath = path.join(targetDir, `data.${targetFormat}`);
  metadataPath = path.join(targetDir, "metadata.json");
}

function isSnapshotPayload(value) {
  return Boolean(
    value
    && typeof value === "object"
    && typeof value.snapshotId === "string"
    && Array.isArray(value.partitions)
    && value.partitions.every((item) => item && Number.isInteger(item.partition) && item.startOffset !== undefined && item.endOffset !== undefined),
  );
}

async function captureKafkaSnapshot(kafka) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const [topicOffsets, groupOffsets] = await Promise.all([
      admin.fetchTopicOffsets(topic),
      admin.fetchOffsets({ groupId: consumerGroupId, topics: [topic] }),
    ]);
    const committedByPartition = new Map((groupOffsets[0]?.partitions || []).map((item) => [item.partition, item.offset]));
    const partitions = topicOffsets
      .map((item) => snapshotPartition(item, committedByPartition.get(item.partition)))
      .sort((left, right) => left.partition - right.partition);
    const snapshotIdentity = JSON.stringify({ consumerGroupId, partitions, topic });
    return {
      capturedAt: new Date().toISOString(),
      consumerGroupId,
      offsetPolicy,
      partitions,
      snapshotId: `kafka_snapshot_${createHash("sha256").update(snapshotIdentity).digest("hex").slice(0, 16)}`,
      topic,
    };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function snapshotReaderGroupId(snapshot) {
  return `asklake-snapshot-${String(snapshot.snapshotId).replace(/^kafka_snapshot_/, "")}`;
}

async function prepareSnapshotReader(kafka, snapshot) {
  const offsets = snapshot.partitions
    .map((partition) => ({ offset: partition.startOffset, partition: partition.partition }));
  if (offsets.length === 0) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.setOffsets({ groupId: snapshotReaderGroupId(snapshot), topic, partitions: offsets });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function snapshotPartition(topicOffset, committedOffset) {
  const low = asOffset(topicOffset.low, "0");
  const high = asOffset(topicOffset.high ?? topicOffset.offset, low);
  const committed = asOffset(committedOffset, "-1");
  const initial = committed < 0n ? (offsetPolicy === "latest" ? high : low) : committed;
  const start = initial < low ? low : initial > high ? high : initial;
  const cap = BigInt(maxMessages);
  const end = start + cap < high ? start + cap : high;
  return {
    endOffset: end.toString(),
    highWatermark: high.toString(),
    partition: Number(topicOffset.partition),
    startOffset: start.toString(),
  };
}

function asOffset(value, fallback) {
  try {
    return BigInt(value ?? fallback);
  } catch {
    return BigInt(fallback);
  }
}

async function consumeKafkaSnapshot(consumer, snapshot) {
  const ranges = new Map(snapshot.partitions.map((partition) => [partition.partition, {
    end: BigInt(partition.endOffset),
    start: BigInt(partition.startOffset),
  }]));
  const completed = new Set(snapshot.partitions
    .filter((partition) => BigInt(partition.startOffset) >= BigInt(partition.endOffset))
    .map((partition) => partition.partition));
  const records = [];
  const invalidRecords = [];

  if (completed.size === snapshot.partitions.length) return { invalidRecords, records };

  await consumer.subscribe({ fromBeginning: false, topic });

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!error) {
        try {
          consumer.pause([{ partitions: snapshot.partitions.map((partition) => partition.partition), topic }]);
          resolve();
        } catch (pauseError) {
          reject(pauseError);
        }
        return;
      }
      reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Kafka snapshot ${snapshot.snapshotId} timed out before all partition ranges were consumed.`));
    }, timeoutMs);

    consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: Math.max(1, snapshot.partitions.length),
      eachBatch: async ({ batch, heartbeat, isRunning, isStale, resolveOffset }) => {
        const range = ranges.get(batch.partition);
        if (!range || completed.has(batch.partition) || settled) return;
        for (const message of batch.messages) {
          if (!isRunning() || isStale() || settled) return;
          const messageOffset = BigInt(message.offset);
          if (messageOffset >= range.end) {
            completed.add(batch.partition);
            if (completed.size === snapshot.partitions.length) finish();
            return;
          }
          if (messageOffset >= range.start) {
            const value = message.value?.toString("utf8") ?? "";
            const parsed = parseKafkaSnapshotRecord(value, {
              key: message.key?.toString("utf8") ?? "",
              offset: message.offset,
              partition: batch.partition,
              topic: batch.topic,
            }, configuredSchemaColumns, recordParsing);
            if (parsed.valid) records.push(parsed.record);
            else invalidRecords.push(parsed.error);
          }
          resolveOffset(message.offset);
          if (messageOffset + 1n >= range.end) {
            completed.add(batch.partition);
            if (completed.size === snapshot.partitions.length) {
              finish();
              return;
            }
          }
          await heartbeat();
        }
      },
    }).catch(finish);
  });

  return { invalidRecords, records };
}

async function commitKafkaSnapshot(kafka, snapshot) {
  const offsets = snapshot.partitions
    .filter((partition) => BigInt(partition.startOffset) < BigInt(partition.endOffset))
    .map((partition) => ({ offset: partition.endOffset, partition: partition.partition }));
  if (offsets.length === 0) return;
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.setOffsets({ groupId: consumerGroupId, topic, partitions: offsets });
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

function writeLocalTarget(dataBody) {
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(dataPath, dataBody, "utf8");
  return dataPath;
}

async function writeS3Landing(dataBody, metadata) {
  const client = s3LandingClient();
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

function writeLocalQuarantine(records) {
  const quarantinePath = path.join(targetDir, "quarantine.jsonl");
  writeFileSync(quarantinePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return quarantinePath;
}

async function writeS3Quarantine(records) {
  const client = s3LandingClient();
  await client.send(new PutObjectCommand({
    Body: Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8"),
    Bucket: s3Bucket,
    ContentType: "application/x-ndjson",
    Key: s3QuarantineKey,
  }));
  return `s3://${s3Bucket}/${s3QuarantineKey}`;
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
  const fields = [
    ["Endpoint URL", s3Endpoint],
    ["Region", process.env.ASKLAKE_REVIEW_LANDING_REGION || defaultStorage.region],
    ["Access Key", process.env.ASKLAKE_REVIEW_LANDING_ACCESS_KEY || ""],
    ["Secret Key", process.env.ASKLAKE_REVIEW_LANDING_SECRET_KEY || ""],
    ["Use Path Style", process.env.ASKLAKE_REVIEW_LANDING_FORCE_PATH_STYLE || String(defaultStorage.forcePathStyle)],
  ];
  return new S3Client(s3ClientOptions(resolveObjectStorageConfig(fields)));
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isMinioProvider()) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

async function registerCatalogDataset(metadata) {
  const previous = await getDataset(datasetId);
  const schema = metadata.schema;
  const run = {
    createdAt: metadata.endedAt,
    jobId: "kafka-review-ingest",
    kafkaSnapshot: metadata.snapshot,
    materializationMode: "delta",
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
    description: targetDescription,
    downstream: ["SQL 분석", "리뷰 분석"],
    freshness: "latest",
    id: datasetId,
    layer: targetLayer,
    lastUpdated: aggregate.lastUpdated || metadata.endedAt,
    lineageGraph: reviewLineageGraph(schema),
    materializationRuns,
    name: datasetName,
    nextRefresh: "-",
    owner: process.env.ASKLAKE_REVIEW_DATASET_OWNER || "AskLake",
    quality: metadata.quality?.summary || (metadata.failedCount > 0 ? `적재 완료 · 실패 ${metadata.failedCount}건` : "Kafka snapshot 적재 완료"),
    queryEngineStatus: "unavailable",
    rag: false,
    rows: String(aggregate.rowCount),
    sampleRows: metadata.sampleRows,
    schema,
    size: formatBytes(aggregate.storageSizeBytes),
    source: `Kafka ${metadata.topic}`,
    sourceRunId: aggregate.latestRunId || metadata.runId,
    status: "available",
    storageFormat: targetFormat,
    storageLocation: aggregate.latestStorageLocation || metadata.storageLocation,
    storageSizeBytes: aggregate.storageSizeBytes,
    tags: ["#kafka", "#reviews", `#${targetLayer.toLowerCase()}`],
    upstream: [`Kafka topic: ${metadata.topic}`],
  };
  await saveDataset(payload);
  return payload;
}

function appendMaterializationRun(previousRuns, nextRun) {
  const runs = Array.isArray(previousRuns) ? previousRuns.filter((run) => run && typeof run === "object") : [];
  const snapshotId = nextRun.kafkaSnapshot?.snapshotId;
  const filtered = runs.filter((run) => (
    run.runId !== nextRun.runId
    && (!snapshotId || run.kafkaSnapshot?.snapshotId !== snapshotId)
  ));
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
    engine: targetFormat.toUpperCase(),
    id: datasetId,
    layer: targetLayer,
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

function pipelineError(failedStage, message) {
  const error = new Error(message);
  error.failedStage = failedStage;
  return error;
}

function reviewSampleRow(record, schema = standardKafkaReviewSchema()) {
  return schema.map((column) => {
    const value = getKafkaRecordValue(record, column.targetName);
    return value && typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  });
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

function objectArrayOption(key) {
  const value = apiPayload[key];
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function objectOption(key) {
  const value = apiPayload[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function tupleArrayOption(key) {
  const value = apiPayload[key];
  return Array.isArray(value)
    ? value.filter((item) => Array.isArray(item) && item.length >= 2)
    : [];
}
