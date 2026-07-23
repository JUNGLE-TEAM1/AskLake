

import type { CatalogDataset, CreateDerivedDatasetRequest, DraftPipeline, SchemaColumnDraft, SqlResultDraft } from "../../types";
import { initialDraftPipeline } from "./etlDraftState";

export const sqlJobPermissionAccess = ["조회", "쿼리 실행", "메타데이터", "관리"];

export function buildSqlJobPermissionRoles(
  accessScope: NonNullable<CreateDerivedDatasetRequest["job"]>["accessScope"] | undefined,
  principalId?: string,
) {
  if (accessScope === "private") {
    return [];
  }

  if (accessScope === "organization" || !accessScope) {
    return [{
      access: [...sqlJobPermissionAccess],
      checked: true,
      name: "모든 인증 사용자",
      principalId: "authenticated-users",
      principalType: "public" as const,
    }];
  }

  const normalizedPrincipalId = principalId?.trim() ?? "";
  if (!normalizedPrincipalId) return [];
  return [{
    access: [...sqlJobPermissionAccess],
    checked: true,
    name: normalizedPrincipalId,
    principalId: normalizedPrincipalId,
    principalType: "group" as const,
  }];
}

export function buildSqlJobPermissionSummary(
  accessScope: NonNullable<CreateDerivedDatasetRequest["job"]>["accessScope"] | undefined,
  owner: string,
  principalId?: string,
) {
  if (accessScope === "organization" || !accessScope) return "모든 인증 사용자 · 조직 내부";
  if (accessScope === "project") {
    const normalizedPrincipalId = principalId?.trim() ?? "";
    return normalizedPrincipalId ? `그룹 ${normalizedPrincipalId} · 프로젝트 멤버` : "프로젝트 그룹 선택 필요";
  }
  return `${owner} · 소유자 전용`;
}

export function buildSqlDatasetJobDraft(
  request: CreateDerivedDatasetRequest,
  sourceDataset: CatalogDataset,
  sqlResult: SqlResultDraft,
): DraftPipeline {
  const targetDataset = normalizeDraftDatasetName(request.dataset.name, `${sourceDataset.name}_analysis`);
  const targetLayer = request.dataset.layer;
  const targetFormat = request.job?.fileFormat ?? "parquet";
  const partitionColumns = request.job?.partitionColumns
    ?? (request.job?.partitionColumn ? [request.job.partitionColumn] : []);
  const permissionOwner = request.job?.owner || sourceDataset.owner || initialDraftPipeline.permission.owner;
  const outputColumns: Array<[string, string]> = sqlResult.columns.map((column) => [column, inferSqlResultColumnType(sourceDataset, column)]);
  const schemaColumns: SchemaColumnDraft[] = outputColumns.map(([name, type], index) => ({
    confidence: 1,
    included: true,
    nullable: true,
    role: index === 0 ? "primary" : "derived",
    sourceName: name,
    targetName: name,
    type,
  }));
  return {
    ...initialDraftPipeline,
    id: `sql_${normalizeDraftId(targetDataset)}_${normalizeDraftId(sqlResult.runId).slice(-8)}`,
    permission: {
      ...initialDraftPipeline.permission,
      owner: permissionOwner,
      roles: buildSqlJobPermissionRoles(request.job?.accessScope, request.job?.principalId),
      summary: buildSqlJobPermissionSummary(
        request.job?.accessScope,
        permissionOwner,
        request.job?.principalId,
      ),
    },
    quality: {
      invalidRows: [],
      rules: [],
      score: 100,
      status: "pass",
      summary: `SQL Preview 검증 완료 · ${sqlResult.rowCount.toLocaleString()} rows · read-only query`,
    },
    schedule: {
      ...initialDraftPipeline.schedule,
      endDate: "",
      label: request.job?.scheduleLabel || "스케줄링 건너뛰기",
      mode: request.job?.scheduleMode || "manual",
      nextRun: request.job?.scheduleMode === "repeat" ? "다음 예약 계산 중" : "수동 실행 대기",
      overlapPolicy: request.job?.overlapPolicy ?? initialDraftPipeline.schedule.overlapPolicy,
      startDate: "",
      summary: request.job?.scheduleSummary || "SQL 결과 저장 Job · 수동 실행",
      timezone: request.job?.timezone ?? initialDraftPipeline.schedule.timezone,
    },
    schema: {
      columns: schemaColumns,
      sampleRows: sqlResult.rows,
      schemaFingerprint: `${sqlResult.runId}:${sqlResult.columns.join("|")}`,
      summary: `${schemaColumns.length}개 컬럼 · Preview ${sqlResult.rows.length}/${sqlResult.rowCount} rows`,
    },
    source: {
      connectionMessage: `SQL Preview ${sqlResult.runId} 결과를 처리 Job 입력으로 사용합니다.`,
      connectionStatus: "success",
      sourceConfig: [
        ["Source Dataset", sourceDataset.name],
        ["Source Dataset ID", sourceDataset.id],
        ["SQL Run ID", sqlResult.runId],
        ["Preview Limit", String(sqlResult.previewLimit ?? request.previewLimit ?? "")],
        ["Preview Row Count", String(sqlResult.rowCount)],
        ["Reference Dataset IDs", (request.referenceDatasetIds ?? []).join(", ") || "-"],
        ["Validation Key", request.validationKey ?? "-"],
        ["Query", request.query],
      ],
      sourceLabel: `${sourceDataset.name} / ${sqlResult.runId}`,
      sourceType: "SQL Result",
    },
    target: {
      ...initialDraftPipeline.target,
      compression: request.job?.compression ?? "Snappy",
      databaseName: request.job?.databaseName?.trim() || "asklake",
      datasetName: targetDataset,
      description: request.dataset.description,
      format: targetFormat,
      layer: targetLayer,
      partition: partitionColumns.join("/"),
      partitionColumns,
      rag: false,
      storagePath: request.job?.storagePath || `s3a://asklake-output/${targetDataset}/${targetLayer.toLowerCase()}/`,
      storageType: "S3",
      tableName: targetDataset,
      tags: request.job?.tags ?? request.dataset.tags,
    },
    transform: {
      outputColumns,
      // SQL Result is already the materialized source for this Job. The
      // query result schema is carried by sourceConfig and outputColumns;
      // representing it as a single-column transform makes the backend rule
      // compiler reject the dataset name as an input column.
      steps: [],
      summary: `SQL Preview ${sqlResult.runId} 결과를 ${targetDataset} 데이터셋으로 저장`,
    },
  };
}

export function inferSqlResultColumnType(dataset: CatalogDataset, columnName: string) {
  return dataset.schema.find(([name]) => name === columnName)?.[1] ?? "string";
}

export function normalizeDraftDatasetName(value: string, fallback: string) {
  const normalized = value.trim() || fallback;
  return normalized.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "sql_derived_dataset";
}

export function normalizeDraftId(value: string) {
  return normalizeDraftDatasetName(value, "sql_derived").toLowerCase();
}
