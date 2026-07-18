import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ensureDraftDashboard,
  getPublishedDashboard,
} from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeResponse } from "../../../types";
import { dashboardRuntimeErrorMessage } from "./dashboardRuntimeErrors";


type RuntimeLoadOptions = { silent?: boolean };


export function useDashboardRuntimeLoaders(
  setSelectedPageId: Dispatch<SetStateAction<string | null>>,
) {
  const [publishedRuntime, setPublishedRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const selectPageFromResponse = useCallback((runtime: DashboardRuntimeResponse) => {
    const requestedPageId = new URLSearchParams(window.location.search).get("page");
    const requestedPageExists = requestedPageId && runtime.pages.some((page) => page.id === requestedPageId);
    const fallbackPageId = requestedPageExists ? requestedPageId : runtime.pages[0]?.id ?? null;
    setSelectedPageId((currentPageId) => (
      currentPageId && runtime.pages.some((page) => page.id === currentPageId)
        ? currentPageId
        : fallbackPageId
    ));
  }, [setSelectedPageId]);

  const loadPublishedRuntime = useCallback(async (
    dashboardId: string,
    options: RuntimeLoadOptions = {},
  ) => {
    if (!options.silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }
    try {
      const runtime = await getPublishedDashboard(dashboardId, { includeData: false });
      setPublishedRuntime(runtime);
      setRuntimeError(null);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!options.silent) {
        setPublishedRuntime(null);
        setRuntimeError(dashboardRuntimeErrorMessage(error, "게시된 대시보드를 불러오지 못했습니다."));
      }
      return null;
    } finally {
      if (!options.silent) setRuntimeLoading(false);
    }
  }, [selectPageFromResponse]);

  const loadDraftRuntime = useCallback(async (
    dashboardId: string,
    options: RuntimeLoadOptions = {},
  ) => {
    if (!options.silent) setDraftLoading(true);
    setDraftError(null);
    try {
      const runtime = await ensureDraftDashboard(dashboardId, { includeData: false });
      setDraftRuntime(runtime);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!options.silent) setDraftRuntime(null);
      setDraftError(dashboardRuntimeErrorMessage(error, "편집 중인 대시보드를 불러오지 못했습니다."));
      return null;
    } finally {
      if (!options.silent) setDraftLoading(false);
    }
  }, [selectPageFromResponse]);

  return {
    draftError, draftLoading, draftRuntime, loadDraftRuntime,
    loadPublishedRuntime, publishedRuntime, runtimeError, runtimeLoading,
    setDraftError, setDraftRuntime, setPublishedRuntime,
    setDraftLoading, setRuntimeError, setRuntimeLoading,
  };
}
