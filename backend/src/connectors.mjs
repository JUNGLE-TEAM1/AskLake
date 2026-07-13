import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKafkaJs } from "./kafka-codecs.mjs";
import {
  isMinioProvider,
  objectStorageDockerEnv,
  resolveObjectStorageConfig,
  s3ClientOptions,
} from "./objectStorageConfig.mjs";
import { canonicalSchemaType, fieldValue, formatBytes, inferSchemaColumns, parseSourceSample, schemaFingerprint, sourceId, upsertFields } from "./profile.mjs";
import {
  createSparkRestSubmission,
  runSparkRestSubmission,
  sparkRestRuntimeConfig,
} from "./sparkRunner.mjs";
import {
  createSparkRuntime,
  SPARK_RUNTIME_IDS,
  SPARK_RUNTIME_OPERATIONS,
} from "./sparkRuntime.mjs";

const textFileExtensions = [".csv", ".json", ".jsonl", ".log", ".txt", ".tsv"];
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = path.join(backendDir, "scripts");
const ivyDir = path.resolve(process.env.ASKLAKE_SPARK_IVY_DIR || path.join(backendDir, "tmp", "spark-ivy"));
const sparkReportDir = path.resolve(process.env.ASKLAKE_SPARK_REPORT_DIR || path.join(backendDir, "tmp", "spark-runs"));
const sparkReportRuntimeDir = process.env.ASKLAKE_SPARK_REPORT_CONTAINER_DIR || "/work/reports";

const objectStorageSourceTypes = new Set(["File / S3", "File / S3 CSV", "File / S3 JSON", "File / S3 JSONL", "File / S3 TSV", "File / S3 TXT"]);
const dataLakeSourceTypes = new Set(["Data Lake", "Data Lake Parquet"]);
const kafkaSourceTypes = new Set(["Stream / Kafka", "Kafka JSON"]);
const sourceAssetCache = new Map();
const sourceAssetFailureCache = new Map();
const minioDockerFailureCache = new Map();

export async function testSourceConnector(sourceType, fields) {
  if (objectStorageSourceTypes.has(sourceType)) return testObjectStorageSource(fields, sourceType);
  if (sourceType === "REST API") return testRestSource(fields);
  if (sourceType === "Database" || sourceType === "PostgreSQL") return testPostgresSource(fields);
  if (sourceType === "MongoDB") return testMongoSource(fields);
  if (dataLakeSourceTypes.has(sourceType)) return testDataLakeSourceStable(fields, sourceType);
  if (kafkaSourceTypes.has(sourceType)) return testKafkaSource(fields, sourceType);
  throw apiError("UNSUPPORTED_SOURCE", `${sourceType}는 지원하지 않는 소스 커넥터입니다.`, 400);
}

export async function listSourceAssets(sourceType, fields, requestedPrefix) {
  if (sourceType === "Database" || sourceType === "PostgreSQL") {
    return listPostgresSourceAssets(fields);
  }
  if (sourceType === "MongoDB") {
    return listMongoSourceAssets(fields);
  }
  if (!objectStorageSourceTypes.has(sourceType) && !dataLakeSourceTypes.has(sourceType)) {
    throw apiError("UNSUPPORTED_SOURCE_ASSETS", `${sourceType} source asset listing is not supported.`, 400);
  }
  const storage = resolveObjectStorageConfig(fields);
  const { accessKeyId, endpoint, forcePathStyle, region, secretAccessKey } = storage;
  const parsedLakePath = dataLakeSourceTypes.has(sourceType) ? parseS3Path(fieldValue(fields, "Path")) : null;
  const bucket = fieldValue(fields, "Bucket / Stage Name") || parsedLakePath?.bucket;
  if (!bucket) throw apiError("SOURCE_FIELD_REQUIRED", "MinIO/S3 bucket name is required.", 400);
  const prefix = sourceAssetPrefix(sourceType, fields, requestedPrefix);
  const limit = sourceAssetListLimit();
  requireMinioCredentials(storage);
  const cacheKey = sourceAssetCacheKey({ accessKeyId, bucket, endpoint, forcePathStyle, prefix, region, sourceType });
  const cached = getCachedSourceAssets(cacheKey);
  if (cached) return cached;
  const cachedFailure = getCachedSourceAssetFailure(cacheKey);
  if (cachedFailure) throw cachedFailure;

  let items;
  const client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
  try {
    items = await listDirectObjects(client, bucket, prefix, limit);
  } catch (error) {
    items = isMinioProvider(fields)
      ? listDirectObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, limit, prefix, secretAccessKey })
      : null;
    if (!items) {
      setCachedSourceAssetFailure(cacheKey, error);
      throw error;
    }
  }
  if (!items) {
    const error = apiError("SOURCE_ASSET_LIST_FAILED", "MinIO/S3 object listing failed.", 502);
    setCachedSourceAssetFailure(cacheKey, error);
    throw error;
  }

  const response = {
    assets: toSourceAssets(items, limit),
    count: items.length,
    limit,
    prefix,
  };
  setCachedSourceAssets(cacheKey, response);
  sourceAssetFailureCache.delete(cacheKey);
  return response;
}

export async function testObjectStorageSource(fields, sourceType = "File / S3") {
  const storage = resolveObjectStorageConfig(fields);
  const { accessKeyId, endpoint, forcePathStyle, region, secretAccessKey } = storage;
  const bucket = requiredSourceField(fields, "Bucket / Stage Name", "MinIO/S3 bucket name is required.");
  const prefix = normalizePrefix(fieldValue(fields, "Path / Prefix"));
  const selectedObject = selectedObjectKey(fields);
  const collectionScope = String(fieldValue(fields, "Collection Scope") || "file").trim().toLowerCase();
  const collectionPattern = fieldValue(fields, "File Pattern") || "*";
  const collectionRecursive = parseBoolean(fieldValue(fields, "Recursive"), false);

  if (!accessKeyId || !secretAccessKey) {
    throw apiError("SOURCE_CREDENTIALS_REQUIRED", "MinIO/S3 액세스 키와 시크릿 키가 필요합니다.", 400);
  }
  requireMinioCredentials(storage);

  // A selected Parquet object needs the Spark reader; treating it as a text
  // object silently falls back to object metadata instead of its real schema.
  if (isParquetObjectKey(selectedObject)) {
    const parquetPath = `s3://${bucket}/${selectedObject}`;
    const parquetFields = upsertFields(fields, [
      ["Path", parquetPath],
      ["Path / Prefix", selectedObject],
      ["__Selected Object", selectedObject],
      ["__Sample Object", selectedObject],
    ]);
    return testDataLakeSourceStable(parquetFields, sourceType);
  }

  const samplePolicy = samplePolicyForFields(fields, "object");
  const client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
  try {
    let objects = selectedObject
      ? await listSelectedObject(client, bucket, selectedObject)
      : await listDirectObjects(client, bucket, prefix, sourceAssetListLimit());
    if (!prefix && objects.length === 0) {
      objects = isMinioProvider(fields)
        ? listDirectObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, limit: sourceAssetListLimit(), prefix, secretAccessKey }) ?? objects
        : objects;
    }
    let sampleObject = selectedObject
      ? objects.find((item) => item.Key === selectedObject)
      : collectionScope === "folder"
        ? immediateCollectionSampleObject(objects, prefix, collectionPattern)
        : immediateSampleObject(objects, prefix);
    if (!sampleObject && !selectedObject && collectionScope === "folder" && collectionRecursive) {
      sampleObject = await findRecursiveCollectionSampleObject(client, bucket, prefix, collectionPattern);
    }
    return buildObjectStorageAnalysis({
      bucket,
      client,
      endpoint,
      fields,
      forcePathStyle,
      objects,
      prefix,
      region,
      samplePolicy,
      sampleObject,
      selectedObject,
      sourceType,
    });
  } catch (error) {
    const fallback = isMinioProvider(fields)
      ? readObjectStorageViaMinioContainer({ accessKeyId, bucket, endpoint, fields, prefix, samplePolicy, secretAccessKey, selectedObject, sourceType })
      : null;
    if (fallback) return fallback;
    throw error;
  }
}

export async function testDataLakeSource(fields, sourceType = "Data Lake") {
  return testDataLakeSourceStable(fields, sourceType);

  const path = requiredSourceField(fields, "Path", "Data Lake path is required.");
  const parsed = parseS3Path(path);
  if (!parsed) {
    throw apiError("UNSUPPORTED_LAKE_PATH", "데이터 레이크 경로는 이 로컬 러너에서 s3:// 또는 s3a:// MinIO 경로여야 합니다.", 400);
  }

  const endpoint = requiredSourceField(fields, "Endpoint URL", "Data Lake endpoint URL is required.");
  const region = fieldValue(fields, "Region") || "us-east-1";
  const accessKeyId = requiredSourceField(fields, "Access Key", "Data Lake access key is required.");
  const secretAccessKey = requiredSourceField(fields, "Secret Key", "Data Lake secret key is required.");
  const forcePathStyle = parseBoolean(fieldValue(fields, "Use Path Style"), true);
  if (!accessKeyId || !secretAccessKey) {
    throw apiError("SOURCE_CREDENTIALS_REQUIRED", "로컬 데이터 레이크 경로에는 MinIO 액세스 키와 시크릿 키가 필요합니다.", 400);
  }

  let client;
  let objects;
  try {
    client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
    objects = await listObjects(client, parsed.bucket, parsed.prefix);
  } catch (error) {
    objects = listObjectsViaMinioContainer({ accessKeyId, bucket: parsed.bucket, endpoint, prefix: parsed.prefix, secretAccessKey });
    if (!objects) throw error;
  }
  const parquetObjects = objects.filter((item) => String(item.Key ?? "").toLowerCase().endsWith(".parquet"));
  const sample = parquetObjects[0] ?? objects[0];
  const samplePolicy = samplePolicyForFields(fields, "rows");
  const inspectPath = sample?.Key && String(sample.Key).toLowerCase().endsWith(".parquet")
    ? `s3a://${parsed.bucket}/${sample.Key}`
    : path;
  let inspected = null;
  let inspectError = "";
  if (parquetObjects.length > 0) {
    try {
      inspected = inspectParquetLakeWithSpark({
        accessKeyId,
        endpoint,
        path: inspectPath,
        rowLimit: samplePolicy.rowLimit,
        secretAccessKey,
      });
    } catch (error) {
      if (error?.code === "SPARK_RUNNER_CONFIGURATION_INVALID") throw error;
      inspectError = error?.message || "Data Lake Parquet schema inference failed.";
      try {
        inspected = await inspectParquetObjectWithJs({
          bucket: parsed.bucket,
          client,
          key: sample?.Key,
          rowLimit: samplePolicy.rowLimit,
        });
        inspectError = "";
      } catch (fallbackError) {
        inspectError = `${inspectError}; JS Parquet fallback failed: ${fallbackError?.message || fallbackError}`;
      }
      if (parseBoolean(process.env.ASKLAKE_DATALAKE_SCHEMA_STRICT, false)) throw error;
    }
  }
  const schemaColumns = inspected?.schemaColumns ?? [];
  const sampleRows = inspected?.sampleRows ?? [];
  const id = sourceId("source", `${path}:${objects.length}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Path", path],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Use Path Style", String(forcePathStyle)],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Row Limit", String(samplePolicy.rowLimit)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sample?.Key ?? ""],
  ]);

  return {
    actionPath: "/api/etl/sources/datalake/test",
    assets: toSourceAssets(objects),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary: schemaColumns.length
          ? `데이터 레이크 Parquet 스키마 ${schemaColumns.length}개 필드 추론 · ${sampleRows.length}개 샘플 확인`
          : `데이터 레이크 경로 접근 성공: Parquet 파일 ${parquetObjects.length}개 · 스키마 추론 대기`,
      },
      source: {
        connectionMessage: `데이터 레이크 연결 성공: ${path} (오브젝트 ${objects.length}개)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel: path,
        sourceType,
      },
    },
    logs: [
      `데이터 레이크 오브젝트 목록 조회 성공: ${path}`,
      `Parquet 파일 감지: ${parquetObjects.length}개`,
      `스키마 샘플 파일: ${inspectPath}`,
      ...(inspected?.logs ?? ["Parquet 물리 스키마를 추론할 샘플이 없습니다."]),
    ],
    message: `데이터 레이크 연결 성공: 오브젝트 ${objects.length}개`,
    previewColumns: schemaColumns.length ? schemaColumns.map((column) => column.targetName) : ["Object Key", "Size", "Last Modified"],
    previewNote: schemaColumns.length
      ? `${path}에서 Spark가 읽은 Parquet 제한 샘플`
      : "오브젝트 메타데이터 미리보기입니다.",
    previewRows: sampleRows.length
      ? sampleRows
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", item.__folder ? "folder" : formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Path", path], ["Objects", String(objects.length)], ["Parquet", String(parquetObjects.length)]],
  };
}

export async function testDataLakeSourceStable(fields, sourceType = "Data Lake") {
  const rawLakePath = requiredSourceField(fields, "Path", "Data Lake path is required.");
  const selectedObject = selectedObjectKey(fields);
  let parsed = parseS3Path(rawLakePath);
  if (!parsed && selectedObject && fieldValue(fields, "Bucket / Stage Name")) {
    parsed = { bucket: fieldValue(fields, "Bucket / Stage Name"), prefix: normalizePrefix(fieldValue(fields, "Path / Prefix")) };
  }
  if (!parsed) {
    throw apiError("UNSUPPORTED_LAKE_PATH", "Data Lake path must be an s3:// or s3a:// object-storage path.", 400);
  }
  const lakePath = parseS3Path(rawLakePath) ? rawLakePath : `s3://${parsed.bucket}/${selectedObject || parsed.prefix}`;

  const storage = resolveObjectStorageConfig(fields);
  const { accessKeyId, endpoint, forcePathStyle, region, secretAccessKey } = storage;
  requireMinioCredentials(storage);

  let client;
  let objects;
  try {
    client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
    objects = selectedObject
      ? await listSelectedObject(client, parsed.bucket, selectedObject)
      : await listDirectObjects(client, parsed.bucket, parsed.prefix);
  } catch (error) {
    objects = isMinioProvider(fields)
      ? selectedObject
        ? listSelectedObjectViaMinioContainer({ accessKeyId, bucket: parsed.bucket, endpoint, key: selectedObject, secretAccessKey })
        : listDirectObjectsViaMinioContainer({ accessKeyId, bucket: parsed.bucket, endpoint, prefix: parsed.prefix, secretAccessKey })
      : null;
    if (!objects) throw error;
  }

  const parquetObjects = selectedObject
    ? objects.filter((item) => String(item.Key ?? "").toLowerCase().endsWith(".parquet"))
    : [];
  const sample = selectedObject ? parquetObjects[0] ?? objects.find((item) => item.Key === selectedObject) : null;
  const samplePolicy = samplePolicyForFields(fields, "rows");
  const inspectPath = sample?.Key && String(sample.Key).toLowerCase().endsWith(".parquet")
    ? `s3a://${parsed.bucket}/${sample.Key}`
    : lakePath;
  let inspected = null;
  let inspectError = "";
  if (parquetObjects.length > 0) {
    try {
      inspected = inspectParquetLakeWithSpark({
        accessKeyId,
        endpoint,
        fields,
        path: inspectPath,
        rowLimit: samplePolicy.rowLimit,
        secretAccessKey,
      });
    } catch (error) {
      if (error?.code === "SPARK_RUNNER_CONFIGURATION_INVALID") throw error;
      inspectError = error?.message || "Data Lake Parquet schema inference failed.";
      try {
        inspected = await inspectParquetObjectWithJs({
          bucket: parsed.bucket,
          client,
          key: sample?.Key,
          rowLimit: samplePolicy.rowLimit,
        });
        inspectError = "";
      } catch (fallbackError) {
        inspectError = `${inspectError}; JS Parquet fallback failed: ${fallbackError?.message || fallbackError}`;
      }
      if (parseBoolean(process.env.ASKLAKE_DATALAKE_SCHEMA_STRICT, false)) throw error;
    }
  }

  if (isParquetObjectKey(selectedObject) && inspectError) {
    throw apiError(
      "PARQUET_SCHEMA_INFERENCE_FAILED",
      `선택한 Parquet 파일의 스키마를 읽지 못했습니다: ${inspectError}`,
      502,
    );
  }

  const schemaColumns = inspected?.schemaColumns ?? [];
  const sampleRows = inspected?.sampleRows ?? [];
  const id = sourceId("source", `${lakePath}:${objects.length}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Storage Provider", storage.provider === "aws" ? "Amazon S3" : "MinIO"],
    ["Path", lakePath],
    ["Bucket / Stage Name", parsed.bucket],
    ["Path / Prefix", parsed.prefix],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Use Path Style", String(forcePathStyle)],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Row Limit", String(samplePolicy.rowLimit)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sample?.Key ?? ""],
    ["__Selected Object", selectedObject],
    ["__Schema Inspect Path", inspectPath],
    ["__Schema Inspect Error", inspectError],
  ]);
  const summary = schemaColumns.length
    ? `Data Lake Parquet schema inferred: ${schemaColumns.length} fields, ${sampleRows.length} sample rows`
    : inspectError
      ? "Data Lake path reachable, but Parquet schema inference failed"
      : selectedObject
        ? `Data Lake selected file reachable: ${selectedObject}, schema inference pending`
        : `Data Lake path reachable: ${objects.length} immediate children, select a file to infer schema`;

  return {
    actionPath: "/api/etl/sources/datalake/test",
    assets: toSourceAssets(objects),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary,
      },
      source: {
        connectionMessage: `Data Lake reachable: ${lakePath} (${objects.length} immediate children)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel: lakePath,
        sourceType,
      },
    },
    logs: [
      `Data Lake object listing succeeded: ${lakePath}`,
      `Parquet files detected: ${parquetObjects.length}`,
      `Schema sample path: ${inspectPath}`,
      ...(inspected?.logs ?? [
        inspectError
          ? `Parquet schema inference failed: ${inspectError}`
          : "No Parquet physical schema sample was inferred.",
      ]),
    ],
    message: `Data Lake reachable: ${objects.length} immediate children`,
    previewColumns: schemaColumns.length ? schemaColumns.map((column) => column.targetName) : ["Object Key", "Size", "Last Modified"],
    previewNote: schemaColumns.length
      ? `${lakePath}에서 가져온 Parquet 제한 샘플`
      : "Parquet 스키마를 추론하지 못해 오브젝트 메타데이터만 표시합니다.",
    previewRows: sampleRows.length
      ? sampleRows
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", item.__folder ? "folder" : formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Path", lakePath], ["Immediate children", String(objects.length)], ["Parquet", String(parquetObjects.length)]],
  };
}

export async function testRestSource(fields) {
  const endpoint = fieldValue(fields, "Endpoint URL");
  const method = fieldValue(fields, "Method") || "GET";
  const accept = fieldValue(fields, "Accept") || "application/json";
  if (!endpoint) throw apiError("REST_ENDPOINT_REQUIRED", "REST API 엔드포인트 URL이 필요합니다.", 400);

  const response = await fetch(endpoint, {
    headers: { Accept: accept },
    method,
    signal: AbortSignal.timeout(sourceConnectTimeoutMs("ASKLAKE_REST_TIMEOUT_MS", 5000)),
  });
  if (!response.ok) {
    throw apiError("REST_SOURCE_FAILED", `REST API 응답 실패: ${response.status} ${response.statusText}`, 502);
  }

  const text = await response.text();
  const parsedSample = parseSourceSample(endpoint, text.slice(0, 512 * 1024));
  const schemaColumns = inferSchemaColumns(parsedSample);
  const id = sourceId("source", endpoint);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", "1"],
  ]);

  return {
    actionPath: "/api/etl/sources/rest/test",
    assets: [[endpoint, `${text.length} bytes`, `HTTP ${response.status}`]],
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary: `REST ${parsedSample.format} 샘플에서 ${schemaColumns.length}개 필드 추론 · 프로파일 확인`,
      },
      source: {
        connectionMessage: `REST API 연결 성공: ${endpoint}`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel: endpoint,
        sourceType: "REST API",
      },
    },
    logs: [
      `REST 소스 접근 성공: ${endpoint}`,
      `제한 응답 샘플 조회: ${text.length}바이트`,
      `프로파일 스냅샷 추론: ${schemaColumns.length}개 필드`,
    ],
    message: "REST API 연결 성공",
    previewColumns: parsedSample.columns,
    previewNote: `${endpoint}에서 가져온 제한 샘플`,
    previewRows: parsedSample.rows,
    status: "success",
    testItems: [["Endpoint", "Reachable"], ["HTTP", String(response.status)]],
  };
}

async function listPostgresSourceAssets(fields) {
  const { Client } = await import("pg");
  const host = requiredSourceField(fields, "Endpoint / Host", "PostgreSQL host is required.");
  const port = Number(requiredSourceField(fields, "Port", "PostgreSQL port is required."));
  const database = requiredSourceField(fields, "Database Name", "PostgreSQL database name is required.");
  const schema = fieldValue(fields, "Schema") || "public";
  const user = requiredSourceField(fields, "Username", "PostgreSQL username is required.");
  const password = requiredSourceField(fields, "Password / Auth Token", "PostgreSQL password is required.");
  const limit = 20;
  const client = new Client({
    connectionTimeoutMillis: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_CONNECT_TIMEOUT_MS", 3000),
    database,
    host,
    password,
    port,
    query_timeout: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
    statement_timeout: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
    user,
  });

  await client.connect();
  try {
    const result = await client.query(
      "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name limit $2",
      [schema, limit],
    );
    const assets = result.rows.map((row) => [String(row.table_name), schema, "detected"]);
    return { assets, count: assets.length, limit, prefix: schema };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function listMongoSourceAssets(fields) {
  const { MongoClient } = await import("mongodb");
  const endpoint = process.env.ASKLAKE_MONGO_HOST || fieldValue(fields, "Endpoint / Host") || "127.0.0.1";
  const port = Number(process.env.ASKLAKE_MONGO_PORT || fieldValue(fields, "Port") || 27018);
  const database = fieldValue(fields, "Database Name") || process.env.ASKLAKE_MONGO_DATABASE || "asklake_sources";
  const username = process.env.ASKLAKE_MONGO_USER || fieldValue(fields, "Username") || "";
  const password = process.env.ASKLAKE_MONGO_PASSWORD || fieldValue(fields, "Password / Auth Token") || "";
  const authPart = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const uri = process.env.ASKLAKE_MONGO_HOST
    ? `mongodb://${authPart}${endpoint}:${port}/${database}${username ? "?authSource=admin" : ""}`
    : fieldValue(fields, "Connection URI") || `mongodb://${authPart}${endpoint}:${port}/${database}${username ? "?authSource=admin" : ""}`;
  const client = new MongoClient(uri, {
    connectTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_CONNECT_TIMEOUT_MS", 3000),
    serverSelectionTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_SERVER_SELECTION_TIMEOUT_MS", 3000),
    socketTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_SOCKET_TIMEOUT_MS", 5000),
  });

  try {
    await client.connect();
    const collections = (await client.db(database).listCollections({}, { nameOnly: true }).toArray())
      .map((collectionInfo) => String(collectionInfo.name ?? ""))
      .filter(Boolean)
      .sort();
    return {
      assets: collections.map((collection) => [collection, database, "detected"]),
      count: collections.length,
      limit: collections.length,
      prefix: database,
    };
  } catch (error) {
    throw apiError("MONGO_SOURCE_FAILED", `MongoDB 연결 실패: ${tailText(error?.message || error)}`, 502);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function testPostgresSource(fields) {
  const { Client } = await import("pg");
  const host = requiredSourceField(fields, "Endpoint / Host", "PostgreSQL host is required.");
  const port = Number(requiredSourceField(fields, "Port", "PostgreSQL port is required."));
  const database = requiredSourceField(fields, "Database Name", "PostgreSQL database name is required.");
  const schema = fieldValue(fields, "Schema") || "public";
  const user = requiredSourceField(fields, "Username", "PostgreSQL username is required.");
  const password = requiredSourceField(fields, "Password / Auth Token", "PostgreSQL password is required.");
  const tableSelector = requiredSourceField(
    fields,
    "DATASET OR TABLE SELECTOR",
    "PostgreSQL table selection is required before schema preview.",
  );
  const samplePolicy = samplePolicyForFields(fields, "rows");

  const client = new Client({
    connectionTimeoutMillis: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_CONNECT_TIMEOUT_MS", 3000),
    database,
    host,
    password,
    port,
    query_timeout: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
    statement_timeout: sourceConnectTimeoutMs("ASKLAKE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
    user,
  });
  await client.connect();
  try {
    const tableResult = await client.query(
      "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name limit 20",
      [schema],
    );
    const table = tableSelector;
    if (!tableResult.rows.some((row) => row.table_name === table)) {
      throw apiError("POSTGRES_TABLE_NOT_FOUND", `${schema}.${table} 테이블을 찾지 못했습니다.`, 404);
    }

    const sample = await client.query(`select * from ${quoteIdent(schema)}.${quoteIdent(table)} limit ${samplePolicy.rowLimit}`);
    const columns = sample.fields.map((field) => field.name);
    const rows = sample.rows.map((row) => columns.map((column) => stringifyCell(row[column])));
    const parsedSample = { columns, format: "postgres", rows };
    const schemaColumns = inferSchemaColumns(parsedSample);
    const id = sourceId("source", `postgres://${host}:${port}/${database}/${schema}/${table}`);
    const runId = sourceId("run", `${id}:${Date.now()}`);
    const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
      ["Endpoint / Host", host],
      ["Port", String(port)],
      ["Database Name", database],
      ["Schema", schema],
      ["Username", user],
      ["__Schema Sample Scope", samplePolicy.scope],
      ["__Schema Sample Scope Label", samplePolicy.label],
      ["__Sample Row Limit", String(samplePolicy.rowLimit)],
      ["__Source ID", id],
      ["__Run ID", runId],
      ["__Source Unit Count", String(tableResult.rows.length)],
      ["DATASET OR TABLE SELECTOR", table],
    ]);

    return {
      actionPath: "/api/etl/sources/postgres/test",
      assets: tableResult.rows.map((row) => [row.table_name, schema, row.table_name === table ? "sampled" : "detected"]),
      draftPatch: {
        schema: {
          columns: schemaColumns,
          sampleRows: rows,
          schemaFingerprint: schemaFingerprint(schemaColumns),
          summary: `PostgreSQL 테이블 ${schema}.${table}에서 ${schemaColumns.length}개 필드 추론 · 프로파일 확인`,
        },
        source: {
          connectionMessage: `PostgreSQL 연결 성공: ${schema}.${table}`,
          connectionStatus: "success",
          sourceConfig,
          sourceLabel: `${host}:${port}/${database}/${schema}.${table}`,
          sourceType: "PostgreSQL",
        },
      },
      logs: [
        `PostgreSQL 연결 성공: ${host}:${port}/${database}`,
        `선택 테이블: ${schema}.${table}`,
        `프로파일 스냅샷 추론: ${schemaColumns.length}개 필드, 샘플 행 ${rows.length}개`,
        `샘플 범위 적용: ${samplePolicy.label} (최대 ${samplePolicy.rowLimit.toLocaleString()}행)`,
      ],
      message: `PostgreSQL 연결 성공: ${schema}.${table}`,
      previewColumns: columns,
      previewNote: `${schema}.${table}에서 가져온 첫 ${rows.length}행`,
      previewRows: rows,
      status: "success",
      testItems: [["Endpoint", `${host}:${port}`], ["Database", database], ["Table", `${schema}.${table}`]],
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function testMongoSource(fields) {
  const endpoint = process.env.ASKLAKE_MONGO_HOST || fieldValue(fields, "Endpoint / Host") || "127.0.0.1";
  const port = Number(process.env.ASKLAKE_MONGO_PORT || fieldValue(fields, "Port") || 27018);
  const database = fieldValue(fields, "Database Name") || process.env.ASKLAKE_MONGO_DATABASE || "asklake_sources";
  const username = process.env.ASKLAKE_MONGO_USER || fieldValue(fields, "Username") || "";
  const password = process.env.ASKLAKE_MONGO_PASSWORD || fieldValue(fields, "Password / Auth Token") || "";
  const collectionSelector = fieldValue(fields, "DATASET OR TABLE SELECTOR") || fieldValue(fields, "Collection");
  if (!collectionSelector) {
    throw apiError(
      "MONGO_COLLECTION_REQUIRED",
      "MongoDB collection selection is required before schema preview.",
      400,
    );
  }
  const samplePolicy = samplePolicyForFields(fields, "documents");
  const authPart = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const uri = process.env.ASKLAKE_MONGO_HOST
    ? `mongodb://${authPart}${endpoint}:${port}/${database}${username ? "?authSource=admin" : ""}`
    : fieldValue(fields, "Connection URI") || `mongodb://${authPart}${endpoint}:${port}/${database}${username ? "?authSource=admin" : ""}`;

  const { collection, collections, docs } = await runMongoDriverSample({ collectionSelector, database, rowLimit: samplePolicy.rowLimit, uri });
  if (!collection) throw apiError("MONGO_NO_COLLECTIONS", `${database} 데이터베이스에서 컬렉션을 찾지 못했습니다.`, 404);
  if (collectionSelector && !collections.includes(collectionSelector)) {
    throw apiError("MONGO_COLLECTION_NOT_FOUND", `${database}.${collectionSelector} 컬렉션을 찾지 못했습니다.`, 404);
  }

  const parsedSample = {
    columns: Array.from(new Set(docs.flatMap((doc) => Object.keys(flattenMongoDocument(doc))))),
    format: "mongodb",
    rows: [],
  };
  const flattenedDocs = docs.map((doc) => flattenMongoDocument(doc));
  parsedSample.rows = flattenedDocs.map((doc) => parsedSample.columns.map((column) => stringifyCell(doc[column])));
  const schemaColumns = inferSchemaColumns(parsedSample);
  const id = sourceId("source", `mongodb://${endpoint}:${port}/${database}/${collection}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Endpoint / Host", endpoint],
    ["Port", String(port)],
    ["Database Name", database],
    ["Username", username],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Row Limit", String(samplePolicy.rowLimit)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(collections.length)],
    ["DATASET OR TABLE SELECTOR", collection],
  ]);

  return {
    actionPath: "/api/etl/sources/mongodb/test",
    assets: collections.map((name) => [name, database, name === collection ? "sampled" : "detected"]),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary: `MongoDB 컬렉션 ${database}.${collection}에서 ${schemaColumns.length}개 필드 추론 · 문서 샘플 확인`,
      },
      source: {
        connectionMessage: `MongoDB 연결 성공: ${database}.${collection}`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel: `${endpoint}:${port}/${database}.${collection}`,
        sourceType: "MongoDB",
      },
    },
    logs: [
      `MongoDB 연결 성공: ${endpoint}:${port}/${database}`,
      `선택 컬렉션: ${database}.${collection}`,
      `문서 샘플 추론: ${schemaColumns.length}개 필드, 샘플 문서 ${docs.length}개`,
      `샘플 범위 적용: ${samplePolicy.label} (최대 ${samplePolicy.rowLimit.toLocaleString()}문서)`,
    ],
    message: `MongoDB 연결 성공: ${database}.${collection}`,
    previewColumns: parsedSample.columns,
    previewNote: `${database}.${collection}에서 가져온 첫 ${docs.length}개 문서`,
    previewRows: parsedSample.rows,
    status: "success",
    testItems: [["Endpoint", `${endpoint}:${port}`], ["Database", database], ["Collection", collection]],
  };
}

export async function testKafkaSource(fields, sourceType = "Stream / Kafka") {
  const { Kafka } = await loadKafkaJs();
  const broker = requiredSourceField(fields, "Broker / Endpoint", "Kafka broker endpoint is required.");
  const topic = requiredSourceField(fields, "TOPIC / QUEUE NAME", "Kafka topic name is required.");
  const configuredGroupId = fieldValue(fields, "CONSUMER GROUP ID") || "asklake-schema-preview";
  const sampleGroupId = `asklake-schema-preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const samplePolicy = samplePolicyForFields(fields, "rows");
  const kafka = new Kafka({
    brokers: [broker],
    clientId: "asklake-source-test",
    connectionTimeout: sourceConnectTimeoutMs("ASKLAKE_KAFKA_CONNECT_TIMEOUT_MS", 3000),
    requestTimeout: sourceConnectTimeoutMs("ASKLAKE_KAFKA_REQUEST_TIMEOUT_MS", 5000),
    retry: { retries: 0 },
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const topicMeta = metadata.topics.find((item) => item.name === topic);
    if (!topicMeta || topicMeta.partitions.length === 0) {
      throw apiError("KAFKA_TOPIC_NOT_FOUND", `${topic} Kafka 토픽을 찾지 못했거나 파티션이 없습니다.`, 404);
    }
    const messages = await sampleKafkaMessages({ broker, groupId: sampleGroupId, rowLimit: Math.min(samplePolicy.rowLimit, 100), topic });
    const parsedSample = parseKafkaMessages(topic, messages, samplePolicy.rowLimit);
    const schemaColumns = inferSchemaColumns(parsedSample);

    const id = sourceId("source", `kafka://${broker}/${topic}`);
    const runId = sourceId("run", `${id}:${Date.now()}`);
    const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
      ["Broker / Endpoint", broker],
      ["TOPIC / QUEUE NAME", topic],
      ["CONSUMER GROUP ID", configuredGroupId],
      ["__Sample Consumer Group ID", sampleGroupId],
      ["__Schema Sample Scope", samplePolicy.scope],
      ["__Schema Sample Scope Label", samplePolicy.label],
      ["__Sample Row Limit", String(samplePolicy.rowLimit)],
      ["__Source ID", id],
      ["__Run ID", runId],
      ["__Source Unit Count", String(topicMeta.partitions.length)],
    ]);

    return {
      actionPath: "/api/etl/sources/kafka/test",
      assets: topicMeta.partitions.map((partition) => [
        `${topic}:${partition.partitionId}`,
        `leader ${partition.leader}`,
        "metadata reachable",
      ]),
      draftPatch: {
        schema: {
          columns: schemaColumns,
          sampleRows: parsedSample.rows,
          schemaFingerprint: schemaFingerprint(schemaColumns),
          summary: schemaColumns.length
            ? `Kafka ${parsedSample.format} 메시지 샘플에서 ${schemaColumns.length}개 필드 추론 · ${messages.length}개 메시지 확인`
            : `Kafka 토픽 접근 성공: ${topic} · 샘플 메시지 없음`,
        },
        source: {
          connectionMessage: `Kafka 토픽 연결 성공: ${topic}`,
          connectionStatus: "success",
          sourceConfig,
          sourceLabel: `${broker}/${topic}`,
          sourceType,
        },
      },
      logs: [
        `Kafka 브로커 핸드셰이크 성공: ${broker}`,
        `토픽 메타데이터 조회: ${topic}`,
        messages.length > 0
          ? `제한 메시지 샘플 조회: ${messages.length}개`
          : "샘플 메시지를 제한 시간 안에 읽지 못했습니다.",
        schemaColumns.length > 0
          ? `페이로드 스키마 추론: ${schemaColumns.length}개 필드`
          : "페이로드 스키마는 메시지가 들어오면 추론됩니다.",
      ],
      message: `Kafka 토픽 연결 성공: ${topic}`,
      previewColumns: parsedSample.columns.length ? parsedSample.columns : ["Topic", "Partition", "Leader"],
      previewNote: parsedSample.rows.length ? `${topic}에서 가져온 제한 메시지 샘플` : "Kafka 메타데이터 미리보기입니다.",
      previewRows: parsedSample.rows.length
        ? parsedSample.rows
        : topicMeta.partitions.map((partition) => [topic, String(partition.partitionId), String(partition.leader)]),
      status: "success",
      testItems: [["Broker", broker], ["Topic", topic], ["Partitions", String(topicMeta.partitions.length)]],
    };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function buildObjectStorageAnalysis({ bucket, client, endpoint, fields, forcePathStyle, objects, prefix, region, sampleObject, samplePolicy, selectedObject = "", sourceType }) {
  const logs = [
    `MinIO/S3 오브젝트 목록 조회 성공: bucket=${bucket}, prefix=${prefix || "(root)"}`,
    `소스 단위 감지: ${objects.length}개`,
  ];

  let parsedSample = { columns: [], format: "unknown", rows: [] };
  let sampleKey = "";
  let requestedBytes = 0;
  if (sampleObject?.Key && hasTextExtension(sampleObject.Key)) {
    sampleKey = sampleObject.Key;
    const objectSize = Number(sampleObject.Size ?? 0);
    requestedBytes = sampleObjectRangeBytes(samplePolicy, objectSize);
    const objectResult = await client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: sampleObject.Key,
      Range: requestedBytes > 0 ? `bytes=0-${Math.max(0, requestedBytes - 1)}` : undefined,
    }));
    const text = await readBodyTextWithinLimit(objectResult.Body, requestedBytes);
    parsedSample = parseSourceSample(sampleObject.Key, text ?? "", { maxRows: samplePolicy.rowLimit });
    logs.push(`제한 샘플 조회: ${sampleObject.Key}`);
    logs.push(`샘플 범위 적용: ${samplePolicy.label} (${formatBytes(requestedBytes)} 요청, 최대 ${samplePolicy.rowLimit.toLocaleString()}행 프로파일)`);
    logs.push(`프로파일 스냅샷 추론: ${parsedSample.columns.length}개 필드, 샘플 행 ${parsedSample.rows.length}개`);
  } else if (sampleObject?.Key) {
    sampleKey = sampleObject.Key;
    logs.push(`샘플 오브젝트가 텍스트 오브젝트가 아닙니다: ${sampleObject.Key}`);
  } else {
    logs.push("버킷 접근은 성공했지만 프리픽스와 일치하는 오브젝트가 없습니다.");
  }

  const id = sourceId("source", `${endpoint}:${bucket}:${prefix}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const schemaColumns = inferSchemaColumns(parsedSample);
  const summary = schemaColumns.length
    ? `MinIO/S3 ${parsedSample.format} 샘플에서 ${schemaColumns.length}개 필드 추론 · 프로파일 확인`
    : `MinIO/S3 연결 성공 · 스키마 추론 대기 (오브젝트 ${objects.length}개)`;
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Storage Provider", isMinioProvider(fields) ? "MinIO" : "Amazon S3"],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Bucket / Stage Name", bucket],
    ["Path / Prefix", prefix],
    ["Use Path Style", String(forcePathStyle)],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Row Limit", String(samplePolicy.rowLimit)],
    ["__Sample Requested Bytes", String(requestedBytes)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sampleKey],
    ["__Selected Object", selectedObject],
  ]);
  const sourceLabel = `${bucket}${prefix ? `/${prefix}` : ""}`;

  return {
    actionPath: "/api/etl/sources/minio/test",
    assets: toSourceAssets(objects),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary,
      },
      source: {
        connectionMessage: `MinIO/S3 연결 성공: ${sourceLabel} (오브젝트 ${objects.length}개)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel,
        sourceType,
      },
    },
    logs,
    message: `MinIO/S3 연결 성공: 오브젝트 ${objects.length}개`,
    previewColumns: parsedSample.columns.length ? parsedSample.columns : ["Object Key", "Size", "Last Modified"],
    previewNote: sampleKey ? `${sampleKey}에서 가져온 제한 샘플` : `MinIO/S3 오브젝트 ${objects.length}개 목록 조회`,
    previewRows: parsedSample.rows.length
      ? parsedSample.rows
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", item.__folder ? "folder" : formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Endpoint", endpoint], ["Bucket", bucket], ["Immediate children", String(objects.length)]],
  };
}

function readObjectStorageViaMinioContainer({ accessKeyId, bucket, endpoint, fields, prefix, samplePolicy, secretAccessKey, selectedObject = "", sourceType = "File / S3" }) {
  const objects = selectedObject
    ? listSelectedObjectViaMinioContainer({ accessKeyId, bucket, endpoint, key: selectedObject, secretAccessKey })
    : listDirectObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, prefix, secretAccessKey });
  if (!objects) return null;

  const sampleObject = selectedObject ? objects.find((item) => item.Key === selectedObject) : immediateSampleObject(objects, prefix);
  let parsedSample = { columns: [], format: "unknown", rows: [] };
  let sampleKey = "";
  let requestedBytes = 0;
  const logs = [
    `MinIO 컨테이너에서 실제 오브젝트 목록 조회: bucket=${bucket}, prefix=${prefix || "(root)"}`,
    `감지된 오브젝트: ${objects.length}개`,
  ];

  if (sampleObject?.Key && hasTextExtension(sampleObject.Key)) {
    sampleKey = sampleObject.Key;
    requestedBytes = sampleObjectRangeBytes(samplePolicy, Number(sampleObject.Size ?? 0));
    const text = readObjectSampleViaMinioContainer({
      accessKeyId,
      bucket,
      bytes: requestedBytes,
      key: sampleObject.Key,
      secretAccessKey,
    });
    parsedSample = parseSourceSample(sampleObject.Key, text ?? "", { maxRows: samplePolicy.rowLimit });
    logs.push(`제한 샘플 조회: ${sampleObject.Key}`);
    logs.push(`샘플 범위 적용: ${samplePolicy.label} (${formatBytes(requestedBytes)} 요청, 최대 ${samplePolicy.rowLimit.toLocaleString()}행 프로파일)`);
    logs.push(`프로파일 스키마 추론: ${parsedSample.columns.length}개 필드, 샘플 행 ${parsedSample.rows.length}개`);
  } else if (sampleObject?.Key) {
    sampleKey = sampleObject.Key;
    logs.push(`샘플 오브젝트가 텍스트 파일이 아닙니다: ${sampleObject.Key}`);
  } else {
    logs.push("버킷 접근은 성공했지만 prefix와 일치하는 오브젝트가 없습니다.");
  }

  const id = sourceId("source", `${endpoint}:${bucket}:${prefix}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const schemaColumns = inferSchemaColumns(parsedSample);
  const summary = schemaColumns.length
    ? `MinIO/S3 ${parsedSample.format} 샘플에서 ${schemaColumns.length}개 필드 추론 · 프로파일 확인`
    : `MinIO/S3 연결 성공 · 스키마 추론 대기(오브젝트 ${objects.length}개)`;
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Endpoint URL", endpoint],
    ["Bucket / Stage Name", bucket],
    ["Path / Prefix", prefix],
    ["Use Path Style", "true"],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Row Limit", String(samplePolicy.rowLimit)],
    ["__Sample Requested Bytes", String(requestedBytes)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sampleKey],
    ["__Selected Object", selectedObject],
    ["__MinIO Runtime", "docker-container"],
  ]);
  const sourceLabel = `${bucket}${prefix ? `/${prefix}` : ""}`;

  return {
    actionPath: "/api/etl/sources/minio/test",
    assets: toSourceAssets(objects),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint: schemaFingerprint(schemaColumns),
        summary,
      },
      source: {
        connectionMessage: `MinIO/S3 연결 성공: ${sourceLabel} (오브젝트 ${objects.length}개)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel,
        sourceType,
      },
    },
    logs,
    message: `MinIO/S3 연결 성공: 오브젝트 ${objects.length}개`,
    previewColumns: parsedSample.columns.length ? parsedSample.columns : ["Object Key", "Size", "Last Modified"],
    previewNote: sampleKey ? `${sampleKey}에서 가져온 제한 샘플` : `MinIO/S3 오브젝트 ${objects.length}개 목록 조회`,
    previewRows: parsedSample.rows.length
      ? parsedSample.rows
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", item.__folder ? "folder" : formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Endpoint", endpoint], ["Bucket", bucket], ["Immediate children", String(objects.length)]],
  };
}

function s3Client(config) {
  return new S3Client({
    ...s3ClientOptions(config),
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: sourceConnectTimeoutMs("ASKLAKE_S3_CONNECT_TIMEOUT_MS", 800),
      requestTimeout: sourceConnectTimeoutMs("ASKLAKE_S3_REQUEST_TIMEOUT_MS", 2500),
    }),
  });
}

async function listObjects(client, bucket, prefix) {
  const normalizedPrefix = normalizePrefix(prefix);
  const limit = sourceListLimit();
  const objects = [];
  let continuationToken;

  do {
    const remaining = Math.max(1, limit - objects.length);
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: Math.min(1000, remaining),
      Prefix: normalizedPrefix,
    }));
    objects.push(...(result.Contents ?? [])
      .filter((item) => item.Key && item.Key !== `${normalizedPrefix}/`));
    continuationToken = result.IsTruncated && objects.length < limit ? result.NextContinuationToken : undefined;
  } while (continuationToken && objects.length < limit);

  return objects;
}

async function listSelectedObject(client, bucket, key) {
  const normalizedKey = normalizePrefix(key);
  if (!normalizedKey) return [];
  const result = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    MaxKeys: 1,
    Prefix: normalizedKey,
  }));
  const exact = (result.Contents ?? []).find((item) => item.Key === normalizedKey);
  if (!exact) {
    throw apiError("SOURCE_OBJECT_NOT_FOUND", `Selected object was not found: ${normalizedKey}`, 404);
  }
  return [{ ...exact, __folder: false }];
}

function sourceAssetPrefix(sourceType, fields, requestedPrefix) {
  if (typeof requestedPrefix === "string" && requestedPrefix.trim()) return normalizeAssetPrefix(requestedPrefix);
  const parsedLakePath = dataLakeSourceTypes.has(sourceType) ? parseS3Path(fieldValue(fields, "Path")) : null;
  const selectedObject = selectedObjectKey(fields);
  return safeAssetConfigPrefix(fieldValue(fields, "Path / Prefix") || parsedLakePath?.prefix || fieldValue(fields, "Path"), selectedObject);
}

function normalizeAssetPrefix(value) {
  const parsed = parseS3Path(value);
  return normalizePrefix(parsed?.prefix ?? value);
}

function safeAssetConfigPrefix(value, selectedObject) {
  const normalized = normalizeAssetPrefix(value);
  if (!normalized) return "";
  const normalizedSelectedObject = normalizePrefix(selectedObject);
  if ((normalizedSelectedObject && normalized === normalizedSelectedObject) || looksLikeObjectKey(normalized)) {
    return parentPrefix(normalized);
  }
  return normalized;
}

function parentPrefix(value) {
  const parts = normalizePrefix(value).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function looksLikeObjectKey(value) {
  return /\.(csv|json|jsonl|log|parquet|tsv|txt)$/i.test(String(value ?? "").trim());
}

function sourceListLimit() {
  return configuredListLimit("ASKLAKE_SOURCE_LIST_LIMIT", 5000);
}

function sourceAssetListLimit() {
  return Math.min(configuredListLimit("ASKLAKE_SOURCE_ASSET_LIST_LIMIT", 200), 1000);
}

function sourceConnectTimeoutMs(envName, defaultMs) {
  const configured = Number(process.env[envName] ?? defaultMs);
  if (!Number.isFinite(configured) || configured <= 0) return defaultMs;
  return Math.trunc(configured);
}

function sourceAssetCacheKey({ accessKeyId, bucket, endpoint, forcePathStyle, prefix, region, sourceType }) {
  return JSON.stringify({
    accessKeyId,
    bucket,
    endpoint,
    forcePathStyle: Boolean(forcePathStyle),
    prefix: normalizePrefix(prefix),
    region,
    sourceType,
  });
}

function getCachedSourceAssets(key) {
  const cached = sourceAssetCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    sourceAssetCache.delete(key);
    return null;
  }
  return { ...cached.value, assets: [...cached.value.assets] };
}

function setCachedSourceAssets(key, value) {
  sourceAssetCache.set(key, {
    expiresAt: Date.now() + sourceConnectTimeoutMs("ASKLAKE_SOURCE_ASSET_CACHE_TTL_MS", 30000),
    value: { ...value, assets: [...value.assets] },
  });
  if (sourceAssetCache.size > 200) {
    const oldestKey = sourceAssetCache.keys().next().value;
    if (oldestKey) sourceAssetCache.delete(oldestKey);
  }
}

function getCachedSourceAssetFailure(key) {
  const cached = sourceAssetFailureCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    sourceAssetFailureCache.delete(key);
    return null;
  }
  return apiError(cached.code, cached.message, cached.status);
}

function setCachedSourceAssetFailure(key, error) {
  const status = Number(error?.status || 502);
  sourceAssetFailureCache.set(key, {
    code: typeof error?.code === "string" ? error.code : "SOURCE_ASSET_LIST_FAILED",
    expiresAt: Date.now() + sourceConnectTimeoutMs("ASKLAKE_SOURCE_ASSET_FAILURE_CACHE_TTL_MS", 10000),
    message: error?.message || "Source asset listing failed.",
    status,
  });
  if (sourceAssetFailureCache.size > 200) {
    const oldestKey = sourceAssetFailureCache.keys().next().value;
    if (oldestKey) sourceAssetFailureCache.delete(oldestKey);
  }
}

function configuredListLimit(envName, defaultLimit) {
  const configured = Number(process.env[envName] ?? defaultLimit);
  if (!Number.isFinite(configured) || configured <= 0) return defaultLimit;
  return Math.trunc(configured);
}

function configuredInlineLimit(value, defaultLimit) {
  const configured = Number(value ?? defaultLimit);
  if (!Number.isFinite(configured) || configured <= 0) return defaultLimit;
  return Math.trunc(configured);
}

function immediateSampleObject(objects, prefix) {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  return objects.find((item) => {
    const key = String(item.Key ?? "");
    if (!hasTextExtension(key)) return false;
    if (!key) return false;
    if (normalizedPrefix && (key === normalizedPrefix || key === normalizedPrefixWithSlash)) return true;
    const relative = normalizedPrefix
      ? (key.startsWith(normalizedPrefixWithSlash) ? key.slice(normalizedPrefixWithSlash.length) : "")
      : key;
    return relative.length > 0 && !relative.includes("/");
  });
}

function immediateCollectionSampleObject(objects, prefix, pattern) {
  return immediateSampleObject(objects.filter((item) => collectionPatternMatches(item.Key, pattern)), prefix);
}

async function findRecursiveCollectionSampleObject(client, bucket, prefix, pattern) {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  const limit = sourceAssetListLimit();
  let continuationToken;
  let scanned = 0;
  do {
    const remaining = Math.max(1, limit - scanned);
    const result = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      MaxKeys: Math.min(200, remaining),
      Prefix: normalizedPrefixWithSlash || normalizedPrefix,
    }));
    const contents = result.Contents ?? [];
    scanned += contents.length;
    const sample = contents.find((item) => (
      item.Key
      && item.Key !== normalizedPrefixWithSlash
      && hasTextExtension(item.Key)
      && collectionPatternMatches(item.Key, pattern)
    ));
    if (sample) return { ...sample, __folder: false };
    continuationToken = result.IsTruncated && scanned < limit ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return undefined;
}

function collectionPatternMatches(key, pattern) {
  const normalizedPattern = String(pattern || "*").trim() || "*";
  const fileName = String(key || "").split("/").pop() || "";
  let source = "^";
  for (const character of normalizedPattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`, "i").test(fileName);
}

function browsableObjectStorageItems(objects, prefix) {
  const normalizedPrefix = normalizePrefix(prefix);
  const folders = new Map();
  const files = [];
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  for (const item of objects) {
    const key = String(item.Key ?? "");
    if (!key) continue;
    if (normalizedPrefix && (key === normalizedPrefix || key === `${normalizedPrefix}/`)) {
      continue;
    }
    if (normalizedPrefix && !key.startsWith(normalizedPrefixWithSlash)) {
      continue;
    }
    const relative = (normalizedPrefix ? key.slice(normalizedPrefixWithSlash.length) : key).replace(/^\/+/, "");
    if (!relative) continue;
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const folderKey = `${normalizedPrefixWithSlash}${parts.slice(0, index + 1).join("/")}/`;
      if (!folders.has(folderKey)) {
        folders.set(folderKey, { __folder: true, Key: folderKey, LastModified: item.LastModified, Size: 0 });
      }
    }
    if (!item.__folder && !key.endsWith("/")) {
      files.push(item);
    }
  }
  return [...folders.values(), ...files].sort((left, right) => String(left.Key ?? "").localeCompare(String(right.Key ?? "")));
}

function listObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, limit = sourceListLimit(), prefix, secretAccessKey }) {
  const normalizedPrefix = normalizePrefix(prefix);
  const maxItems = configuredInlineLimit(limit, sourceListLimit());
  const target = `local/${bucket}/${normalizedPrefix ? `${normalizedPrefix}/` : ""}`;
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  const result = runMinioClientCommand({
    accessKeyId,
    command: `mc ls --json ${shellQuote(target)} | head -n ${maxItems}`,
    endpoint,
    secretAccessKey,
  });
  if (!result) return null;

  const root = `local/${bucket}/`;
  return result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((item) => item?.status === "success" && item.key)
    .map((item) => {
      const rawKey = String(item.key);
      const normalizedKey = rawKey.startsWith(root) ? rawKey.slice(root.length) : rawKey.replace(/^\/+/, "");
      const key = normalizedPrefix
        ? (normalizedKey.startsWith(normalizedPrefixWithSlash) ? normalizedKey : `${normalizedPrefixWithSlash}${normalizedKey}`)
        : normalizedKey;
      return {
        __folder: item.type === "folder" || String(item.key).endsWith("/"),
        Key: key,
        LastModified: item.lastModified ? new Date(item.lastModified) : undefined,
        Size: Number(item.size ?? 0),
      };
    });
}

function listDirectObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, limit = sourceListLimit(), prefix, secretAccessKey }) {
  return listObjectsViaMinioContainer({ accessKeyId, bucket, endpoint, limit, prefix, secretAccessKey });
}

function listSelectedObjectViaMinioContainer({ accessKeyId, bucket, endpoint, key, secretAccessKey }) {
  const normalizedKey = normalizePrefix(key);
  if (!normalizedKey) return [];
  const result = runMinioClientCommand({
    accessKeyId,
    command: `mc stat --json ${shellQuote(`local/${bucket}/${normalizedKey}`)}`,
    endpoint,
    secretAccessKey,
  });
  if (!result) return null;
  const line = result.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  try {
    const item = JSON.parse(line);
    return [{
      __folder: false,
      Key: normalizedKey,
      LastModified: item.lastModified ? new Date(item.lastModified) : undefined,
      Size: Number(item.size ?? 0),
    }];
  } catch {
    return null;
  }
}

async function listDirectObjects(client, bucket, prefix, limit = sourceListLimit()) {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedPrefixWithSlash = normalizedPrefix ? `${normalizedPrefix}/` : "";
  const maxItems = configuredInlineLimit(limit, sourceListLimit());
  const result = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Delimiter: "/",
    MaxKeys: Math.min(1000, maxItems),
    Prefix: normalizedPrefixWithSlash || normalizedPrefix,
  }));
  const folders = (result.CommonPrefixes ?? []).map((item) => ({
    __folder: true,
    Key: item.Prefix,
    LastModified: undefined,
    Size: 0,
  }));
  const files = (result.Contents ?? [])
    .filter((item) => item.Key && item.Key !== normalizedPrefix && item.Key !== normalizedPrefixWithSlash)
    .map((item) => ({ ...item, __folder: false }));
  return [...folders, ...files].sort((left, right) => String(left.Key ?? "").localeCompare(String(right.Key ?? "")));
}

function toSourceAssets(items, limit = sourceListLimit()) {
  return items.slice(0, configuredInlineLimit(limit, sourceListLimit())).map((item, index) => [
    item.Key ?? `object-${index + 1}`,
    item.__folder ? "folder" : formatBytes(item.Size ?? 0),
    item.LastModified ? item.LastModified.toISOString() : "listed",
  ]);
}

function readObjectSampleViaMinioContainer({ accessKeyId, bucket, bytes, key, secretAccessKey }) {
  const byteLimit = Math.max(1, Math.trunc(Number(bytes) || 512 * 1024));
  const target = `local/${bucket}/${key}`;
  return runMinioClientCommand({
    accessKeyId,
    command: `mc cat ${shellQuote(target)} | head -c ${byteLimit}`,
    secretAccessKey,
  }) ?? "";
}

function runMinioClientCommand({ accessKeyId, command, endpoint = "http://127.0.0.1:9000", secretAccessKey }) {
  if (process.env.ASKLAKE_MINIO_DOCKER_FALLBACK === "false") return null;
  const container = process.env.ASKLAKE_MINIO_CONTAINER || "m3-minio";
  const minioEndpoint = process.env.ASKLAKE_MINIO_CONTAINER_ENDPOINT || endpointForMinioContainer(endpoint);
  const failureKey = `${container}:${minioEndpoint}`;
  const failureUntil = minioDockerFailureCache.get(failureKey) ?? 0;
  if (failureUntil > Date.now()) return null;
  const accessKey = accessKeyId || process.env.MINIO_ACCESS_KEY || process.env.MINIO_ROOT_USER || "m3admin";
  const secretKey = secretAccessKey || process.env.MINIO_SECRET_KEY || process.env.MINIO_ROOT_PASSWORD || "wishuponastar";
  const script = [
    `mc alias set local ${shellQuote(minioEndpoint)} ${shellQuote(accessKey)} ${shellQuote(secretKey)} >/dev/null`,
    command,
  ].join(" && ");
  const result = spawnSync("docker", ["exec", "-i", container, "sh", "-lc", script], {
    encoding: "utf8",
    env: { ...process.env, MC_QUIET: "1", MC_DISABLE_PAGER: "1" },
    maxBuffer: 32 * 1024 * 1024,
    timeout: sourceConnectTimeoutMs("ASKLAKE_MINIO_DOCKER_TIMEOUT_MS", 5000),
  });
  if (result.status !== 0) {
    minioDockerFailureCache.set(
      failureKey,
      Date.now() + sourceConnectTimeoutMs("ASKLAKE_MINIO_DOCKER_FAILURE_CACHE_MS", 30000),
    );
    return null;
  }
  minioDockerFailureCache.delete(failureKey);
  return result.stdout ?? "";
}

function endpointForMinioContainer(endpoint) {
  const value = String(endpoint || "");
  return value;
}

function inspectParquetLakeWithSpark({ fields = [], path: sourcePath, rowLimit }) {
  const runtime = createSparkRuntime(process.env, {
    [SPARK_RUNTIME_IDS.DOCKER]: {
      [SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT]: inspectParquetLakeWithSparkDocker,
    },
    [SPARK_RUNTIME_IDS.SPARK_REST]: {
      [SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT]: inspectParquetLakeWithSparkRest,
    },
  });
  const executionMode = runtime.legacyRunner;
  mkdirSync(ivyDir, { recursive: true });
  const storageFields = upsertFields(fields, [
    ["Endpoint URL", isMinioProvider(fields) ? endpointForDockerNetwork(fieldValue(fields, "Endpoint URL")) : fieldValue(fields, "Endpoint URL")],
  ]);
  const requestedStorage = resolveObjectStorageConfig(storageFields, { docker: true });
  const inheritedStorage = resolveObjectStorageConfig([], { docker: true });
  if (
    executionMode === "rest"
    && requestedStorage.provider === "minio"
    && ((requestedStorage.accessKeyId && requestedStorage.accessKeyId !== inheritedStorage.accessKeyId)
      || (requestedStorage.secretAccessKey && requestedStorage.secretAccessKey !== inheritedStorage.secretAccessKey))
  ) {
    throw apiError(
      "DATALAKE_SPARK_CREDENTIAL_CONFIGURATION_INVALID",
      "Spark REST source inspection only supports MinIO application credentials inherited by the worker.",
      422,
    );
  }
  const storageEnvironment = Object.fromEntries(
    objectStorageDockerEnv(storageFields).filter(([name]) => (
      executionMode === "docker"
      || !["MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"].includes(name)
    )),
  );
  const inspectEnvironment = {
    ...storageEnvironment,
    ASKLAKE_SOURCE_PATH: toS3APath(sourcePath),
    ASKLAKE_SOURCE_FORMAT: "parquet",
    ASKLAKE_SOURCE_ROW_LIMIT: Math.max(1, Math.min(Number(rowLimit) || 10, 50000)),
    HOME: "/tmp",
  };
  const inspected = runtime.execute(SPARK_RUNTIME_OPERATIONS.SOURCE_INSPECT, { inspectEnvironment });
  const columns = Array.isArray(inspected.columns) ? inspected.columns : [];
  const sampleRows = Array.isArray(inspected.rows) ? inspected.rows : [];
  const schemaColumns = columns.map((column, index) => ({
    confidence: 95,
    nullable: column.nullable !== false,
    role: undefined,
    sourceName: column.name || `column_${index + 1}`,
    targetName: normalizeSparkColumnName(column.name || `column_${index + 1}`),
    type: sparkLogicalType(column.type),
  }));
  return {
    logs: [
      `Spark Parquet 스키마 추론 성공: ${schemaColumns.length}개 필드`,
      `제한 샘플 조회: ${sampleRows.length.toLocaleString()}행`,
      `샘플 범위 적용: 최대 ${(Number(rowLimit) || 10).toLocaleString()}행`,
    ],
    sampleRows,
    schemaColumns,
  };
}

function inspectParquetLakeWithSparkRest({ inspectEnvironment }) {
  mkdirSync(sparkReportDir, { recursive: true });
  const reportName = `source-inspect-${randomUUID()}.json`;
  const reportPath = path.join(sparkReportDir, reportName);
  const statePath = path.join(sparkReportDir, reportName.replace(/\.json$/, ".spark-rest-state.json"));
  const reportRuntimePath = path.posix.join(
    String(sparkReportRuntimeDir).replace(/\\/g, "/"),
    reportName,
  );
  rmSync(reportPath, { force: true });
  const result = runSparkRestSubmission(
    createSparkSourceInspectRestSubmission({
      environmentVariables: {
        ...inspectEnvironment,
        ASKLAKE_SOURCE_INSPECT_REPORT_FILE: reportRuntimePath,
      },
    }),
    sourceInspectTimeoutMs(),
    process.env,
    { stateFile: statePath },
  );
  const output = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.message || ""}`;
  try {
    if (result.status !== 0) {
      throw apiError(
        "DATALAKE_SCHEMA_INFERENCE_FAILED",
        `데이터 레이크 Parquet 스키마 추론에 실패했습니다: ${tail(output)}`,
        502,
      );
    }
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    if (error?.code === "DATALAKE_SCHEMA_INFERENCE_FAILED") throw error;
    throw apiError(
      "DATALAKE_SCHEMA_INFERENCE_FAILED",
      `데이터 레이크 Parquet 검사 결과를 읽지 못했습니다: ${error?.message || error}`,
      502,
    );
  } finally {
    rmSync(reportPath, { force: true });
  }
}

function inspectParquetLakeWithSparkDocker({ inspectEnvironment }) {
  const dockerArgs = [
    "run",
    "--rm",
    "--network",
    process.env.ASKLAKE_DOCKER_NETWORK || "asklake_default",
    "-v",
    `${scriptsDir}:/work/scripts:ro`,
    "-v",
    `${ivyDir}:/tmp/.ivy2`,
    ...Object.entries(inspectEnvironment).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    process.env.ASKLAKE_SPARK_IMAGE || "apache/spark:4.0.1",
    "/opt/spark/bin/spark-submit",
    "--master",
    process.env.ASKLAKE_SOURCE_INSPECT_SPARK_MASTER || "local[1]",
    "--conf",
    "spark.jars.ivy=/tmp/.ivy2",
    "--packages",
    process.env.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE || "org.apache.hadoop:hadoop-aws:3.4.1",
    "/work/scripts/spark_source_inspect.py",
  ];
  const result = spawnSync("docker", dockerArgs, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: sourceInspectTimeoutMs(),
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const marker = output.split(/\r?\n/).findLast((line) => line.startsWith("ASKLAKE_SOURCE_INSPECT="));
  if (result.status !== 0 || !marker) {
    throw apiError(
      "DATALAKE_SCHEMA_INFERENCE_FAILED",
      `데이터 레이크 Parquet 스키마 추론에 실패했습니다: ${tail(output)}`,
      502,
    );
  }
  return JSON.parse(marker.slice("ASKLAKE_SOURCE_INSPECT=".length));
}

function requireMinioCredentials(config) {
  if (config.provider !== "minio") return;
  if (!config.endpoint) {
    throw apiError("SOURCE_FIELD_REQUIRED", "MinIO endpoint URL is required.", 400);
  }
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw apiError("SOURCE_CREDENTIALS_REQUIRED", "MinIO access key and secret key are required.", 400);
  }
}

export function createSparkSourceInspectRestSubmission({ environmentVariables }, environment = process.env) {
  const runtime = sparkRestRuntimeConfig(environment);
  const hadoopPackage = environment.ASKLAKE_SPARK_HADOOP_AWS_PACKAGE
    || "org.apache.hadoop:hadoop-aws:3.4.1";
  return createSparkRestSubmission({
    appName: "asklake-source-inspect",
    environmentVariables,
    packages: hadoopPackage === "none" ? [] : [hadoopPackage],
    scriptPath: runtime.sourceInspectScript,
  }, environment);
}

function sourceInspectTimeoutMs() {
  const configured = Number(process.env.ASKLAKE_SOURCE_INSPECT_TIMEOUT_MS || 90_000);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 90_000;
}

function endpointForDockerNetwork(endpoint) {
  const value = String(endpoint || "");
  if (value.includes("127.0.0.1:9000") || value.includes("localhost:9000")) {
    return process.env.ASKLAKE_MINIO_CONTAINER_ENDPOINT || "http://m3-minio:9000";
  }
  return value;
}

async function inspectParquetObjectWithJs({ bucket, client, key, rowLimit }) {
  if (!key) throw new Error("Parquet sample key is required.");
  const parquet = await import("parquetjs-lite");
  const objectResult = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const buffer = await readBodyBufferWithinLimit(objectResult.Body, Number(process.env.ASKLAKE_PARQUET_JS_MAX_BYTES || 64 * 1024 * 1024));
  const reader = await parquet.default.ParquetReader.openBuffer(buffer);
  try {
    const schema = reader.getSchema();
    const fieldEntries = Object.entries(schema.fields ?? {});
    const cursor = reader.getCursor();
    const rows = [];
    for (let index = 0; index < Math.max(1, Math.min(Number(rowLimit) || 10, 100)); index += 1) {
      const row = await cursor.next();
      if (!row) break;
      rows.push(fieldEntries.map(([name]) => stringifyCell(row[name])));
    }
    return {
      logs: [
        `JS Parquet metadata fallback succeeded: ${fieldEntries.length} fields`,
        `제한 샘플 조회: ${rows.length.toLocaleString()}행`,
      ],
      sampleRows: rows,
      schemaColumns: fieldEntries.map(([name, field]) => ({
        confidence: 88,
        nullable: field?.optional !== false,
        role: undefined,
        sourceName: name,
        targetName: normalizeSparkColumnName(name),
        type: parquetJsLogicalType(name, field),
      })),
    };
  } finally {
    await reader.close().catch(() => undefined);
  }
}

async function sampleKafkaMessages({ broker, groupId, rowLimit, topic }) {
  const { Kafka } = await loadKafkaJs();
  const kafka = new Kafka({
    brokers: [broker],
    clientId: "asklake-source-sampler",
    connectionTimeout: sourceConnectTimeoutMs("ASKLAKE_KAFKA_CONNECT_TIMEOUT_MS", 3000),
    requestTimeout: sourceConnectTimeoutMs("ASKLAKE_KAFKA_REQUEST_TIMEOUT_MS", 5000),
    retry: { retries: 0 },
  });
  const consumer = kafka.consumer({ groupId });
  const messages = [];
  const timeoutMs = sourceConnectTimeoutMs("ASKLAKE_KAFKA_SAMPLE_TIMEOUT_MS", 8000);
  const idleMs = sourceConnectTimeoutMs("ASKLAKE_KAFKA_SAMPLE_IDLE_MS", 500);
  const minimumMessages = Math.min(
    rowLimit,
    sourceConnectTimeoutMs("ASKLAKE_KAFKA_SAMPLE_MIN_MESSAGES", 3),
  );
  const settleMs = sourceConnectTimeoutMs("ASKLAKE_KAFKA_SAMPLE_SETTLE_MS", 1500);
  await consumer.connect();
  try {
    await consumer.subscribe({ fromBeginning: true, topic });
    await new Promise((resolve, reject) => {
      let idleTimer;
      let settleTimer;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (error) reject(error);
        else resolve();
      };
      const timeoutTimer = setTimeout(finish, timeoutMs);
      consumer.run({
        eachMessage: async ({ message }) => {
          if (messages.length >= rowLimit) return;
          const value = message.value?.toString("utf8") ?? "";
          if (value.trim()) messages.push(value);
          if (messages.length >= rowLimit) {
            finish();
            return;
          }
          if (!settleTimer) settleTimer = setTimeout(finish, settleMs);
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (messages.length >= minimumMessages) finish();
          }, idleMs);
        },
      }).catch((error) => finish(error));
    });
  } finally {
    await consumer.disconnect().catch(() => undefined);
  }
  return messages;
}

function parseKafkaMessages(topic, messages, rowLimit) {
  if (messages.length === 0) return { columns: [], format: "kafka", rows: [] };
  const text = messages.join("\n");
  const first = messages[0]?.trim() ?? "";
  if (first.startsWith("{") || first.startsWith("[")) {
    return parseSourceSample(`${topic}.jsonl`, text, { maxRows: rowLimit });
  }
  if (first.includes(",") || topic.toLowerCase().endsWith(".csv")) {
    return parseSourceSample(`${topic}.csv`, text, { maxRows: rowLimit });
  }
  return parseSourceSample(`${topic}.txt`, text, { maxRows: rowLimit });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function parseS3Path(path) {
  const match = String(path).match(/^s3a?:\/\/([^/]+)\/?(.*)$/);
  if (!match) return null;
  return { bucket: match[1], prefix: normalizePrefix(match[2] ?? "") };
}

function toS3APath(value) {
  return String(value).replace(/^s3:\/\//i, "s3a://");
}

function normalizeSparkColumnName(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^0-9A-Za-z_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function sparkLogicalType(value) {
  const normalized = String(value ?? "").toLowerCase();
  return canonicalSchemaType(normalized);
}

function parquetJsLogicalType(name, field) {
  const normalizedName = String(name || "").toLowerCase();
  const primitive = String(field?.primitiveType || field?.type || field?.originalType || "").toLowerCase();
  const logical = String(field?.logicalType || field?.originalType || "").toLowerCase();
  if (primitive.includes("boolean")) return "Boolean";
  if (logical.includes("timestamp") || normalizedName.includes("time") || normalizedName.endsWith("_at")) return "Timestamp";
  if (logical.includes("date")) return "Date";
  return canonicalSchemaType(`${primitive} ${logical}`);
}

function tail(value) {
  const text = String(value ?? "").trim();
  if (text.length <= 1200) return text;
  return text.slice(-1200);
}

function normalizePrefix(prefix) {
  return String(prefix ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function selectedObjectKey(fields) {
  return normalizePrefix(fieldValue(fields, "__Selected Object") || fieldValue(fields, "__Sample Object"));
}

function redactSecretConfigValues(fields) {
  const secretPattern = /(access key|secret key|password|auth token|token|private key)/i;
  return fields.map(([label, value]) => [label, secretPattern.test(label) ? "" : value]);
}

function hasTextExtension(key) {
  const lower = key.toLowerCase();
  return textFileExtensions.some((extension) => lower.endsWith(extension));
}

function isParquetObjectKey(key) {
  return String(key ?? "").trim().toLowerCase().endsWith(".parquet");
}

function samplePolicyForFields(fields, kind) {
  const rawScope = fieldValue(fields, "__Schema Sample Scope").toLowerCase();
  const scope = ["slice1gb", "full"].includes(rawScope) ? rawScope : "current";
  const label = fieldValue(fields, "__Schema Sample Scope Label") || defaultSampleLabel(scope, kind);
  const rowLimit = sampleRowLimit(scope, kind);
  return { kind, label, rowLimit, scope };
}

function defaultSampleLabel(scope, kind) {
  if (kind === "documents") {
    if (scope === "slice1gb") return "10k 문서";
    if (scope === "full") return "전체 컬렉션";
    return "현재 문서";
  }
  if (kind === "rows") {
    if (scope === "slice1gb") return "10k 행";
    if (scope === "full") return "전체 테이블";
    return "현재 행";
  }
  if (scope === "slice1gb") return "1GB 요청(기본 16MB 제한)";
  if (scope === "full") return "전체";
  return "현재 샘플";
}

function sampleRowLimit(scope, kind) {
  if (kind === "object") {
    if (scope === "slice1gb") return 10000;
    if (scope === "full") return 50000;
    return 10;
  }
  if (scope === "slice1gb") return 10000;
  if (scope === "full") return 50000;
  return 10;
}

function sampleObjectRangeBytes(policy, objectSize) {
  const currentBytes = Number(process.env.ASKLAKE_SOURCE_CURRENT_SAMPLE_BYTES || 512 * 1024);
  const oneGbBytes = Number(process.env.ASKLAKE_SOURCE_1GB_SAMPLE_BYTES || 1024 * 1024 * 1024);
  const interactiveCapBytes = Number(process.env.ASKLAKE_SOURCE_INTERACTIVE_SAMPLE_CAP_BYTES || 16 * 1024 * 1024);
  const fullCapBytes = Number(process.env.ASKLAKE_SOURCE_FULL_SAMPLE_CAP_BYTES || interactiveCapBytes);
  const desiredBytes = policy.scope === "slice1gb"
    ? oneGbBytes
    : policy.scope === "full"
      ? Math.min(Number.isFinite(objectSize) && objectSize > 0 ? objectSize : fullCapBytes, fullCapBytes)
      : currentBytes;
  const cappedBytes = Math.min(
    Number.isFinite(desiredBytes) && desiredBytes > 0 ? desiredBytes : currentBytes,
    Number.isFinite(interactiveCapBytes) && interactiveCapBytes > 0 ? interactiveCapBytes : currentBytes,
  );
  if (Number.isFinite(objectSize) && objectSize > 0) return Math.min(objectSize, cappedBytes);
  return cappedBytes;
}

async function readBodyTextWithinLimit(body, maxBytes) {
  const buffer = await readBodyBufferWithinLimit(body, maxBytes);
  return buffer.toString("utf8");
}

async function readBodyBufferWithinLimit(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  const chunks = [];
  let totalBytes = 0;

  if (typeof body[Symbol.asyncIterator] !== "function") {
    return Buffer.alloc(0);
  }

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = byteLimit - totalBytes;
    if (remaining <= 0) break;
    const next = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
    chunks.push(next);
    totalBytes += next.length;
    if (totalBytes >= byteLimit) break;
  }

  return Buffer.concat(chunks, totalBytes);
}

function parseBoolean(value, fallback) {
  if (!value) return fallback;
  return ["true", "1", "yes", "y"].includes(value.toLowerCase());
}

function requiredSourceField(fields, label, message) {
  const value = fieldValue(fields, label);
  if (String(value ?? "").trim()) return value;
  throw apiError("SOURCE_FIELD_REQUIRED", message || `${label} is required.`, 400);
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function runMongoDriverSample({ collectionSelector, database, rowLimit, uri }) {
  const { MongoClient } = await import("mongodb");
  const limit = Number.isFinite(rowLimit) && rowLimit > 0 ? Math.floor(rowLimit) : 10;
  const client = new MongoClient(uri, {
    connectTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_CONNECT_TIMEOUT_MS", 3000),
    serverSelectionTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_SERVER_SELECTION_TIMEOUT_MS", 3000),
    socketTimeoutMS: sourceConnectTimeoutMs("ASKLAKE_MONGO_SOCKET_TIMEOUT_MS", 5000),
  });

  try {
    await client.connect();
    const dbh = client.db(database);
    const collections = (await dbh.listCollections({}, { nameOnly: true }).toArray())
      .map((collectionInfo) => String(collectionInfo.name ?? ""))
      .filter(Boolean)
      .sort();
    const collection = collectionSelector || "";
    const docs = collection ? await dbh.collection(collection).find({}).limit(limit).toArray() : [];
    return { collection, collections, docs };
  } catch (error) {
    throw apiError("MONGO_SOURCE_FAILED", `MongoDB 연결 실패: ${tailText(error?.message || error)}`, 502);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function flattenMongoDocument(value, prefix = "") {
  if (value === null || value === undefined) return { [prefix || "value"]: value };
  if (value instanceof Date) return { [prefix || "value"]: value.toISOString() };
  if (typeof value?.toHexString === "function") return { [prefix || "_id"]: value.toHexString() };
  if (typeof value !== "object" || Array.isArray(value)) return { [prefix || "value"]: value };

  return Object.entries(value).reduce((acc, [key, child]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child instanceof Date) {
      acc[nextKey] = child.toISOString();
    } else if (child && typeof child.toHexString === "function") {
      acc[nextKey] = child.toHexString();
    } else if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(acc, flattenMongoDocument(child, nextKey));
    } else {
      acc[nextKey] = child;
    }
    return acc;
  }, {});
}

export function apiError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function tailText(value, maxLength = 1200) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return text.slice(-maxLength);
}
