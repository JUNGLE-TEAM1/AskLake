import type {
  CatalogDataset,
  DashboardRuntimeWidgetConfig,
  DashboardRuntimeWidgetType,
  SqlResultDraft,
  TrinoQueryEstimate,
  TrinoQueryRun,
  TrinoQueryRunChart,
  TrinoQueryRunResultPage,
  TrinoQueryValidation,
} from "../types";
import { apiClient } from "./apiClient";


export type SqlQueryRunResponse = SqlResultDraft | TrinoQueryRun;


export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return apiClient.post<SqlResultDraft>("/api/query/runs", { datasetId: dataset.id, query });
}


export async function getQueryRun(runId: string): Promise<SqlResultDraft> {
  return apiClient.get<SqlResultDraft>(`/api/query/runs/${encodeURIComponent(runId)}`);
}


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
    limit: 100,
    mode: "preview",
    query,
    referenceDatasetIds,
    resultPageSize: 100,
  });
}


export async function requestTrinoFullResults(
  previewRunId: string,
  clientRequestId?: string,
): Promise<TrinoQueryRun> {
  return apiClient.post<TrinoQueryRun>(`/api/query/runs/${encodeURIComponent(previewRunId)}/full-results`, {
    clientRequestId,
  });
}


export async function estimateSqlQueryRun(
  dataset: CatalogDataset,
  query: string,
  referenceDatasetIds: string[],
): Promise<TrinoQueryEstimate> {
  return apiClient.post<TrinoQueryEstimate>("/api/query/estimates", {
    baseDatasetId: dataset.id,
    query,
    referenceDatasetIds,
  });
}


export async function validateSqlQueryRun(
  dataset: CatalogDataset,
  query: string,
  referenceDatasetIds: string[],
): Promise<TrinoQueryValidation> {
  return apiClient.post<TrinoQueryValidation>("/api/query/validate", {
    baseDatasetId: dataset.id,
    query,
    referenceDatasetIds,
  });
}


export async function getTrinoQueryRun(runId: string): Promise<TrinoQueryRun> {
  return apiClient.get<TrinoQueryRun>(`/api/query/runs/${encodeURIComponent(runId)}`);
}


export async function getTrinoQueryRunResultPage(
  runId: string,
  cursor?: string | null,
): Promise<TrinoQueryRunResultPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiClient.get<TrinoQueryRunResultPage>(`/api/query/runs/${encodeURIComponent(runId)}/results${query}`);
}


export async function getTrinoQueryRunChart(
  runId: string,
  type: DashboardRuntimeWidgetType,
  config: DashboardRuntimeWidgetConfig,
  signal?: AbortSignal,
): Promise<TrinoQueryRunChart> {
  return apiClient.post<TrinoQueryRunChart>(
    `/api/query/runs/${encodeURIComponent(runId)}/chart`,
    { config, type },
    { signal, timeoutMs: 30_000 },
  );
}


export async function cancelTrinoQueryRun(runId: string): Promise<TrinoQueryRun> {
  return apiClient.post<TrinoQueryRun>(`/api/query/runs/${encodeURIComponent(runId)}/cancel`, {});
}
