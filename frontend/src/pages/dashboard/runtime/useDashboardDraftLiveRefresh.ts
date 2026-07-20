import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { queryDashboardDatasetFreshness, queryDashboardWidgets } from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeResponse } from "../../../types";
import {
  dashboardCursorFromFreshness,
  dashboardLiveDatasetIds,
  dashboardLiveRefreshInterval,
  mergePublishedDashboardWidgets,
  staleDashboardWidgetIds,
  type DashboardDatasetCursor,
  type DashboardLiveDataState,
} from "./dashboardLiveRefresh";

const REQUEST_TIMEOUT_MS = 10_000;

/** Refreshes only server-calculated widget data; the draft's config and layout stay local. */
export function useDashboardDraftLiveRefresh({
  active, dashboardId, runtime, setRuntime,
}: {
  active: boolean;
  dashboardId: string;
  runtime: DashboardRuntimeResponse | null;
  setRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
}) {
  const [realtimeDataState, setRealtimeDataState] = useState<DashboardLiveDataState>("fresh");
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const datasetIds = useMemo(() => dashboardLiveDatasetIds(runtime, dashboardId), [dashboardId, runtime]);
  const datasetIdsKey = JSON.stringify(datasetIds);

  useEffect(() => {
    if (!active || datasetIds.length === 0) {
      setRealtimeDataState("fresh");
      return undefined;
    }
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let inFlight = false;
    const cursors = new Map<string, DashboardDatasetCursor>();
    const nextCheckAt = new Map(datasetIds.map((datasetId) => [datasetId, Date.now()]));

    const schedule = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      if (timer !== undefined) window.clearTimeout(timer);
      const now = Date.now();
      const next = Math.min(...datasetIds.map((id) => nextCheckAt.get(id) ?? now));
      timer = window.setTimeout(() => { timer = undefined; void poll(); }, Math.max(0, next - now));
    };
    const poll = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      const now = Date.now();
      const due = datasetIds.filter((id) => (nextCheckAt.get(id) ?? now) <= now);
      if (!due.length) { schedule(); return; }
      inFlight = true;
      const request = new AbortController();
      controller = request;
      try {
        const { datasets } = await queryDashboardDatasetFreshness(due, { signal: request.signal, timeoutMs: REQUEST_TIMEOUT_MS });
        if (cancelled || request.signal.aborted) return;
        const scheduledAt = Date.now();
        datasets.forEach((dataset) => nextCheckAt.set(
          dataset.datasetId,
          scheduledAt + dashboardLiveRefreshInterval(dataset.nextCheckAfterMs, dataset.datasetId),
        ));
        const widgetIds = staleDashboardWidgetIds(runtimeRef.current, datasets);
        if (!widgetIds.length) {
          datasets.forEach((dataset) => cursors.set(dataset.datasetId, dashboardCursorFromFreshness(dataset, cursors.get(dataset.datasetId))));
          setRealtimeDataState("fresh");
          return;
        }
        setRealtimeDataState("stale");
        const response = await queryDashboardWidgets(dashboardId, "draft", widgetIds, { signal: request.signal, timeoutMs: REQUEST_TIMEOUT_MS });
        if (cancelled || request.signal.aborted) return;
        setRuntime((current) => {
          const updated = mergePublishedDashboardWidgets(current, dashboardId, response.widgets ?? []);
          runtimeRef.current = updated;
          return updated;
        });
        datasets.forEach((dataset) => cursors.set(dataset.datasetId, dashboardCursorFromFreshness(dataset, cursors.get(dataset.datasetId))));
        setRealtimeDataState("fresh");
      } catch {
        if (!cancelled && !request.signal.aborted) setRealtimeDataState("degraded");
        due.forEach((datasetId) => nextCheckAt.set(datasetId, Date.now() + 1_000));
      } finally {
        if (controller === request) controller = null;
        inFlight = false;
        schedule();
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") { controller?.abort(); return; }
      datasetIds.forEach((id) => nextCheckAt.set(id, Date.now()));
      void poll();
    };
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [active, dashboardId, datasetIdsKey, setRuntime]);

  return { realtimeDataState };
}
