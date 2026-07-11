import type {
  CatalogDataset,
  CreateDerivedDatasetRequest,
  DashboardListResponse,
  DraftPipeline,
  JobCommand,
  JobRowData,
  JobRunSummary,
  LineageGraph,
  SavedDashboardCard,
  SqlResultDraft,
} from "../types";
import { apiClient } from "./apiClient";
import {
  createPipelineDraft as createLivePipelineDraft,
  runJobCommand as runLiveJobCommand,
} from "./pipelineApi";

export type PipelineCreationResult = {
  catalogTarget?: { id: string; layer: string; name: string; status: "pending_run" };
  dataset?: CatalogDataset;
  job: JobRowData;
};

export type JobCommandResult = {
  action: string;
  apiPath: string;
  dagSteps?: Array<{ id: string; logs?: string[]; meta: string; note?: string; status: "success" | "running" | "pending" | "failed" | "blocked"; title: string }>;
  dataset?: CatalogDataset;
  job?: JobRowData;
  run?: JobRunSummary;
};

type PageEnvelope = { page?: { cursor: string | null; hasNext: boolean } };
type JobsResponse = PageEnvelope & { jobs: JobRowData[] };
type DatasetsResponse = PageEnvelope & { datasets: CatalogDataset[] };
type DashboardResponse = { dashboard: SavedDashboardCard };

export type DashboardQuery = {
  owner?: string;
  page?: number;
  pageSize?: number;
  searchQuery?: string;
  sort?: string;
  tags?: string[];
};

export type DashboardPageResult = {
  dashboards: SavedDashboardCard[];
  facets: { owners: string[]; tags: string[] };
  page: { current: number; end: number; hasNext: boolean; hasPrevious: boolean; pageSize: number; start: number; total: number; totalPages: number };
};

export async function getJobs(): Promise<JobRowData[]> {
  const result = await apiClient.get<JobsResponse | JobRowData[]>("/api/etl/jobs");
  return Array.isArray(result) ? result : result.jobs;
}

export async function getDatasets(): Promise<CatalogDataset[]> {
  const result = await apiClient.get<DatasetsResponse | CatalogDataset[]>("/api/catalog/datasets");
  return Array.isArray(result) ? result : result.datasets;
}

export async function getDashboards(query: DashboardQuery = {}): Promise<DashboardPageResult> {
  const response = await apiClient.post<DashboardListResponse>("/api/dashboards/query", {
    owner: query.owner,
    page: Math.max(1, query.page ?? 1),
    pageSize: Math.max(1, Math.min(50, query.pageSize ?? 10)),
    searchQuery: query.searchQuery?.trim() || undefined,
    sort: query.sort || "updated-desc",
    tags: query.tags?.filter(Boolean),
  });
  const pageSize = Math.max(1, response.pageSize);
  const total = Math.max(0, response.total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, response.page), totalPages);
  const start = total === 0 ? 0 : (current - 1) * pageSize + 1;
  return {
    dashboards: response.items,
    facets: response.filterOptions,
    page: {
      current,
      end: start === 0 ? 0 : start + response.items.length - 1,
      hasNext: current < totalPages,
      hasPrevious: current > 1,
      pageSize,
      start,
      total,
      totalPages,
    },
  };
}

export async function saveDashboardCard(card: SavedDashboardCard): Promise<SavedDashboardCard> {
  const result = await apiClient.put<DashboardResponse>(`/api/dashboards/${encodeURIComponent(card.id)}`, card);
  return result.dashboard;
}

export async function createPipelineDraft(draftPipeline: DraftPipeline, _jobCount?: number): Promise<PipelineCreationResult> {
  return createLivePipelineDraft(draftPipeline);
}

export async function getDatasetLineageGraph(dataset: CatalogDataset): Promise<LineageGraph> {
  return apiClient.get<LineageGraph>(`/api/catalog/datasets/${encodeURIComponent(dataset.id)}/lineage`);
}

export async function runJobCommand(job: JobRowData, command: Exclude<JobCommand, "edit" | "delete">): Promise<JobCommandResult> {
  return runLiveJobCommand(job, command);
}

export type QueryPreviewOptions = {
  limit: number;
  referenceDatasetIds: string[];
  validationKey: string;
};

export type DerivedDatasetCreationContext = {
  request: CreateDerivedDatasetRequest;
  sourceDataset: CatalogDataset;
  sqlResult: SqlResultDraft;
};

export async function executeQueryPreview(dataset: CatalogDataset, query: string, options: QueryPreviewOptions): Promise<SqlResultDraft> {
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

export async function executeQueryDraft(dataset: CatalogDataset, query: string): Promise<SqlResultDraft> {
  return executeQueryPreview(dataset, query, { limit: 100, referenceDatasetIds: [], validationKey: `${dataset.id}:${query}` });
}

export async function createDerivedDatasetFromSql({ request }: DerivedDatasetCreationContext): Promise<CatalogDataset> {
  return apiClient.post<CatalogDataset>("/api/catalog/derived-datasets", request);
}
