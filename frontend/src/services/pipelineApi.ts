import type { CatalogDataset, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, SqlResultDraft } from "../types";
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

export async function deletePipelineJob(jobId: string): Promise<{ deletedJobId: string }> {
  return apiClient.delete<{ deletedJobId: string }>(`/api/etl/jobs/${encodeURIComponent(jobId)}`);
}

export async function runJobCommand(job: JobRowData, command: Exclude<JobCommand, "edit" | "delete">): Promise<JobCommandResult> {
  return apiClient.post<JobCommandResult>(`/api/etl/jobs/${job.id}/commands`, { command });
}

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return apiClient.post<SqlResultDraft>("/api/query/runs", { datasetId: dataset.id, query });
}

export async function getQueryRun(runId: string): Promise<SqlResultDraft> {
  return apiClient.get<SqlResultDraft>(`/api/query/runs/${encodeURIComponent(runId)}`);
}
