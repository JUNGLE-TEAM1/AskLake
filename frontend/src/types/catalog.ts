import type { IdentityProfile } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";

export type LineageLayer = "SOURCE" | "PROCESS" | "RAW" | "BRONZE" | "SILVER" | "GOLD" | "CONSUMER";

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
  textStructuring?: TextStructuringRuntimeCheck[];
  textStructuringDefinition?: {
    columns?: Array<Record<string, unknown>>;
    sourceFields?: string[];
    version?: number;
  } | null;
  textStructuringExecution?: TextStructuringExecutionSummary;
  upstream: string[];
};

export type DatasetMaterializationRun = {
  createdAt: string;
  jobId: string;
  publicationManifest?: string;
  quality?: Record<string, unknown> | null;
  quarantine?: {
    format?: string;
    path?: string;
    reason?: string;
    rows?: number;
  } | null;
  rowCount: number;
  ruleContractVersion?: string;
  ruleFingerprint?: string;
  runId: string;
  runtimeFingerprint?: string;
  schemaFingerprint?: string;
  sourceKind: "etl" | "sql" | "kafka";
  sourceLabel: string;
  sourceRanges?: Array<Record<string, unknown>>;
  status: "success" | "failed" | "canceled" | "running" | "queued";
  storageLocation?: string;
  storageSizeBytes: number;
  textStructuring?: TextStructuringRuntimeCheck[];
  textStructuringExecution?: TextStructuringExecutionSummary;
  transform?: Record<string, unknown> | null;
};

export type TextStructuringRuntimeCheck = {
  allowedValues?: string[];
  distinctOutputValues?: number;
  distributionWarning?: string;
  executionMode?: "selected_model" | "auto_model" | "fallback_rule" | "missing_model" | "copy" | "instruction" | string;
  fallbackAllowed?: boolean;
  fallbackUsed?: boolean;
  invalidRows?: number;
  method?: string;
  metrics?: {
    accuracy?: number;
    macroF1?: number;
    validationRows?: number;
    [key: string]: unknown;
  };
  modelArtifact?: string;
  modelRequired?: boolean;
  modelSelectionPolicy?: string;
  output?: string;
  outputDistribution?: Array<{ count: number; value: string }>;
  runtimeStatus?: string;
  selectedModelArtifact?: string;
  target?: string;
  targetColumn?: string;
  validationStatus?: string;
  validationRows?: number;
};

export type TextStructuringExecutionSummary = {
  columns: TextStructuringRuntimeCheck[];
  fallbackColumns: string[];
  missingModelColumns: string[];
  modelColumns: string[];
  oneOfValueColumns: number;
  totalColumns: number;
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
  distinctOutputValues?: number;
  distributionWarning?: string;
  executionMode?: string;
  fallbackUsed?: boolean;
  id: string;
  jobId?: string;
  method?: string;
  metrics?: {
    accuracy?: number;
    macroF1?: number;
    validationRows?: number;
    [key: string]: unknown;
  };
  modelArtifact?: string;
  modelKind?: string;
  outputColumn?: string;
  outputDistribution?: Array<{ count: number; value: string }>;
  runId?: string;
  runtimeStatus?: string;
  status?: "available" | "fallback" | "missing" | string;
  targetColumn?: string;
  targetDatasetId?: string;
  totalRows?: number;
  updatedAt?: string;
  validRows?: number;
  validationStatus?: string;
  validationRows?: number;
};
