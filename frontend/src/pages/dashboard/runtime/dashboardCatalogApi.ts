import type { CatalogDataset } from "../../../types";
import { apiClient } from "../../../services/apiClient";

type CatalogDatasetListResponse = {
  datasets: CatalogDataset[];
};

export async function getDashboardCatalogDatasets(): Promise<CatalogDataset[]> {
  const response = await apiClient.get<CatalogDatasetListResponse | CatalogDataset[]>("/api/catalog/datasets");
  return Array.isArray(response) ? response : response.datasets;
}
