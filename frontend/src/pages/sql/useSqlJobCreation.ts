import { useCallback } from "react";

import type {
  CreateDerivedDatasetRequest,
  CreateTrinoSqlJobRequest,
  SqlResultDraft,
} from "../../types";
import {
  formatSqlJobWizardScheduleLabel,
  formatSqlJobWizardScheduleSummary,
  type SqlJobWizardCreateRequest,
} from "./SqlJobWizardDialog";

function buildTrinoJobRequest({
  configuration,
  context,
}: SqlJobWizardCreateRequest): CreateTrinoSqlJobRequest {
  return {
    baseDatasetId: context.baseDatasetId,
    dataset: {
      description: configuration.dataset.description.trim(),
      layer: configuration.dataset.layer,
      name: configuration.dataset.name.trim(),
      rag: false,
      refreshPolicy: "manual",
      tags: configuration.target.tags,
    },
    governance: {
      accessScope: configuration.governance.accessScope,
      owner: configuration.governance.owner.trim(),
      permissionSummary: configuration.governance.permissionSummary.trim(),
    },
    jobName: `${configuration.dataset.name.trim()} SQL Job`,
    query: context.query,
    referenceDatasetIds: context.referenceDatasetIds,
    schedule: {
      mode: configuration.schedule.mode,
      overlapPolicy: "skip_if_running",
      time: configuration.schedule.time,
      timezone: configuration.schedule.timezone,
      weekday: configuration.schedule.weekday,
    },
    sourceRunId: context.sourceRunId,
    target: {
      partitionColumn: configuration.target.partitionColumns[0] || undefined,
      writeMode: "full_refresh",
    },
  };
}

function buildCompatibilityJobRequest({
  configuration,
  context,
}: SqlJobWizardCreateRequest): CreateDerivedDatasetRequest {
  return {
    dataset: {
      description: configuration.dataset.description.trim(),
      layer: configuration.dataset.layer,
      name: configuration.dataset.name.trim(),
      rag: false,
      refreshPolicy: "manual",
      tags: configuration.target.tags,
    },
    job: {
      accessScope: configuration.governance.accessScope,
      compression: configuration.target.compression,
      databaseName: configuration.target.databaseName.trim(),
      fileFormat: configuration.target.fileFormat,
      owner: configuration.governance.owner.trim(),
      overlapPolicy: configuration.schedule.overlapPolicy,
      partitionColumn: configuration.target.partitionColumns[0] || undefined,
      partitionColumns: configuration.target.partitionColumns,
      permissionSummary: configuration.governance.permissionSummary.trim(),
      scheduleLabel: formatSqlJobWizardScheduleLabel(configuration.schedule),
      scheduleMode: configuration.schedule.mode === "manual" ? "manual" : "repeat",
      scheduleSummary: formatSqlJobWizardScheduleSummary(configuration.schedule),
      storagePath: configuration.target.storagePath.trim(),
      tags: configuration.target.tags,
      timezone: configuration.schedule.timezone,
    },
    previewLimit: context.previewLimit,
    query: context.query,
    referenceDatasetIds: context.referenceDatasetIds,
    sourceDatasetId: context.baseDatasetId,
    sourceRunId: context.sourceRunId,
    validationKey: context.validationKey,
  };
}

export function useSqlJobCreation({
  materializationResult,
  onClose,
  onCreateDatasetJob,
  onCreateTrinoSqlJob,
}: {
  materializationResult: SqlResultDraft | null;
  onClose: () => void;
  onCreateDatasetJob: (request: CreateDerivedDatasetRequest) => Promise<boolean>;
  onCreateTrinoSqlJob: (request: CreateTrinoSqlJobRequest) => Promise<boolean>;
}) {
  return useCallback(async (request: SqlJobWizardCreateRequest) => {
    const isTrinoRun = materializationResult?.engine === "trino"
      && materializationResult.runId === request.context.sourceRunId;
    const created = isTrinoRun
      ? await onCreateTrinoSqlJob(buildTrinoJobRequest(request))
      : await onCreateDatasetJob(buildCompatibilityJobRequest(request));
    if (created) onClose();
    return created;
  }, [materializationResult?.engine, materializationResult?.runId, onClose, onCreateDatasetJob, onCreateTrinoSqlJob]);
}
