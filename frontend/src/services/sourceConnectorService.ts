import { apiClient, apiConfig } from "./apiClient";
import type { DraftPipelinePatch, RecordParsingDraft, RecordParsingPreviewResponse, SchemaColumnDraft, SourceDraft } from "../types";
import { sanitizeSourceConnectorFields, type SourceFieldRows } from "../utils/sourceConnectorFields";

const directBackendBaseUrl = String(
  import.meta.env.VITE_BACKEND_DIRECT_URL
    || import.meta.env.VITE_API_BASE_URL
    || "http://127.0.0.1:8080",
).replace(/\/$/, "");

export type SourceDatasetSummary = {
  selectionKind: "prefix";
  bucket: string;
  prefix: string;
  format: string;
  fileCount: number;
  totalBytes: number;
  representativeObject: string;
  schemaFingerprint?: string;
  schemaCompatible: boolean;
  excludedFileCount: number;
};

export type SourceConnectorAnalysis = {
  actionPath: string;
  assets: Array<[string, string, string]>;
  datasetSummary?: SourceDatasetSummary;
  draftPatch: DraftPipelinePatch;
  logs: string[];
  message: string;
  previewColumns: string[];
  previewNote: string;
  previewRows: string[][];
  status: SourceDraft["connectionStatus"];
  testItems: Array<[string, string]>;
};

export type SourceConnectorDefaults = {
  kafkaBroker: string;
  kafkaTopic: string;
  s3Bucket: string;
  s3Prefix: string;
};

type BackendSourceConnectorResponse = SourceConnectorAnalysis;

export type SourceAssetsResponse = {
  assets: Array<[string, string, string]>;
  count?: number;
  limit?: number;
  prefix: string;
};

export async function testSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  const normalizedSourceType = normalizeSourceType(sourceType);
  if (normalizedSourceType === "SQL Result") {
    return buildSqlResultConnectorAnalysis(fields);
  }
  const requestFields = sanitizeSourceConnectorFields(normalizedSourceType, fields);
  return withUnselectedTargetSchema(withRecordParsingSourceMetadata(normalizeConnectorAnalysis(
    await postSourceConnector(normalizedSourceType, requestFields),
    normalizedSourceType,
    requestFields,
  ), requestFields));
}

export async function previewRecordParsing(rawLines: string[], recordParsing: RecordParsingDraft): Promise<RecordParsingPreviewResponse> {
  if (apiConfig.useMock) return buildMockRecordParsingPreview(rawLines, recordParsing);
  return apiClient.post<RecordParsingPreviewResponse>("/api/etl/record-parsing/preview", { rawLines, recordParsing });
}

export async function getSourceConnectorDefaults(): Promise<SourceConnectorDefaults> {
  if (apiConfig.useMock) {
    return {
      kafkaBroker: "127.0.0.1:19092",
      kafkaTopic: "asklake-source-events",
      s3Bucket: "m3-raw",
      s3Prefix: "",
    };
  }
  return getWithDevFallback<SourceConnectorDefaults>("/api/etl/sources/defaults");
}

export async function listSourceAssets(sourceType: string, fields: SourceFieldRows, prefix = ""): Promise<SourceAssetsResponse> {
  const normalizedSourceType = normalizeSourceType(sourceType);
  return postSourceAssets(normalizedSourceType, sanitizeSourceConnectorFields(normalizedSourceType, fields), prefix);
}

async function postSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<BackendSourceConnectorResponse> {
  if (apiConfig.useMock) return resolveMockConnectorAnalysis(sourceType, fields);
  const body = { sourceConfig: fields, sourceType };
  return postWithDevFallback<BackendSourceConnectorResponse>("/api/etl/sources/test", body);
}

async function postSourceAssets(sourceType: string, fields: SourceFieldRows, prefix: string): Promise<SourceAssetsResponse> {
  if (apiConfig.useMock) {
    const assets = mockSourceAssets(sourceType, prefix);
    return { assets, count: assets.length, limit: assets.length, prefix };
  }
  const body = { prefix, sourceConfig: fields, sourceType };
  return postWithDevFallback<SourceAssetsResponse>("/api/etl/sources/assets", body);
}

function resolveMockConnectorAnalysis(sourceType: string, fields: SourceFieldRows): BackendSourceConnectorResponse {
  const sourceLabel = fieldValue(fields, "Source Dataset")
    || fieldValue(fields, "Bucket / Stage Name")
    || fieldValue(fields, "Database Name")
    || sourceType;
  const previewColumns = ["review_id", "product_id", "rating", "review_text", "updated_at"];
  const previewRows = [
    ["r-1001", "p-100", "5", "배송이 빨라요", "2026-07-10T09:00:00Z"],
    ["r-1002", "p-101", "4", "상품 상태가 좋아요", "2026-07-10T09:05:00Z"],
  ];

  const selectedPrefix = fieldValue(fields, "__Selection Kind").toLowerCase() === "prefix"
    ? normalizePrefix(fieldValue(fields, "Path / Prefix"))
    : "";
  const datasetSummary: SourceDatasetSummary | undefined = selectedPrefix
    ? {
        bucket: fieldValue(fields, "Bucket / Stage Name") || "mock-bucket",
        excludedFileCount: 0,
        fileCount: 2,
        format: fieldValue(fields, "File Type") === "auto" ? "JSONL" : fieldValue(fields, "File Type").toUpperCase(),
        prefix: selectedPrefix,
        representativeObject: `${selectedPrefix}part-00000.jsonl`,
        schemaCompatible: true,
        schemaFingerprint: "review_id:string|product_id:string|rating:integer|review_text:string|updated_at:timestamp",
        selectionKind: "prefix",
        totalBytes: 128 * 1024 * 1024,
      }
    : undefined;

  return {
    actionPath: "/api/etl/sources/test",
    assets: mockSourceAssets(sourceType, ""),
    datasetSummary,
    draftPatch: {
      source: {
        connectionMessage: "mock 소스 연결 확인이 완료되었습니다.",
        connectionStatus: "success",
        sourceConfig: fields,
        sourceLabel,
        sourceType,
      },
    },
    logs: ["mock connector fixture applied", "sample schema is ready"],
    message: "mock 소스 연결 확인이 완료되었습니다.",
    previewColumns,
    previewNote: "mock 샘플",
    previewRows,
    status: "success",
    testItems: [["소스 연결", "성공"], ["샘플 조회", "성공"], ["스키마 추론", "준비됨"]],
  };
}

function mockSourceAssets(sourceType: string, prefix: string): Array<[string, string, string]> {
  if (sourceType === "PostgreSQL") {
    return [
      ["customer_reviews", prefix.trim() || "public", "detected"],
      ["product_metadata", prefix.trim() || "public", "detected"],
    ];
  }
  if (sourceType === "MongoDB") {
    return [
      ["app_events", prefix.trim() || "asklake_sources", "detected"],
      ["customer_profiles", prefix.trim() || "asklake_sources", "detected"],
    ];
  }
  const basePath = normalizePrefix(prefix) || "sample/";
  return [
    [`${basePath}customer_reviews.parquet`, "Parquet", "준비됨"],
    [`${basePath}customer_reviews.csv`, "CSV", "준비됨"],
  ];
}

async function postWithDevFallback<T>(path: string, body: unknown): Promise<T> {
  if (import.meta.env.DEV) {
    try {
      return await postBackendDirect<T>(path, body);
    } catch (error) {
      if (!isNetworkError(error) && !isNotFoundError(error)) {
        throw error;
      }
    }
  }

  try {
    return await apiClient.post<T>(path, body);
  } catch (error) {
    if (import.meta.env.DEV && isNotFoundError(error)) {
      return postBackendDirect<T>(path, body);
    }
    throw error;
  }
}

async function getWithDevFallback<T>(path: string): Promise<T> {
  if (import.meta.env.DEV) {
    try {
      return await getBackendDirect<T>(path);
    } catch (error) {
      if (!isNetworkError(error) && !isNotFoundError(error)) throw error;
    }
  }

  return apiClient.get<T>(path);
}

async function getBackendDirect<T>(path: string): Promise<T> {
  const response = await fetch(`${directBackendBaseUrl}${path}`);
  if (response.ok) return await response.json() as T;
  const text = await response.text().catch(() => "");
  throw new Error(text || `Backend ${response.status} ${response.statusText}`);
}

async function postBackendDirect<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${directBackendBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (response.ok) {
    return await response.json() as T;
  }
  const text = await response.text().catch(() => "");
  throw new Error(text || `Backend ${response.status} ${response.statusText}`);
}

function isNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /failed to fetch|networkerror|load failed/i.test(message);
}

function normalizeSourceType(sourceType: string) {
  return sourceType === "Database" ? "PostgreSQL" : sourceType;
}

function isNotFoundError(error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: unknown }).status) : 0;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  return status === 404 || /404|not found/i.test(`${code} ${message}`);
}

function normalizeConnectorAnalysis(
  analysis: BackendSourceConnectorResponse,
  sourceType: string,
  fields: SourceFieldRows,
): SourceConnectorAnalysis {
  const columns = analysis.draftPatch.schema?.columns ?? [];
  const sampleRows = analysis.draftPatch.schema?.sampleRows ?? [];
  if (columns.length > 0 && sampleRows.length > 0) {
    return analysis;
  }

  if (isObjectStorageSource(sourceType) && !hasSelectedObject(fields)) {
    return {
      ...analysis,
      draftPatch: {
        ...analysis.draftPatch,
        schema: undefined,
      },
    };
  }

  if (analysis.previewColumns.length === 0 || analysis.previewRows.length === 0) {
    return analysis;
  }

  const inferredColumns = inferSchemaColumnsFromPreview(analysis.previewColumns, analysis.previewRows);
  if (inferredColumns.length === 0) {
    return analysis;
  }

  return {
    ...analysis,
    draftPatch: {
      ...analysis.draftPatch,
      schema: {
        columns: inferredColumns,
        sampleRows: analysis.previewRows,
        schemaFingerprint: inferredColumns
          .map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`)
          .join("|"),
        summary: `${analysis.previewNote || "\uC0D8\uD50C"} \uAE30\uC900 ${inferredColumns.length}\uAC1C \uD544\uB4DC \uCD94\uB860`,
      },
    },
  };
}

function isObjectStorageSource(sourceType: string) {
  return sourceType === "File / S3" || sourceType === "Data Lake";
}

function hasSelectedObject(fields: SourceFieldRows) {
  const selectionKind = fieldValue(fields, "__Selection Kind").toLowerCase();
  const selectedPrefix = fieldValue(fields, "Path / Prefix");
  return Boolean(
    (selectionKind === "prefix" && selectedPrefix)
      || fieldValue(fields, "__Selected Object")
      || fieldValue(fields, "__Sample Object")
      || looksLikeDataFile(fieldValue(fields, "Path / Prefix"))
      || looksLikeDataFile(fieldValue(fields, "Path"))
      || looksLikeDataFile(fieldValue(fields, "DATASET OR TABLE SELECTOR")),
  );
}

function looksLikeDataFile(value: string) {
  return /\.(csv|tsv|txt|log|json|jsonl|parquet)$/i.test(value.trim());
}

function withRecordParsingSourceMetadata(analysis: SourceConnectorAnalysis, fields: SourceFieldRows): SourceConnectorAnalysis {
  const sampleObject = analysis.datasetSummary?.representativeObject
    || fieldValue(analysis.draftPatch.source?.sourceConfig ?? fields, "__Sample Object")
    || fieldValue(analysis.draftPatch.source?.sourceConfig ?? fields, "__Selected Object")
    || fieldValue(fields, "Path / Prefix");
  const detectedFormat = /\.(txt|log)$/i.test(sampleObject) ? "TXT" : undefined;
  const rawValueIndex = analysis.previewColumns.findIndex((column) => /^(value|raw_value)$/i.test(column));
  const requiresRecordParsing = detectedFormat === "TXT" && rawValueIndex >= 0;
  if (!analysis.draftPatch.source) return analysis;
  return {
    ...analysis,
    draftPatch: {
      ...analysis.draftPatch,
      source: {
        ...analysis.draftPatch.source,
        detectedFormat,
        rawPreviewLines: requiresRecordParsing
          ? analysis.previewRows.map((row) => row[rawValueIndex] ?? "").filter((line) => line.trim())
          : [],
        requiresRecordParsing,
      },
    },
  };
}

function withUnselectedTargetSchema(analysis: SourceConnectorAnalysis): SourceConnectorAnalysis {
  const schema = analysis.draftPatch.schema;
  if (!schema?.columns) return analysis;
  return {
    ...analysis,
    draftPatch: {
      ...analysis.draftPatch,
      schema: {
        ...schema,
        columns: schema.columns.map((column) => ({
          ...column,
          included: false,
          targetOrder: undefined,
        })),
      },
    },
  };
}

function buildMockRecordParsingPreview(rawLines: string[], recordParsing: RecordParsingDraft): RecordParsingPreviewResponse {
  const indexed = rawLines.map((line, index) => ({ line, lineNumber: index + 1 })).filter(({ line }) => line.trim());
  const rows = indexed.map(({ line, lineNumber }) => ({ line, lineNumber, values: line.trim().split(/\s+/) }));
  const dataRows = recordParsing.header ? rows.slice(1) : rows;
  const counts = new Map<number, number>();
  dataRows.forEach(({ values }) => counts.set(values.length, (counts.get(values.length) ?? 0) + 1));
  const maxCount = Math.max(0, ...counts.values());
  const dominant = Array.from(counts.entries()).filter(([, count]) => count === maxCount).map(([count]) => count);
  const expectedFieldCount = recordParsing.expectedFieldCount || recordParsing.columns.length || (dominant.length === 1 ? dominant[0] : 0);
  const valid = dataRows.filter(({ values }) => values.length === expectedFieldCount);
  const columns = Array.from({ length: expectedFieldCount }, (_, position) => {
    const current = recordParsing.columns[position];
    const values = valid.map((row) => row.values[position] ?? "");
    const inferredType = current?.inferredType ?? inferPreviewColumnType(values);
    const name = current?.name || `field_${position + 1}`;
    return { confidence: 90, nullable: false, sourceName: name, targetName: name, type: inferredType };
  });
  const normalizedColumns = columns.map((column, position) => ({ position, name: column.targetName, inferredType: column.type as RecordParsingDraft["columns"][number]["inferredType"] }));
  const invalidRows = dataRows.filter(({ values }) => values.length !== expectedFieldCount).slice(0, 20).map(({ line, lineNumber, values }) => ({
    actualFieldCount: values.length,
    expectedFieldCount,
    lineNumber,
    rawPreview: line.slice(0, 200),
  }));
  return {
    canApply: expectedFieldCount > 0 && dataRows.length > 0 && invalidRows.length === 0,
    columns,
    invalidRows,
    recordParsing: { ...recordParsing, columns: normalizedColumns, enabled: true, expectedFieldCount },
    sampleRows: valid.map(({ values }) => values),
    totalRows: dataRows.length,
    validRows: valid.length,
  };
}

function inferSchemaColumnsFromPreview(columns: string[], rows: string[][]): SchemaColumnDraft[] {
  return columns.map((column, columnIndex) => {
    const values = rows.map((row) => row[columnIndex] ?? "");
    return {
      confidence: 85,
      included: false,
      nullable: values.some((value) => isEmptyValue(value)),
      sourceName: column,
      targetName: normalizeColumnName(column),
      type: inferPreviewColumnType(values),
    };
  });
}

function inferPreviewColumnType(values: string[]) {
  const nonEmptyValues = values.map((value) => value.trim()).filter((value) => !isEmptyValue(value));
  if (nonEmptyValues.length === 0) return "String";
  if (nonEmptyValues.every((value) => /^(true|false)$/i.test(value))) return "Boolean";
  if (nonEmptyValues.every((value) => /^-?\d+$/.test(value))) return "Integer";
  if (nonEmptyValues.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Double";
  if (nonEmptyValues.every((value) => !Number.isNaN(Date.parse(value)) && /[-T:]/.test(value))) return "Timestamp";
  if (nonEmptyValues.some((value) => /^[\[{]/.test(value))) return "JSON";
  return "String";
}

function normalizeColumnName(value: string) {
  return value.trim().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || "column";
}

function isEmptyValue(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "null" || normalized === "undefined" || normalized === "-";
}

function buildSqlResultConnectorAnalysis(fields: SourceFieldRows): SourceConnectorAnalysis {
  const sourceDataset = fieldValue(fields, "Source Dataset");
  const runId = fieldValue(fields, "SQL Run ID");
  const rowCount = fieldValue(fields, "Preview Row Count");
  const sourceLabel = [sourceDataset, runId].filter(Boolean).join(" / ") || "SQL Result";
  const previewRows = [
    ["Source Dataset", sourceDataset || "-"],
    ["SQL Run ID", runId || "-"],
    ["Preview Row Count", rowCount || "-"],
    ["Backend connector", "Skipped"],
  ];

  return {
    actionPath: "/api/query/runs",
    assets: sourceDataset ? [[sourceDataset, runId || "SQL Preview", "verified"]] : [],
    draftPatch: {
      source: {
        connectionMessage: "SQL Preview result is already verified; connector test is skipped.",
        connectionStatus: "success",
        sourceConfig: fields,
        sourceLabel,
        sourceType: "SQL Result",
      },
    },
    logs: [
      "SQL Preview result is used as the processing job input.",
      "Browser connector test and schema re-inference are skipped.",
    ],
    message: "SQL Preview result is already verified; connector test is skipped.",
    previewColumns: ["Item", "Value"],
    previewNote: "SQL Preview result is preserved.",
    previewRows,
    status: "success",
    testItems: [["SQL Preview", "Verified"], ["Query", "Read-only"], ["Backend connector", "Skipped"]],
  };
}

function fieldValue(fields: SourceFieldRows, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

function normalizePrefix(value: string) {
  const normalized = value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `${normalized}/` : "";
}
