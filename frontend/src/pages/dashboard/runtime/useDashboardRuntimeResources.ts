import { useCallback, useEffect, useState } from "react";
import {
  ensureDraftDashboard,
  getPublishedDashboard,
} from "../../../services/dashboardRuntimeApi";
import type {
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
} from "../../../types";
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
  const [publishedRuntime, setPublishedRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>("page-1");

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

  const loadPublishedRuntime = useCallback(async (
    nextDashboardId: string,
    options: { silent?: boolean } = {},
  ) => {
    if (!options.silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }
    try {
      const runtime = await getPublishedDashboard(nextDashboardId);
      setPublishedRuntime(runtime);
      setRuntimeError(null);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!options.silent) {
        setPublishedRuntime(null);
        setRuntimeError(error instanceof Error ? error.message : "Failed to load the published dashboard.");
      }
      return null;
    } finally {
      if (!options.silent) setRuntimeLoading(false);
    }
  }, [selectPageFromResponse]);

  const loadDraftRuntime = useCallback(async (
    nextDashboardId: string,
    options: { silent?: boolean } = {},
  ) => {
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
  }, [selectPageFromResponse]);

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
