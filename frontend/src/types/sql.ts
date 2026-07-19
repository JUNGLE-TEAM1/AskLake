import type { CatalogDataset } from "./catalog";
import type { DashboardRuntimeWidgetConfig } from "./dashboard";
import type { ScheduleOverlapPolicy } from "./etl";

export type DerivedDatasetLayer = Extract<CatalogDataset["layer"], "SILVER" | "GOLD">;

export type SqlResultDraft = {
  baseDatasetId?: string;
  columns: string[];
  datasetId: string;
  datasetName: string;
  engine?: "trino";
  executedAt: string;
  hasNext?: boolean;
  mode?: "preview" | "run";
  pageLimit?: number;
  pageOffset?: number;
  previewLimit?: number;
  query: string;
  rangeEnd?: number;
  rangeStart?: number;
  referenceDatasetIds?: string[];
  returnedRows?: number;
  rowCount: number;
  rows: string[][];
  runId: string;
  trinoRuntime?: {
    cursors: Array<string | null>;
    firstPageDisplayMs: number | null;
    firstPageRowCount: number | null;
    page: TrinoQueryRunResultPage;
    pageIndex: number;
    run: TrinoQueryRun;
  };
  validationKey?: string;
};

export type TrinoQueryRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type TrinoQueryEstimate = {
  confirmationRequired: boolean;
  confirmationToken?: string | null;
  durationEstimateSource: "query_history" | "dataset_history" | "configured_throughput";
  estimatedBytes?: number | null;
  estimatedDurationSeconds?: number | null;
  estimatedThroughputBytesPerSecond?: number | null;
  estimateSource: "iceberg_metadata" | "trino_plan" | "catalog_heuristic" | "conservative_bound";
  icebergEstimatedBytes?: number | null;
  knownInputBytes: number;
  planEstimatedBytes?: number | null;
  riskLevel: "low" | "medium" | "high";
  warnings: string[];
};

export type TrinoQueryValidation = {
  canExecute: true;
  normalizedQuery: string;
  referencedDatasetIds: string[];
};

export type TrinoQueryRunEstimate = Omit<TrinoQueryEstimate, "confirmationRequired" | "confirmationToken">;

export type TrinoQueryRun = {
  baseDatasetId: string;
  completedAt?: string;
  engine: "trino";
  estimate?: TrinoQueryRunEstimate | null;
  error?: { code: string; message: string };
  mode: "preview" | "run";
  query: string;
  referenceDatasetIds: string[];
  result?: {
    availablePageCount?: number;
    byteSize?: number;
    collectedRowCount?: number;
    collectionCompletedAt?: string;
    collectionElapsedMs?: number;
    collectionProgressPercentage?: number;
    collectionStartedAt?: string;
    columns: string[];
    expectedRowCount?: number;
    firstPageAvailableAt?: string;
    firstPageElapsedMs?: number;
    nextCursor?: string | null;
    pageCount?: number;
    retentionExpiresAt?: string;
    rowCount?: number;
    storage?: "s3" | "minio" | "postgres";
    storageStatus?: "collecting" | "available" | "expired" | "unavailable";
    totalReadyMs?: number;
  };
  runId: string;
  startedAt?: string;
  stats?: {
    cpuMs?: number;
    completedDrivers?: number;
    completedSplits?: number;
    elapsedMs?: number;
    outputBytes?: number;
    outputRows?: number;
    peakMemoryBytes?: number;
    progressPercentage?: number;
    progressObservedAt?: string;
    processedBytes?: number;
    processedRows?: number;
    queryCompletedAt?: string;
    queryState?: string;
    queuedMs?: number;
    totalDrivers?: number;
    totalSplits?: number;
  };
  status: TrinoQueryRunStatus;
  sourceRunId?: string;
  submittedAt: string;
  trinoQueryId?: string;
};

export type TrinoQueryRunResultPage = {
  columns: string[];
  nextCursor?: string | null;
  pageSize: number;
  pageNumber: number;
  rowEnd: number;
  rowStart: number;
  rows: Array<Array<string | number | boolean | null>>;
  runId: string;
  totalPages?: number | null;
  totalRows?: number | null;
};

export type TrinoQueryRunChart = {
  config: DashboardRuntimeWidgetConfig;
  data: Array<Record<string, unknown>>;
  groupCount: number;
  runId: string;
  sourceRowCount: number;
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
    principalId?: string;
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

export type CreateTrinoSqlJobRequest = {
  baseDatasetId: string;
  dataset: {
    description: string;
    layer: DerivedDatasetLayer;
    name: string;
    rag: boolean;
    refreshPolicy: "manual";
    tags: string[];
  };
  governance: {
    accessScope: "organization" | "private" | "project";
    owner: string;
    permissionSummary: string;
    principalId?: string;
  };
  jobName?: string;
  query: string;
  referenceDatasetIds: string[];
  schedule: {
    mode: "manual" | "daily" | "weekly";
    overlapPolicy: Extract<ScheduleOverlapPolicy, "skip_if_running">;
    time: string;
    timezone: string;
    weekday: "금" | "목" | "수" | "월" | "일" | "토" | "화";
  };
  sourceRunId: string;
  target: {
    partitionColumn?: string;
    writeMode: "full_refresh";
  };
};
