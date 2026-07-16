import type { DashboardDatasetFreshness } from "../../../services/dashboardRuntimeApi";
import type { DashboardSyncMode } from "../../../services/realtimeConfigApi";
import type { RealtimeConnectionState } from "../../../services/realtimeEvents";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../../../types";

export const DASHBOARD_LIVE_REFRESH_DEFAULT_MS = 1_000;
export const DASHBOARD_LIVE_REFRESH_MAX_MS = 60_000;
export const DASHBOARD_LIVE_REFRESH_MIN_MS = 1_000;
export const DASHBOARD_LIVE_CATCH_UP_MS = 250;

export type DashboardLivePollingStrategy = "normal" | "safety" | "suspended";

export function dashboardLivePollingStrategy(
  syncMode: DashboardSyncMode,
  connectionState: RealtimeConnectionState,
): DashboardLivePollingStrategy {
  if (connectionState !== "open" || syncMode === "polling") return "normal";
  return syncMode === "sse" ? "suspended" : "safety";
}

export function dashboardLiveRefreshInterval(
  value: number | null | undefined,
  jitterKey = "",
) {
  const interval = typeof value === "number" && Number.isFinite(value)
    ? value
    : DASHBOARD_LIVE_REFRESH_DEFAULT_MS;
  const jitterRatio = jitterKey
    ? (Array.from(jitterKey).reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0) % 101) / 1_000
    : 0;
  return Math.min(
    DASHBOARD_LIVE_REFRESH_MAX_MS,
    Math.max(DASHBOARD_LIVE_REFRESH_MIN_MS, Math.round(interval * (1 + jitterRatio))),
  );
}

export function dashboardLiveDatasetIds(
  runtime: DashboardRuntimeResponse | null,
  dashboardId: string,
) {
  if (
    !runtime
    || runtime.dashboard.id !== dashboardId
    || runtime.mode !== "published"
    || !runtime.revision
  ) {
    return [];
  }

  return Array.from(new Set(
    Object.values(runtime.widgetsByPageId)
      .flat()
      .filter((widget) => widget.liveRefresh === true && Boolean(widget.datasetId))
      .map((widget) => widget.datasetId as string),
  )).sort();
}

export function staleDashboardWidgetIds(
  runtime: DashboardRuntimeResponse | null,
  freshness: DashboardDatasetFreshness[],
) {
  if (!runtime || runtime.mode !== "published") return [];

  const latestRevisionByDatasetId = new Map(
    freshness
      .filter((dataset) => dataset.isContinuous)
      .map((dataset) => [dataset.datasetId, dataset.latestRevision] as const),
  );

  return Object.values(runtime.widgetsByPageId)
    .flat()
    .filter((widget) => {
      if (widget.liveRefresh !== true || !widget.datasetId) return false;
      const latestRevision = latestRevisionByDatasetId.get(widget.datasetId);
      if (latestRevision === undefined || !Number.isFinite(latestRevision)) return false;
      const appliedRevision = typeof widget.appliedRevision === "number" && Number.isFinite(widget.appliedRevision)
        ? widget.appliedRevision
        : 0;
      return latestRevision > appliedRevision;
    })
    .map((widget) => widget.id);
}

export function mergePublishedDashboardWidgets(
  runtime: DashboardRuntimeResponse | null,
  dashboardId: string,
  refreshedWidgets: DashboardRuntimeWidget[],
) {
  if (!runtime || runtime.dashboard.id !== dashboardId || refreshedWidgets.length === 0) return runtime;

  const refreshedById = new Map(refreshedWidgets.map((widget) => [widget.id, widget]));
  let changed = false;
  const widgetsByPageId = Object.fromEntries(
    Object.entries(runtime.widgetsByPageId).map(([pageId, widgets]) => [
      pageId,
      widgets.map((widget) => {
        const refreshed = refreshedById.get(widget.id);
        if (!refreshed) return widget;
        changed = true;
        return { ...widget, ...refreshed } as DashboardRuntimeWidget;
      }),
    ]),
  );

  return changed ? { ...runtime, widgetsByPageId } : runtime;
}

export function dashboardLiveCatchUpDatasetIds(
  currentRuntime: DashboardRuntimeResponse | null,
  refreshedWidgets: DashboardRuntimeWidget[],
  freshness: DashboardDatasetFreshness[],
) {
  const latestRevisionByDatasetId = new Map(
    freshness
      .filter((dataset) => dataset.isContinuous)
      .map((dataset) => [dataset.datasetId, dataset.latestRevision] as const),
  );
  const previousWidgetById = new Map(
    Object.values(currentRuntime?.widgetsByPageId ?? {})
      .flat()
      .map((widget) => [widget.id, widget] as const),
  );

  return Array.from(new Set(
    refreshedWidgets
      .filter((widget) => {
        if (!widget.datasetId || !currentRuntime) return false;
        const latestRevision = latestRevisionByDatasetId.get(widget.datasetId);
        const appliedRevision = typeof widget.appliedRevision === "number"
          ? widget.appliedRevision
          : 0;
        const previousWidget = previousWidgetById.get(widget.id);
        const previousRevision = typeof previousWidget?.appliedRevision === "number"
          ? previousWidget.appliedRevision
          : 0;
        return (
          typeof latestRevision === "number"
          && latestRevision > appliedRevision
          && appliedRevision > previousRevision
        );
      })
      .map((widget) => widget.datasetId as string),
  ));
}
