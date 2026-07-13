import type {
  DashboardPublishedDataRefreshScope,
  DashboardPublishedDataResponse,
  DashboardRuntimeResponse,
  DashboardRuntimeWidgetType,
  DashboardWidgetLayout,
} from "../types";
import { apiClient } from "./apiClient";

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

export function getPublishedDashboard(dashboardId: string) {
  return apiClient.get<DashboardRuntimeResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/published`,
  );
}

export function getPublishedDashboardData(
  dashboardId: string,
  scope: DashboardPublishedDataRefreshScope = "all",
) {
  return apiClient.get<DashboardPublishedDataResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/published/data?scope=${encodeURIComponent(scope)}`,
  );
}

export function ensureDraftDashboard(dashboardId: string) {
  return apiClient.post<DashboardRuntimeResponse>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`,
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
  return apiClient.post<{ id: string }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}/widgets`,
    input,
  );
}

export function deleteDraftPage(dashboardId: string, pageId: string) {
  return apiClient.delete<{ ok: true }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}`,
  );
}

export function deleteDraftWidget(dashboardId: string, widgetId: string) {
  return apiClient.delete<{ deletedWidgetId: string; ok: true }>(
    `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/widgets/${encodeURIComponent(widgetId)}`,
  );
}

export function updateDraftWidget(dashboardId: string, widgetId: string, input: UpdateDraftWidgetInput) {
  return apiClient.patch<{ id: string }>(
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
