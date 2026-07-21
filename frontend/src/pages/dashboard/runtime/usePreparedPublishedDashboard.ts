import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { getPublishedDashboard } from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";

const DASHBOARD_BACKGROUND_PREFETCH_MS = 5_000;

type LoadOptions = { preferPrefetched?: boolean; silent?: boolean };

export function usePreparedPublishedDashboard({
  active,
  dashboardId,
  loadFromApi,
  mode,
  publishedRuntime,
  setPublishedRuntime,
  setRuntimeError,
}: {
  active: boolean;
  dashboardId: string;
  loadFromApi: (dashboardId: string, options?: { silent?: boolean }) => Promise<DashboardRuntimeResponse | null>;
  mode: DashboardRuntimeMode;
  publishedRuntime: DashboardRuntimeResponse | null;
  setPublishedRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setRuntimeError: Dispatch<SetStateAction<string | null>>;
}) {
  const preparedRuntimeRef = useRef<DashboardRuntimeResponse | null>(null);
  const displayedRuntimeRef = useRef(publishedRuntime);
  displayedRuntimeRef.current = publishedRuntime;

  const load = useCallback(async (
    nextDashboardId: string,
    options: LoadOptions = {},
  ) => {
    if (options.preferPrefetched) {
      const prepared = preparedRuntimeRef.current;
      if (prepared?.dashboard.id === nextDashboardId) {
        preparedRuntimeRef.current = null;
        setPublishedRuntime(prepared);
        setRuntimeError(null);
        return prepared;
      }
      if (displayedRuntimeRef.current?.dashboard.id === nextDashboardId) {
        return displayedRuntimeRef.current;
      }
    }
    preparedRuntimeRef.current = null;
    return loadFromApi(nextDashboardId, options);
  }, [loadFromApi, setPublishedRuntime, setRuntimeError]);

  useEffect(() => {
    if (!active || mode !== "published" || !publishedRuntime) return;
    let cancelled = false;
    let timer: number | undefined;
    const prefetch = async () => {
      try {
        const runtime = await getPublishedDashboard(dashboardId);
        if (!cancelled && runtime.dashboard.id === dashboardId) preparedRuntimeRef.current = runtime;
      } catch {
        // Keep the last prepared snapshot; the next cycle retries in the background.
      } finally {
        if (!cancelled) timer = window.setTimeout(prefetch, DASHBOARD_BACKGROUND_PREFETCH_MS);
      }
    };
    timer = window.setTimeout(prefetch, 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, dashboardId, mode, publishedRuntime !== null]);

  return load;
}
