import type {
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetType,
  DashboardWidgetLayout,
} from "../types";
import { apiClient, type ApiRequestOptions } from "./apiClient";

export type DashboardDatasetFreshness = {
  datasetId: string;
  isContinuous: boolean;
  latestRevision: number;
  nextCheckAfterMs: number;
  updatedAt: string | null;
};

export type DashboardDatasetFreshnessResponse = {
  datasets: DashboardDatasetFreshness[];
};

export type DashboardWidgetRefreshResponse = {
  widgets: DashboardRuntimeWidget[];
};

export type DashboardWidgetMutationResponse = {
  id: string;
  widget: DashboardRuntimeWidget;
};

export type CreateDraftWidgetInput = {
  config?: Record<string, unknown>;
  data?: Array<Record<string, unknown>>;
  datasetId?: string | null;
  layout: DashboardWidgetLayout;
  title?: string | null;
  type: DashboardRuntimeWidgetType;
};

export type UpdateDraftWidgetInput = {
  config?: Record<string, unknown>;
  data?: Array<Record<string, unknown>>;
  datasetId?: string | null;
  title?: string | null;
  type?: DashboardRuntimeWidgetType;
};

export function getPublishedDashboard(
  dashboardId: string,
  { includeData = true }: { includeData?: boolean } = {},
) {
  return apiClient.get<DashboardRuntimeResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/published?includeData=${includeData}`,
  );
}

export function queryDashboardDatasetFreshness(
  datasetIds: string[],
  options: ApiRequestOptions = {},
) {
  return apiClient.post<DashboardDatasetFreshnessResponse>(
    "/api/datasets/freshness/query",
    { datasetIds },
    options,
  );
}

export function queryDashboardWidgets(
  dashboardId: string,
  mode: "draft" | "published",
  widgetIds: string[],
  options: ApiRequestOptions = {},
) {
  return apiClient.post<DashboardWidgetRefreshResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/widgets/query`,
    { mode, widgetIds },
    options,
  );
}

export function queryPublishedDashboardWidgets(
  dashboardId: string,
  widgetIds: string[],
  options: ApiRequestOptions = {},
) {
  return queryDashboardWidgets(dashboardId, "published", widgetIds, options);
}

export function ensureDraftDashboard(
  dashboardId: string,
  { includeData = true }: { includeData?: boolean } = {},
) {
  return apiClient.post<DashboardRuntimeResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure?includeData=${includeData}`,
    {},
  );
}

export function createDraftPage(dashboardId: string, input: { title: string }) {
  return apiClient.post<{ id: string; orderIndex: number; title: string }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages`,
    input,
  );
}

export function createDraftWidget(dashboardId: string, pageId: string, input: CreateDraftWidgetInput) {
  return apiClient.post<DashboardWidgetMutationResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}/widgets`,
    input,
  );
}

export function deleteDraftPage(dashboardId: string, pageId: string) {
  return apiClient.delete<{
    ok: true;
    replacementPage: { id: string; orderIndex: number; title: string } | null;
  }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}`,
  );
}

export function deleteDraftWidget(dashboardId: string, widgetId: string) {
  return apiClient.delete<{ deletedWidgetId: string; ok: true }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/widgets/${encodeURIComponent(widgetId)}`,
  );
}

export function updateDraftWidget(dashboardId: string, widgetId: string, input: UpdateDraftWidgetInput) {
  return apiClient.patch<DashboardWidgetMutationResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/widgets/${encodeURIComponent(widgetId)}`,
    input,
  );
}

export function updateDraftPageTitle(dashboardId: string, pageId: string, input: { title: string }) {
  return apiClient.patch<{ id: string; orderIndex: number; title: string }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}`,
    input,
  );
}

export function saveDraftLayouts(
  dashboardId: string,
  input: {
    layouts: Array<DashboardWidgetLayout & { widgetId: string }>;
    pageId: string;
  },
) {
  return apiClient.patch<{ ok: true }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/layouts`,
    input,
  );
}

export function publishDashboard(dashboardId: string) {
  return apiClient.post<{ dashboardId: string; publishedAt: string; publishedRevisionId: string }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/publish`,
    {},
  );
}
