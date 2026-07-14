import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  queryDashboardDatasetFreshness,
  queryPublishedDashboardWidgets,
} from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";
import {
  DASHBOARD_LIVE_REFRESH_DEFAULT_MS,
  DASHBOARD_LIVE_CATCH_UP_MS,
  dashboardLiveCatchUpDatasetIds,
  dashboardLiveDatasetIds,
  dashboardLiveRefreshInterval,
  mergePublishedDashboardWidgets,
  staleDashboardWidgetIds,
} from "./dashboardLiveRefresh";

const DASHBOARD_LIVE_REFRESH_REQUEST_TIMEOUT_MS = 10_000;

export function usePublishedDashboardLiveRefresh({
  active,
  dashboardId,
  mode,
  publishedRuntime,
  setPublishedRuntime,
}: {
  active: boolean;
  dashboardId: string;
  mode: DashboardRuntimeMode;
  publishedRuntime: DashboardRuntimeResponse | null;
  setPublishedRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
}) {
  const runtimeRef = useRef(publishedRuntime);
  runtimeRef.current = publishedRuntime;

  const liveDatasetIds = useMemo(
    () => dashboardLiveDatasetIds(publishedRuntime, dashboardId),
    [dashboardId, publishedRuntime],
  );
  const liveDatasetIdsKey = JSON.stringify(liveDatasetIds);

  useEffect(() => {
    if (!active || mode !== "published" || liveDatasetIds.length === 0) return;

    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;
    let requestController: AbortController | null = null;
    const eligibleDatasetIds = new Set(liveDatasetIds);
    const nextCheckAtByDatasetId = new Map(
      liveDatasetIds.map((datasetId) => [datasetId, Date.now()]),
    );

    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const scheduleNextPoll = () => {
      clearTimer();
      if (cancelled || document.visibilityState === "hidden" || eligibleDatasetIds.size === 0) return;
      const now = Date.now();
      const nextCheckAt = Math.min(...Array.from(eligibleDatasetIds).map(
        (datasetId) => nextCheckAtByDatasetId.get(datasetId) ?? now,
      ));
      timer = window.setTimeout(() => {
        timer = undefined;
        void poll();
      }, Math.max(0, nextCheckAt - now));
    };

    async function poll() {
      if (cancelled || document.visibilityState === "hidden") return;
      if (inFlight) {
        clearTimer();
        timer = window.setTimeout(() => {
          timer = undefined;
          void poll();
        }, 50);
        return;
      }

      const now = Date.now();
      const dueDatasetIds = Array.from(eligibleDatasetIds).filter(
        (datasetId) => (nextCheckAtByDatasetId.get(datasetId) ?? now) <= now,
      );
      if (dueDatasetIds.length === 0) {
        scheduleNextPoll();
        return;
      }

      inFlight = true;
      const controller = new AbortController();
      requestController = controller;

      try {
        let freshnessResponse;
        try {
          freshnessResponse = await queryDashboardDatasetFreshness(dueDatasetIds, {
            signal: controller.signal,
            timeoutMs: DASHBOARD_LIVE_REFRESH_REQUEST_TIMEOUT_MS,
          });
        } catch {
          if (!cancelled && !controller.signal.aborted) {
            const retryAt = Date.now() + DASHBOARD_LIVE_REFRESH_DEFAULT_MS;
            dueDatasetIds.forEach((datasetId) => nextCheckAtByDatasetId.set(datasetId, retryAt));
          }
          return;
        }

        if (cancelled || controller.signal.aborted) return;
        const freshnessDatasets = Array.isArray(freshnessResponse.datasets)
          ? freshnessResponse.datasets
          : [];
        const freshnessByDatasetId = new Map(
          freshnessDatasets.map((dataset) => [dataset.datasetId, dataset]),
        );
        const scheduledAt = Date.now();

        dueDatasetIds.forEach((datasetId) => {
          const freshness = freshnessByDatasetId.get(datasetId);
          if (freshness && !freshness.isContinuous) {
            eligibleDatasetIds.delete(datasetId);
            nextCheckAtByDatasetId.delete(datasetId);
            return;
          }
          nextCheckAtByDatasetId.set(
            datasetId,
            scheduledAt + dashboardLiveRefreshInterval(freshness?.nextCheckAfterMs, datasetId),
          );
        });

        const staleWidgetIds = staleDashboardWidgetIds(
          runtimeRef.current,
          freshnessDatasets,
        );
        if (staleWidgetIds.length === 0) return;

        try {
          const widgetResponse = await queryPublishedDashboardWidgets(dashboardId, staleWidgetIds, {
            signal: controller.signal,
            timeoutMs: DASHBOARD_LIVE_REFRESH_REQUEST_TIMEOUT_MS,
          });
          if (cancelled || controller.signal.aborted) return;
          const refreshedWidgets = Array.isArray(widgetResponse.widgets) ? widgetResponse.widgets : [];
          const catchUpAt = Date.now() + DASHBOARD_LIVE_CATCH_UP_MS;
          dashboardLiveCatchUpDatasetIds(runtimeRef.current, refreshedWidgets, freshnessDatasets)
            .forEach((datasetId) => nextCheckAtByDatasetId.set(datasetId, catchUpAt));
          setPublishedRuntime((current) => {
            const merged = mergePublishedDashboardWidgets(current, dashboardId, refreshedWidgets);
            runtimeRef.current = merged;
            return merged;
          });
        } catch {
          // Background refresh keeps the last successfully rendered widget result.
        }
      } finally {
        if (requestController === controller) requestController = null;
        inFlight = false;
        scheduleNextPoll();
      }
    }

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "hidden") {
        requestController?.abort();
        return;
      }
      const now = Date.now();
      eligibleDatasetIds.forEach((datasetId) => nextCheckAtByDatasetId.set(datasetId, now));
      void poll();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextPoll();

    return () => {
      cancelled = true;
      clearTimer();
      requestController?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, dashboardId, liveDatasetIdsKey, mode, setPublishedRuntime]);
}
