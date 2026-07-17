import { apiClient, type ApiRequestOptions } from "./apiClient";

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

export type RagRecommendation = {
  id: string;
  columnName: string;
  role: "body" | "title" | "metadata" | "identifier" | "excluded";
  confidence: number;
  reason: string;
  approved: boolean;
};

export type RagProfile = {
  datasetId: string;
  reviewState: string;
  indexStatus: string;
  buildStatus?: string;
  servingStatus?: string;
  embeddingStatus: string;
  schema: SemanticSchemaColumn[];
  schemaFingerprint?: string | null;
  bodyColumns: string[];
  titleColumns: string[];
  metadataColumns: string[];
  identifierColumns: string[];
  excludedColumns: string[];
  classifier?: string | null;
  classifierConfidence?: number | null;
  targetAlias?: string | null;
  activeIndex?: string | null;
  activeSourceFingerprint?: string | null;
  activeEmbeddingProvider?: string | null;
  activeEmbeddingModel?: string | null;
  activeEmbeddingDimensions?: number | null;
  activeChunkingVersion?: string | null;
  lastError?: string | null;
  physicalColumnMapping?: Record<string, string>;
  semanticBindings: Record<string, Array<Record<string, unknown>>>;
  recommendations: RagRecommendation[];
};

export type RagJob = {
  jobId: string;
  datasetId: string;
  requestedMode: string;
  status: string;
  stage: string;
  progressPercent: number;
  documentCount: number;
  indexedCount: number;
  parentCount: number;
  chunkCount: number;
  failedCount: number;
  fallbackCount: number;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  validationStatus: string;
  activationStatus: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RagDocument = {
  documentId: string;
  parentDocumentId?: string | null;
  chunkIndex?: number;
  startSentence?: number;
  endSentence?: number;
  datasetId: string;
  sourceRowId: string;
  body: string;
  title?: string | null;
  filterTerms: Record<string, string>;
  metadataFilter?: Record<string, Record<string, unknown>>;
  metadataDisplay: Record<string, unknown>;
  semanticBindings: Record<string, Array<Record<string, unknown>>>;
  sourceDataset: string;
  sourceColumns: string[];
  targetIndex: string;
  embeddingStatus: string;
  contentHash: string;
  embeddingText?: string;
  chunkingStrategy?: string;
  chunkingVersion?: string;
  embeddingInputVersion?: string;
  fieldRenderingVersion?: string;
};

export type RagPreview = {
  datasetId: string;
  targetAlias: string;
  sourceColumns: string[];
  documents: RagDocument[];
};

export type RagSearchSource = {
  documentId: string;
  chunkDocumentId?: string | null;
  parentDocumentId?: string | null;
  datasetId?: string | null;
  sourceRowId?: string | null;
  title?: string | null;
  body?: string | null;
  metadata: Record<string, unknown>;
  sourceFields: Array<string | { logicalField?: string; physicalField?: string; role?: string }>;
  chunkIndex?: number | null;
  chunkCount?: number | null;
  chunkingStrategy?: string | null;
  chunkingStrategies?: string[];
  chunkingVersion?: string | null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDimensions?: number | null;
  embeddingInputVersion?: string | null;
  fieldRenderingVersion?: string | null;
  fallbackApplied?: boolean;
  fallbackReason?: string | null;
  fallbackReasons?: string[];
  retrievalAlias?: string | null;
  score?: number | null;
  retrievalScore?: number | null;
  relevanceReason?: string | null;
};

export type RagSearchResponse = {
  sources: RagSearchSource[];
  retrieval: {
    mode?: string;
    status?: string;
    aliases?: string[];
    resultCount?: number;
    buildStatus?: string;
    servingStatus?: string;
    servingIndex?: string | null;
    fallbackEvidenceCount?: number;
    fallbackReasons?: string[];
    degradationReasons?: string[];
    queryPlannerProvider?: string | null;
    queryPlannerModel?: string | null;
    queryEmbeddings?: Record<string, { provider?: string | null; model?: string | null; dimensions?: number | null }>;
    relevanceProvider?: string | null;
    relevanceModel?: string | null;
    [key: string]: unknown;
  };
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

export async function getRagProfile(datasetId: string): Promise<RagProfile> {
  return apiClient.get<RagProfile>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag`);
}

export async function classifyRagDataset(datasetId: string, semanticModelId: string): Promise<{ runId: string; datasetId: string; status: string }> {
  return apiClient.post(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/classify?semantic_model_id=${encodeURIComponent(semanticModelId)}`, {});
}

export async function approveRagDataset(datasetId: string, input: { bodyColumns: string[]; titleColumns: string[]; metadataColumns: string[]; identifierColumns: string[]; excludedColumns: string[] }): Promise<RagProfile> {
  return apiClient.post<RagProfile>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/approve`, input);
}

export async function previewRagDocuments(datasetId: string): Promise<RagPreview> {
  return apiClient.get<RagPreview>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/document-preview`);
}

export async function indexRagDataset(datasetId: string, mode: "index" | "reindex" = "index"): Promise<{ jobId: string; datasetId: string; status: string; targetIndex?: string | null }> {
  return apiClient.post(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/${mode}`, { idempotencyKey: `${datasetId}-${Date.now()}` });
}

export async function listRagJobs(datasetId: string, options: ApiRequestOptions = {}): Promise<RagJob[]> {
  return apiClient.get<RagJob[]>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/jobs?limit=30`, options);
}

export async function searchRagDataset(datasetId: string, query: string, filters: Record<string, unknown> = {}): Promise<RagSearchResponse> {
  return apiClient.post<RagSearchResponse>(`/api/catalog/datasets/${encodeURIComponent(datasetId)}/rag/search`, {
    query,
    filters,
  });
}
