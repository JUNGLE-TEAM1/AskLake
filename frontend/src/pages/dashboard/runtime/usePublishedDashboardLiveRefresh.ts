import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  queryDashboardDatasetFreshness,
  queryPublishedDashboardWidgets,
} from "../../../services/dashboardRuntimeApi";
import type { DashboardDatasetFreshness } from "../../../services/dashboardRuntimeApi";
import {
  getRealtimeFeatureConfig,
  type DashboardSyncMode,
} from "../../../services/realtimeConfigApi";
import {
  coalesceDatasetRevisions,
  dashboardRealtimeEventClient,
  type RealtimeConnectionState,
  type RealtimeEventConnection,
  type RealtimeEventEnvelope,
} from "../../../services/realtimeEvents";
import type { DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";
import {
  DASHBOARD_LIVE_REFRESH_DEFAULT_MS,
  DASHBOARD_LIVE_CATCH_UP_MS,
  dashboardLiveCatchUpDatasetIds,
  dashboardLiveDatasetIds,
  dashboardLivePollingStrategy,
  dashboardLiveRefreshInterval,
  mergePublishedDashboardWidgets,
  staleDashboardWidgetIds,
} from "./dashboardLiveRefresh";


const DASHBOARD_LIVE_REFRESH_REQUEST_TIMEOUT_MS = 10_000;
const REALTIME_EVENT_COALESCE_MS = 50;


export function usePublishedDashboardLiveRefresh({
  active,
  dashboardId,
  mode,
  publishedRuntime,
  reloadPublishedRuntime,
  setPublishedRuntime,
}: {
  active: boolean;
  dashboardId: string;
  mode: DashboardRuntimeMode;
  publishedRuntime: DashboardRuntimeResponse | null;
  reloadPublishedRuntime: (
    dashboardId: string,
    options?: { silent?: boolean },
  ) => Promise<DashboardRuntimeResponse | null>;
  setPublishedRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
}) {
  const [realtimeConnectionState, setRealtimeConnectionState] = useState<RealtimeConnectionState>("closed");
  const runtimeRef = useRef(publishedRuntime);
  runtimeRef.current = publishedRuntime;

  const liveDatasetIds = useMemo(
    () => dashboardLiveDatasetIds(publishedRuntime, dashboardId),
    [dashboardId, publishedRuntime],
  );
  const liveDatasetIdsKey = JSON.stringify(liveDatasetIds);

  useEffect(() => {
    if (!active || mode !== "published" || liveDatasetIds.length === 0) {
      setRealtimeConnectionState("closed");
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let eventRefreshInFlight = false;
    let timer: number | undefined;
    let eventFlushTimer: number | undefined;
    let requestController: AbortController | null = null;
    let eventRequestController: AbortController | null = null;
    let syncMode: DashboardSyncMode = "polling";
    let connectionState: RealtimeConnectionState = "closed";
    let heartbeatTimeoutMs = 45_000;
    let reconnectRetryMs = 3_000;
    let safetyPollAfterMs = 60_000;
    let realtimeConnection: RealtimeEventConnection | null = null;
    let snapshotResyncInFlight = false;
    const pendingRealtimeEvents = new Map<string, RealtimeEventEnvelope>();
    const eligibleDatasetIds = new Set(liveDatasetIds);
    const nextCheckAtByDatasetId = new Map(
      liveDatasetIds.map((datasetId) => [datasetId, Date.now()]),
    );

    const clearTimer = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const clearEventFlushTimer = () => {
      if (eventFlushTimer === undefined) return;
      window.clearTimeout(eventFlushTimer);
      eventFlushTimer = undefined;
    };

    const pollingStrategy = () => dashboardLivePollingStrategy(syncMode, connectionState);

    const scheduleNextPoll = () => {
      clearTimer();
      if (
        cancelled
        || document.visibilityState === "hidden"
        || eligibleDatasetIds.size === 0
        || pollingStrategy() === "suspended"
      ) {
        return;
      }
      const now = Date.now();
      const nextCheckAt = Math.min(...Array.from(eligibleDatasetIds).map(
        (datasetId) => nextCheckAtByDatasetId.get(datasetId) ?? now,
      ));
      timer = window.setTimeout(() => {
        timer = undefined;
        void poll();
      }, Math.max(0, nextCheckAt - now));
    };

    const scheduleRealtimeFlush = (delayMs = REALTIME_EVENT_COALESCE_MS) => {
      clearEventFlushTimer();
      if (
        cancelled
        || document.visibilityState === "hidden"
        || pendingRealtimeEvents.size === 0
      ) {
        return;
      }
      eventFlushTimer = window.setTimeout(() => {
        eventFlushTimer = undefined;
        void flushRealtimeEvents();
      }, delayMs);
    };

    const enqueueRealtimeEvent = (
      event: RealtimeEventEnvelope,
      delayMs = REALTIME_EVENT_COALESCE_MS,
    ) => {
      const current = pendingRealtimeEvents.get(event.resourceId);
      if (
        !current
        || event.aggregateRevision > current.aggregateRevision
        || (
          event.aggregateRevision === current.aggregateRevision
          && event.eventId > current.eventId
        )
      ) {
        pendingRealtimeEvents.set(event.resourceId, event);
      }
      scheduleRealtimeFlush(delayMs);
    };

    const updateRuntimeEventCursor = (eventCursor: number) => {
      setPublishedRuntime((current) => {
        if (!current) return current;
        const nextCursor = Math.max(current.eventCursor ?? 0, eventCursor);
        if (nextCursor === current.eventCursor) return current;
        const updated = { ...current, eventCursor: nextCursor };
        runtimeRef.current = updated;
        return updated;
      });
    };

    async function refreshDatasetFromEvent(event: RealtimeEventEnvelope) {
      if (cancelled || document.visibilityState === "hidden") {
        enqueueRealtimeEvent(event);
        return;
      }
      const freshness: DashboardDatasetFreshness[] = [{
        datasetId: event.resourceId,
        isContinuous: true,
        latestRevision: event.aggregateRevision,
        nextCheckAfterMs: DASHBOARD_LIVE_REFRESH_DEFAULT_MS,
        updatedAt: event.occurredAt,
      }];
      const staleWidgetIds = staleDashboardWidgetIds(runtimeRef.current, freshness);
      if (staleWidgetIds.length === 0) {
        updateRuntimeEventCursor(event.eventId);
        return;
      }

      const controller = new AbortController();
      eventRequestController = controller;
      const previousRuntime = runtimeRef.current;
      try {
        const widgetResponse = await queryPublishedDashboardWidgets(
          dashboardId,
          staleWidgetIds,
          {
            signal: controller.signal,
            timeoutMs: DASHBOARD_LIVE_REFRESH_REQUEST_TIMEOUT_MS,
          },
        );
        if (cancelled || controller.signal.aborted) return;
        const refreshedWidgets = Array.isArray(widgetResponse.widgets)
          ? widgetResponse.widgets
          : [];
        const needsCatchUp = dashboardLiveCatchUpDatasetIds(
          previousRuntime,
          refreshedWidgets,
          freshness,
        ).includes(event.resourceId);
        setPublishedRuntime((current) => {
          const merged = mergePublishedDashboardWidgets(current, dashboardId, refreshedWidgets);
          if (!merged) return merged;
          const updated = {
            ...merged,
            eventCursor: Math.max(merged.eventCursor ?? 0, event.eventId),
          };
          runtimeRef.current = updated;
          return updated;
        });
        if (needsCatchUp) {
          enqueueRealtimeEvent(event, DASHBOARD_LIVE_CATCH_UP_MS);
        }
      } catch {
        // Keep the last successful result and retry the canonical REST read.
        // The per-dataset map bounds memory while the endpoint is unavailable.
        if (!cancelled && !controller.signal.aborted) {
          enqueueRealtimeEvent(event, DASHBOARD_LIVE_REFRESH_DEFAULT_MS);
        }
      } finally {
        if (eventRequestController === controller) eventRequestController = null;
      }
    }

    async function flushRealtimeEvents() {
      if (
        cancelled
        || document.visibilityState === "hidden"
        || eventRefreshInFlight
        || pendingRealtimeEvents.size === 0
      ) {
        return;
      }
      eventRefreshInFlight = true;
      const queuedEvents = Array.from(pendingRealtimeEvents.values());
      pendingRealtimeEvents.clear();
      const coalesced = coalesceDatasetRevisions(queuedEvents);
      try {
        for (const [datasetId, target] of coalesced.entries()) {
          if (cancelled) return;
          const event = queuedEvents.find((candidate) => (
            candidate.resourceId === datasetId
            && candidate.eventId === target.eventCursor
          ));
          if (event) await refreshDatasetFromEvent(event);
        }
      } finally {
        eventRefreshInFlight = false;
        if (pendingRealtimeEvents.size > 0) scheduleRealtimeFlush();
      }
    }

    async function refreshDueDatasets(
      dueDatasetIds: string[],
      controller: AbortController,
    ) {
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
      const strategy = pollingStrategy();
      dueDatasetIds.forEach((datasetId) => {
        const freshness = freshnessByDatasetId.get(datasetId);
        if (freshness && !freshness.isContinuous) {
          eligibleDatasetIds.delete(datasetId);
          nextCheckAtByDatasetId.delete(datasetId);
          return;
        }
        const normalInterval = dashboardLiveRefreshInterval(
          freshness?.nextCheckAfterMs,
          datasetId,
        );
        nextCheckAtByDatasetId.set(
          datasetId,
          scheduledAt + (strategy === "safety"
            ? Math.max(normalInterval, safetyPollAfterMs)
            : normalInterval),
        );
      });
      const staleWidgetIds = staleDashboardWidgetIds(runtimeRef.current, freshnessDatasets);
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
    }

    async function poll() {
      if (cancelled || document.visibilityState === "hidden" || pollingStrategy() === "suspended") return;
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
        await refreshDueDatasets(dueDatasetIds, controller);
      } finally {
        if (requestController === controller) requestController = null;
        inFlight = false;
        scheduleNextPoll();
      }
    }

    const markPollingDueNow = () => {
      const now = Date.now();
      eligibleDatasetIds.forEach((datasetId) => nextCheckAtByDatasetId.set(datasetId, now));
    };

    const handleConnectionState = (state: RealtimeConnectionState) => {
      if (cancelled) return;
      connectionState = state;
      setRealtimeConnectionState(state);
      clearTimer();
      if (state === "open") {
        if (syncMode === "hybrid") {
          const safetyAt = Date.now() + safetyPollAfterMs;
          eligibleDatasetIds.forEach((datasetId) => nextCheckAtByDatasetId.set(datasetId, safetyAt));
        }
      } else if (state !== "closed") {
        markPollingDueNow();
      }
      scheduleNextPoll();
    };

    const connectRealtime = () => {
      realtimeConnection = dashboardRealtimeEventClient.connect({
        cursor: Math.max(0, runtimeRef.current?.eventCursor ?? 0),
        dashboardId,
        datasetIds: liveDatasetIds,
        heartbeatTimeoutMs,
        onEvent: (event) => {
          if (cancelled) return;
          if (event.eventType === "dashboard.published") {
            if (event.resourceId === dashboardId) void resyncFromSnapshot();
            return;
          }
          if (!eligibleDatasetIds.has(event.resourceId)) return;
          enqueueRealtimeEvent(event);
        },
        onInvalidEvent: () => {
          // Invalid/unknown events are ignored. Safety or fallback polling
          // remains the canonical recovery path.
        },
        onResyncRequired: () => {
          void resyncFromSnapshot();
        },
        onStateChange: handleConnectionState,
        reconnectRetryMs,
      });
    };

    async function resyncFromSnapshot() {
      if (cancelled || snapshotResyncInFlight) return;
      snapshotResyncInFlight = true;
      try {
        const runtime = await reloadPublishedRuntime(dashboardId, { silent: true });
        if (cancelled || !runtime) {
          markPollingDueNow();
          scheduleNextPoll();
          return;
        }
        runtimeRef.current = runtime;
        realtimeConnection?.restart(Math.max(0, runtime.eventCursor ?? 0));
      } finally {
        snapshotResyncInFlight = false;
      }
    }

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "hidden") {
        requestController?.abort();
        eventRequestController?.abort();
        return;
      }
      if (pendingRealtimeEvents.size > 0) scheduleRealtimeFlush();
      if (pollingStrategy() !== "suspended") {
        markPollingDueNow();
        void poll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextPoll();

    void getRealtimeFeatureConfig()
      .then((config) => {
        if (cancelled) return;
        syncMode = config.dashboardSyncMode;
        heartbeatTimeoutMs = Math.max(10_000, config.heartbeatSeconds * 3_000);
        reconnectRetryMs = Math.max(1_000, config.reconnectRetryMs || 3_000);
        safetyPollAfterMs = Math.max(10_000, config.safetyPollAfterMs || 60_000);
        if (config.realtimeEventsEnabled && syncMode !== "polling") {
          connectRealtime();
          return;
        }
        connectionState = "closed";
        setRealtimeConnectionState("closed");
        scheduleNextPoll();
      })
      .catch(() => {
        if (cancelled) return;
        syncMode = "polling";
        connectionState = "fallback_polling";
        setRealtimeConnectionState("fallback_polling");
        scheduleNextPoll();
      });

    return () => {
      cancelled = true;
      clearTimer();
      clearEventFlushTimer();
      requestController?.abort();
      eventRequestController?.abort();
      realtimeConnection?.close();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    active,
    dashboardId,
    liveDatasetIdsKey,
    mode,
    reloadPublishedRuntime,
    setPublishedRuntime,
  ]);

  return realtimeConnectionState;
}
