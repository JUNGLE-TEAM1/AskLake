import { apiClient } from "./apiClient";
import { ApiError } from "../types";
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
  return apiClient.post<RecordParsingPreviewResponse>("/api/etl/record-parsing/preview", { rawLines, recordParsing });
}

export async function getSourceConnectorDefaults(): Promise<SourceConnectorDefaults> {
  return getWithDevFallback<SourceConnectorDefaults>("/api/etl/sources/defaults");
}

export async function listSourceAssets(sourceType: string, fields: SourceFieldRows, prefix = ""): Promise<SourceAssetsResponse> {
  const normalizedSourceType = normalizeSourceType(sourceType);
  return postSourceAssets(normalizedSourceType, sanitizeSourceConnectorFields(normalizedSourceType, fields), prefix);
}

async function postSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<BackendSourceConnectorResponse> {
  const body = { sourceConfig: fields, sourceType };
  return apiClient.post<BackendSourceConnectorResponse>("/api/etl/sources/test", body);
}

async function postSourceAssets(sourceType: string, fields: SourceFieldRows, prefix: string): Promise<SourceAssetsResponse> {
  const body = { prefix, sourceConfig: fields, sourceType };
  return postWithDevFallback<SourceAssetsResponse>("/api/etl/sources/assets", body);
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

function isNotFoundError(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

function normalizeSourceType(sourceType: string) {
  return sourceType === "Database" ? "PostgreSQL" : sourceType;
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
  if (!analysis.draftPatch.source) return analysis;
  const sourceMetadata = analysis.draftPatch.source;
  const sampleObject = analysis.datasetSummary?.representativeObject
    || fieldValue(sourceMetadata.sourceConfig ?? fields, "__Sample Object")
    || fieldValue(sourceMetadata.sourceConfig ?? fields, "__Selected Object")
    || fieldValue(fields, "Path / Prefix");
  const detectedFormat = sourceMetadata.detectedFormat
    || (/\.(txt|log)$/i.test(sampleObject) ? "TXT" : undefined);
  const rawValueIndex = analysis.previewColumns.findIndex((column) => /^(value|raw_value)$/i.test(column));
  const inferredRequiresRecordParsing = detectedFormat === "TXT" && rawValueIndex >= 0;
  const requiresRecordParsing = sourceMetadata.requiresRecordParsing ?? inferredRequiresRecordParsing;
  const backendRawPreviewLines = sourceMetadata.rawPreviewLines?.filter((line) => line.trim()) ?? [];
  const rawPreviewLines = backendRawPreviewLines.length > 0
    ? backendRawPreviewLines
    : requiresRecordParsing && rawValueIndex >= 0
      ? analysis.previewRows.map((row) => row[rawValueIndex] ?? "").filter((line) => line.trim())
      : [];
  return {
    ...analysis,
    draftPatch: {
      ...analysis.draftPatch,
      source: {
        ...sourceMetadata,
        detectedFormat,
        rawPreviewLines,
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
