import type { DraftPipeline, RetryPolicyDraft, WatermarkPolicyDraft } from "../types";

export const ETL_DRAFT_CONTRACT_VERSION = 1 as const;
export const ETL_DRAFT_REDACTED_VALUE = "********";

export type EtlDraftEnvelope = {
  draft: DraftPipeline;
  version: typeof ETL_DRAFT_CONTRACT_VERSION;
};

export function normalizeEtlDraft(draft: DraftPipeline): DraftPipeline {
  return {
    ...draft,
    permission: {
      ...draft.permission,
      grants: draft.permission.grants?.map((grant) => ({ ...grant, actions: [...grant.actions] })),
      roles: draft.permission.roles?.map((role) => ({ ...role, access: [...role.access] })),
    },
    quality: {
      ...draft.quality,
      invalidRows: draft.quality.invalidRows.map((row) => [...row]),
      rules: draft.quality.rules.map((rule) => ({ ...rule })),
    },
    recordParsing: {
      ...draft.recordParsing,
      columns: draft.recordParsing.columns.map((column) => ({ ...column })),
    },
    schedule: {
      ...draft.schedule,
      retryPolicy: normalizeRetryPolicy(draft.schedule.retryPolicy),
      watermarkPolicy: draft.schedule.watermarkPolicy ? normalizeWatermarkPolicy(draft.schedule.watermarkPolicy) : undefined,
    },
    schema: {
      ...draft.schema,
      columns: draft.schema.columns.map((column) => ({
        ...column,
        transformChain: column.transformChain?.map((step) => ({ ...step })),
      })),
      sampleRows: draft.schema.sampleRows.map((row) => [...row]),
    },
    source: {
      ...draft.source,
      continuousConfig: draft.source.continuousConfig
        ? { ...draft.source.continuousConfig, schemaEvolutionPolicy: draft.source.continuousConfig.schemaEvolutionPolicy ? { ...draft.source.continuousConfig.schemaEvolutionPolicy } : undefined }
        : undefined,
      rawPreviewLines: draft.source.rawPreviewLines ? [...draft.source.rawPreviewLines] : undefined,
      sourceConfig: draft.source.sourceConfig.map(([label, value]) => [String(label), String(value)]),
    },
    target: {
      ...draft.target,
      indexColumns: draft.target.indexColumns ? [...draft.target.indexColumns] : undefined,
      partitionColumns: draft.target.partitionColumns ? [...draft.target.partitionColumns] : undefined,
      schemaRules: draft.target.schemaRules?.map((rule) => ({ ...rule })),
      tags: draft.target.tags ? [...draft.target.tags] : undefined,
    },
    transform: {
      ...draft.transform,
      outputColumns: draft.transform.outputColumns.map(([name, type]) => [name, type]),
      steps: draft.transform.steps.map((step) => ({ ...step })),
    },
  };
}

export function serializeEtlDraft(draft: DraftPipeline) {
  const normalized = normalizeEtlDraft(draft);
  const envelope: EtlDraftEnvelope = {
    draft: {
      ...normalized,
      source: {
        ...normalized.source,
        sourceConfig: normalized.source.sourceConfig.map(([label, value]) => [
          label,
          isSecretDraftField(label) && value ? ETL_DRAFT_REDACTED_VALUE : value,
        ]),
      },
    },
    version: ETL_DRAFT_CONTRACT_VERSION,
  };
  return JSON.stringify(envelope);
}

export function hydrateEtlDraft(serialized: string | null | undefined, fallback: DraftPipeline): DraftPipeline {
  if (!serialized) return normalizeEtlDraft(fallback);
  try {
    const parsed = JSON.parse(serialized) as unknown;
    const candidate = isRecord(parsed) && parsed.version === ETL_DRAFT_CONTRACT_VERSION && isRecord(parsed.draft) ? parsed.draft : parsed;
    if (!isRecord(candidate)) return normalizeEtlDraft(fallback);
    return normalizeEtlDraft({
      ...fallback,
      ...candidate,
      id: typeof candidate.id === "string" ? candidate.id : fallback.id,
      permission: { ...fallback.permission, ...(isRecord(candidate.permission) ? candidate.permission : {}) },
      quality: { ...fallback.quality, ...(isRecord(candidate.quality) ? candidate.quality : {}) },
      recordParsing: { ...fallback.recordParsing, ...(isRecord(candidate.recordParsing) ? candidate.recordParsing : {}) },
      schedule: { ...fallback.schedule, ...(isRecord(candidate.schedule) ? candidate.schedule : {}) },
      schema: { ...fallback.schema, ...(isRecord(candidate.schema) ? candidate.schema : {}) },
      source: { ...fallback.source, ...(isRecord(candidate.source) ? candidate.source : {}) },
      target: { ...fallback.target, ...(isRecord(candidate.target) ? candidate.target : {}) },
      transform: { ...fallback.transform, ...(isRecord(candidate.transform) ? candidate.transform : {}) },
    } as DraftPipeline);
  } catch {
    return normalizeEtlDraft(fallback);
  }
}

function normalizeRetryPolicy(policy: RetryPolicyDraft): RetryPolicyDraft {
  const backoffStrategy = policy.backoffStrategy === "fixed" ? "fixed" : "exponential";
  const initialRetryDelayMinutes = clampInteger(policy.initialRetryDelayMinutes ?? policy.retryIntervalMinutes, 1, 1, 1440);
  return {
    backoffMultiplier: clampNumber(policy.backoffMultiplier, 2, 1, 10),
    backoffStrategy,
    failureAction: ["notify_only", "retry_then_fail", "retry_then_quarantine"].includes(policy.failureAction) ? policy.failureAction : "retry_then_fail",
    initialRetryDelayMinutes,
    maxRetries: clampInteger(policy.maxRetries, 3, 0, 10),
    maxRetryDelayMinutes: clampInteger(policy.maxRetryDelayMinutes, 30, initialRetryDelayMinutes, 1440),
    retryIntervalMinutes: backoffStrategy === "fixed" ? clampInteger(policy.retryIntervalMinutes, initialRetryDelayMinutes, 1, 1440) : initialRetryDelayMinutes,
    timeoutMinutes: clampInteger(policy.timeoutMinutes, 60, 1, 1440),
  };
}

function normalizeWatermarkPolicy(policy: WatermarkPolicyDraft): WatermarkPolicyDraft {
  const mode = policy.mode === "full_refresh" || policy.mode === "last_success_to_run_started_at" ? policy.mode : "last_success_to_scheduled_at";
  return {
    column: policy.column.trim() || "updated_at",
    enabled: policy.enabled ?? mode !== "full_refresh",
    lookbackMinutes: clampInteger(policy.lookbackMinutes, 5, 0, 1440),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSecretDraftField(label: string) {
  return /(access key|secret key|password|auth token|token|private key)/i.test(label);
}
