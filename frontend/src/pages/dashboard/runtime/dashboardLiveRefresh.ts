import type { DashboardDatasetFreshness } from "../../../services/dashboardRuntimeApi";
import type { DashboardSyncMode } from "../../../services/realtimeConfigApi";
import type {
  RealtimeConnectionState,
  RealtimeDatasetEventV2,
  RealtimeEventEnvelope,
} from "../../../services/realtimeEvents";
import type { DashboardRuntimeResponse, DashboardRuntimeWidget } from "../../../types";

export const DASHBOARD_LIVE_REFRESH_DEFAULT_MS = 1_000;
export const DASHBOARD_LIVE_REFRESH_MAX_MS = 60_000;
export const DASHBOARD_LIVE_REFRESH_MIN_MS = 1_000;
export const DASHBOARD_LIVE_CATCH_UP_MS = 250;

export type DashboardLivePollingStrategy = "normal" | "safety" | "suspended";
export type DashboardLiveDataState = "fresh" | "stale" | "degraded";

export type DashboardDatasetCursor = {
  bindingEpoch: number | null;
  engine: string | null;
  eventCursor: number;
  pipelineVersionId: string | null;
  revision: number;
  servingVersionId: string | null;
};

export type DashboardRealtimeRefreshPlan = {
  action: "ignore" | "targeted" | "snapshot";
  nextCursor: DashboardDatasetCursor;
  reason: "binding_changed" | "duplicate" | "mutation_replace" | "pipeline_changed" | "revision_gap" | null;
};

export function planDashboardRealtimeRefresh(
  current: DashboardDatasetCursor | undefined,
  event: RealtimeEventEnvelope,
): DashboardRealtimeRefreshPlan {
  const nextCursor = event.schemaVersion === 2
    ? cursorFromV2Event(event)
    : {
      bindingEpoch: current?.bindingEpoch ?? null,
      engine: current?.engine ?? null,
      eventCursor: event.eventId,
      pipelineVersionId: current?.pipelineVersionId ?? null,
      revision: event.aggregateRevision,
      servingVersionId: current?.servingVersionId ?? null,
    };
  if (event.eventType !== "dataset.revision.committed") {
    return { action: "snapshot", nextCursor, reason: "mutation_replace" };
  }
  if (current && event.eventId <= current.eventCursor) {
    return { action: "ignore", nextCursor: current, reason: "duplicate" };
  }
  if (event.schemaVersion === 2) {
    if (event.payload.mutationType === "replace") {
      return { action: "snapshot", nextCursor, reason: "mutation_replace" };
    }
    if (
      current?.bindingEpoch !== null
      && current?.bindingEpoch !== undefined
      && current.bindingEpoch !== event.payload.bindingEpoch
    ) {
      return { action: "snapshot", nextCursor, reason: "binding_changed" };
    }
    if (
      current?.pipelineVersionId
      && current.pipelineVersionId !== event.payload.pipelineVersionId
    ) {
      return { action: "snapshot", nextCursor, reason: "pipeline_changed" };
    }
  }
  if (current && event.aggregateRevision <= current.revision) {
    return { action: "ignore", nextCursor: current, reason: "duplicate" };
  }
  if (current && event.aggregateRevision > current.revision + 1) {
    return { action: "snapshot", nextCursor, reason: "revision_gap" };
  }
  return { action: "targeted", nextCursor, reason: null };
}

export function dashboardFreshnessRequiresSnapshot(
  current: DashboardDatasetCursor | undefined,
  freshness: DashboardDatasetFreshness,
) {
  if (!current) return false;
  return (
    current.bindingEpoch !== null
    && current.bindingEpoch !== freshness.bindingEpoch
  ) || (
    Boolean(current.engine)
    && current.engine !== freshness.activeServingEngine
  ) || (
    Boolean(current.servingVersionId)
    && current.servingVersionId !== freshness.activeServingVersionId
  ) || freshness.latestRevision < current.revision || (
    freshness.latestMutationType === "replace"
    && freshness.latestRevision > current.revision
  );
}

export function dashboardCursorFromFreshness(
  freshness: DashboardDatasetFreshness,
  current?: DashboardDatasetCursor,
): DashboardDatasetCursor {
  return {
    bindingEpoch: freshness.bindingEpoch,
    engine: freshness.activeServingEngine,
    eventCursor: current?.eventCursor ?? 0,
    pipelineVersionId: current?.pipelineVersionId ?? null,
    revision: freshness.latestRevision,
    servingVersionId: freshness.activeServingVersionId,
  };
}

function cursorFromV2Event(event: RealtimeDatasetEventV2): DashboardDatasetCursor {
  return {
    bindingEpoch: event.payload.bindingEpoch,
    engine: "iceberg",
    eventCursor: event.eventId,
    pipelineVersionId: event.payload.pipelineVersionId,
    revision: event.aggregateRevision,
    servingVersionId: event.payload.servingVersionId,
  };
}

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
      .filter((widget) => (
        widget.liveRefresh === true
        && widget.dataStatus !== "pending"
        && widget.dataStatus !== "loading"
        && Boolean(widget.datasetId)
      ))
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
      if (
        widget.liveRefresh !== true
        || widget.dataStatus === "pending"
        || widget.dataStatus === "loading"
        || !widget.datasetId
      ) return false;
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
