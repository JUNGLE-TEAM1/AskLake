import type { CatalogDataset } from "./catalog";

export type DerivedDatasetLayer = Extract<CatalogDataset["layer"], "SILVER" | "GOLD">;

export type SqlResultDraft = {
  baseDatasetId?: string;
  columns: string[];
  datasetId: string;
  datasetName: string;
  executedAt: string;
  mode?: "preview" | "run";
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  rowCount: number;
  rows: string[][];
  runId: string;
  validationKey?: string;
};

export type CreateDerivedDatasetRequest = {
  dataset: {
    description: string;
    layer: DerivedDatasetLayer;
    name: string;
    rag: boolean;
    refreshPolicy: "manual";
    tags: string[];
  };
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  sourceDatasetId: string;
  sourceRunId: string;
  validationKey?: string;
};

export type DerivedDatasetCreationOperation = {
  datasetId?: string;
  errorMessage?: string;
  estimatedSeconds: number;
  operationId: string;
  progress: number;
  stage: string;
  status: "pending" | "running" | "success" | "failed";
};

export type DerivedDatasetCreationResult = {
  dataset: CatalogDataset;
  operation: DerivedDatasetCreationOperation;
};
