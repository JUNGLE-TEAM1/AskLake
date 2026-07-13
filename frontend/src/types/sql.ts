import type { CatalogDataset } from "./catalog";
import type { ScheduleOverlapPolicy } from "./etl";

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
  job?: {
    accessScope: "organization" | "private" | "project";
    compression: "Gzip" | "None" | "Snappy";
    databaseName?: string;
    fileFormat?: "csv" | "json" | "parquet";
    owner: string;
    overlapPolicy: ScheduleOverlapPolicy;
    partitionColumn?: string;
    partitionColumns?: string[];
    permissionSummary: string;
    scheduleLabel: string;
    scheduleMode: "manual" | "repeat";
    scheduleSummary: string;
    storagePath: string;
    tags?: string[];
    timezone?: string;
  };
  previewLimit?: number;
  query: string;
  referenceDatasetIds?: string[];
  sourceDatasetId: string;
  sourceRunId: string;
  validationKey?: string;
};
