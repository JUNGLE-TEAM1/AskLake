import type { CreatePipelineRequest, DraftPipeline, DraftPipelinePatch, JobRowData, RetryBackoffStrategy, RetryFailureAction, RetryPolicyDraft, ScheduleDraft, ScheduleOverlapPolicy, UpdatePipelineRequest, WatermarkPolicyDraft, WatermarkWindowMode } from "../types";

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
  const partitionColumns = normalizeStringList(draft.target.partitionColumns);
  const targetTags = normalizeStringList(draft.target.tags);
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
    executionMode: draft.source.executionMode ?? "snapshot",
    continuousConfig: draft.source.executionMode === "continuous"
      ? draft.source.continuousConfig ?? { initialOffsetPolicy: "earliest", triggerIntervalSeconds: 30, maxOffsetsPerTrigger: 10000 }
      : undefined,
    compression: draft.target.compression,
    partition: partitionColumns.length > 0 ? partitionColumns.join("/") : draft.target.partition,
    partitionColumns,
    indexColumns: normalizeStringList(draft.target.indexColumns),
    storagePath: draft.target.storagePath,
    storageType: draft.target.storageType,
    targetDataset,
    targetDatabase: draft.target.databaseName?.trim() || undefined,
    targetDescription: draft.target.description?.trim(),
    targetTags,
    targetFormat: draft.target.format,
    targetLayer: draft.target.layer,
    transformOutputColumns: effectiveTransformOutputColumns(draft),
    transformSteps: draft.transform.steps,
  };
}

export function hydrateDraftPipelineFromJob(job: JobRowData, fallback: DraftPipeline): DraftPipeline {
  const schedulePolicy = job.schedulePolicy;
  const scheduleLabel = job.schedule || fallback.schedule.label;
  const sourceConfig = job.sourceConfig ?? fallback.source.sourceConfig;
  const sourceType = job.sourceType || fallback.source.sourceType;
  const sourceLabel = job.sourceLabel || fallback.source.sourceLabel;
  const transformSummary = job.ruleSummary || fallback.transform.summary;

  return {
    id: job.id,
    permission: {
      ...fallback.permission,
      owner: job.owner || fallback.permission.owner,
      roles: job.permissionRoles ?? fallback.permission.roles,
      summary: job.permissionSummary || fallback.permission.summary,
    },
    quality: {
      ...fallback.quality,
      invalidRows: job.qualityInvalidRows ?? [],
      rules: job.qualityRules ?? [],
      score: job.qualityScore,
      status: job.qualityStatus ?? fallback.quality.status,
      summary: transformSummary,
    },
    schedule: {
      ...fallback.schedule,
      endDate: schedulePolicy?.endDate ?? fallback.schedule.endDate,
      label: scheduleLabel,
      mode: scheduleModeFromLabel(scheduleLabel),
      nextRun: job.nextRun || fallback.schedule.nextRun,
      nextRunUtc: schedulePolicy?.nextRunUtc,
      overlapPolicy: schedulePolicy?.overlapPolicy ?? fallback.schedule.overlapPolicy,
      retryPolicy: job.retryPolicy ?? fallback.schedule.retryPolicy,
      startDate: schedulePolicy?.startDate ?? fallback.schedule.startDate,
      summary: job.scheduleSummary || scheduleLabel,
      timezone: schedulePolicy?.timezone ?? fallback.schedule.timezone,
      watermarkPolicy: schedulePolicy?.watermarkPolicy ?? fallback.schedule.watermarkPolicy,
    },
    schema: {
      columns: job.schemaColumns ?? [],
      sampleRows: job.schemaSampleRows ?? [],
      schemaFingerprint: job.schemaFingerprint,
      summary: job.schemaSummary || fallback.schema.summary,
    },
    source: {
      connectionMessage: "저장된 Job 소스 설정을 수정 모드로 불러왔습니다.",
      connectionStatus: sourceType ? "success" : "idle",
      sourceConfig,
      sourceLabel,
      sourceType,
      executionMode: job.executionMode ?? "snapshot",
      continuousConfig: job.continuousConfig ? {
        initialOffsetPolicy: job.continuousConfig.initialOffsetPolicy,
        triggerIntervalSeconds: job.continuousConfig.triggerIntervalSeconds,
        maxOffsetsPerTrigger: job.continuousConfig.maxOffsetsPerTrigger,
      } : fallback.source.continuousConfig,
    },
    target: {
      ...fallback.target,
      compression: job.compression ?? fallback.target.compression,
      databaseName: job.targetDatabase ?? fallback.target.databaseName,
      datasetName: job.target || fallback.target.datasetName,
      description: job.targetDescription ?? fallback.target.description,
      format: job.targetFormat ?? fallback.target.format,
      indexColumns: job.indexColumns ?? fallback.target.indexColumns,
      layer: job.targetLayer ?? fallback.target.layer,
      partition: job.partition ?? fallback.target.partition,
      partitionColumns: job.partitionColumns ?? fallback.target.partitionColumns,
      rag: job.rag ?? fallback.target.rag,
      storagePath: job.storagePath ?? job.targetPath ?? fallback.target.storagePath,
      storageType: job.storageType ?? fallback.target.storageType,
      tableName: job.target || fallback.target.tableName,
      targetTableName: job.target || fallback.target.targetTableName,
      tags: job.targetTags ?? fallback.target.tags,
      testStatus: "success",
    },
    transform: {
      outputColumns: job.transformOutputColumns ?? [],
      steps: job.transformSteps ?? [],
      summary: transformSummary,
    },
  };
}

export function toUpdatePipelineRequest(draft: DraftPipeline): UpdatePipelineRequest {
  const {
    createdBy: _createdBy,
    createdByProfile: _createdByProfile,
    id: _id,
    permissionGrants: _permissionGrants,
    sourceConfig: _sourceConfig,
    sourceLabel: _sourceLabel,
    sourceType: _sourceType,
    ...request
  } = toCreatePipelineRequest(draft);
  return request;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
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
  if (patch.executionMode !== undefined) next.source.executionMode = patch.executionMode;
  if (patch.continuousConfig !== undefined) next.source.continuousConfig = patch.continuousConfig;
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
