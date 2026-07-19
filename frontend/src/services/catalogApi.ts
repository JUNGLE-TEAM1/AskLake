import type { CatalogDataset, CatalogDatasetDeletionAcceptedResponse, CatalogDatasetDeletionImpact, CatalogDatasetDeletionStatusResponse, CatalogDatasetRowsResponse, CatalogModelArtifact } from "../types";
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

export async function getCatalogDatasetDeletionImpact(datasetId: string): Promise<CatalogDatasetDeletionImpact> {
  return apiClient.get<CatalogDatasetDeletionImpact>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}/deletion-impact`,
  );
}

export async function deleteCatalogDataset(datasetId: string, confirmName: string): Promise<CatalogDatasetDeletionAcceptedResponse> {
  return apiClient.delete<CatalogDatasetDeletionAcceptedResponse>(
    `/api/catalog/datasets/${encodeURIComponent(datasetId)}?confirmName=${encodeURIComponent(confirmName)}`,
  );
}

export async function getCatalogDatasetDeletionStatus(deletionId: string): Promise<CatalogDatasetDeletionStatusResponse> {
  return apiClient.get<CatalogDatasetDeletionStatusResponse>(
    `/api/catalog/dataset-deletions/${encodeURIComponent(deletionId)}`,
  );
}

export async function getCatalogDataset(datasetId: string): Promise<CatalogDataset> {
  return apiClient.get<CatalogDataset>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}`);
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
