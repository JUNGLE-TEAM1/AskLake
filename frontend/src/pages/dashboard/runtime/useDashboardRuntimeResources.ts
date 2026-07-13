import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureDraftDashboard,
  getPublishedDashboard,
  getPublishedDashboardData,
} from "../../../services/dashboardRuntimeApi";
import type {
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
  DashboardWidgetDataRefreshResponse,
} from "../../../types";
import { ApiError } from "../../../types";

export const PUBLISHED_WIDGET_REFRESH_INTERVAL_MS = 10_000;

export type DashboardPublishedRefreshStatus = "idle" | "refreshing" | "live" | "paused" | "error";

function mergePublishedWidgetData(
  runtime: DashboardRuntimeResponse,
  response: DashboardWidgetDataRefreshResponse,
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
  const refreshScopeRef = useRef("");
  const refreshRequestRef = useRef<{
    promise: Promise<DashboardWidgetDataRefreshResponse | null>;
    scope: string;
  } | null>(null);
  const publishedRuntimeScopeRef = useRef("");
  const publishedRuntimeRequestRef = useRef<{
    promise: Promise<DashboardRuntimeResponse | null>;
    scope: string;
  } | null>(null);
  const publishedRuntimeRequestSequenceRef = useRef(0);
  const publishedRuntimeCommitRequestRef = useRef(0);
  const publishedRefreshRetryableRef = useRef(true);
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
  ): Promise<DashboardWidgetDataRefreshResponse | null> => {
    if (!revisionId) return Promise.resolve(null);
    const scope = `${nextDashboardId}:${revisionId}`;
    const existingRequest = refreshRequestRef.current;
    if (existingRequest?.scope === scope) return existingRequest.promise;

    if (refreshScopeRef.current === scope) setPublishedRefreshStatus("refreshing");
    const promise = getPublishedDashboardData(nextDashboardId)
      .then(async (response) => {
        if (refreshScopeRef.current !== scope) return null;
        if (response.revisionId !== revisionId) {
          const runtime = await loadPublishedRuntime(nextDashboardId, { silent: true });
          if (!runtime || refreshScopeRef.current !== scope) return null;
          publishedRefreshRetryableRef.current = true;
          publishedScheduleNextRefreshRef.current?.();
          setPublishedRefreshError(null);
          setPublishedRefreshStatus("refreshing");
          return response;
        }
        setPublishedRuntime((runtime) => runtime ? mergePublishedWidgetData(runtime, response) : runtime);
        publishedRefreshRetryableRef.current = true;
        publishedScheduleNextRefreshRef.current?.();
        setPublishedRefreshError(null);
        setPublishedRefreshedAt(response.refreshedAt);
        setPublishedRefreshStatus(document.visibilityState === "hidden" ? "paused" : "live");
        return response;
      })
      .catch((error: unknown) => {
        if (refreshScopeRef.current !== scope) return null;
        publishedRefreshRetryableRef.current = !(error instanceof ApiError)
          || error.status >= 500
          || error.status === 408
          || error.status === 429;
        setPublishedRefreshError(error instanceof Error ? error.message : "Failed to refresh published dashboard data.");
        setPublishedRefreshStatus("error");
        return null;
      })
      .finally(() => {
        if (refreshRequestRef.current?.scope === scope) refreshRequestRef.current = null;
      });

    refreshRequestRef.current = { promise, scope };
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
    if (!active || mode !== "published" || !revisionId || !runtimeMatchesRoute) {
      refreshScopeRef.current = "";
      publishedRefreshRetryableRef.current = true;
      setPublishedRefreshError(null);
      setPublishedRefreshStatus("idle");
      setPublishedRefreshedAt(null);
      return undefined;
    }

    const scope = `${dashboardId}:${revisionId}`;
    refreshScopeRef.current = scope;
    publishedRefreshRetryableRef.current = true;
    let cancelled = false;
    let timeoutId: number | undefined;

    const clearScheduledRefresh = () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const scheduleNextRefresh = () => {
      clearScheduledRefresh();
      if (!cancelled && publishedRefreshRetryableRef.current && document.visibilityState !== "hidden") {
        timeoutId = window.setTimeout(() => void poll(), PUBLISHED_WIDGET_REFRESH_INTERVAL_MS);
      }
    };
    publishedScheduleNextRefreshRef.current = scheduleNextRefresh;
    const poll = async () => {
      clearScheduledRefresh();
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        if (publishedRefreshRetryableRef.current) setPublishedRefreshStatus("paused");
        return;
      }
      await refreshPublishedWidgetData(dashboardId, revisionId);
      scheduleNextRefresh();
    };
    const handleVisibilityChange = () => {
      clearScheduledRefresh();
      if (document.visibilityState === "hidden") {
        if (publishedRefreshRetryableRef.current) setPublishedRefreshStatus("paused");
        return;
      }
      if (publishedRefreshRetryableRef.current) void poll();
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
