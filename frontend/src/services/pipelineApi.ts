import type { CatalogDataset, ContinuousMaintenanceRun, ContinuousQuarantineResponse, ContinuousWorkerLogsResponse, CreateDerivedDatasetRequest, CreateTrinoSqlJobRequest, DraftPipeline, JobCommand, JobDagStep, JobRowData, JobRunSummary, KafkaContinuousBatch, KafkaContinuousSession, SqlResultDraft, TrinoMaterializationRun, TrinoQueryEstimate, TrinoQueryRun, TrinoQueryRunListResponse, TrinoQueryRunResultPage, TrinoQueryValidation } from "../types";
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

export async function getContinuousSessions(jobId: string): Promise<KafkaContinuousSession[]> {
  return apiClient.get<KafkaContinuousSession[]>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/sessions`);
}

export async function getContinuousSession(jobId: string, sessionId: string): Promise<KafkaContinuousSession> {
  return apiClient.get<KafkaContinuousSession>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getContinuousSessionBatches(jobId: string, sessionId: string, limit = 100): Promise<KafkaContinuousBatch[]> {
  return apiClient.get<KafkaContinuousBatch[]>(`/api/etl/jobs/${encodeURIComponent(jobId)}/continuous/sessions/${encodeURIComponent(sessionId)}/batches?limit=${limit}`);
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

export type SqlQueryRunResponse = SqlResultDraft | TrinoQueryRun;

export function isTrinoQueryRun(response: SqlQueryRunResponse): response is TrinoQueryRun {
  return "engine" in response && response.engine === "trino";
}

export async function submitSqlQueryRun(
  dataset: CatalogDataset,
  query: string,
  referenceDatasetIds: string[],
  confirmationToken?: string,
  clientRequestId?: string,
): Promise<SqlQueryRunResponse> {
  return apiClient.post<SqlQueryRunResponse>("/api/query/runs", {
    baseDatasetId: dataset.id,
    clientRequestId,
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

export async function validateSqlQueryRun(dataset: CatalogDataset, query: string, referenceDatasetIds: string[]): Promise<TrinoQueryValidation> {
  return apiClient.post<TrinoQueryValidation>("/api/query/validate", {
    baseDatasetId: dataset.id,
    query,
    referenceDatasetIds,
  });
}

export async function createTrinoSqlJob(request: CreateTrinoSqlJobRequest): Promise<PipelineCreationResult> {
  return apiClient.post<PipelineCreationResult>("/api/etl/sql-jobs", request);
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
