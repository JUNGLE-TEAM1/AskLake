import { apiClient } from "./apiClient";
import type { DraftPipelinePatch, RecordParsingDraft, RecordParsingPreviewResponse, SchemaColumnDraft, SourceDraft } from "../types";

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
  return withRecordParsingSourceMetadata(normalizeConnectorAnalysis(
    await postSourceConnector(normalizedSourceType, fields),
    normalizedSourceType,
    fields,
  ), fields);
}

export async function previewRecordParsing(rawLines: string[], recordParsing: RecordParsingDraft): Promise<RecordParsingPreviewResponse> {
  return apiClient.post<RecordParsingPreviewResponse>("/api/etl/record-parsing/preview", { rawLines, recordParsing });
}

export async function getSourceConnectorDefaults(): Promise<SourceConnectorDefaults> {
  return apiClient.get<SourceConnectorDefaults>("/api/etl/sources/defaults");
}

export async function listSourceAssets(sourceType: string, fields: SourceFieldRows, prefix = ""): Promise<SourceAssetsResponse> {
  return postSourceAssets(normalizeSourceType(sourceType), fields, prefix);
}

async function postSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<BackendSourceConnectorResponse> {
  const body = { sourceConfig: fields, sourceType };
  return apiClient.post<BackendSourceConnectorResponse>("/api/etl/sources/test", body);
}

async function postSourceAssets(sourceType: string, fields: SourceFieldRows, prefix: string): Promise<SourceAssetsResponse> {
  const body = { prefix, sourceConfig: fields, sourceType };
  return apiClient.post<SourceAssetsResponse>("/api/etl/sources/assets", body);
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
  return Boolean(
    fieldValue(fields, "__Selected Object")
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
  const sampleObject = fieldValue(analysis.draftPatch.source?.sourceConfig ?? fields, "__Sample Object")
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
