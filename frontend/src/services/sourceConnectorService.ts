import { apiClient } from "./apiClient";
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

export type SourceAssetsResponse = {
  assets: Array<[string, string, string]>;
  count?: number;
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

export async function listSourceAssets(sourceType: string, fields: SourceFieldRows, prefix = ""): Promise<SourceAssetsResponse> {
  return postSourceAssets(normalizeSourceType(sourceType), fields, prefix);
}

async function postSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<BackendSourceConnectorResponse> {
  const body = { sourceConfig: fields, sourceType };
  return postWithDevFallback<BackendSourceConnectorResponse>("/api/etl/sources/test", body);
}

async function postSourceAssets(sourceType: string, fields: SourceFieldRows, prefix: string): Promise<SourceAssetsResponse> {
  const body = { prefix, sourceConfig: fields, sourceType };
  return postWithDevFallback<SourceAssetsResponse>("/api/etl/sources/assets", body);
}

async function postWithDevFallback<T>(path: string, body: unknown): Promise<T> {
  try {
    return await apiClient.post<T>(path, body);
  } catch (error) {
    if (import.meta.env.DEV && isNotFoundError(error)) {
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
    throw error;
  }
}

function normalizeSourceType(sourceType: string) {
  return sourceType === "Database" ? "PostgreSQL" : sourceType;
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /not found|404/i.test(error.message);
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
        summary: `${analysis.previewNote || "샘플"} 기준 ${inferredColumns.length}개 필드 추론`,
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
  if (nonEmptyValues.every((value) => /^-?\d+(\.\d+)?$/.test(value))) return "Float";
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
        connectionMessage: "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다.",
        connectionStatus: "success",
        sourceConfig: fields,
        sourceLabel,
        sourceType: "SQL Result",
      },
    },
    logs: [
      "SQL Preview 결과를 처리 Job 입력으로 사용합니다.",
      "외부 커넥터 연결 테스트와 schema 재추론을 생략합니다.",
    ],
    message: "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다.",
    previewColumns: ["항목", "값"],
    previewNote: "SQL 분석 화면에서 전달된 Preview 결과를 보존합니다.",
    previewRows,
    status: "success",
    testItems: [["SQL Preview", "Verified"], ["Query", "Read-only"], ["Backend connector", "Skipped"]],
  };
}

function fieldValue(fields: SourceFieldRows, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}
