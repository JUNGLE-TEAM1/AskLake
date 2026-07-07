import type { DashboardRuntimeWidget, DashboardRuntimeWidgetConfig } from "../types";
import { apiClient } from "./apiClient";

const assistantEndpoint = (import.meta.env.VITE_DASHBOARD_ASSISTANT_API_PATH ?? "").trim();

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
  widgetId: string;
};

export type DashboardAssistantReportAction = {
  markdown: string;
  type: "report";
};

export type DashboardAssistantAction =
  | DashboardAssistantCreateWidgetAction
  | DashboardAssistantUpdateWidgetAction
  | DashboardAssistantReportAction;

export type DashboardAssistantResponse = {
  actions: DashboardAssistantAction[];
  configPatch?: Record<string, unknown>;
  message: string;
  warnings: string[];
  widgetPatch?: DashboardAssistantWidgetPatch;
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
