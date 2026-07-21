import { useCallback, useEffect, useState } from "react";
import type { DashboardRuntimeMode } from "../../../types";
import { useDashboardRuntimeLoaders } from "./useDashboardRuntimeLoaders";
import { usePreparedPublishedDashboard } from "./usePreparedPublishedDashboard";
import { usePublishedDashboardLiveRefresh } from "./usePublishedDashboardLiveRefresh";
import { useDashboardWidgetData } from "./useDashboardWidgetData";
import { onCatalogDatasetDeleted } from "../../../services/catalogEvents";

export function useDashboardRuntimeResources({
  active,
  dashboardId,
  mode,
}: {
  active: boolean;
  dashboardId: string;
  mode: DashboardRuntimeMode;
}) {
  const [selectedPageId, setSelectedPageId] = useState<string | null>("page-1");
  const {
    cancelDraftRuntimeLoad, cancelPublishedRuntimeLoad,
    draftError, draftLoading, draftRuntime, loadDraftRuntime,
    loadPublishedRuntime: loadPublishedRuntimeFromApi, publishedRuntime, runtimeError, runtimeLoading,
    setDraftError, setDraftLoading, setDraftRuntime, setPublishedRuntime,
    setRuntimeError, setRuntimeLoading,
  } = useDashboardRuntimeLoaders(setSelectedPageId);
  const loadPublishedRuntime = usePreparedPublishedDashboard({
    active, dashboardId, loadFromApi: loadPublishedRuntimeFromApi, mode,
    publishedRuntime, setPublishedRuntime, setRuntimeError,
  });

  const pages = mode === "published"
    ? (publishedRuntime?.pages ?? [])
    : (draftRuntime?.pages ?? []);

  useEffect(() => {
    if (!active || mode !== "published") {
      cancelPublishedRuntimeLoad();
      setRuntimeError(null);
      setRuntimeLoading(false);
      return undefined;
    }

    void loadPublishedRuntime(dashboardId);
    return cancelPublishedRuntimeLoad;
  }, [active, cancelPublishedRuntimeLoad, dashboardId, loadPublishedRuntime, mode]);

  useEffect(() => {
    if (!active || mode !== "draft") {
      cancelDraftRuntimeLoad();
      setDraftError(null);
      setDraftLoading(false);
      return undefined;
    }

    void loadDraftRuntime(dashboardId);
    return cancelDraftRuntimeLoad;
  }, [active, cancelDraftRuntimeLoad, dashboardId, loadDraftRuntime, mode]);

  useEffect(() => {
    if (!active) return;
    if (!pages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pages[0]?.id ?? null);
    }
  }, [active, pages, selectedPageId]);

  useEffect(() => {
    if (!active) return undefined;

    return onCatalogDatasetDeleted(() => {
      if (mode === "published") {
        void loadPublishedRuntime(dashboardId, { silent: true });
      } else {
        void loadDraftRuntime(dashboardId, { silent: true });
      }
    });
  }, [active, dashboardId, loadDraftRuntime, loadPublishedRuntime, mode]);

  const activeRuntime = mode === "published" ? publishedRuntime : draftRuntime;
  const setActiveRuntime = useCallback(
    (update: Parameters<typeof setPublishedRuntime>[0]) => {
      if (mode === "published") {
        setPublishedRuntime(update);
      } else {
        setDraftRuntime(update);
      }
    },
    [mode, setDraftRuntime, setPublishedRuntime],
  );
  const { retryWidgetData } = useDashboardWidgetData({
    active,
    dashboardId,
    mode,
    runtime: activeRuntime,
    selectedPageId,
    setRuntime: setActiveRuntime,
  });

  const { realtimeConnectionState, realtimeDataState } = usePublishedDashboardLiveRefresh({
    active,
    dashboardId,
    mode,
    publishedRuntime,
    reloadPublishedRuntime: loadPublishedRuntime,
    setPublishedRuntime,
  });

  return {
    draftError, draftLoading, draftRuntime, loadDraftRuntime, loadPublishedRuntime,
    pages, publishedRuntime, realtimeConnectionState, realtimeDataState,
    retryWidgetData, runtimeError, runtimeLoading, selectedPageId,
    setDraftError, setDraftRuntime, setPublishedRuntime, setSelectedPageId,
  };
}
