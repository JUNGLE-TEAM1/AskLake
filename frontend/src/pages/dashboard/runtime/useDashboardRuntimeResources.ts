import { useEffect, useState } from "react";
import type { DashboardRuntimeMode } from "../../../types";
import { useDashboardRuntimeLoaders } from "./useDashboardRuntimeLoaders";
import { usePublishedDashboardLiveRefresh } from "./usePublishedDashboardLiveRefresh";

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
    draftError, draftLoading, draftRuntime, loadDraftRuntime,
    loadPublishedRuntime, publishedRuntime, runtimeError, runtimeLoading,
    setDraftError, setDraftLoading, setDraftRuntime, setPublishedRuntime,
    setRuntimeError, setRuntimeLoading,
  } = useDashboardRuntimeLoaders(setSelectedPageId);

  const pages = mode === "published"
    ? (publishedRuntime?.pages ?? [])
    : (draftRuntime?.pages ?? []);

  useEffect(() => {
    if (!active || mode !== "published") {
      setRuntimeError(null);
      setRuntimeLoading(false);
      return;
    }

    void loadPublishedRuntime(dashboardId);
  }, [active, dashboardId, loadPublishedRuntime, mode]);

  useEffect(() => {
    if (!active || mode !== "draft") {
      setDraftError(null);
      setDraftLoading(false);
      return;
    }

    void loadDraftRuntime(dashboardId);
  }, [active, dashboardId, loadDraftRuntime, mode]);

  useEffect(() => {
    if (!active) return;
    if (!pages.some((page) => page.id === selectedPageId)) {
      setSelectedPageId(pages[0]?.id ?? null);
    }
  }, [active, pages, selectedPageId]);

  const realtimeConnectionState = usePublishedDashboardLiveRefresh({
    active,
    dashboardId,
    mode,
    publishedRuntime,
    reloadPublishedRuntime: loadPublishedRuntime,
    setPublishedRuntime,
  });

  return {
    draftError,
    draftLoading,
    draftRuntime,
    loadDraftRuntime,
    loadPublishedRuntime,
    pages,
    publishedRuntime,
    realtimeConnectionState,
    runtimeError,
    runtimeLoading,
    selectedPageId,
    setDraftError,
    setDraftRuntime,
    setPublishedRuntime,
    setSelectedPageId,
  };
}
