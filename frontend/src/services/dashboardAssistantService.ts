import type { DashboardRuntimeWidget, DashboardRuntimeWidgetConfig } from "../types";
import { apiClient } from "./apiClient";

const assistantEndpoint = (import.meta.env.VITE_DASHBOARD_ASSISTANT_API_PATH ?? "/api/dashboards/assistant").trim();

export type DashboardAssistantMode = "dashboard_question" | "visualization_request";

export type DashboardAssistantWidgetContext = {
  config: Record<string, unknown>;
  dataSample: Array<Record<string, unknown>>;
  datasetId: string | null;
  id: string;
  layout: DashboardRuntimeWidget["layout"];
  title: string;
  type: DashboardRuntimeWidget["type"];
};

export type DashboardAssistantRequest = {
  dashboardId?: string;
  currentDatasetId?: string | null;
  mode: DashboardAssistantMode;
  pageId?: string | null;
  prompt: string;
  selectedWidgetId?: string | null;
  widgetId?: string | null;
  widgets: DashboardAssistantWidgetContext[];
};

export type DashboardAssistantWidgetPatch = {
  config?: Record<string, unknown>;
  datasetId?: string | null;
  title?: string | null;
  type?: DashboardRuntimeWidget["type"];
};

export type DashboardAssistantCreateWidgetAction = {
  type: "create_widget";
  usedEvidenceIds?: string[];
  widget: {
    config: DashboardRuntimeWidgetConfig;
    datasetId: string;
    title: string;
    type: DashboardRuntimeWidget["type"];
  };
};

export type DashboardAssistantUpdateWidgetAction = {
  patch: DashboardAssistantWidgetPatch;
  type: "update_widget";
  usedEvidenceIds?: string[];
  widgetId: string;
};

export type DashboardAssistantReportAction = {
  markdown: string;
  type: "report";
  usedEvidenceIds?: string[];
};

export type DashboardAssistantAction =
  | DashboardAssistantCreateWidgetAction
  | DashboardAssistantUpdateWidgetAction
  | DashboardAssistantReportAction;

export type DashboardAssistantResponse = {
  actions: DashboardAssistantAction[];
  configPatch?: Record<string, unknown>;
  message: string;
  model?: string | null;
  provider?: string | null;
  requestId?: string | null;
  retrieval?: {
    aliases?: string[];
    datasetIds?: string[];
    provenance?: string;
    resultCount?: number;
    fallbackEvidenceCount?: number;
    fallbackReasons?: string[];
    degradationReasons?: string[];
    queryPlannerProvider?: string | null;
    queryPlannerModel?: string | null;
    queryEmbeddings?: Record<string, { provider?: string | null; model?: string | null; dimensions?: number | null }>;
    relevanceProvider?: string | null;
    relevanceModel?: string | null;
    semanticModelNames?: string[];
    semanticModelVersions?: Array<number | null>;
    status?: string;
  };
  sources?: Array<{
    body?: string;
    chunkIndex?: number;
    chunkingStrategy?: string;
    datasetId?: string;
    documentId?: string;
    embeddingModel?: string;
    embeddingProvider?: string;
    fallbackApplied?: boolean;
    fallbackReason?: string;
    fallbackReasons?: string[];
    metadata?: Record<string, unknown>;
    parentDocumentId?: string;
    semanticModelIds?: string[];
    title?: string;
  }>;
  warnings: string[];
  widgetPatch?: DashboardAssistantWidgetPatch;
  usedEvidenceIds?: string[];
};

export class DashboardAssistantNotConfiguredError extends Error {
  constructor() {
    super("VITE_DASHBOARD_ASSISTANT_API_PATH is not configured.");
    this.name = "DashboardAssistantNotConfiguredError";
  }
}

export function isDashboardAssistantConfigured() {
  return assistantEndpoint.length > 0;
}

export function dashboardAssistantEndpointLabel() {
  return assistantEndpoint || "VITE_DASHBOARD_ASSISTANT_API_PATH";
}

export function dashboardEvidenceSummary(response: DashboardAssistantResponse) {
  const sources = response.sources ?? [];
  if (sources.length === 0) return "";
  const labels = sources.map((source, index) => {
    const label = source.title || source.body?.trim().slice(0, 120) || source.datasetId || source.documentId || "근거 문서";
    return `${index + 1}. ${label}`;
  });
  return `RAG 근거 ${sources.length}건 · ${labels.join(" / ")}`;
}

export function buildDashboardAssistantWidgetContext(widget: DashboardRuntimeWidget): DashboardAssistantWidgetContext {
  return {
    config: widget.config as Record<string, unknown>,
    dataSample: widget.data.slice(0, 5),
    datasetId: widget.datasetId ?? null,
    id: widget.id,
    layout: widget.layout,
    title: widget.title ?? "제목 없는 위젯",
    type: widget.type,
  };
}

function normalizeEndpoint(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function postAbsoluteUrl(endpoint: string, body: DashboardAssistantRequest) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(response.statusText || "Dashboard assistant request failed.");
  }

  return response.json() as Promise<DashboardAssistantResponse>;
}

export async function requestDashboardAssistant(body: DashboardAssistantRequest) {
  if (!assistantEndpoint) throw new DashboardAssistantNotConfiguredError();

  if (/^https?:\/\//i.test(assistantEndpoint)) {
    return postAbsoluteUrl(assistantEndpoint, body);
  }

  return apiClient.post<DashboardAssistantResponse>(normalizeEndpoint(assistantEndpoint), body);
}
