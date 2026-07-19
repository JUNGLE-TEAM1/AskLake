import type { CreatePipelineRequest, DraftPipeline, PermissionGrant, RuleCompilationResult } from "../types";
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

const PERMISSION_REVIEW_ACTION_LABELS = {
  delete: "삭제",
  manage: "관리",
  query: "쿼리 실행",
  run: "실행",
  share: "공유",
  view: "조회",
} as const;

export type ReviewSnapshotRequest = CreatePipelineRequest & {
  sourceConnectionStatus: DraftPipeline["source"]["connectionStatus"];
};

const inFlightReviewRequests = new Map<string, Promise<ReviewSnapshot>>();

export function buildReviewSnapshotRequest(draft: DraftPipeline): ReviewSnapshotRequest {
  return {
    ...toCreatePipelineRequest(draft),
    sourceConnectionStatus: draft.source.connectionStatus,
  };
}

export function getReviewSnapshotRequestKey(request: ReviewSnapshotRequest) {
  return JSON.stringify(request);
}

export function getReviewSnapshot(request: ReviewSnapshotRequest): Promise<ReviewSnapshot> {
  const requestKey = getReviewSnapshotRequestKey(request);
  const inFlightRequest = inFlightReviewRequests.get(requestKey);
  if (inFlightRequest) return inFlightRequest;

  const requestPromise = !apiConfig.useMock
    ? apiClient.post<ReviewSnapshot>("/api/etl/review", request)
    : new Promise<ReviewSnapshot>((resolve) => {
      window.setTimeout(() => resolve(buildMockReviewSnapshot(request)), 120);
    });

  let trackedRequest: Promise<ReviewSnapshot>;
  trackedRequest = requestPromise.finally(() => {
    if (inFlightReviewRequests.get(requestKey) === trackedRequest) {
      inFlightReviewRequests.delete(requestKey);
    }
  });
  inFlightReviewRequests.set(requestKey, trackedRequest);
  return trackedRequest;
}

function buildMockReviewSnapshot(request: ReviewSnapshotRequest): ReviewSnapshot {
  const includedColumns = request.schemaColumns.filter((column) => column.included !== false && Boolean(column.targetName.trim()));
  const ruleCompilation = compileRuleContract({
    contractVersion: request.ruleContractVersion,
    executionMode: request.executionMode,
    qualityRules: request.qualityRules,
    rules: request.rules,
    schemaColumns: request.schemaColumns,
    sourceType: request.sourceType,
    transformOutputColumns: request.transformOutputColumns,
    transformSteps: request.transformSteps,
  });
  const outputColumns = ruleCompilation.outputSchema;
  const sourceReady = request.sourceConnectionStatus === "success";
  const schemaReady = includedColumns.length > 0;
  const processingReady = ruleCompilation.status === "pass";
  const targetReady = Boolean(request.targetDataset.trim() && String(request.targetLayer).trim() && request.targetFormat.trim());
  const permissionIssue = reviewPermissionIssue(request.owner, request.permissionGrants);
  const permissionReady = permissionIssue === null;

  return {
    basicInformation: toReviewEntries([
      ["소스", [sourceTypeLabel(request.sourceType), request.sourceLabel].filter(Boolean).join(" · ")],
      ["처리 방식", request.executionMode === "continuous" ? "실시간 · ClickHouse" : "배치 · Spark"],
      ["출력 데이터셋 이름", request.targetDataset],
      ["설명", request.targetDescription],
    ]),
    canCreate: sourceReady && schemaReady && processingReady && targetReady && permissionReady && Boolean(request.sourceType.trim()) && Boolean(request.sourceLabel.trim()),
    destination: toReviewEntries([
      ["저장 경로", request.storagePath ?? ""],
      ["데이터베이스", request.targetDatabase ?? "asklake"],
      ["형식", request.targetFormat],
      ["파티션", request.partition || "없음"],
    ]),
    permission: permissionReviewEntries(request.owner, request.permissionGrants),
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
      validationRow("소스 데이터", sourceReady, "연결됨", "연결 확인 필요"),
      validationRow("출력 스키마", schemaReady, "확정됨", "필드 선택 필요"),
      validationRow(
        "처리 규칙",
        processingReady,
        ruleCompilation.rules.some((rule) => rule.enabled)
          ? `${ruleCompilation.rules.filter((rule) => rule.enabled).length}개 규칙 컴파일 완료`
          : "규칙 없음 · 원본 스키마 그대로 통과",
        ruleCompilation.issues[0]?.message ?? "규칙을 확인하세요",
      ),
      validationRow("접근 권한", permissionReady, "설정됨", permissionIssue ?? "권한 확인 필요"),
      validationRow("저장 위치", targetReady, "설정됨", "출력 데이터셋 이름 확인 필요"),
    ],
  };
}

function validationRow(label: string, ready: boolean, readyValue: string, warningValue: string): ReviewValidationRow {
  return { label, status: ready ? "ready" : "warning", value: ready ? readyValue : warningValue };
}

function permissionReviewEntries(owner: string, grants: PermissionGrant[] | undefined): ReviewEntry[] {
  const principalLabels = {
    group: "그룹",
    public: "모든 사용자",
    role: "역할",
    user: "사용자",
  } as const;
  const publicView = (grants ?? []).some((grant) => grant.principalType === "public" && grant.actions.includes("view"));
  return toReviewEntries([
    ["담당자", `${owner} · 모든 작업 가능`],
    ["로그인한 모든 사용자", publicView ? "조회 가능" : "조회 불가"],
    ...(grants ?? []).filter((grant) => grant.principalType !== "public").map((grant): [string, string] => {
      return [
        `${grant.principalName ?? grant.principalId} (${principalLabels[grant.principalType]})`,
        grant.actions.map((action) => PERMISSION_REVIEW_ACTION_LABELS[action]).join(" · ") || "권한 없음",
      ];
    }),
  ]);
}

function reviewPermissionIssue(owner: string, grants: PermissionGrant[] | undefined): string | null {
  if (!owner.trim()) return "담당자 확인 필요";
  for (const grant of grants ?? []) {
    if (grant.principalType !== "public" && !grant.principalId.trim()) return "권한 대상 확인 필요";
    if (grant.actions.length === 0) return "허용 작업 확인 필요";
  }
  return null;
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
