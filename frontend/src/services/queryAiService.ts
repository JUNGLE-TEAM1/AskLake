import { ApiError, type CatalogDataset } from "../types";
import { ApiRequestTimeoutError, apiClient } from "./apiClient";

type QueryAiPreflightMessage = {
  text: string;
  tone: "success" | "info" | "warning" | "error";
};

export type QueryAiMode = "draft_sql";

export type QueryAiRequest = {
  baseDataset: CatalogDataset;
  mode: QueryAiMode;
  preflightMessages: QueryAiPreflightMessage[];
  prompt: string;
  query: string;
  selectedDatasets: CatalogDataset[];
};

export type QueryAiSuggestion = {
  body: string;
  mode: QueryAiMode;
  model?: string | null;
  notices: string[];
  retrieval?: {
    datasetIds?: string[];
    provenance?: string;
    resultCount?: number;
    semanticModelNames?: string[];
    semanticModelVersions?: Array<number | null>;
    status?: string;
  } | null;
  sources?: Array<{
    body?: string;
    chunkIndex?: number;
    datasetId?: string;
    parentDocumentId?: string;
    semanticModelIds?: string[];
    title?: string;
  }>;
  sql?: string;
  title: string;
};

export type QueryAiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export const QUERY_AI_REQUEST_TIMEOUT_MS = 25_000;

const QUERY_AI_ABORTED_MESSAGE = "AI SQL 초안 요청이 취소되었습니다. 다시 시도해 주세요.";
const QUERY_AI_FAILED_MESSAGE = "AI SQL 초안을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
const QUERY_AI_TIMEOUT_MESSAGE = "AI SQL 초안 생성 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";

function hasErrorName(error: unknown, name: string) {
  return typeof error === "object" && error !== null && "name" in error && error.name === name;
}

export function getQueryAiErrorMessage(error: unknown) {
  if (
    error instanceof ApiRequestTimeoutError
    || hasErrorName(error, "TimeoutError")
    || (error instanceof ApiError && (error.code === "BACKEND_TIMEOUT" || error.status === 504))
  ) {
    return QUERY_AI_TIMEOUT_MESSAGE;
  }
  if (hasErrorName(error, "AbortError")) return QUERY_AI_ABORTED_MESSAGE;
  if (error instanceof ApiError && error.message.trim()) return error.message;
  return QUERY_AI_FAILED_MESSAGE;
}

export async function generateQueryAiSuggestion(
  request: QueryAiRequest,
  options: QueryAiRequestOptions = {},
): Promise<QueryAiSuggestion> {
  return apiClient.post<QueryAiSuggestion>("/api/query/ai-suggestions", {
    baseDatasetId: request.baseDataset.id,
    currentQuery: request.query,
    mode: request.mode,
    prompt: request.prompt,
    selectedDatasetIds: request.selectedDatasets.map((dataset) => dataset.id),
  }, {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? QUERY_AI_REQUEST_TIMEOUT_MS,
  });
}
