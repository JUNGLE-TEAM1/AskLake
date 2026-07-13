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

export type SourceConnectorDefaults = {
  kafkaBroker: string;
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
  return normalizeConnectorAnalysis(
    await postSourceConnector(normalizedSourceType, fields),
    normalizedSourceType,
    fields,
  );
}

export async function getSourceConnectorDefaults(): Promise<SourceConnectorDefaults> {
  if (apiConfig.useMock) return { kafkaBroker: "127.0.0.1:19092" };
  return getWithDevFallback<SourceConnectorDefaults>("/api/etl/sources/defaults");
}

export async function listSourceAssets(sourceType: string, fields: SourceFieldRows, prefix = ""): Promise<SourceAssetsResponse> {
  return postSourceAssets(normalizeSourceType(sourceType), fields, prefix);
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

  return {
    actionPath: "/api/etl/sources/test",
    assets: mockSourceAssets(sourceType, ""),
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
  const basePath = prefix.trim() || (sourceType === "PostgreSQL" ? "public" : "sample");
  return [
    [`${basePath}/customer_reviews.parquet`, "Parquet", "준비됨"],
    [`${basePath}/customer_reviews.csv`, "CSV", "준비됨"],
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
  const response = await fetch(`http://127.0.0.1:8080${path}`);
  if (response.ok) return await response.json() as T;
  const text = await response.text().catch(() => "");
  throw new Error(text || `Backend ${response.status} ${response.statusText}`);
}

async function postBackendDirect<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:8080${path}`, {
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
  return Boolean(
    fieldValue(fields, "__Selected Object")
      || fieldValue(fields, "__Sample Object")
      || looksLikeDataFile(fieldValue(fields, "Path / Prefix"))
      || looksLikeDataFile(fieldValue(fields, "Path"))
      || looksLikeDataFile(fieldValue(fields, "DATASET OR TABLE SELECTOR")),
  );
}

function looksLikeDataFile(value: string) {
  return /\.(csv|tsv|txt|json|jsonl|parquet)$/i.test(value.trim());
}

function inferSchemaColumnsFromPreview(columns: string[], rows: string[][]): SchemaColumnDraft[] {
  return columns.map((column, columnIndex) => {
    const values = rows.map((row) => row[columnIndex] ?? "");
    return {
      confidence: 85,
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
