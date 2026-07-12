import type { DraftPipeline, RuleCompilationResult } from "../types";
import { apiClient, apiConfig } from "./apiClient";
import { toCreatePipelineRequest } from "./draftPipelineContract";
import { compileRuleContract } from "./ruleContract";

export type ReviewEntry = {
  label: string;
  value: string;
};

export type ReviewSchemaRow = {
  columnName: string;
  nullable: string;
  transform: string;
  type: string;
};

export type ReviewValidationRow = {
  label: string;
  status: "ready" | "warning";
  value: string;
};

export type ReviewSnapshot = {
  basicInformation: ReviewEntry[];
  canCreate: boolean;
  destination: ReviewEntry[];
  permission: ReviewEntry[];
  ruleCompilation: RuleCompilationResult;
  schema: ReviewSchemaRow[];
  validation: ReviewValidationRow[];
};

export async function getReviewSnapshot(draft: DraftPipeline): Promise<ReviewSnapshot> {
  const request = {
    ...toCreatePipelineRequest(draft),
    sourceConnectionStatus: draft.source.connectionStatus,
  };

  if (!apiConfig.useMock) {
    return apiClient.post<ReviewSnapshot>("/api/etl/review", request);
  }

  return new Promise((resolve) => {
    window.setTimeout(() => resolve(buildMockReviewSnapshot(draft)), 120);
  });
}

function buildMockReviewSnapshot(draft: DraftPipeline): ReviewSnapshot {
  const request = toCreatePipelineRequest(draft);
  const includedColumns = draft.schema.columns.filter((column) => column.included !== false && Boolean(column.targetName.trim()));
  const ruleCompilation = compileRuleContract({
    executionMode: request.executionMode,
    qualityRules: request.qualityRules,
    rules: request.rules,
    schemaColumns: request.schemaColumns,
    sourceType: request.sourceType,
    transformOutputColumns: request.transformOutputColumns,
    transformSteps: request.transformSteps,
  });
  const outputColumns = ruleCompilation.outputSchema;
  const sourceReady = draft.source.connectionStatus === "success";
  const schemaReady = includedColumns.length > 0;
  const processingReady = ruleCompilation.status === "pass";
  const scheduleReady = Boolean(request.scheduleLabel.trim());
  const retryReady = Boolean(request.retryPolicySummary.trim());
  const permissionReady = Boolean(request.permissionSummary.trim() && request.targetDataset.trim() && request.owner.trim());

  return {
    basicInformation: toReviewEntries([
      ["작업 ID", request.id],
      ["작업명", request.jobName],
      ["소스", [sourceTypeLabel(request.sourceType), request.sourceLabel].filter(Boolean).join(" · ")],
      ["실행 방식", request.executionMode === "continuous" ? "실시간 스트림" : "Snapshot batch"],
      ["대상 데이터셋", request.targetDataset],
      ["설명", request.targetDescription],
    ]),
    canCreate: sourceReady && schemaReady && processingReady && Boolean(request.sourceType.trim()) && Boolean(request.sourceLabel.trim()) && Boolean(request.targetDataset.trim()) && Boolean(request.owner.trim()),
    destination: toReviewEntries([
      ["저장 경로", request.storagePath ?? ""],
      ["데이터베이스", request.targetDatabase ?? "asklake"],
      ["테이블 이름", draft.target.tableName ?? request.targetDataset],
      ["형식", request.targetFormat],
      ["계층", request.targetLayer],
      ["파티션", request.partition || "없음"],
    ]),
    permission: toReviewEntries([
      ["담당자", request.owner],
      ["요약", request.permissionSummary],
    ]),
    ruleCompilation,
    schema: outputColumns.map(([name, type]) => {
      const sourceColumn = includedColumns.find((column) => column.targetName === name || column.sourceName === name);
      return {
        columnName: name,
        nullable: sourceColumn ? (sourceColumn.nullable ? "예" : "아니요") : "생성",
        transform: sourceColumn ? (sourceColumn.sourceName === name ? `원본.${sourceColumn.sourceName}` : `${sourceColumn.sourceName} -> ${name}`) : "변환 출력",
        type,
      };
    }),
    validation: [
      validationRow("소스 연결", sourceReady, "완료", "확인 필요"),
      validationRow("스키마", schemaReady, "확정됨", "추론 필요"),
      validationRow(
        "처리 규칙",
        processingReady,
        ruleCompilation.rules.some((rule) => rule.enabled)
          ? `${ruleCompilation.rules.filter((rule) => rule.enabled).length}개 규칙 컴파일 완료`
          : "규칙 없음 · 원본 스키마 그대로 통과",
        ruleCompilation.issues[0]?.message ?? "규칙을 확인하세요",
      ),
      validationRow(request.executionMode === "continuous" ? "스트림 제어" : "스케줄", scheduleReady, request.executionMode === "continuous" ? "시작/중지로 제어" : "유효함", "확인 필요"),
      validationRow("실패 재시도", retryReady, "유효함", "확인 필요"),
      validationRow("권한/타겟", permissionReady, "유효함", "확인 필요"),
    ],
  };
}

function validationRow(label: string, ready: boolean, readyValue: string, warningValue: string): ReviewValidationRow {
  return { label, status: ready ? "ready" : "warning", value: ready ? readyValue : warningValue };
}

function toReviewEntries(rows: Array<[string, string | undefined]>): ReviewEntry[] {
  return rows.map(([label, value]) => ({ label, value: displayValue(value) }));
}

function displayValue(value: string | undefined) {
  return value?.trim() || "미설정";
}

function sourceTypeLabel(value: string) {
  return value === "Database" ? "PostgreSQL" : value;
}
