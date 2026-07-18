import { useCallback, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { queryDashboardWidgets } from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";
import {
  dashboardWidgetDataRequests,
  dashboardWidgetDataSelectionKey,
  mergeDashboardWidgetData,
  setDashboardWidgetDataStatus,
} from "./dashboardWidgetDataState";
import { dashboardRuntimeErrorMessage } from "./dashboardRuntimeErrors";

const DASHBOARD_WIDGET_DATA_TIMEOUT_MS = 30_000;

export function useDashboardWidgetData({
  active,
  dashboardId,
  mode,
  runtime,
  selectedPageId,
  setRuntime,
}: {
  active: boolean;
  dashboardId: string;
  mode: DashboardRuntimeMode;
  runtime: DashboardRuntimeResponse | null;
  selectedPageId: string | null;
  setRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
}) {
  const requests = useMemo(
    () => dashboardWidgetDataRequests(runtime, selectedPageId),
    [runtime, selectedPageId],
  );
  const selectionKey = dashboardWidgetDataSelectionKey(runtime, selectedPageId);
  const loadStateKey = `${selectionKey}:${requests.length > 0 ? "needs-data" : "settled"}`;

  useEffect(() => {
    if (!active || requests.length === 0) return undefined;
    const controller = new AbortController();

    for (const request of requests) {
      setRuntime((current) => setDashboardWidgetDataStatus(
        current,
        request.widgetIds,
        "loading",
        null,
        request.signatures,
      ));
      void queryDashboardWidgets(dashboardId, mode, request.widgetIds, {
        signal: controller.signal,
        timeoutMs: DASHBOARD_WIDGET_DATA_TIMEOUT_MS,
      }).then((response) => {
        if (controller.signal.aborted) return;
        setRuntime((current) => mergeDashboardWidgetData(
          current,
          dashboardId,
          response.widgets,
          request.signatures,
        ));
      }).catch((error) => {
        if (controller.signal.aborted) return;
        const message = dashboardRuntimeErrorMessage(error, "위젯 데이터를 불러오지 못했습니다.");
        setRuntime((current) => setDashboardWidgetDataStatus(
          current,
          request.widgetIds,
          "error",
          message,
          request.signatures,
        ));
      });
    }

    return () => controller.abort();
  }, [active, dashboardId, loadStateKey, mode, setRuntime]);

  const retryWidgetData = useCallback((widgetId: string) => {
    setRuntime((current) => setDashboardWidgetDataStatus(current, [widgetId], "pending"));
  }, [setRuntime]);

  return { retryWidgetData };
}
