import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  ensureDraftDashboard,
  getPublishedDashboard,
} from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeResponse } from "../../../types";
import { createResourceQueryKey, LatestRequestGate } from "../../../state/requestOwnership";
import { dashboardRuntimeErrorMessage } from "./dashboardRuntimeErrors";


type RuntimeLoadOptions = { silent?: boolean };


function useRuntimePageSelection(
  setSelectedPageId: Dispatch<SetStateAction<string | null>>,
) {
  return useCallback((runtime: DashboardRuntimeResponse) => {
    const requestedPageId = new URLSearchParams(window.location.search).get("page");
    const requestedPageExists = requestedPageId && runtime.pages.some((page) => page.id === requestedPageId);
    const fallbackPageId = requestedPageExists ? requestedPageId : runtime.pages[0]?.id ?? null;
    setSelectedPageId((currentPageId) => (
      currentPageId && runtime.pages.some((page) => page.id === currentPageId)
        ? currentPageId
        : fallbackPageId
    ));
  }, [setSelectedPageId]);
}


export function useDashboardRuntimeLoaders(
  setSelectedPageId: Dispatch<SetStateAction<string | null>>,
) {
  const [publishedRuntime, setPublishedRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [draftRuntime, setDraftRuntime] = useState<DashboardRuntimeResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const publishedRequests = useRef(new LatestRequestGate());
  const draftRequests = useRef(new LatestRequestGate());
  const selectPageFromResponse = useRuntimePageSelection(setSelectedPageId);

  const loadPublishedRuntime = useCallback(async (
    dashboardId: string,
    options: RuntimeLoadOptions = {},
  ) => {
    const lease = publishedRequests.current.begin(createResourceQueryKey({
      params: { includeData: false },
      resource: "dashboard-published-runtime",
      sessionId: dashboardId,
    }));
    if (!options.silent) {
      setRuntimeLoading(true);
      setRuntimeError(null);
    }
    try {
      const runtime = await getPublishedDashboard(dashboardId, {
        includeData: false,
        signal: lease.signal,
      });
      if (!publishedRequests.current.isCurrent(lease)) return null;
      setPublishedRuntime(runtime);
      setRuntimeError(null);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!publishedRequests.current.isCurrent(lease)) return null;
      if (!options.silent) {
        setPublishedRuntime(null);
        setRuntimeError(dashboardRuntimeErrorMessage(error, "게시된 대시보드를 불러오지 못했습니다."));
      }
      return null;
    } finally {
      if (publishedRequests.current.isCurrent(lease)) {
        if (!options.silent) setRuntimeLoading(false);
        publishedRequests.current.complete(lease);
      }
    }
  }, [selectPageFromResponse]);

  const loadDraftRuntime = useCallback(async (
    dashboardId: string,
    options: RuntimeLoadOptions = {},
  ) => {
    const lease = draftRequests.current.begin(createResourceQueryKey({
      params: { includeData: false },
      resource: "dashboard-draft-runtime",
      sessionId: dashboardId,
    }));
    if (!options.silent) setDraftLoading(true);
    setDraftError(null);
    try {
      const runtime = await ensureDraftDashboard(dashboardId, {
        includeData: false,
        signal: lease.signal,
      });
      if (!draftRequests.current.isCurrent(lease)) return null;
      setDraftRuntime(runtime);
      selectPageFromResponse(runtime);
      return runtime;
    } catch (error) {
      if (!draftRequests.current.isCurrent(lease)) return null;
      if (!options.silent) setDraftRuntime(null);
      setDraftError(dashboardRuntimeErrorMessage(error, "편집 중인 대시보드를 불러오지 못했습니다."));
      return null;
    } finally {
      if (draftRequests.current.isCurrent(lease)) {
        if (!options.silent) setDraftLoading(false);
        draftRequests.current.complete(lease);
      }
    }
  }, [selectPageFromResponse]);

  const cancelPublishedRuntimeLoad = useCallback(() => {
    publishedRequests.current.invalidate();
  }, []);
  const cancelDraftRuntimeLoad = useCallback(() => {
    draftRequests.current.invalidate();
  }, []);

  return {
    cancelDraftRuntimeLoad, cancelPublishedRuntimeLoad,
    draftError, draftLoading, draftRuntime, loadDraftRuntime,
    loadPublishedRuntime, publishedRuntime, runtimeError, runtimeLoading,
    setDraftError, setDraftRuntime, setPublishedRuntime,
    setDraftLoading, setRuntimeError, setRuntimeLoading,
  };
}
