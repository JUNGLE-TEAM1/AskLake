import type { CatalogDataset } from "../types";
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
