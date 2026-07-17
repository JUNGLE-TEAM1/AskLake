import { apiClient } from "./apiClient";
import type { DraftPipelinePatch, RecordParsingDraft, RecordParsingPreviewResponse, SourceDraft } from "../types";
import { sanitizeSourceConnectorFields, type SourceFieldRows } from "../utils/sourceConnectorFields";

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
  return withUnselectedTargetSchema(withRecordParsingSourceMetadata(
    await postSourceConnector(normalizedSourceType, requestFields),
    requestFields,
  ));
}

export async function previewRecordParsing(rawLines: string[], recordParsing: RecordParsingDraft): Promise<RecordParsingPreviewResponse> {
  return apiClient.post<RecordParsingPreviewResponse>("/api/etl/record-parsing/preview", { rawLines, recordParsing });
}

export async function getSourceConnectorDefaults(): Promise<SourceConnectorDefaults> {
  return apiClient.get<SourceConnectorDefaults>("/api/etl/sources/defaults");
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
  return apiClient.post<SourceAssetsResponse>("/api/etl/sources/assets", body);
}

function normalizeSourceType(sourceType: string) {
  return sourceType === "Database" ? "PostgreSQL" : sourceType;
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
