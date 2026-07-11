import type { CatalogDataset, CatalogDatasetRowsResponse, CatalogModelArtifact } from "../types";
import { apiClient } from "./apiClient";

type DeleteMaterializationRunResponse = {
  dataset: CatalogDataset;
  deletedRunId: string;
};

export async function deleteDatasetMaterializationRun(datasetId: string, runId: string): Promise<DeleteMaterializationRunResponse> {
  return apiClient.delete<DeleteMaterializationRunResponse>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}/materialization-runs/${encodeURIComponent(runId)}`,
  );
}

export async function getCatalogDatasetRows(datasetId: string, options: { limit?: number; offset?: number } = {}): Promise<CatalogDatasetRowsResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return apiClient.get<CatalogDatasetRowsResponse>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}/rows${query ? `?${query}` : ""}`,
  );
}

export async function getCatalogModelArtifacts(): Promise<CatalogModelArtifact[]> {
  return apiClient.get<CatalogModelArtifact[]>("/api/catalog/models");
}
