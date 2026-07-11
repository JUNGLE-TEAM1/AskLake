import type { IdentityProfile } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";

export type LineageLayer = "SOURCE" | "RAW" | "BRONZE" | "SILVER" | "GOLD" | "CONSUMER";

export type LineageGraphColumn = {
  id: string;
  name: string;
  type: string;
};

export type LineageGraphDataset = {
  columns: LineageGraphColumn[];
  engine: string;
  id: string;
  layer: LineageLayer;
  name: string;
};

export type LineageGraphEdge = {
  fromColumnId: string;
  fromDatasetId: string;
  toColumnId: string;
  toDatasetId: string;
};

export type LineageGraph = {
  datasetId: string;
  datasets: LineageGraphDataset[];
  edges: LineageGraphEdge[];
};

export type CatalogDataset = {
  description: string;
  downstream: string[];
  freshness: "latest" | "stale" | "approval";
  id: string;
  layer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
  lastUpdated: string;
  lineageGraph?: LineageGraph;
  materializationRuns?: DatasetMaterializationRun[];
  name: string;
  nextRefresh: string;
  owner: string;
  createdBy?: string;
  createdByProfile?: IdentityProfile;
  partition?: string;
  partitionColumns?: string[];
  indexColumns?: string[];
  permissionGrants?: PermissionGrant[];
  permissions?: ResourcePermissions;
  quality: string;
  queryEngineStatus?: "pending" | "available" | "registration_failed" | "unavailable";
  queryEngineRequired?: boolean;
  queryEngineTable?: {
    catalog: string;
    schema: string;
    table: string;
    format: "iceberg" | "parquet";
    partitionColumns: string[];
  };
  rag: boolean;
  rows: string;
  sampleRows: string[][];
  schema: Array<[string, string]>;
  size: string;
  source: string;
  sourceRunId?: string;
  status: "available" | "approval_required";
  storageFormat?: string;
  storageLocation?: string;
  storageSizeBytes?: number;
  tags: string[];
  upstream: string[];
};

export type DatasetMaterializationRun = {
  createdAt: string;
  jobId: string;
  rowCount: number;
  runId: string;
  sourceKind: "etl" | "sql" | "kafka";
  sourceLabel: string;
  status: "success" | "failed" | "canceled" | "running" | "queued";
  storageLocation?: string;
  storageSizeBytes: number;
};

export type CatalogDatasetRowsResponse = {
  columns: string[];
  datasetId: string;
  datasetName: string;
  hasNext: boolean;
  limit: number;
  offset: number;
  returnedRows: number;
  rowCount: number;
  rows: string[][];
};

export type CatalogModelArtifact = {
  allowedValues?: string[];
  artifactType: "model";
  datasetName?: string;
  id: string;
  jobId?: string;
  method?: string;
  modelArtifact?: string;
  modelKind?: string;
  outputColumn?: string;
  runId?: string;
  runtimeStatus?: string;
  status?: "available" | "fallback" | "missing" | string;
  targetColumn?: string;
  targetDatasetId?: string;
  totalRows?: number;
  updatedAt?: string;
  validRows?: number;
  validationStatus?: string;
};
