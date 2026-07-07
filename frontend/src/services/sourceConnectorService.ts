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

export async function testSourceConnector(sourceType: string, fields: SourceFieldRows): Promise<SourceConnectorAnalysis> {
  const normalizedSourceType = sourceType === "Database" ? "PostgreSQL" : sourceType;
  if (normalizedSourceType === "SQL Result") {
    return buildSqlResultConnectorAnalysis(fields);
  }

  if (apiConfig.useMock) {
    return resolveMock(buildMockSourceConnectorAnalysis(sourceType, fields));
  }

  return apiClient.post<BackendSourceConnectorResponse>("/api/etl/sources/test", {
    sourceConfig: fields,
    sourceType,
  });
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
      "외부 커넥터 연결 테스트와 schema 재추론은 생략합니다.",
    ],
    message: "SQL Preview 결과가 이미 검증되어 소스 연결 테스트를 생략합니다.",
    previewColumns: ["항목", "값"],
    previewNote: "SQL 분석 화면에서 전달된 Preview 결과를 보존합니다.",
    previewRows,
    status: "success",
    testItems: [["SQL Preview", "Verified"], ["Query", "Read-only"], ["Backend connector", "Skipped"]],
  };
}

function buildMockSourceConnectorAnalysis(sourceType: string, fields: SourceFieldRows): SourceConnectorAnalysis {
  const normalizedSourceType = sourceType === "Database" ? "PostgreSQL" : sourceType;
  const sourceLabel = getSourceLabel(normalizedSourceType, fields);
  const sourceId = toStableId("source", `${normalizedSourceType}:${sourceLabel}`);
  const runId = toStableId("run", `${sourceId}:${Date.now()}`);
  const sample = getMockSourceSample(normalizedSourceType);
  const sourceConfig = upsertFields(fields, [
    ["__Source ID", sourceId],
    ["__Run ID", runId],
    ["__Source Unit Count", String(sample.assets.length || sample.previewRows.length || 1)],
  ]);

  return {
    actionPath: "/api/etl/sources/test/mock",
    assets: sample.assets,
    draftPatch: {
      schema: {
        columns: sample.schemaColumns,
        sampleRows: sample.previewRows,
        schemaFingerprint: sample.schemaColumns.map((column) => `${column.targetName}:${column.type}:${column.nullable ? "nullable" : "required"}`).join("|"),
        summary: `${sourceLabel} mock sample에서 ${sample.schemaColumns.length}개 필드 추론`,
      },
      source: {
        connectionMessage: `${getSourceTypeLabel(normalizedSourceType)} mock 연결 성공: ${sourceLabel}`,
        connectionStatus: "success",
        sourceConfig,
        sourceLabel,
        sourceType: normalizedSourceType,
      },
    },
    logs: [
      `${getSourceTypeLabel(normalizedSourceType)} mock connector 실행`,
      `샘플 소스 식별: ${sourceLabel}`,
      `스키마 필드 ${sample.schemaColumns.length}개, 샘플 행 ${sample.previewRows.length}개 반환`,
    ],
    message: `${getSourceTypeLabel(normalizedSourceType)} mock 연결 성공`,
    previewColumns: sample.previewColumns,
    previewNote: "Mock mode에서는 백엔드 커넥터 호출 없이 제한 샘플을 반환합니다.",
    previewRows: sample.previewRows,
    status: "success",
    testItems: [["Connector", normalizedSourceType], ["Mode", "Mock"], ["Result", "Success"]],
  };
}

function getMockSourceSample(sourceType: string) {
  if (sourceType === "PostgreSQL") {
    return makeSample({
      assets: [["commerce.orders", "public", "sampled"], ["commerce.customers", "public", "detected"]],
      columns: [["order_id", "string"], ["customer_id", "string"], ["order_date", "timestamp"], ["total_amount", "decimal"], ["status", "string"]],
      rows: [["ORD-1001", "CUS-204", "2026-07-02", "128000", "paid"], ["ORD-1002", "CUS-118", "2026-07-02", "56000", "shipped"]],
    });
  }

  if (sourceType === "MongoDB") {
    return makeSample({
      assets: [["events", "42,000 documents", "sampled"], ["profiles", "8,400 documents", "detected"]],
      columns: [["_id", "string"], ["user_id", "string"], ["event_name", "string"], ["event_time", "timestamp"], ["payload", "JSON"]],
      rows: [["evt_001", "u_001", "page_view", "2026-07-04T10:00:00Z", "{\"page\":\"/pricing\"}"], ["evt_002", "u_002", "purchase", "2026-07-04T10:03:00Z", "{\"amount\":42000}"]],
    });
  }

  if (sourceType === "REST API") {
    return makeSample({
      assets: [["REST endpoint", "246 bytes", "HTTP 200"]],
      columns: [["user_id", "string"], ["email", "string"], ["date", "date"], ["status", "string"], ["amount", "decimal"]],
      rows: [["u_001", "demo1@example.com", "2026-07-04", "active", "42.7"], ["u_002", "demo2@example.com", "2026-07-04", "active", "19.25"]],
    });
  }

  if (sourceType === "Data Lake") {
    return makeSample({
      assets: [["nyc_taxi/yellow_parquet/part-0001.parquet", "128 MB", "listed"], ["nyc_taxi/yellow_parquet/part-0002.parquet", "126 MB", "listed"]],
      columns: [["pickup_at", "timestamp"], ["dropoff_at", "timestamp"], ["passenger_count", "integer"], ["fare_amount", "decimal"], ["payment_type", "string"]],
      rows: [["2026-07-04 09:12:00", "2026-07-04 09:31:00", "2", "18.4", "card"], ["2026-07-04 09:20:00", "2026-07-04 09:44:00", "1", "24.8", "cash"]],
    });
  }

  if (sourceType === "Stream / Kafka") {
    return makeSample({
      assets: [["asklake-source-events", "3 partitions", "sampled"], ["consumer-group", "asklake-etl-consumer-01", "ready"]],
      columns: [["event_id", "string"], ["user_id", "string"], ["event_time", "timestamp"], ["page_url", "string"], ["raw_payload", "JSON"]],
      rows: [["EVT-881", "CUS-204", "2026-07-04T10:21:00Z", "/pricing", "{\"action\":\"click\"}"], ["EVT-882", "CUS-118", "2026-07-04T10:22:00Z", "/checkout", "{\"action\":\"view\"}"]],
    });
  }

  return makeSample({
    assets: [["nyc_taxi/csv/yellow_tripdata_sample.csv", "24 MB", "listed"], ["nyc_taxi/csv/yellow_tripdata_02.csv", "27 MB", "listed"]],
    columns: [["trip_id", "string"], ["pickup_at", "timestamp"], ["dropoff_at", "timestamp"], ["fare_amount", "decimal"], ["payment_type", "string"]],
    rows: [["trip_001", "2026-07-04 09:12:00", "2026-07-04 09:31:00", "18.4", "card"], ["trip_002", "2026-07-04 09:20:00", "2026-07-04 09:44:00", "24.8", "cash"]],
  });
}

function makeSample({
  assets,
  columns,
  rows,
}: {
  assets: Array<[string, string, string]>;
  columns: Array<[string, string]>;
  rows: string[][];
}) {
  const schemaColumns: SchemaColumnDraft[] = columns.map(([name, type]) => ({
    confidence: 90,
    nullable: false,
    sourceName: name,
    targetName: name,
    type,
  }));

  return {
    assets,
    previewColumns: columns.map(([name]) => name),
    previewRows: rows,
    schemaColumns,
  };
}

function getSourceLabel(sourceType: string, fields: SourceFieldRows) {
  const labelBySourceType: Record<string, string[]> = {
    "Data Lake": ["Path"],
    "File / S3": ["Bucket / Stage Name", "Path / Prefix"],
    MongoDB: ["Database Name", "Collection"],
    PostgreSQL: ["Endpoint / Host", "Database Name", "DATASET OR TABLE SELECTOR"],
    "REST API": ["Endpoint URL"],
    "SQL Result": ["Source Dataset", "SQL Run ID"],
    "Stream / Kafka": ["TOPIC / QUEUE NAME", "Broker / Endpoint"],
  };
  const labels = labelBySourceType[sourceType] ?? [];
  const values = labels.map((label) => fieldValue(fields, label)).filter(Boolean);
  return values.join(" / ") || sourceType;
}

function getSourceTypeLabel(sourceType: string) {
  const labels: Record<string, string> = {
    "Data Lake": "Data Lake",
    "File / S3": "File / S3",
    MongoDB: "MongoDB",
    PostgreSQL: "PostgreSQL",
    "REST API": "REST API",
    "SQL Result": "SQL Result",
    "Stream / Kafka": "Kafka",
  };
  return labels[sourceType] ?? sourceType;
}

function fieldValue(fields: SourceFieldRows, label: string) {
  return fields.find(([fieldLabel]) => fieldLabel === label)?.[1]?.trim() ?? "";
}

function upsertFields(fields: SourceFieldRows, patches: SourceFieldRows) {
  const nextFields = [...fields];
  patches.forEach(([label, value]) => {
    const index = nextFields.findIndex(([fieldLabel]) => fieldLabel === label);
    if (index >= 0) {
      nextFields[index] = [label, value];
    } else {
      nextFields.push([label, value]);
    }
  });
  return nextFields;
}

function toStableId(prefix: string, value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return `${prefix}_${Math.abs(hash).toString(16)}`;
}

async function resolveMock<T>(payload: T): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  return payload;
}
