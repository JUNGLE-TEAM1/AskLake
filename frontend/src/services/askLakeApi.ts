import type {
  CatalogDataset,
  JobListQuery,
  JobListResult,
  JobRowData,
  LineageGraph,
  SavedDashboardCard,
  SqlResultDraft,
} from "../types";
import { normalizeDatasetStatus, normalizeJobStatus } from "../utils/statusMeta";
import { apiClient } from "./apiClient";

type PageEnvelope = {
  page?: {
    cursor: string | null;
    hasNext: boolean;
  };
};

type DatasetsResponse = PageEnvelope & {
  datasets: CatalogDataset[];
};

type DashboardResponse = {
  dashboard: SavedDashboardCard;
};

export type QueryPreviewOptions = {
  limit: number;
  referenceDatasetIds: string[];
  validationKey: string;
};

export type QueryResultPageOptions = {
  limit?: number;
  offset: number;
};

const queryResultPageTimeoutMs = 15_000;

function normalizeJob(job: JobRowData): JobRowData {
  return { ...job, status: normalizeJobStatus(job.status) };
}

function normalizeDataset(dataset: CatalogDataset): CatalogDataset {
  return { ...dataset, status: normalizeDatasetStatus(dataset.status) };
}

function toJobListSearchParams(query: JobListQuery) {
  const searchParams = new URLSearchParams();
  query.statuses?.forEach((status) => searchParams.append("status", status));
  if (query.lastRunOutcome) searchParams.set("lastRunOutcome", query.lastRunOutcome);
  if (query.owner) searchParams.set("owner", query.owner);
  if (query.scheduleKind) searchParams.set("scheduleKind", query.scheduleKind);
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

export async function getJobs(query: JobListQuery = {}): Promise<JobListResult> {
  const result = await apiClient.get<JobListResult>(`/api/etl/jobs${toJobListSearchParams(query)}`);
  return {
    facets: result.facets,
    jobs: result.jobs.map(normalizeJob),
  };
}

export async function getDatasets(): Promise<CatalogDataset[]> {
  const result = await apiClient.get<DatasetsResponse | CatalogDataset[]>("/api/catalog/datasets");
  const datasets = Array.isArray(result) ? result : result.datasets;
  return datasets.map(normalizeDataset);
}

export async function saveDashboardCard(card: SavedDashboardCard): Promise<SavedDashboardCard> {
  const result = await apiClient.patch<DashboardResponse>(`/api/dashboards/${encodeURIComponent(card.id)}`, card);
  return result.dashboard;
}

export function getDatasetLineageGraph(dataset: CatalogDataset): Promise<LineageGraph> {
  return apiClient.get<LineageGraph>(`/api/catalog/datasets/${encodeURIComponent(dataset.id)}/lineage`);
}

export function executeQueryPreview(
  dataset: CatalogDataset,
  query: string,
  options: QueryPreviewOptions,
): Promise<SqlResultDraft> {
  return apiClient.post<SqlResultDraft>("/api/query/runs", {
    baseDatasetId: dataset.id,
    datasetId: dataset.id,
    limit: options.limit,
    mode: "preview",
    query,
    referenceDatasetIds: options.referenceDatasetIds,
    validationKey: options.validationKey,
  });
}

export function getQueryPreviewPage(runId: string, options: QueryResultPageOptions): Promise<SqlResultDraft> {
  const limit = options.limit ?? 100;
  const offset = Math.max(options.offset, 0);
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return apiClient.get<SqlResultDraft>(
    `/api/query/runs/${encodeURIComponent(runId)}?${params.toString()}`,
    { timeoutMs: queryResultPageTimeoutMs },
  );
}
