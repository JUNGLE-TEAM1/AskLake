import type { IdentityProfile } from "./identity";
import type { PermissionGrant, ResourcePermissions } from "./permissions";
import type { TextStructuringSpecRef } from "./textStructuring";

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
  artifacts?: Array<Record<string, unknown>>;
  textStructuring?: TextStructuringSpecRef;
  parentDatasetId?: string;
  artifactKind?: string;
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
