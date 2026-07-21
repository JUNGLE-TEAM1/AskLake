import { apiClient } from "./apiClient";

export type SemanticSchemaColumn = {
  name: string;
  dataType: string;
  description: string;
  sampleValues: string[];
};

export type SemanticDataset = {
  id: string;
  datasetId: string;
  role: "source" | "lookup";
  joinConfig: Record<string, unknown>;
  name?: string;
  description: string;
  layer?: string;
  rows?: string;
  schema: SemanticSchemaColumn[];
  schemaFingerprint?: string | null;
};

export type SemanticMetric = {
  id: string;
  name: string;
  label: string;
  description: string;
  expression: string;
  datasetId?: string | null;
  sourceColumns: string[];
  sourceFields?: Array<{ logicalField?: string; physicalField?: string; role?: string }>;
  format?: string | null;
};

export type SemanticDimension = {
  id: string;
  name: string;
  label: string;
  description: string;
  datasetId?: string | null;
  columnName?: string | null;
  dataType?: string | null;
};

export type SemanticPermissionGrant = {
  id?: string;
  principalType: string;
  principalId: string;
  actions: string[];
};

export type SemanticModel = {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: "draft" | "published" | "archived";
  version: number;
  publishedVersion?: number | null;
  datasets: SemanticDataset[];
  metrics: SemanticMetric[];
  dimensions: SemanticDimension[];
  relationships: Array<Record<string, unknown>>;
  vocabulary: Array<Record<string, unknown>>;
  permissionGrants: SemanticPermissionGrant[];
  permissions: Record<string, boolean>;
};

export async function listSemanticModels(): Promise<SemanticModel[]> {
  return apiClient.get<SemanticModel[]>("/api/semantic-models");
}

export async function createSemanticModel(input: { name: string; description: string; datasets: Array<{ datasetId: string; role: "source" | "lookup" }> }): Promise<SemanticModel> {
  return apiClient.post<SemanticModel>("/api/semantic-models", input);
}

export async function updateSemanticModel(modelId: string, input: { name?: string; description?: string }): Promise<SemanticModel> {
  return apiClient.patch<SemanticModel>(`/api/semantic-models/${encodeURIComponent(modelId)}`, input);
}

export async function replaceSemanticDatasets(modelId: string, datasets: Array<{ datasetId: string; role: "source" | "lookup" }>): Promise<SemanticModel> {
  return apiClient.put<SemanticModel>(`/api/semantic-models/${encodeURIComponent(modelId)}/datasets`, datasets);
}

export async function replaceSemanticMetrics(modelId: string, metrics: Array<Omit<SemanticMetric, "id">>): Promise<SemanticModel> {
  return apiClient.put<SemanticModel>(`/api/semantic-models/${encodeURIComponent(modelId)}/metrics`, metrics);
}

export async function replaceSemanticDimensions(modelId: string, dimensions: Array<Omit<SemanticDimension, "id">>): Promise<SemanticModel> {
  return apiClient.put<SemanticModel>(`/api/semantic-models/${encodeURIComponent(modelId)}/dimensions`, dimensions);
}

export async function validateSemanticModel(modelId: string): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  return apiClient.post(`/api/semantic-models/${encodeURIComponent(modelId)}/validate`, {});
}

export async function publishSemanticModel(modelId: string): Promise<{ model: SemanticModel; publishedVersion: number }> {
  return apiClient.post(`/api/semantic-models/${encodeURIComponent(modelId)}/publish`, {});
}
