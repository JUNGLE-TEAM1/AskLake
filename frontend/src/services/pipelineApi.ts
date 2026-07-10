import type { CatalogDataset, CreateDerivedDatasetRequest, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, SqlResultDraft, TrinoMaterializationRun, TrinoQueryEstimate, TrinoQueryRun, TrinoQueryRunListResponse, TrinoQueryRunResultPage } from "../types";
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

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return apiClient.post<SqlResultDraft>("/api/query/runs", { datasetId: dataset.id, query });
}

export async function getQueryRun(runId: string): Promise<SqlResultDraft> {
  return apiClient.get<SqlResultDraft>(`/api/query/runs/${encodeURIComponent(runId)}`);
}

export type SqlQueryRunResponse = SqlResultDraft | TrinoQueryRun;

export function isTrinoQueryRun(response: SqlQueryRunResponse): response is TrinoQueryRun {
  return "engine" in response && response.engine === "trino";
}

export async function submitSqlQueryRun(dataset: CatalogDataset, query: string, referenceDatasetIds: string[], confirmationToken?: string): Promise<SqlQueryRunResponse> {
  return apiClient.post<SqlQueryRunResponse>("/api/query/runs", {
    baseDatasetId: dataset.id,
    confirmationToken,
    datasetId: dataset.id,
    query,
    referenceDatasetIds,
    resultPageSize: 100,
  });
}

export async function estimateSqlQueryRun(dataset: CatalogDataset, query: string, referenceDatasetIds: string[]): Promise<TrinoQueryEstimate> {
  return apiClient.post<TrinoQueryEstimate>("/api/query/estimates", {
    baseDatasetId: dataset.id,
    query,
    referenceDatasetIds,
  });
}

export async function getTrinoQueryRun(runId: string): Promise<TrinoQueryRun> {
  return apiClient.get<TrinoQueryRun>(`/api/query/runs/${encodeURIComponent(runId)}`);
}

export async function listTrinoQueryRuns(limit = 8): Promise<TrinoQueryRunListResponse> {
  return apiClient.get<TrinoQueryRunListResponse>(`/api/query/runs?limit=${encodeURIComponent(String(limit))}`);
}

export async function getTrinoQueryRunResultPage(runId: string, cursor?: string | null): Promise<TrinoQueryRunResultPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiClient.get<TrinoQueryRunResultPage>(`/api/query/runs/${encodeURIComponent(runId)}/results${query}`);
}

export async function cancelTrinoQueryRun(runId: string): Promise<TrinoQueryRun> {
  return apiClient.post<TrinoQueryRun>(`/api/query/runs/${encodeURIComponent(runId)}/cancel`, {});
}

export async function materializeTrinoQueryRun(runId: string, request: CreateDerivedDatasetRequest): Promise<TrinoMaterializationRun> {
  return apiClient.post<TrinoMaterializationRun>(`/api/catalog/trino-runs/${encodeURIComponent(runId)}/materializations`, request);
}

export async function getTrinoMaterialization(materializationId: string): Promise<TrinoMaterializationRun> {
  return apiClient.get<TrinoMaterializationRun>(`/api/catalog/trino-materializations/${encodeURIComponent(materializationId)}`);
}
