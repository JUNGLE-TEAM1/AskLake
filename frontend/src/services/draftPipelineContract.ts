import type { CreatePipelineRequest, DraftPipeline, DraftPipelinePatch, RetryFailureAction, RetryPolicyDraft, ScheduleDraft } from "../types";

export const retryFailureActionLabels: Record<RetryFailureAction, string> = {
  notify_only: "알림만 남기기",
  retry_then_fail: "재시도 후 실패 처리",
  retry_then_quarantine: "재시도 후 격리",
};

export function toCreatePipelineRequest(draft: DraftPipeline): CreatePipelineRequest {
  const targetDataset = draft.target.datasetName.trim() || "unnamed_dataset";
  const retryPolicy = normalizeRetryPolicy(draft.schedule.retryPolicy);
  return {
    id: draft.id,
    jobName: `${targetDataset}_pipeline`,
    owner: draft.permission.owner,
    permissionSummary: draft.permission.summary,
    rag: draft.target.rag,
    retryPolicy,
    retryPolicySummary: formatRetryPolicySummary(retryPolicy),
    ruleSummary: combineSummaries(draft.transform.summary, draft.quality.summary),
    qualityInvalidRows: draft.quality.invalidRows,
    qualityRules: draft.quality.rules,
    qualityScore: draft.quality.score,
    qualityStatus: draft.quality.status,
    scheduleLabel: draft.schedule.label,
    schemaColumns: draft.schema.columns,
    schemaFingerprint: draft.schema.schemaFingerprint,
    schemaSampleRows: draft.schema.sampleRows,
    schemaSummary: draft.schema.summary,
    sourceConfig: draft.source.sourceConfig,
    sourceLabel: draft.source.sourceLabel,
    sourceType: draft.source.sourceType,
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
  if (patch.permissionSummary !== undefined) next.permission.summary = patch.permissionSummary;
  if (patch.owner !== undefined) next.permission.owner = patch.owner;
  if (patch.targetDataset !== undefined) next.target.datasetName = patch.targetDataset;
  if (patch.targetFormat !== undefined) next.target.format = patch.targetFormat;
  if (patch.targetLayer !== undefined) next.target.layer = patch.targetLayer;
  if (patch.rag !== undefined) next.target.rag = patch.rag;

  return next;
}

export function formatRetryPolicySummary(policy: RetryPolicyDraft): string {
  const normalized = normalizeRetryPolicy(policy);
  return `${normalized.maxRetries}회 재시도 · ${normalized.retryIntervalMinutes}분 간격 · ${normalized.timeoutMinutes}분 제한 · ${retryFailureActionLabels[normalized.failureAction]}`;
}

export function normalizeRetryPolicy(policy: RetryPolicyDraft): RetryPolicyDraft {
  return {
    failureAction: retryFailureActionLabels[policy.failureAction] ? policy.failureAction : "retry_then_fail",
    maxRetries: clampInteger(policy.maxRetries, 3, 0, 10),
    retryIntervalMinutes: clampInteger(policy.retryIntervalMinutes, 10, 1, 1440),
    timeoutMinutes: clampInteger(policy.timeoutMinutes, 60, 1, 1440),
  };
}

function clampInteger(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function scheduleModeFromLabel(label: string): ScheduleDraft["mode"] {
  if (label.includes("수동")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}

function combineSummaries(...summaries: string[]): string {
  return Array.from(new Set(summaries.map((summary) => summary.trim()).filter(Boolean))).join(" · ");
}
