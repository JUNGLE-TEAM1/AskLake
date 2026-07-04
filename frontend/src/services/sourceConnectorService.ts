import { apiClient, apiConfig } from "./apiClient";
import type { DraftPipelinePatch, SchemaColumnDraft, SourceDraft } from "../types";

type SourceFieldRows = Array<[string, string]>;

export type SourceConnectorAnalysis = {
  actionPath: string;
  assets: Array<[string, string, string]>;
  draftPatch: DraftPipelinePatch;
  logs: string[];
  message: string;
  previewColumns: string[];
  previewNote: string;
  previewRows: string[][];
  status: SourceDraft["connectionStatus"];
  testItems: Array<[string, string]>;
};

type BackendSourceConnectorResponse = SourceConnectorAnalysis;

type ParsedSourceSample = {
  columns: string[];
  format: string;
  rows: string[][];
};

const textFileExtensions = [".csv", ".json", ".jsonl", ".txt", ".tsv"];

export async function testSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  if (sourceType === "File / S3") {
    return testMinioSource(fields);
  }

  if (sourceType === "REST API") {
    return testRestSource(fields);
  }

  if (!apiConfig.useMock) {
    return apiClient.post<BackendSourceConnectorResponse>("/api/etl/sources/test", { sourceConfig: fields, sourceType });
  }

  throw new Error(`${sourceType} connector requires the backend connector runner. 브라우저 단독으로는 이 소스에 직접 접속할 수 없습니다.`);
}

async function testMinioSource(fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const endpoint = fieldValue(fields, "Endpoint URL") || import.meta.env.VITE_MINIO_ENDPOINT || "http://127.0.0.1:9000";
  const region = fieldValue(fields, "Region") || import.meta.env.VITE_MINIO_REGION || "us-east-1";
  const bucket = fieldValue(fields, "Bucket / Stage Name") || import.meta.env.VITE_MINIO_BUCKET || "m3-raw";
  const prefix = normalizePrefix(fieldValue(fields, "Path / Prefix") || import.meta.env.VITE_MINIO_PREFIX || "nyc_taxi/csv/");
  const accessKeyId = fieldValue(fields, "Access Key") || import.meta.env.VITE_MINIO_ACCESS_KEY || "m3admin";
  const secretAccessKey = fieldValue(fields, "Secret Key") || import.meta.env.VITE_MINIO_SECRET_KEY || "wishuponastar";
  const forcePathStyle = parseBoolean(fieldValue(fields, "Use Path Style"), true);

  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle,
    region,
  });

  const listResult = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    MaxKeys: 20,
    Prefix: prefix,
  }));
  const objects = (listResult.Contents ?? []).filter((item) => item.Key);
  const sampleObject = objects.find((item) => hasTextExtension(item.Key ?? "")) ?? objects[0];
  const logs = [
    `[M3:L0] MinIO ListObjectsV2 succeeded: bucket=${bucket}, prefix=${prefix || "(root)"}`,
    `[M3:L0] source units detected: ${objects.length}`,
  ];

  let parsedSample: ParsedSourceSample = { columns: [], format: "unknown", rows: [] };
  let sampleKey = "";
  if (sampleObject?.Key && hasTextExtension(sampleObject.Key)) {
    sampleKey = sampleObject.Key;
    const objectResult = await client.send(new GetObjectCommand({ Bucket: bucket, Key: sampleObject.Key, Range: "bytes=0-65535" }));
    const text = await objectResult.Body?.transformToString();
    parsedSample = parseSourceSample(sampleObject.Key, text ?? "");
    logs.push(`[M3:L1] bounded sample fetched: ${sampleObject.Key}`);
    logs.push(`[M3:L2] profile snapshot inferred: ${parsedSample.columns.length} fields, ${parsedSample.rows.length} sample rows`);
  } else if (sampleObject?.Key) {
    sampleKey = sampleObject.Key;
    logs.push(`[M3:L1] sample object is not browser-readable text: ${sampleObject.Key}`);
  } else {
    logs.push("[M3:L1] bucket reachable but no object matched the prefix.");
  }

  const sourceId = stableId("source", `${endpoint}:${bucket}:${prefix}`);
  const runId = stableId("run", `${sourceId}:${Date.now()}`);
  const sourceUnitIds = objects.map((item, index) => `${sourceId}_unit_${String(index + 1).padStart(5, "0")}`);
  const schemaColumns = inferSchemaColumns(parsedSample);
  const schemaFingerprint = schemaColumns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|");
  const schemaSummary = schemaColumns.length
    ? `${schemaColumns.length} fields inferred from MinIO ${parsedSample.format} sample · M3 L0-L3 profile`
    : `MinIO reachable · schema inference pending (${objects.length} objects)`;
  const sourceConfig = upsertFields(fields, [
    ["Endpoint URL", endpoint],
    ["Region", region],
    ["Bucket / Stage Name", bucket],
    ["Path / Prefix", prefix],
    ["Access Key", accessKeyId],
    ["Secret Key", secretAccessKey],
    ["Use Path Style", String(forcePathStyle)],
    ["M3 Source ID", sourceId],
    ["M3 Run ID", runId],
    ["M3 Source Unit Count", String(sourceUnitIds.length)],
    ["M3 Sample Object", sampleKey],
  ]);
  const sourceLabel = `${bucket}${prefix ? `/${prefix}` : ""}`;

  return {
    actionPath: "/api/etl/sources/minio/test",
    assets: objects.map((item, index) => [
      item.Key ?? `object-${index + 1}`,
      formatBytes(item.Size ?? 0),
      item.LastModified ? item.LastModified.toISOString() : "listed",
    ]),
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint,
        summary: schemaSummary,
      },
      source: {
        connectionMessage: `MinIO 연결 성공: ${bucket}${prefix ? `/${prefix}` : ""} (${objects.length} objects)`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel,
        sourceType: "File / S3",
      },
    },
    logs,
    message: `MinIO 연결 성공: ${objects.length}개 object 확인`,
    previewColumns: parsedSample.columns.length ? parsedSample.columns : ["Object Key", "Size", "Last Modified"],
    previewNote: sampleKey ? `Bounded sample from ${sampleKey}` : `Listed ${objects.length} objects from MinIO`,
    previewRows: parsedSample.rows.length
      ? parsedSample.rows
      : objects.slice(0, 8).map((item) => [item.Key ?? "-", formatBytes(item.Size ?? 0), item.LastModified?.toISOString() ?? "-"]),
    status: "success",
    testItems: [
      ["Endpoint", endpoint],
      ["Bucket", bucket],
      ["Objects", String(objects.length)],
      ["M3 Run", runId],
      ["Source Units", String(sourceUnitIds.length)],
    ],
  };
}

async function testRestSource(fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  const endpoint = fieldValue(fields, "Endpoint URL");
  const method = fieldValue(fields, "Method") || "GET";
  if (!endpoint) {
    throw new Error("REST API Endpoint URL이 비어 있습니다.");
  }

  const response = await fetch(endpoint, { method });
  if (!response.ok) {
    throw new Error(`REST API responded ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const parsedSample = parseSourceSample(endpoint, text);
  const schemaColumns = inferSchemaColumns(parsedSample);
  const schemaFingerprint = schemaColumns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|");
  const sourceId = stableId("source", endpoint);
  const runId = stableId("run", `${sourceId}:${Date.now()}`);
  const sourceConfig = upsertFields(fields, [
    ["M3 Source ID", sourceId],
    ["M3 Run ID", runId],
    ["M3 Source Unit Count", "1"],
  ]);

  return {
    actionPath: "/api/etl/sources/rest/test",
    assets: [[endpoint, `${text.length} bytes`, "HTTP 200"]],
    draftPatch: {
      schema: {
        columns: schemaColumns,
        sampleRows: parsedSample.rows,
        schemaFingerprint,
        summary: `${schemaColumns.length} fields inferred from REST ${parsedSample.format} sample · M3 L0-L3 profile`,
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
      `[M3:L0] REST source reachable: ${endpoint}`,
      `[M3:L1] bounded response sample fetched: ${text.length} bytes`,
      `[M3:L2] profile snapshot inferred: ${schemaColumns.length} fields`,
    ],
    message: "REST API 연결 성공",
    previewColumns: parsedSample.columns,
    previewNote: `Bounded sample from ${endpoint}`,
    previewRows: parsedSample.rows,
    status: "success",
    testItems: [["Endpoint", "Reachable"], ["HTTP", String(response.status)], ["M3 Run", runId]],
  };
}

function parseSourceSample(name: string, text: string): ParsedSourceSample {
  const trimmed = text.trim();
  if (!trimmed) return { columns: [], format: "empty", rows: [] };
  const lowerName = name.toLowerCase();

  if (lowerName.endsWith(".json") || lowerName.endsWith(".jsonl") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseJsonSample(trimmed, lowerName.endsWith(".jsonl") ? "jsonl" : "json");
  }

  return parseDelimitedSample(trimmed, lowerName.endsWith(".tsv") ? "\t" : ",");
}

function parseDelimitedSample(text: string, delimiter: string): ParsedSourceSample {
  const rows = text.split(/\r?\n/).slice(0, 51).map((line) => parseDelimitedLine(line, delimiter));
  const header = rows[0] ?? [];
  const dataRows = rows.slice(1, 11);
  return {
    columns: header.map((column, index) => column.trim() || `column_${index + 1}`),
    format: delimiter === "\t" ? "tsv" : "csv",
    rows: dataRows,
  };
}

function parseJsonSample(text: string, format: string): ParsedSourceSample {
  const values: unknown[] = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) values.push(...parsed.slice(0, 10));
    else values.push(parsed);
  } catch {
    for (const line of text.split(/\r?\n/).slice(0, 10)) {
      if (!line.trim()) continue;
      values.push(JSON.parse(line));
    }
    format = "jsonl";
  }

  const flattened = values.map((value) => flattenRecord(value));
  const columns = Array.from(new Set(flattened.flatMap((record) => Object.keys(record))));
  return {
    columns,
    format,
    rows: flattened.map((record) => columns.map((column) => stringifyCell(record[column]))),
  };
}

function inferSchemaColumns(sample: ParsedSourceSample): SchemaColumnDraft[] {
  return sample.columns.map((column, index) => {
    const values = sample.rows.map((row) => row[index] ?? "");
    return {
      confidence: values.length > 0 ? 90 : 65,
      nullable: values.some((value) => value.trim() === ""),
      role: inferRole(column),
      sourceName: column,
      targetName: normalizeColumnName(column),
      type: inferType(values),
    };
  });
}

function inferType(values: string[]) {
  const nonEmpty = values.map((value) => value.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "String";
  if (nonEmpty.every((value) => /^-?\d+$/.test(value))) return "Integer";
  if (nonEmpty.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Float";
  if (nonEmpty.every((value) => !Number.isNaN(Date.parse(value)) && /[-:TZ/]/.test(value))) return "Timestamp";
  if (nonEmpty.every((value) => ["true", "false"].includes(value.toLowerCase()))) return "Boolean";
  if (nonEmpty.every((value) => (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]")))) return "JSON";
  return "String";
}

function inferRole(column: string) {
  const normalized = normalizeColumnName(column);
  if (normalized === "id" || normalized.endsWith("_id")) return "Identifier";
  if (normalized.includes("email")) return "PII";
  if (normalized.includes("time") || normalized.includes("date") || normalized.endsWith("_ts")) return "Event Time";
  if (normalized.includes("price") || normalized.includes("amount") || normalized.includes("rating")) return "Metric";
  return undefined;
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function flattenRecord(value: unknown, prefix = ""): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix || "value"]: value };
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, child]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      Object.assign(acc, flattenRecord(child, nextKey));
    } else {
      acc[nextKey] = child;
    }
    return acc;
  }, {});
}

function fieldValue(fields: SourceFieldRows, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

function upsertFields(fields: SourceFieldRows, updates: SourceFieldRows): SourceFieldRows {
  const updateMap = new Map(updates);
  const seen = new Set<string>();
  const merged = fields.map(([label, value]) => {
    seen.add(label);
    return [label, updateMap.get(label) ?? value] as [string, string];
  });
  for (const [label, value] of updates) {
    if (!seen.has(label)) merged.push([label, value]);
  }
  return merged;
}

function normalizePrefix(prefix: string) {
  return prefix.replace(/^\/+/, "");
}

function hasTextExtension(key: string) {
  const lower = key.toLowerCase();
  return textFileExtensions.some((extension) => lower.endsWith(extension));
}

function parseBoolean(value: string, fallback: boolean) {
  if (!value) return fallback;
  return ["true", "1", "yes", "y"].includes(value.toLowerCase());
}

function normalizeColumnName(value: string) {
  return value
    .trim()
    .replace(/[^0-9A-Za-z가-힣_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";
}

function stableId(prefix: string, value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}_${Math.abs(hash).toString(16)}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function stringifyCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
