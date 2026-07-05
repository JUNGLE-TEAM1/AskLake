import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { fieldValue, formatBytes, inferSchemaColumns, parseSourceSample, schemaFingerprint, sourceId, upsertFields } from "./profile.mjs";

const textFileExtensions = [".csv", ".json", ".jsonl", ".txt", ".tsv"];

export async function testSourceConnector(sourceType, fields) {
  if (sourceType === "File / S3") return testObjectStorageSource(fields);
  if (sourceType === "REST API") return testRestSource(fields);
  if (sourceType === "Database" || sourceType === "PostgreSQL") return testPostgresSource(fields);
  if (sourceType === "MongoDB") return testMongoSource(fields);
  if (sourceType === "Data Lake") return testDataLakeSource(fields);
  if (sourceType === "Stream / Kafka") return testKafkaSource(fields);
  throw apiError("UNSUPPORTED_SOURCE", `${sourceType}는 지원하지 않는 소스 커넥터입니다.`, 400);
}

export async function testObjectStorageSource(fields) {
  const endpoint = fieldValue(fields, "Endpoint URL") || process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
  const region = fieldValue(fields, "Region") || process.env.MINIO_REGION || "us-east-1";
  const bucket = fieldValue(fields, "Bucket / Stage Name") || process.env.MINIO_BUCKET || "m3-raw";
  const prefix = normalizePrefix(fieldValue(fields, "Path / Prefix") || process.env.MINIO_PREFIX || "nyc_taxi/csv/");
  const accessKeyId = fieldValue(fields, "Access Key") || process.env.MINIO_ACCESS_KEY || "";
  const secretAccessKey = fieldValue(fields, "Secret Key") || process.env.MINIO_SECRET_KEY || "";
  const forcePathStyle = parseBoolean(fieldValue(fields, "Use Path Style"), true);

  if (!accessKeyId || !secretAccessKey) {
    throw apiError("SOURCE_CREDENTIALS_REQUIRED", "MinIO/S3 액세스 키와 시크릿 키가 필요합니다.", 400);
  }

  const client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
  const objects = await listObjects(client, bucket, prefix);
  const sampleObject = objects.find((item) => hasTextExtension(item.Key ?? "")) ?? objects[0];
  const samplePolicy = samplePolicyForFields(fields, "object");
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
    sourceType: "File / S3",
  });
}

export async function testDataLakeSource(fields) {
  const path = fieldValue(fields, "Path") || "s3://m3-raw/nyc_taxi/yellow_parquet/";
  const parsed = parseS3Path(path);
  if (!parsed) {
    throw apiError("UNSUPPORTED_LAKE_PATH", "데이터 레이크 경로는 이 로컬 러너에서 s3:// 또는 s3a:// MinIO 경로여야 합니다.", 400);
  }

  const endpoint = fieldValue(fields, "Endpoint URL") || process.env.MINIO_ENDPOINT || "http://127.0.0.1:9000";
  const region = fieldValue(fields, "Region") || process.env.MINIO_REGION || "us-east-1";
  const accessKeyId = fieldValue(fields, "Access Key") || process.env.MINIO_ACCESS_KEY || "";
  const secretAccessKey = fieldValue(fields, "Secret Key") || process.env.MINIO_SECRET_KEY || "";
  const forcePathStyle = parseBoolean(fieldValue(fields, "Use Path Style"), true);
  if (!accessKeyId || !secretAccessKey) {
    throw apiError("SOURCE_CREDENTIALS_REQUIRED", "로컬 데이터 레이크 경로에는 MinIO 액세스 키와 시크릿 키가 필요합니다.", 400);
  }

  const client = s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey });
  const objects = await listObjects(client, parsed.bucket, parsed.prefix);
  const parquetObjects = objects.filter((item) => String(item.Key ?? "").toLowerCase().endsWith(".parquet"));
  const sample = parquetObjects[0] ?? objects[0];
  const id = sourceId("source", `${path}:${objects.length}`);
  const runId = sourceId("run", `${id}:${Date.now()}`);
  const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
    ["Path", path],
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Use Path Style", String(forcePathStyle)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sample?.Key ?? ""],
  ]);

  return {
    actionPath: "/api/etl/sources/datalake/test",
    assets: objects.slice(0, 20).map((item, index) => [
      item.Key ?? `object-${index + 1}`,
      formatBytes(item.Size ?? 0),
      item.LastModified ? item.LastModified.toISOString() : "listed",
    ]),
    draftPatch: {
      schema: {
        columns: [],
        sampleRows: [],
        schemaFingerprint: "",
        summary: `데이터 레이크 경로 접근 성공: Parquet 파일 ${parquetObjects.length}개. 물리 스키마는 백엔드 Spark 검증을 실행하세요.`,
      },
      source: {
        connectionMessage: `데이터 레이크 연결 성공: ${path} (오브젝트 ${objects.length}개)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel: path,
        sourceType: "Data Lake",
      },
    },
    logs: [
      `데이터 레이크 오브젝트 목록 조회 성공: ${path}`,
      `Parquet 파일 감지: ${parquetObjects.length}개`,
      "Spark 스키마 추론은 백엔드 검증 작업에서 실행합니다.",
    ],
    message: `데이터 레이크 연결 성공: 오브젝트 ${objects.length}개`,
    previewColumns: ["Object Key", "Size", "Last Modified"],
    previewNote: "오브젝트 메타데이터 미리보기입니다. Parquet 물리 스키마는 Spark 검증을 사용하세요.",
    previewRows: objects.slice(0, 8).map((item) => [item.Key ?? "-", formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Path", path], ["Objects", String(objects.length)], ["Parquet", String(parquetObjects.length)]],
  };
}

export async function testRestSource(fields) {
  const endpoint = fieldValue(fields, "Endpoint URL");
  const method = fieldValue(fields, "Method") || "GET";
  const accept = fieldValue(fields, "Accept") || "application/json";
  if (!endpoint) throw apiError("REST_ENDPOINT_REQUIRED", "REST API 엔드포인트 URL이 필요합니다.", 400);

  const response = await fetch(endpoint, { headers: { Accept: accept }, method });
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

export async function testPostgresSource(fields) {
  const { Client } = await import("pg");
  const host = fieldValue(fields, "Endpoint / Host") || process.env.ASKLAKE_SOURCE_PGHOST || "127.0.0.1";
  const port = Number(fieldValue(fields, "Port") || process.env.ASKLAKE_SOURCE_PGPORT || 15432);
  const database = fieldValue(fields, "Database Name") || process.env.ASKLAKE_SOURCE_PGDATABASE || "asklake_sources";
  const schema = fieldValue(fields, "Schema") || "public";
  const user = fieldValue(fields, "Username") || process.env.ASKLAKE_SOURCE_PGUSER || "asklake";
  const password = fieldValue(fields, "Password / Auth Token") || process.env.ASKLAKE_SOURCE_PGPASSWORD || "";
  const tableSelector = fieldValue(fields, "DATASET OR TABLE SELECTOR");
  const samplePolicy = samplePolicyForFields(fields, "rows");

  const client = new Client({ database, host, password, port, user });
  await client.connect();
  try {
    const tableResult = await client.query(
      "select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name limit 20",
      [schema],
    );
    const table = tableSelector || tableResult.rows[0]?.table_name;
    if (!table) throw apiError("POSTGRES_NO_TABLES", `${schema} 스키마에서 기본 테이블을 찾지 못했습니다.`, 404);
    if (!tableResult.rows.some((row) => row.table_name === table) && tableSelector) {
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
  const { MongoClient } = await import("mongodb");
  const endpoint = fieldValue(fields, "Endpoint / Host") || process.env.ASKLAKE_MONGO_HOST || "127.0.0.1";
  const port = Number(fieldValue(fields, "Port") || process.env.ASKLAKE_MONGO_PORT || 27018);
  const database = fieldValue(fields, "Database Name") || process.env.ASKLAKE_MONGO_DATABASE || "asklake_sources";
  const username = fieldValue(fields, "Username") || process.env.ASKLAKE_MONGO_USER || "";
  const password = fieldValue(fields, "Password / Auth Token") || process.env.ASKLAKE_MONGO_PASSWORD || "";
  const collectionSelector = fieldValue(fields, "DATASET OR TABLE SELECTOR") || fieldValue(fields, "Collection");
  const samplePolicy = samplePolicyForFields(fields, "documents");
  const authPart = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : "";
  const uri = fieldValue(fields, "Connection URI") || `mongodb://${authPart}${endpoint}:${port}/${database}${username ? "?authSource=admin" : ""}`;
  const client = new MongoClient(uri, {
    connectTimeoutMS: 3000,
    serverSelectionTimeoutMS: 3000,
  });

  await client.connect();
  try {
    const db = client.db(database);
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((item) => item.name)
      .filter(Boolean)
      .sort();
    const collection = collectionSelector || collections[0];
    if (!collection) throw apiError("MONGO_NO_COLLECTIONS", `${database} 데이터베이스에서 컬렉션을 찾지 못했습니다.`, 404);
    if (collectionSelector && !collections.includes(collectionSelector)) {
      throw apiError("MONGO_COLLECTION_NOT_FOUND", `${database}.${collectionSelector} 컬렉션을 찾지 못했습니다.`, 404);
    }

    const docs = await db.collection(collection).find({}, { limit: samplePolicy.rowLimit }).toArray();
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
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function testKafkaSource(fields) {
  const { Kafka } = await import("kafkajs");
  const broker = fieldValue(fields, "Broker / Endpoint") || process.env.ASKLAKE_KAFKA_BROKER || "127.0.0.1:19092";
  const topic = fieldValue(fields, "TOPIC / QUEUE NAME") || process.env.ASKLAKE_KAFKA_TOPIC || "asklake-source-events";
  const groupId = fieldValue(fields, "CONSUMER GROUP ID") || `asklake-schema-${Date.now()}`;
  const kafka = new Kafka({ brokers: [broker], clientId: "asklake-source-test", retry: { retries: 1 } });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
    const topicMeta = metadata.topics.find((item) => item.name === topic);
    if (!topicMeta || topicMeta.partitions.length === 0) {
      throw apiError("KAFKA_TOPIC_NOT_FOUND", `${topic} Kafka 토픽을 찾지 못했거나 파티션이 없습니다.`, 404);
    }

    const id = sourceId("source", `kafka://${broker}/${topic}`);
    const runId = sourceId("run", `${id}:${Date.now()}`);
    const sourceConfig = upsertFields(redactSecretConfigValues(fields), [
      ["Broker / Endpoint", broker],
      ["TOPIC / QUEUE NAME", topic],
      ["CONSUMER GROUP ID", groupId],
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
          columns: [],
          sampleRows: [],
          schemaFingerprint: "",
          summary: `Kafka 토픽 접근 성공: ${topic}. 페이로드 스키마 추론은 JSON 메시지를 적재한 뒤 하네스를 실행하세요.`,
        },
        source: {
          connectionMessage: `Kafka 토픽 연결 성공: ${topic}`,
          connectionStatus: "success",
          sourceConfig,
          sourceLabel: `${broker}/${topic}`,
          sourceType: "Stream / Kafka",
        },
      },
      logs: [
        `Kafka 브로커 핸드셰이크 성공: ${broker}`,
        `토픽 메타데이터 조회: ${topic}`,
        "스트리밍 페이로드 스키마 추론은 샘플 메시지 확보 후 수행합니다.",
      ],
      message: `Kafka 토픽 연결 성공: ${topic}`,
      previewColumns: ["Topic", "Partition", "Leader"],
      previewNote: "Kafka 메타데이터 미리보기입니다. 페이로드 스키마에는 샘플 메시지가 필요합니다.",
      previewRows: topicMeta.partitions.map((partition) => [topic, String(partition.partitionId), String(partition.leader)]),
      status: "success",
      testItems: [["Broker", broker], ["Topic", topic], ["Partitions", String(topicMeta.partitions.length)]],
    };
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function buildObjectStorageAnalysis({ bucket, client, endpoint, fields, forcePathStyle, objects, prefix, region, sampleObject, samplePolicy, sourceType }) {
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
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Bucket / Stage Name", bucket],
    ["Path / Prefix", prefix],
    ["Use Path Style", String(forcePathStyle)],
    ["__Schema Sample Scope", samplePolicy.scope],
    ["__Schema Sample Scope Label", samplePolicy.label],
    ["__Sample Requested Bytes", String(requestedBytes)],
    ["__Source ID", id],
    ["__Run ID", runId],
    ["__Source Unit Count", String(objects.length)],
    ["__Sample Object", sampleKey],
  ]);
  const sourceLabel = `${bucket}${prefix ? `/${prefix}` : ""}`;

  return {
    actionPath: "/api/etl/sources/minio/test",
    assets: objects.slice(0, 20).map((item, index) => [
      item.Key ?? `object-${index + 1}`,
      formatBytes(item.Size ?? 0),
      item.LastModified ? item.LastModified.toISOString() : "listed",
    ]),
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
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [["Endpoint", endpoint], ["Bucket", bucket], ["Objects", String(objects.length)]],
  };
}

function s3Client({ accessKeyId, endpoint, forcePathStyle, region, secretAccessKey }) {
  return new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle,
    region,
  });
}

async function listObjects(client, bucket, prefix) {
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50, Prefix: prefix }));
  return (result.Contents ?? []).filter((item) => item.Key);
}

function parseS3Path(path) {
  const match = String(path).match(/^s3a?:\/\/([^/]+)\/?(.*)$/);
  if (!match) return null;
  return { bucket: match[1], prefix: normalizePrefix(match[2] ?? "") };
}

function normalizePrefix(prefix) {
  return String(prefix ?? "").replace(/^\/+/, "");
}

function redactSecretConfigValues(fields) {
  const secretPattern = /(access key|secret key|password|auth token|token|private key)/i;
  return fields.map(([label, value]) => [label, secretPattern.test(label) ? "" : value]);
}

function hasTextExtension(key) {
  const lower = key.toLowerCase();
  return textFileExtensions.some((extension) => lower.endsWith(extension));
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
  if (scope === "slice1gb") return "1GB 샘플";
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
  if (!body) return "";
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  const chunks = [];
  let totalBytes = 0;

  if (typeof body[Symbol.asyncIterator] !== "function") {
    return "";
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

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function parseBoolean(value, fallback) {
  if (!value) return fallback;
  return ["true", "1", "yes", "y"].includes(value.toLowerCase());
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function stringifyCell(value) {
  if (value === null || value === undefined) return "";
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
