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

export type TrinoQueryRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type TrinoQueryRun = {
  baseDatasetId: string;
  completedAt?: string;
  engine: "trino";
  error?: { code: string; message: string };
  query: string;
  referenceDatasetIds: string[];
  result?: {
    columns: string[];
    nextCursor?: string | null;
    retentionExpiresAt?: string;
    rowCount?: number;
  };
  runId: string;
  startedAt?: string;
  stats?: {
    cpuMs?: number;
    elapsedMs?: number;
    peakMemoryBytes?: number;
    processedBytes?: number;
    processedRows?: number;
    queuedMs?: number;
  };
  status: TrinoQueryRunStatus;
  submittedAt: string;
  trinoQueryId?: string;
};

export type TrinoQueryRunResultPage = {
  columns: string[];
  nextCursor?: string | null;
  pageSize: number;
  rows: Array<Array<string | number | boolean | null>>;
  runId: string;
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
