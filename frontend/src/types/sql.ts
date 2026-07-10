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

export type TrinoQueryEstimate = {
  confirmationRequired: boolean;
  confirmationToken?: string | null;
  estimatedBytes?: number | null;
  estimatedDurationSeconds?: number | null;
  estimateSource: "trino_plan" | "catalog_heuristic";
  knownInputBytes: number;
  riskLevel: "low" | "medium" | "high";
  warnings: string[];
};

export type TrinoQueryRun = {
  baseDatasetId: string;
  completedAt?: string;
  engine: "trino";
  error?: { code: string; message: string };
  query: string;
  referenceDatasetIds: string[];
  result?: {
    availablePageCount?: number;
    byteSize?: number;
    columns: string[];
    nextCursor?: string | null;
    pageCount?: number;
    retentionExpiresAt?: string;
    rowCount?: number;
    storage?: "postgres" | "minio";
    storageStatus?: "collecting" | "available" | "expired" | "unavailable";
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

export type TrinoQueryRunHistoryItem = {
  baseDatasetId: string;
  completedAt?: string;
  query: string;
  result?: {
    rowCount?: number | null;
    storageStatus?: "collecting" | "available" | "expired" | "unavailable" | null;
  } | null;
  runId: string;
  stats?: {
    processedBytes?: number | null;
  } | null;
  status: TrinoQueryRunStatus;
  submittedAt: string;
};

export type TrinoQueryRunListResponse = {
  items: TrinoQueryRunHistoryItem[];
};

export type TrinoQueryRunResultPage = {
  columns: string[];
  nextCursor?: string | null;
  pageSize: number;
  rows: Array<Array<string | number | boolean | null>>;
  runId: string;
};

export type TrinoMaterializationRun = {
  datasetId: string;
  datasetName: string;
  materializationId: string;
  sourceRunId: string;
  status: TrinoQueryRunStatus;
  trinoQueryId?: string;
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
