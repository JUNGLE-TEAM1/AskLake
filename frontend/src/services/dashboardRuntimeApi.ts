import { ApiError } from "../types";
import type {
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetType,
  DashboardWidgetLayout,
} from "../types";
import { apiClient, apiConfig } from "./apiClient";

type RuntimeStoreEntry = {
  draft: DashboardRuntimeResponse;
  published: DashboardRuntimeResponse;
};

const runtimeStore = new Map<string, RuntimeStoreEntry>();

function shouldUseRuntimeFallback(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

async function withRuntimeFallback<T>(request: () => Promise<T>, fallback: () => T): Promise<T> {
  if (apiConfig.useMock) return fallback();
  try {
    return await request();
  } catch (error) {
    if (shouldUseRuntimeFallback(error)) return fallback();
    throw error;
  }
}

export function getPublishedDashboard(dashboardId: string) {
  return withRuntimeFallback(
    () => apiClient.get<DashboardRuntimeResponse>(`/api/dashboards/${encodeURIComponent(dashboardId)}/published`),
    () => getStoreEntry(dashboardId).published,
  );
}

export function ensureDraftDashboard(dashboardId: string) {
  return withRuntimeFallback(
    () => apiClient.post<DashboardRuntimeResponse>(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/ensure`, {}),
    () => getStoreEntry(dashboardId).draft,
  );
}

export function createDraftPage(dashboardId: string, input: { title: string }) {
  return withRuntimeFallback(
    () => apiClient.post<{ id: string; orderIndex: number; title: string }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages`,
      input,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      const page = {
        id: `page-${Date.now()}`,
        orderIndex: entry.draft.pages.length,
        title: input.title.trim() || "제목 없는 페이지",
      };
      entry.draft = {
        ...entry.draft,
        pages: [...entry.draft.pages, page],
        widgetsByPageId: {
          ...entry.draft.widgetsByPageId,
          [page.id]: [],
        },
      };
      return page;
    },
  );
}

export function createDraftWidget(dashboardId: string, pageId: string, input: CreateDraftWidgetInput) {
  return withRuntimeFallback(
    () => apiClient.post<{ id: string }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}/widgets`,
      input,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      const widget = createLocalWidget(pageId, input);
      entry.draft = {
        ...entry.draft,
        widgetsByPageId: {
          ...entry.draft.widgetsByPageId,
          [pageId]: [...(entry.draft.widgetsByPageId[pageId] ?? []), widget],
        },
      };
      return { id: widget.id };
    },
  );
}

export function deleteDraftPage(dashboardId: string, pageId: string) {
  return withRuntimeFallback(
    () => apiClient.delete<{ ok: true }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}`,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      const { [pageId]: _deletedWidgets, ...widgetsByPageId } = entry.draft.widgetsByPageId;
      entry.draft = {
        ...entry.draft,
        pages: entry.draft.pages.filter((page) => page.id !== pageId).map((page, index) => ({ ...page, orderIndex: index })),
        widgetsByPageId,
      };
      return { ok: true };
    },
  );
}

export function deleteDraftWidget(dashboardId: string, widgetId: string) {
  return withRuntimeFallback(
    () => apiClient.delete<{ deletedWidgetId: string; ok: true }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/widgets/${encodeURIComponent(widgetId)}`,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      entry.draft = {
        ...entry.draft,
        widgetsByPageId: Object.fromEntries(
          Object.entries(entry.draft.widgetsByPageId).map(([pageId, widgets]) => [
            pageId,
            widgets.filter((widget) => widget.id !== widgetId),
          ]),
        ),
      };
      return { deletedWidgetId: widgetId, ok: true };
    },
  );
}

export function updateDraftWidget(dashboardId: string, widgetId: string, input: UpdateDraftWidgetInput) {
  return withRuntimeFallback(
    () => apiClient.patch<{ id: string }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/widgets/${encodeURIComponent(widgetId)}`,
      input,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      entry.draft = {
        ...entry.draft,
        widgetsByPageId: Object.fromEntries(
          Object.entries(entry.draft.widgetsByPageId).map(([pageId, widgets]) => [
            pageId,
            widgets.map((widget) => widget.id === widgetId ? updateLocalWidget(widget, input) : widget),
          ]),
        ),
      };
      return { id: widgetId };
    },
  );
}

export function updateDraftPageTitle(dashboardId: string, pageId: string, input: { title: string }) {
  return withRuntimeFallback(
    () => apiClient.patch<{ id: string; orderIndex: number; title: string }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/draft/pages/${encodeURIComponent(pageId)}`,
      input,
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      const title = input.title.trim() || "제목 없는 페이지";
      entry.draft = {
        ...entry.draft,
        pages: entry.draft.pages.map((page) => page.id === pageId ? { ...page, title } : page),
      };
      const page = entry.draft.pages.find((item) => item.id === pageId);
      return page ?? { id: pageId, orderIndex: 0, title };
    },
  );
}

export function saveDraftLayouts(
  dashboardId: string,
  input: {
    layouts: Array<DashboardWidgetLayout & { widgetId: string }>;
    pageId: string;
  },
) {
  return withRuntimeFallback(
    () => apiClient.patch<{ ok: true }>(`/api/dashboards/${encodeURIComponent(dashboardId)}/draft/layouts`, input),
    () => {
      const entry = getStoreEntry(dashboardId);
      const layoutByWidgetId = new Map(input.layouts.map((layout) => [layout.widgetId, layout]));
      entry.draft = {
        ...entry.draft,
        widgetsByPageId: {
          ...entry.draft.widgetsByPageId,
          [input.pageId]: (entry.draft.widgetsByPageId[input.pageId] ?? []).map((widget) => {
            const layout = layoutByWidgetId.get(widget.id);
            return layout ? { ...widget, layout: { ...widget.layout, ...layout } } : widget;
          }),
        },
      };
      return { ok: true };
    },
  );
}

export function publishDashboard(dashboardId: string) {
  return withRuntimeFallback(
    () => apiClient.post<{ dashboardId: string; publishedAt: string; publishedRevisionId: string }>(
      `/api/dashboards/${encodeURIComponent(dashboardId)}/publish`,
      {},
    ),
    () => {
      const entry = getStoreEntry(dashboardId);
      const publishedAt = new Date().toISOString();
      const revisionId = `rev_published_${Date.now()}`;
      entry.published = {
        ...cloneRuntime(entry.draft),
        dashboard: {
          ...entry.draft.dashboard,
          hasPublishedRevision: true,
          status: "published",
          updatedAt: publishedAt,
        },
        mode: "published",
        revision: {
          id: revisionId,
          kind: "published",
          publishedAt,
          version: (entry.draft.revision?.version ?? 0) + 1,
        },
      };
      entry.draft = {
        ...entry.draft,
        dashboard: {
          ...entry.draft.dashboard,
          hasPublishedRevision: true,
        },
      };
      return { dashboardId, publishedAt, publishedRevisionId: revisionId };
    },
  );
}

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
  datasetId?: string | null;
  title?: string | null;
  type?: DashboardRuntimeWidgetType;
};

function getStoreEntry(dashboardId: string): RuntimeStoreEntry {
  const existing = runtimeStore.get(dashboardId);
  if (existing) return existing;

  const entry = {
    draft: createEmptyRuntime(dashboardId, "draft"),
    published: createEmptyRuntime(dashboardId, "published", { hasPublishedRevision: false, pages: [] }),
  };
  runtimeStore.set(dashboardId, entry);
  return entry;
}

function createEmptyRuntime(
  dashboardId: string,
  mode: DashboardRuntimeMode,
  options: { hasPublishedRevision?: boolean; pages?: DashboardRuntimeResponse["pages"] } = {},
): DashboardRuntimeResponse {
  const now = new Date().toISOString();
  const pages = options.pages ?? [{ id: "page-1", orderIndex: 0, title: "Untitled page" }];
  return {
    dashboard: {
      hasPublishedRevision: options.hasPublishedRevision ?? mode === "published",
      id: dashboardId,
      status: mode === "published" ? "published" : "draft",
      title: dashboardId,
      updatedAt: now,
    },
    filters: [],
    mode,
    pages,
    revision: mode === "draft"
      ? { id: `rev_draft_${dashboardId}`, kind: "draft", version: 1 }
      : null,
    widgetsByPageId: Object.fromEntries(pages.map((page) => [page.id, []])),
  };
}

function createLocalWidget(pageId: string, input: CreateDraftWidgetInput): DashboardRuntimeWidget {
  return {
    config: input.config ?? defaultConfigForType(input.type),
    data: input.data ?? defaultWidgetData(),
    datasetId: input.datasetId,
    id: `widget-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    layout: input.layout,
    pageId,
    queryId: null,
    title: input.title ?? defaultTitleForType(input.type),
    type: input.type,
  } as DashboardRuntimeWidget;
}

function updateLocalWidget(widget: DashboardRuntimeWidget, input: UpdateDraftWidgetInput): DashboardRuntimeWidget {
  return {
    ...widget,
    config: input.config ?? widget.config,
    datasetId: input.datasetId ?? widget.datasetId,
    title: input.title ?? widget.title,
    type: input.type ?? widget.type,
  } as DashboardRuntimeWidget;
}

function defaultConfigForType(type: DashboardRuntimeWidgetType): Record<string, unknown> {
  const color = { paletteId: "asklake-default" };
  if (type === "metric") return { aggregation: "sum", color, format: "number", valueKey: "value" };
  if (type === "table") return { columns: ["label", "value"], limit: 10 };
  if (type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") {
    return { aggregation: "sum", color, labelKey: "label", valueKey: "value" };
  }
  if (type === "radial_bar_chart") {
    return { aggregation: "avg", color, format: "percent", max: 100, min: 0, valueKey: "value" };
  }
  if (type === "heatmap_chart") {
    return { aggregation: "sum", color, valueKey: "value", xKey: "label", yKey: "series" };
  }
  return { aggregation: "sum", color, xKey: "label", yKey: "value" };
}

function defaultTitleForType(type: DashboardRuntimeWidgetType) {
  return {
    area_chart: "영역 차트",
    bar_chart: "막대 차트",
    donut_chart: "도넛 차트",
    heatmap_chart: "히트맵",
    line_chart: "라인 차트",
    metric: "지표",
    pie_chart: "파이 차트",
    radial_bar_chart: "방사형 차트",
    table: "테이블",
    treemap_chart: "트리맵",
  }[type];
}

function defaultWidgetData() {
  return [
    { label: "A", value: 120 },
    { label: "B", value: 86 },
    { label: "C", value: 64 },
  ];
}

function cloneRuntime(runtime: DashboardRuntimeResponse): DashboardRuntimeResponse {
  return JSON.parse(JSON.stringify(runtime)) as DashboardRuntimeResponse;
}
