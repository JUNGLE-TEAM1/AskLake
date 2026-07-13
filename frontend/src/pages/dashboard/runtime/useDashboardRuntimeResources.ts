import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureDraftDashboard,
  getPublishedDashboard,
  getPublishedDashboardData,
} from "../../../services/dashboardRuntimeApi";
import type {
  DashboardPublishedDataRefreshScope,
  DashboardPublishedDataResponse,
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
} from "../../../types";
import { ApiError } from "../../../types";
import {
  DEFAULT_DASHBOARD_SYNC_INTERVAL_MINUTES,
  MAX_DASHBOARD_SYNC_INTERVAL_MINUTES,
  MIN_DASHBOARD_SYNC_INTERVAL_MINUTES,
} from "../../../types/etl";

const MINUTES_TO_MILLISECONDS = 60_000;

export type DashboardPublishedRefreshStatus = "idle" | "refreshing" | "live" | "manual" | "paused" | "error";

function normalizeAutoRefreshIntervalMinutes(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(
    MAX_DASHBOARD_SYNC_INTERVAL_MINUTES,
    Math.max(MIN_DASHBOARD_SYNC_INTERVAL_MINUTES, Math.round(value)),
  );
}

function mergePublishedWidgetData(
  runtime: DashboardRuntimeResponse,
  response: DashboardPublishedDataResponse,
) {
  if (runtime.dashboard.id !== response.dashboardId || runtime.revision?.id !== response.revisionId) {
    return runtime;
  }

  const refreshByWidgetId = new Map(response.widgets.map((widget) => [widget.widgetId, widget]));
  let changed = false;
  const widgetsByPageId = Object.fromEntries(
    Object.entries(runtime.widgetsByPageId).map(([pageId, widgets]) => [
      pageId,
      widgets.map((widget) => {
        const refresh = refreshByWidgetId.get(widget.id);
        if (!refresh || JSON.stringify(widget.data) === JSON.stringify(refresh.data)) return widget;
        changed = true;
        return { ...widget, data: refresh.data };
      }),
    ]),
  ) as DashboardRuntimeResponse["widgetsByPageId"];

  return changed ? { ...runtime, widgetsByPageId } : runtime;
}

export function useDashboardRuntimeResources({
  active,
  dashboardId,
  mode,
}: {
  active: boolean;
  dashboardId: string;
  mode: DashboardRuntimeMode;
}) {
  const [publishedRuntime, setPublishedRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>("page-1");
  const [publishedRefreshError, setPublishedRefreshError] = useState<string | null>(null);
  const [publishedRefreshStatus, setPublishedRefreshStatus] = useState<DashboardPublishedRefreshStatus>("idle");
  const [publishedRefreshedAt, setPublishedRefreshedAt] = useState<string | null>(null);
  const [publishedAutoRefreshIntervalMinutes, setPublishedAutoRefreshIntervalMinutes] = useState<number | null>(null);
  const refreshScopeRef = useRef("");
  const refreshRequestRef = useRef<{
    activeScope: string;
    promise: Promise<DashboardPublishedDataResponse | null>;
    requestKey: string;
  } | null>(null);
  const publishedRuntimeScopeRef = useRef("");
  const publishedRuntimeRequestRef = useRef<{
    promise: Promise<DashboardRuntimeResponse | null>;
    scope: string;
  } | null>(null);
  const publishedRuntimeRequestSequenceRef = useRef(0);
  const publishedRuntimeCommitRequestRef = useRef(0);
  const publishedRefreshRetryableRef = useRef(true);
  const publishedAutoRefreshIntervalMinutesRef = useRef<number | null>(DEFAULT_DASHBOARD_SYNC_INTERVAL_MINUTES);
  const publishedScheduleNextRefreshRef = useRef<(() => void) | null>(null);

  const selectPageFromResponse = useCallback((runtime: DashboardRuntimeResponse) => {
    const requestedPageId = new URLSearchParams(window.location.search).get("page");
    const requestedPageExists = requestedPageId && runtime.pages.some((page) => page.id === requestedPageId);
    const fallbackPageId = requestedPageExists ? requestedPageId : runtime.pages[0]?.id ?? null;

    setSelectedPageId((currentPageId) => {
      if (currentPageId && runtime.pages.some((page) => page.id === currentPageId)) {
        return currentPageId;
      }
      return fallbackPageId;
    });
  }, []);

  const loadPublishedRuntime = useCallback((
    nextDashboardId: string,
    options: { silent?: boolean } = {},
  ): Promise<DashboardRuntimeResponse | null> => {
    const scope = nextDashboardId;
    const existingRequest = publishedRuntimeRequestRef.current;
    if (existingRequest?.scope === scope) return existingRequest.promise;

    if (!options.silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }
    const requestId = publishedRuntimeRequestSequenceRef.current + 1;
    publishedRuntimeRequestSequenceRef.current = requestId;
    publishedRuntimeCommitRequestRef.current = requestId;

    const promise = getPublishedDashboard(nextDashboardId)
      .then((runtime) => {
        if (
          publishedRuntimeScopeRef.current !== scope
          || publishedRuntimeCommitRequestRef.current !== requestId
        ) return null;
        setPublishedRuntime(runtime);
        setRuntimeError(null);
        selectPageFromResponse(runtime);
        return runtime;
      })
      .catch((error: unknown) => {
        if (
          publishedRuntimeScopeRef.current !== scope
          || publishedRuntimeCommitRequestRef.current !== requestId
        ) return null;
        const message = error instanceof Error ? error.message : "Failed to load the published dashboard.";
        if (options.silent) {
          setPublishedRefreshError(message);
          setPublishedRefreshStatus("error");
        } else {
          setPublishedRuntime(null);
          setRuntimeError(message);
        }
        return null;
      })
      .finally(() => {
        if (publishedRuntimeRequestRef.current?.promise === promise) {
          publishedRuntimeRequestRef.current = null;
        }
        if (
          !options.silent
          && publishedRuntimeScopeRef.current === scope
          && publishedRuntimeCommitRequestRef.current === requestId
        ) {
          setRuntimeLoading(false);
        }
      });

    publishedRuntimeRequestRef.current = { promise, scope };
    return promise;
  }, [selectPageFromResponse]);

  const loadDraftRuntime = async (nextDashboardId: string, options: { silent?: boolean } = {}) => {
    if (!options.silent) setDraftLoading(true);
    setDraftError(null);
    try {
      const runtime = await ensureDraftDashboard(nextDashboardId);
      setDraftRuntime(runtime);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!options.silent) setDraftRuntime(null);
      setDraftError(error instanceof Error ? error.message : "Failed to load the draft dashboard.");
      return null;
    } finally {
      if (!options.silent) setDraftLoading(false);
    }
  };

  const refreshPublishedWidgetData = useCallback((
    nextDashboardId: string,
    revisionId: string | null | undefined,
    dataScope: DashboardPublishedDataRefreshScope = "all",
  ): Promise<DashboardPublishedDataResponse | null> => {
    if (!revisionId) return Promise.resolve(null);
    const activeScope = `${nextDashboardId}:${revisionId}`;
    const requestKey = `${activeScope}:${dataScope}`;
    const existingRequest = refreshRequestRef.current;
    if (existingRequest?.requestKey === requestKey) return existingRequest.promise;

    if (refreshScopeRef.current === activeScope) setPublishedRefreshStatus("refreshing");
    const promise = getPublishedDashboardData(nextDashboardId, dataScope)
      .then(async (response) => {
        if (refreshScopeRef.current !== activeScope) return null;
        const autoRefreshIntervalMinutes = normalizeAutoRefreshIntervalMinutes(
          response.autoRefreshIntervalMinutes,
        );
        if (response.revisionId !== revisionId) {
          const runtime = await loadPublishedRuntime(nextDashboardId, { silent: true });
          if (!runtime || refreshScopeRef.current !== activeScope) return null;
          publishedRefreshRetryableRef.current = true;
          publishedAutoRefreshIntervalMinutesRef.current = autoRefreshIntervalMinutes;
          setPublishedAutoRefreshIntervalMinutes(autoRefreshIntervalMinutes);
          setPublishedRefreshError(null);
          setPublishedRefreshStatus(autoRefreshIntervalMinutes === null
            ? "manual"
            : document.visibilityState === "hidden" ? "paused" : "refreshing");
          publishedScheduleNextRefreshRef.current?.();
          return response;
        }
        setPublishedRuntime((runtime) => runtime ? mergePublishedWidgetData(runtime, response) : runtime);
        publishedRefreshRetryableRef.current = true;
        publishedAutoRefreshIntervalMinutesRef.current = autoRefreshIntervalMinutes;
        setPublishedAutoRefreshIntervalMinutes(autoRefreshIntervalMinutes);
        setPublishedRefreshError(null);
        setPublishedRefreshedAt(response.refreshedAt);
        setPublishedRefreshStatus(autoRefreshIntervalMinutes === null
          ? "manual"
          : document.visibilityState === "hidden" ? "paused" : "live");
        publishedScheduleNextRefreshRef.current?.();
        return response;
      })
      .catch((error: unknown) => {
        if (refreshScopeRef.current !== activeScope) return null;
        publishedRefreshRetryableRef.current = !(error instanceof ApiError)
          || error.status >= 500
          || error.status === 408
          || error.status === 429;
        setPublishedRefreshError(error instanceof Error ? error.message : "Failed to refresh published dashboard data.");
        setPublishedRefreshStatus("error");
        publishedScheduleNextRefreshRef.current?.();
        return null;
      })
      .finally(() => {
        if (refreshRequestRef.current?.requestKey === requestKey) refreshRequestRef.current = null;
      });

    refreshRequestRef.current = { activeScope, promise, requestKey };
    return promise;
  }, [loadPublishedRuntime]);

  const activePublishedRuntime = publishedRuntime?.dashboard.id === dashboardId
    ? publishedRuntime
    : null;
  const pages = mode === "published"
    ? (activePublishedRuntime?.pages ?? [])
    : (draftRuntime?.pages ?? []);

  useEffect(() => {
    if (!active || mode !== "published") {
      publishedRuntimeScopeRef.current = "";
      setRuntimeError(null);
      setRuntimeLoading(false);
      return;
    }

    publishedRuntimeScopeRef.current = dashboardId;
    void loadPublishedRuntime(dashboardId);
    return () => {
      if (publishedRuntimeScopeRef.current === dashboardId) {
        publishedRuntimeScopeRef.current = "";
      }
    };
  }, [active, dashboardId, loadPublishedRuntime, mode]);

  useEffect(() => {
    const revisionId = publishedRuntime?.revision?.id;
    const runtimeMatchesRoute = publishedRuntime?.dashboard.id === dashboardId;
    if (!active || mode !== "published" || !runtimeMatchesRoute) {
      refreshScopeRef.current = "";
      publishedRefreshRetryableRef.current = true;
      publishedAutoRefreshIntervalMinutesRef.current = null;
      setPublishedRefreshError(null);
      setPublishedRefreshStatus("idle");
      setPublishedRefreshedAt(null);
      setPublishedAutoRefreshIntervalMinutes(null);
      return undefined;
    }

    if (!revisionId) {
      refreshScopeRef.current = "";
      publishedRefreshRetryableRef.current = true;
      publishedAutoRefreshIntervalMinutesRef.current = null;
      setPublishedRefreshError(null);
      setPublishedRefreshStatus("manual");
      setPublishedRefreshedAt(null);
      setPublishedAutoRefreshIntervalMinutes(null);
      return undefined;
    }

    const scope = `${dashboardId}:${revisionId}`;
    refreshScopeRef.current = scope;
    publishedRefreshRetryableRef.current = true;
    publishedAutoRefreshIntervalMinutesRef.current = DEFAULT_DASHBOARD_SYNC_INTERVAL_MINUTES;
    setPublishedAutoRefreshIntervalMinutes(null);
    let cancelled = false;
    let timeoutId: number | undefined;

    const clearScheduledRefresh = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const scheduleNextRefresh = () => {
      clearScheduledRefresh();
      const intervalMinutes = publishedAutoRefreshIntervalMinutesRef.current;
      if (
        !cancelled
        && intervalMinutes !== null
        && publishedRefreshRetryableRef.current
        && document.visibilityState !== "hidden"
      ) {
        timeoutId = window.setTimeout(() => void poll(), intervalMinutes * MINUTES_TO_MILLISECONDS);
      }
    };
    publishedScheduleNextRefreshRef.current = scheduleNextRefresh;
    const poll = async () => {
      clearScheduledRefresh();
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        if (publishedRefreshRetryableRef.current && publishedAutoRefreshIntervalMinutesRef.current !== null) {
          setPublishedRefreshStatus("paused");
        }
        return;
      }
      const inFlightRequest = refreshRequestRef.current;
      if (inFlightRequest?.activeScope === scope) {
        await inFlightRequest.promise;
        scheduleNextRefresh();
        return;
      }
      await refreshPublishedWidgetData(dashboardId, revisionId, "continuous_kafka");
    };
    const handleVisibilityChange = () => {
      clearScheduledRefresh();
      if (document.visibilityState === "hidden") {
        if (publishedRefreshRetryableRef.current && publishedAutoRefreshIntervalMinutesRef.current !== null) {
          setPublishedRefreshStatus("paused");
        }
        return;
      }
      if (publishedRefreshRetryableRef.current && publishedAutoRefreshIntervalMinutesRef.current !== null) {
        void poll();
      } else if (publishedAutoRefreshIntervalMinutesRef.current === null) {
        setPublishedRefreshStatus("manual");
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    void poll();

    return () => {
      cancelled = true;
      clearScheduledRefresh();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (publishedScheduleNextRefreshRef.current === scheduleNextRefresh) {
        publishedScheduleNextRefreshRef.current = null;
      }
      if (refreshScopeRef.current === scope) refreshScopeRef.current = "";
    };
  }, [active, dashboardId, mode, publishedRuntime?.dashboard.id, publishedRuntime?.revision?.id, refreshPublishedWidgetData]);

  useEffect(() => {
    if (!active || mode !== "draft") {
      setDraftError(null);
      setDraftLoading(false);
      return;
    }

    void loadDraftRuntime(dashboardId);
  }, [active, dashboardId, mode]);

  useEffect(() => {
    if (!active) return;
    if (!pages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pages[0]?.id ?? null);
    }
  }, [active, pages, selectedPageId]);

  return {
    draftError,
    draftLoading,
    draftRuntime,
    loadDraftRuntime,
    loadPublishedRuntime,
    pages,
    publishedRuntime: activePublishedRuntime,
    publishedAutoRefreshIntervalMinutes,
    publishedRefreshError,
    publishedRefreshedAt,
    publishedRefreshStatus,
    refreshPublishedWidgetData,
    runtimeError,
    runtimeLoading,
    selectedPageId,
    setDraftError,
    setDraftRuntime,
    setPublishedRuntime,
    setSelectedPageId,
  };
}
