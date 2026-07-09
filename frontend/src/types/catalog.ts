import type { IdentityProfile } from "./identity";

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
};

export type DatasetMaterializationRun = {
  createdAt: string;
  jobId: string;
  rowCount: number;
  runId: string;
  sourceKind: "etl" | "sql";
  sourceLabel: string;
  status: "success" | "failed" | "canceled" | "running" | "queued";
  storageLocation?: string;
  storageSizeBytes: number;
};
