import type { CreatePipelineRequest, DraftPipeline, DraftPipelinePatch, RetryBackoffStrategy, RetryFailureAction, RetryPolicyDraft, ScheduleDraft, ScheduleOverlapPolicy, WatermarkPolicyDraft, WatermarkWindowMode } from "../types";

export const retryFailureActionLabels: Record<RetryFailureAction, string> = {
  notify_only: "알림만 남기기",
  retry_then_fail: "재시도 후 실패 처리",
  retry_then_quarantine: "재시도 후 격리",
};

export const retryBackoffStrategyLabels: Record<RetryBackoffStrategy, string> = {
  exponential: "지수 백오프",
  fixed: "고정 간격",
};

export const scheduleOverlapPolicyLabels: Record<ScheduleOverlapPolicy, string> = {
  allow_parallel: "겹쳐도 새 Run 시작",
  queue_after_current: "이전 Run 종료 후 대기 Run 실행",
  skip_if_running: "이전 Run 실행 중이면 다음 예약 건너뜀",
};

export const watermarkWindowModeLabels: Record<WatermarkWindowMode, string> = {
  full_refresh: "매번 전체 수집",
  last_success_to_run_started_at: "마지막 성공 Run부터 실제 시작 시각까지",
  last_success_to_scheduled_at: "마지막 성공 Run부터 예약 기준 시각까지",
};

export function toCreatePipelineRequest(draft: DraftPipeline): CreatePipelineRequest {
  const targetDataset = draft.target.datasetName.trim();
  const retryPolicy = normalizeRetryPolicy(draft.schedule.retryPolicy);
  const watermarkPolicy = normalizeWatermarkPolicy(draft.schedule.watermarkPolicy);
  return {
    id: draft.id,
    jobName: `${targetDataset}_pipeline`,
    owner: draft.permission.owner,
    permissionSummary: draft.permission.summary,
    permissionRoles: draft.permission.roles,
    rag: draft.target.rag,
    retryPolicy,
    retryPolicySummary: formatRetryPolicySummary(retryPolicy),
    runLimitSummary: formatRunLimitSummary(retryPolicy),
    ruleSummary: combineSummaries(draft.transform.summary, draft.quality.summary),
    qualityInvalidRows: draft.quality.invalidRows,
    qualityRules: draft.quality.rules,
    qualityScore: draft.quality.score,
    qualityStatus: draft.quality.status,
    endDate: draft.schedule.endDate,
    nextRunUtc: draft.schedule.nextRunUtc,
    overlapPolicy: draft.schedule.overlapPolicy,
    scheduleLabel: draft.schedule.label,
    scheduleSummary: draft.schedule.summary || draft.schedule.label,
    startDate: draft.schedule.startDate,
    timezone: draft.schedule.timezone,
    watermarkPolicy,
    schemaColumns: draft.schema.columns,
    schemaFingerprint: draft.schema.schemaFingerprint,
    schemaSampleRows: draft.schema.sampleRows,
    schemaSummary: draft.schema.summary,
    sourceConfig: draft.source.sourceConfig,
    sourceLabel: draft.source.sourceLabel,
    sourceType: draft.source.sourceType,
    compression: draft.target.compression,
    partition: draft.target.partition,
    storagePath: draft.target.storagePath,
    storageType: draft.target.storageType,
    targetDataset,
    targetFormat: draft.target.format,
    targetLayer: draft.target.layer,
    transformOutputColumns: effectiveTransformOutputColumns(draft),
    transformSteps: draft.transform.steps,
  };
}

function effectiveTransformOutputColumns(draft: DraftPipeline): Array<[string, string]> {
  const includedBaseColumns = new Set(
    draft.schema.columns
      .filter((column) => column.included !== false)
      .map((column) => (column.targetName || column.sourceName || "").trim())
      .filter(Boolean),
  );
  const transformOutputs = new Set(
    draft.transform.steps
      .filter((step) => step.enabled !== false)
      .map((step) => step.output.trim())
      .filter(Boolean),
  );
  return draft.transform.outputColumns.filter(([name]) => includedBaseColumns.has(name) || transformOutputs.has(name));
}

export function applyDraftPipelinePatch(draft: DraftPipeline, patch: DraftPipelinePatch): DraftPipeline {
  const next: DraftPipeline = {
    ...draft,
    permission: { ...draft.permission, ...patch.permission },
    quality: { ...draft.quality, ...patch.quality },
    schedule: { ...draft.schedule, ...patch.schedule },
    schema: { ...draft.schema, ...patch.schema },
    source: { ...draft.source, ...patch.source },
    target: { ...draft.target, ...patch.target },
    transform: { ...draft.transform, ...patch.transform },
  };

  if (patch.id !== undefined) next.id = patch.id;
  if (patch.sourceConfig !== undefined) next.source.sourceConfig = patch.sourceConfig;
  if (patch.sourceLabel !== undefined) next.source.sourceLabel = patch.sourceLabel;
  if (patch.sourceType !== undefined) next.source.sourceType = patch.sourceType;
  if (patch.schemaColumns !== undefined) next.schema.columns = patch.schemaColumns;
  if (patch.schemaFingerprint !== undefined) next.schema.schemaFingerprint = patch.schemaFingerprint;
  if (patch.schemaSampleRows !== undefined) next.schema.sampleRows = patch.schemaSampleRows;
  if (patch.schemaSummary !== undefined) next.schema.summary = patch.schemaSummary;
  if (patch.ruleSummary !== undefined) next.transform.summary = patch.ruleSummary;
  if (patch.transformOutputColumns !== undefined) next.transform.outputColumns = patch.transformOutputColumns;
  if (patch.transformSteps !== undefined) next.transform.steps = patch.transformSteps;
  if (patch.qualityInvalidRows !== undefined) next.quality.invalidRows = patch.qualityInvalidRows;
  if (patch.qualityRules !== undefined) next.quality.rules = patch.qualityRules;
  if (patch.qualityScore !== undefined) next.quality.score = patch.qualityScore;
  if (patch.qualityStatus !== undefined) next.quality.status = patch.qualityStatus;
  if (patch.scheduleLabel !== undefined) {
    next.schedule.label = patch.scheduleLabel;
    next.schedule.mode = scheduleModeFromLabel(patch.scheduleLabel);
  }
  if (patch.scheduleSummary !== undefined) next.schedule.summary = patch.scheduleSummary;
  if (patch.startDate !== undefined) next.schedule.startDate = patch.startDate;
  if (patch.endDate !== undefined) next.schedule.endDate = patch.endDate;
  if (patch.nextRunUtc !== undefined) next.schedule.nextRunUtc = patch.nextRunUtc;
  if (patch.overlapPolicy !== undefined) next.schedule.overlapPolicy = patch.overlapPolicy;
  if (patch.timezone !== undefined) next.schedule.timezone = patch.timezone;
  if (patch.watermarkPolicy !== undefined) next.schedule.watermarkPolicy = patch.watermarkPolicy;
  if (patch.permissionSummary !== undefined) next.permission.summary = patch.permissionSummary;
  if (patch.permissionRoles !== undefined) next.permission.roles = patch.permissionRoles;
  if (patch.owner !== undefined) next.permission.owner = patch.owner;
  if (patch.compression !== undefined) next.target.compression = patch.compression;
  if (patch.partition !== undefined) next.target.partition = patch.partition;
  if (patch.storagePath !== undefined) next.target.storagePath = patch.storagePath;
  if (patch.storageType !== undefined) next.target.storageType = patch.storageType;
  if (patch.targetDataset !== undefined) next.target.datasetName = patch.targetDataset;
  if (patch.targetFormat !== undefined) next.target.format = patch.targetFormat;
  if (patch.targetLayer !== undefined) next.target.layer = patch.targetLayer;
  if (patch.rag !== undefined) next.target.rag = patch.rag;

  return next;
}

export function formatRetryPolicySummary(policy: RetryPolicyDraft): string {
  const normalized = normalizeRetryPolicy(policy);
  if (normalized.maxRetries === 0) return `재시도 없음 · ${retryFailureActionLabels[normalized.failureAction]}`;
  if (normalized.backoffStrategy === "fixed") {
    return `${normalized.maxRetries}회 재시도 · ${normalized.retryIntervalMinutes}분 고정 간격 · ${retryFailureActionLabels[normalized.failureAction]}`;
  }
  return `${normalized.maxRetries}회 재시도 · ${normalized.initialRetryDelayMinutes}분부터 ${normalized.backoffMultiplier}배 지수 백오프 · 최대 ${normalized.maxRetryDelayMinutes}분 · ${retryFailureActionLabels[normalized.failureAction]}`;
}

export function formatRunLimitSummary(policy: RetryPolicyDraft): string {
  const normalized = normalizeRetryPolicy(policy);
  return `${normalized.timeoutMinutes}분 초과 시 Run 실패 처리`;
}

export function formatOverlapPolicySummary(policy?: ScheduleOverlapPolicy): string {
  return scheduleOverlapPolicyLabels[policy ?? "skip_if_running"];
}

export function formatWatermarkPolicySummary(policy?: WatermarkPolicyDraft): string {
  const normalized = normalizeWatermarkPolicy(policy);
  if (!normalized.enabled || normalized.mode === "full_refresh") return watermarkWindowModeLabels.full_refresh;
  return `${normalized.column} · ${watermarkWindowModeLabels[normalized.mode]} · ${normalized.lookbackMinutes}분 lookback`;
}

export function normalizeRetryPolicy(policy: RetryPolicyDraft): RetryPolicyDraft {
  const backoffStrategy: RetryBackoffStrategy = policy.backoffStrategy === "fixed" ? "fixed" : "exponential";
  const initialRetryDelayMinutes = clampInteger(policy.initialRetryDelayMinutes ?? policy.retryIntervalMinutes, 1, 1, 1440);
  const backoffMultiplier = clampNumber(policy.backoffMultiplier, 2, 1, 10);
  const maxRetryDelayMinutes = clampInteger(policy.maxRetryDelayMinutes, 30, initialRetryDelayMinutes, 1440);
  return {
    backoffMultiplier,
    backoffStrategy,
    failureAction: retryFailureActionLabels[policy.failureAction] ? policy.failureAction : "retry_then_fail",
    initialRetryDelayMinutes,
    maxRetries: clampInteger(policy.maxRetries, 3, 0, 10),
    maxRetryDelayMinutes,
    retryIntervalMinutes: backoffStrategy === "fixed"
      ? clampInteger(policy.retryIntervalMinutes, initialRetryDelayMinutes, 1, 1440)
      : initialRetryDelayMinutes,
    timeoutMinutes: clampInteger(policy.timeoutMinutes, 60, 1, 1440),
  };
}

export function normalizeWatermarkPolicy(policy?: WatermarkPolicyDraft): WatermarkPolicyDraft {
  const mode: WatermarkWindowMode = policy?.mode === "full_refresh" || policy?.mode === "last_success_to_run_started_at"
    ? policy.mode
    : "last_success_to_scheduled_at";
  return {
    column: (policy?.column ?? "updated_at").trim() || "updated_at",
    enabled: policy?.enabled ?? mode !== "full_refresh",
    lookbackMinutes: clampInteger(policy?.lookbackMinutes ?? 5, 5, 0, 1440),
    mode,
  };
}

function clampInteger(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function clampNumber(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function scheduleModeFromLabel(label: string): ScheduleDraft["mode"] {
  if (label.includes("건너뛰기") || label.includes("스케줄 없음") || label.includes("수동")) return "manual";
  if (label.includes("예약") || label.includes("1회")) return "manual";
  return "repeat";
}

function combineSummaries(...summaries: string[]): string {
  return Array.from(new Set(summaries.map((summary) => summary.trim()).filter(Boolean))).join(" · ");
}
