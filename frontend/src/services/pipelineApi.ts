import type { CatalogDataset, ContinuousMaintenanceRun, ContinuousQuarantineResponse, ContinuousWorkerLogsResponse, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, SqlResultDraft } from "../types";
import { toCreatePipelineRequest, toUpdatePipelineRequest } from "./draftPipelineContract";
import { apiClient } from "./apiClient";

export type PipelineCreationResult = {
  catalogTarget?: {
    id: string;
    layer: string;
    name: string;
    status: "pending_run";
  };
  dataset?: CatalogDataset;
  job: JobRowData;
};

export type JobCommandResult = {
  action: string;
  apiPath: string;
  dagSteps?: JobDagStep[];
  dataset?: CatalogDataset;
  job?: JobRowData;
  run?: JobRunSummary;
};

export async function createPipelineDraft(draftPipeline: DraftPipeline): Promise<PipelineCreationResult> {
  const request = toCreatePipelineRequest(draftPipeline);
  return apiClient.post<PipelineCreationResult>("/api/etl/jobs", request);
}

export async function getJob(jobId: string): Promise<JobRowData> {
  return apiClient.get<JobRowData>(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
}

export async function updatePipelineDraft(jobId: string, draftPipeline: DraftPipeline): Promise<JobRowData> {
  return apiClient.patch<JobRowData>(`/api/etl/jobs/${encodeURIComponent(jobId)}`, toUpdatePipelineRequest(draftPipeline));
}

export async function runJobCommand(job: JobRowData, command: Exclude<JobCommand, "edit" | "delete">): Promise<JobCommandResult> {
  return apiClient.post<JobCommandResult>(`/api/etl/jobs/${job.id}/commands`, { command });
}

export async function getContinuousWorkerLogs(jobId: string, tail = 200): Promise<ContinuousWorkerLogsResponse> {
  return apiClient.get<ContinuousWorkerLogsResponse>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/logs?tail=${tail}`);
}

export async function getContinuousQuarantine(jobId: string, limit = 100): Promise<ContinuousQuarantineResponse> {
  return apiClient.get<ContinuousQuarantineResponse>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine?limit=${limit}`);
}

export async function getContinuousMaintenanceRuns(jobId: string): Promise<ContinuousMaintenanceRun[]> {
  return apiClient.get<ContinuousMaintenanceRun[]>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/maintenance-runs`);
}

export async function replayContinuousQuarantine(jobId: string, offsets: string[] = [], approveUnknownFields = false): Promise<ContinuousMaintenanceRun> {
  return apiClient.post<ContinuousMaintenanceRun>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/quarantine/replays`, { offsets, approveUnknownFields });
}

export async function compactContinuousTarget(jobId: string, targetFileSizeMb = 256): Promise<ContinuousMaintenanceRun> {
  return apiClient.post<ContinuousMaintenanceRun>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/compactions`, { targetFileSizeMb });
}

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return apiClient.post<SqlResultDraft>("/api/query/runs", { datasetId: dataset.id, query });
}

export async function getQueryRun(runId: string): Promise<SqlResultDraft> {
  return apiClient.get<SqlResultDraft>(`/api/query/runs/${encodeURIComponent(runId)}`);
}
