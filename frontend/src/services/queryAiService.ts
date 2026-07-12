import type { CatalogDataset } from "../types";
import { apiClient } from "./apiClient";

type QueryAiPreflightMessage = {
  text: string;
  tone: "success" | "info" | "warning" | "error";
};

export type QueryAiMode = "draft_sql";

export type QueryAiRequest = {
  baseDataset: CatalogDataset;
  mode: QueryAiMode;
  preflightMessages: QueryAiPreflightMessage[];
  prompt: string;
  query: string;
  selectedDatasets: CatalogDataset[];
};

export type QueryAiSuggestion = {
  body: string;
  mode: QueryAiMode;
  model?: string | null;
  notices: string[];
  sql?: string;
  title: string;
};

export async function generateQueryAiSuggestion(request: QueryAiRequest): Promise<QueryAiSuggestion> {
  return apiClient.post<QueryAiSuggestion>("/api/query/ai-suggestions", {
    baseDatasetId: request.baseDataset.id,
    currentQuery: request.query,
    mode: request.mode,
    prompt: request.prompt,
    selectedDatasetIds: request.selectedDatasets.map((dataset) => dataset.id),
    selectedDatasets: request.selectedDatasets.map((dataset) => ({
      description: dataset.description,
      id: dataset.id,
      layer: dataset.layer,
      name: dataset.name,
      schema: dataset.schema,
    })),
  });
}
