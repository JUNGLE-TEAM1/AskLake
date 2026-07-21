import type { DashboardRuntimeWidget, DashboardRuntimeWidgetConfig } from "../types";
import { apiClient } from "./apiClient";
import type { ApiRequestOptions } from "./apiClient";

// Docker build args are exposed to Vite as empty strings when omitted. Treat an
// empty value like an unset value so every build keeps the live same-origin API.
const assistantEndpoint = (import.meta.env.VITE_DASHBOARD_ASSISTANT_API_PATH || "/api/dashboards/assistant").trim();

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
  selectedDatasetIds?: string[];
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
    datasetIds?: string[];
    mode?: "disabled";
    provenance?: "rag_removed";
    resultCount?: 0;
    status?: "disabled";
  };
  sources?: [];
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

async function postAbsoluteUrl(
  endpoint: string,
  body: DashboardAssistantRequest,
  options: ApiRequestOptions,
) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(response.statusText || "Dashboard assistant request failed.");
  }

  return response.json() as Promise<DashboardAssistantResponse>;
}

export async function requestDashboardAssistant(
  body: DashboardAssistantRequest,
  options: ApiRequestOptions = {},
) {
  if (!assistantEndpoint) throw new DashboardAssistantNotConfiguredError();

  if (/^https?:\/\//i.test(assistantEndpoint)) {
    return postAbsoluteUrl(assistantEndpoint, body, options);
  }

  return apiClient.post<DashboardAssistantResponse>(normalizeEndpoint(assistantEndpoint), body, options);
}
