import { apiClient } from "./apiClient";

export type ReviewAnalysisRow = {
  asin: string;
  evidence: string;
  helpful_vote: number;
  issue_category: string;
  issue_label: string;
  issue_subcategory: string;
  parent_asin: string;
  rating: number;
  review_id: string;
  sentiment: string;
  severity: string;
  summary: string;
  timestamp: number | null;
  title: string;
  user_id: string;
  verified_purchase: boolean;
};

export type ReviewAnalysisBreakdown = {
  count: number;
  id: string;
  label: string;
  share: number;
};

export type ReviewModelTraining = {
  artifacts: Array<{
    artifact?: string;
    metrics?: { accuracy?: number; macroF1?: number; validationRows?: number };
    status?: string;
    targetColumn: string;
  }>;
  labelModels?: string[];
  labelSource?: string;
  message: string;
  status: "success" | "quality_gate_failed" | "failed" | "insufficient_training_rows" | "not_applicable";
  trainingRows?: number;
};

export type ReviewAnalysisSummary = {
  analysis?: {
    fallbackUsed: boolean;
    mode: "ai_gateway";
    models: string[];
    providers: string[];
    schemaSource?: "builtin_template" | "user_defined";
    schemaTemplateId?: string | null;
  };
  categoryBreakdown?: ReviewAnalysisBreakdown[];
  finishedAt?: string;
  invalidRows?: number;
  limit?: number;
  message?: string;
  metrics?: {
    averageRating: number;
    highSeverityRows: number;
    issueRows: number;
    negativeRows: number;
    positiveRows: number;
    totalHelpfulVotes: number;
  };
  method?: {
    name: string;
    note: string;
    schema: string[];
  };
  modelTraining?: ReviewModelTraining;
  output?: {
    jsonlPath: string;
    summaryPath: string;
  };
  processedRows?: number;
  rows?: ReviewAnalysisRow[];
  runId?: string;
  sentimentBreakdown?: ReviewAnalysisBreakdown[];
  severityBreakdown?: ReviewAnalysisBreakdown[];
  source?: {
    bucket: string;
    key: string;
    object: string;
    runtime: string;
  };
  startedAt?: string;
  status: "idle" | "queued" | "running" | "success" | "failed";
  stoppedAtLimit?: boolean;
  warning?: string;
};

export type ReviewSchemaSuggestionColumn = {
  allowedValues?: string[];
  instruction?: string;
  label: string;
  method?: string;
  modelArtifact?: string;
  modelId?: string;
  nullable: boolean;
  requireModel?: boolean;
  targetName: string;
  type: string;
};

export type ReviewSchemaSuggestion = {
  columns: ReviewSchemaSuggestionColumn[];
  model: string;
  source: string;
  status: "success";
};

export type ReviewAnalysisPreviewColumn = {
  allowedValues: string[];
  instruction: string;
  method: "copy" | "one_of_values" | "instruction";
  sourceField: string;
  targetName: string;
};

export type ReviewAnalysisPreviewResponse = {
  model: string;
  models: string[];
  provider: string;
  providers: string[];
  rows: Array<Record<string, string>>;
  runtime: "gateway";
  status: "success";
};

export type ReviewAnalysisRunStatus = {
  createdAt?: string | null;
  error?: string | null;
  finishedAt?: string | null;
  message?: string;
  result?: ReviewAnalysisSummary | null;
  runId?: string;
  source: {
    bucket: string;
    key: string;
    object?: string;
    runtime?: string;
  };
  modelTraining?: ReviewModelTraining;
  startedAt?: string | null;
  status: "idle" | "queued" | "running" | "success" | "failed";
};

export function getLatestReviewAnalysis() {
  return apiClient.get<ReviewAnalysisRunStatus>("/api/review-analysis/runs/latest");
}

export function getReviewAnalysisRun(runId: string) {
  return apiClient.get<ReviewAnalysisRunStatus>(`/api/review-analysis/runs/${encodeURIComponent(runId)}`);
}

export function suggestReviewAnalysisSchema(request: {
  sampleRows: string[][];
  sourceColumns: Array<{ name: string; type: string }>;
}) {
  return apiClient.post<ReviewSchemaSuggestion>("/api/review-analysis/schema-suggestion", request);
}

export function previewReviewAnalysis(request: {
  columns: ReviewAnalysisPreviewColumn[];
  rows: Array<Record<string, string>>;
}) {
  return apiClient.post<ReviewAnalysisPreviewResponse>("/api/review-analysis/preview", request);
}

export function startReviewAnalysis(
  limit = 25,
  schemaColumns?: Array<{
    allowedValues?: string[];
    instruction?: string;
    label?: string;
    method?: string;
    modelArtifact?: string;
    modelId?: string;
    requireModel?: boolean;
    targetName: string;
    type?: string;
  }>,
  runtime: "gateway" = "gateway",
  source?: { bucket: string; key: string },
  trainModels = false,
) {
  return apiClient.post<ReviewAnalysisRunStatus>("/api/review-analysis/runs", {
    limit,
    runtime,
    schemaColumns,
    source,
    trainModels,
  });
}

export function reviewAnalysisRunSummary(run: ReviewAnalysisRunStatus): ReviewAnalysisSummary {
  if (run.result) {
    return {
      ...run.result,
      modelTraining: run.result.modelTraining ?? run.modelTraining,
      runId: run.runId || run.result.runId,
      source: run.result.source ?? {
        bucket: run.source.bucket,
        key: run.source.key,
        object: run.source.object ?? `s3://${run.source.bucket}/${run.source.key}`,
        runtime: run.source.runtime ?? "object-storage",
      },
      status: run.status,
      warning: run.error || run.result.warning,
    };
  }

  return {
    message: run.message,
    modelTraining: run.modelTraining,
    runId: run.runId,
    source: {
      bucket: run.source.bucket,
      key: run.source.key,
      object: run.source.object ?? `s3://${run.source.bucket}/${run.source.key}`,
      runtime: run.source.runtime ?? "object-storage",
    },
    status: run.status,
    warning: run.error ?? undefined,
  };
}
