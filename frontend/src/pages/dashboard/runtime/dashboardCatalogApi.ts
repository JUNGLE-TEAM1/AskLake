import type { CatalogDataset, DashboardWidgetFilter, DashboardWidgetFilterValue } from "../../../types";
import { apiClient } from "../../../services/apiClient";

type CatalogDatasetListResponse = {
  datasets: CatalogDataset[];
};

export async function getDashboardCatalogDatasets(): Promise<CatalogDataset[]> {
  const response = await apiClient.get<CatalogDatasetListResponse | CatalogDataset[]>("/api/catalog/datasets");
  return Array.isArray(response) ? response : response.datasets;
}

export type DashboardFilterValueOption = {
  label: string;
  value: DashboardWidgetFilterValue;
};

type DashboardFilterValuesResponse = {
  column: string;
  datasetId: string;
  truncated: boolean;
  values: DashboardFilterValueOption[];
};

export async function getDashboardDatasetFilterValues(
  datasetId: string,
  input: {
    column: string;
    contextFilters?: DashboardWidgetFilter[];
    limit?: number;
    search?: string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<DashboardFilterValuesResponse> {
  return apiClient.post<DashboardFilterValuesResponse>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}/filter-values/query`,
    {
      column: input.column,
      contextFilters: input.contextFilters ?? [],
      limit: input.limit ?? 50,
      search: input.search?.trim() || undefined,
    },
    options,
  );
}
