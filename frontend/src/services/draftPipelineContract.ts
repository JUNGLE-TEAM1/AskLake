import type { CreatePipelineRequest, DraftPipeline, DraftPipelinePatch, ScheduleDraft } from "../types";

export function toCreatePipelineRequest(draft: DraftPipeline): CreatePipelineRequest {
  const targetDataset = draft.target.datasetName.trim() || "unnamed_dataset";
  return {
    id: draft.id,
    jobName: `${targetDataset}_pipeline`,
    owner: draft.permission.owner,
    permissionSummary: draft.permission.summary,
    rag: draft.target.rag,
    ruleSummary: draft.transform.summary || draft.quality.summary,
    scheduleLabel: draft.schedule.label,
    schemaSummary: draft.schema.summary,
    sourceConfig: draft.source.sourceConfig,
    sourceLabel: draft.source.sourceLabel,
    sourceType: draft.source.sourceType,
    targetDataset,
    targetFormat: draft.target.format,
    targetLayer: draft.target.layer,
  };
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
  if (patch.schemaSummary !== undefined) next.schema.summary = patch.schemaSummary;
  if (patch.ruleSummary !== undefined) next.transform.summary = patch.ruleSummary;
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

function scheduleModeFromLabel(label: string): ScheduleDraft["mode"] {
  if (label.includes("수동")) return "manual";
  if (label.includes("1회")) return "once";
  return "repeat";
}
