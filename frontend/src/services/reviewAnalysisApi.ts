import { apiClient } from "./apiClient";

export type ReviewAnalysisRow = {
  asin: string;
  confidence: number;
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

export type ReviewAnalysisSummary = {
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
  status: "idle" | "running" | "success" | "failed";
  stoppedAtLimit?: boolean;
  warning?: string;
};

export type ReviewSchemaSuggestionColumn = {
  label: string;
  nullable: boolean;
  targetName: string;
  type: string;
};

export type ReviewSchemaSuggestion = {
  columns: ReviewSchemaSuggestionColumn[];
  model: string;
  source: string;
  status: "success";
};

export function getCellphonesReviewAnalysis() {
  return apiClient.get<ReviewAnalysisSummary>("/api/review-analysis/cellphones");
}

export function suggestReviewAnalysisSchema(request: {
  sampleRows: string[][];
  sourceColumns: Array<{ name: string; type: string }>;
}) {
  return apiClient.post<ReviewSchemaSuggestion>("/api/review-analysis/schema-suggestion", request);
}

export function runCellphonesReviewAnalysis(
  limit = 50000,
  schemaColumns?: Array<{ label?: string; targetName: string; type?: string }>,
) {
  return apiClient.post<ReviewAnalysisSummary>("/api/review-analysis/cellphones/run", { limit, schemaColumns });
}
