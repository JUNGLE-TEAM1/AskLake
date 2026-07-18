import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../../../types";

export type DashboardWidgetDataRequest = {
  key: string;
  signatures: Record<string, string>;
  widgetIds: string[];
};

export function dashboardWidgetDataSignature(widget: DashboardRuntimeWidget) {
  const runtimeConfig = widget.config as Record<string, unknown>;
  const sourceConfig = runtimeConfig.sourceConfig;
  const editableConfig = sourceConfig && typeof sourceConfig === "object" && !Array.isArray(sourceConfig)
    ? sourceConfig
    : Object.fromEntries(
      Object.entries(runtimeConfig).filter(([key]) => ![
        "dataMode",
        "error",
        "errorMessage",
        "sourceConfig",
      ].includes(key)),
    );
  return JSON.stringify({
    config: editableConfig,
    datasetId: widget.datasetId ?? null,
    type: widget.type,
  });
}

export function dashboardWidgetDataRequests(
  runtime: DashboardRuntimeResponse | null,
  pageId: string | null,
): DashboardWidgetDataRequest[] {
  if (!runtime || !pageId) return [];
  const grouped = new Map<string, DashboardRuntimeWidget[]>();
  for (const widget of runtime.widgetsByPageId[pageId] ?? []) {
    if (widget.dataStatus !== "pending" && widget.dataStatus !== "loading") continue;
    const groupKey = widget.datasetId ? `dataset:${widget.datasetId}` : `widget:${widget.id}`;
    grouped.set(groupKey, [...(grouped.get(groupKey) ?? []), widget]);
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, widgets]) => ({
      key,
      signatures: Object.fromEntries(
        widgets.map((widget) => [widget.id, dashboardWidgetDataSignature(widget)]),
      ),
      widgetIds: widgets.map((widget) => widget.id).sort(),
    }));
}

export function dashboardWidgetDataSelectionKey(
  runtime: DashboardRuntimeResponse | null,
  pageId: string | null,
) {
  if (!runtime || !pageId) return "[]";
  return JSON.stringify(
    (runtime.widgetsByPageId[pageId] ?? [])
      .filter((widget) => Boolean(widget.datasetId))
      .map((widget) => [widget.id, dashboardWidgetDataSignature(widget)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function setDashboardWidgetDataStatus(
  runtime: DashboardRuntimeResponse | null,
  widgetIds: string[],
  dataStatus: "pending" | "loading" | "error",
  dataError: string | null = null,
  expectedSignatures: Record<string, string> = {},
) {
  if (!runtime || widgetIds.length === 0) return runtime;
  const targetIds = new Set(widgetIds);
  let changed = false;
  let widgetsByPageId = runtime.widgetsByPageId;
  for (const [pageId, widgets] of Object.entries(runtime.widgetsByPageId)) {
    let pageChanged = false;
    const nextWidgets = widgets.map((widget) => {
        if (!targetIds.has(widget.id)) return widget;
        const expectedSignature = expectedSignatures[widget.id];
        if (expectedSignature && dashboardWidgetDataSignature(widget) !== expectedSignature) return widget;
        changed = true;
        pageChanged = true;
        return { ...widget, dataError, dataStatus } as DashboardRuntimeWidget;
      });
    if (pageChanged) {
      if (widgetsByPageId === runtime.widgetsByPageId) widgetsByPageId = { ...runtime.widgetsByPageId };
      widgetsByPageId[pageId] = nextWidgets;
    }
  }
  return changed ? { ...runtime, widgetsByPageId } : runtime;
}

export function mergeDashboardWidgetData(
  runtime: DashboardRuntimeResponse | null,
  dashboardId: string,
  widgets: DashboardRuntimeWidget[],
  expectedSignatures: Record<string, string>,
) {
  if (!runtime || runtime.dashboard.id !== dashboardId || widgets.length === 0) return runtime;
  const refreshedById = new Map(widgets.map((widget) => [widget.id, widget]));
  let changed = false;
  let widgetsByPageId = runtime.widgetsByPageId;
  for (const [pageId, currentWidgets] of Object.entries(runtime.widgetsByPageId)) {
    let pageChanged = false;
    const nextWidgets = currentWidgets.map((widget) => {
        const refreshed = refreshedById.get(widget.id);
        if (!refreshed) return widget;
        if (dashboardWidgetDataSignature(widget) !== expectedSignatures[widget.id]) return widget;
        changed = true;
        pageChanged = true;
        return refreshed;
      });
    if (pageChanged) {
      if (widgetsByPageId === runtime.widgetsByPageId) widgetsByPageId = { ...runtime.widgetsByPageId };
      widgetsByPageId[pageId] = nextWidgets;
    }
  }
  return changed ? { ...runtime, widgetsByPageId } : runtime;
}
