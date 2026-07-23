import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { queryDashboardWidgets } from "../../../services/dashboardRuntimeApi";
import type { DashboardRuntimeMode, DashboardRuntimeResponse } from "../../../types";
import {
  dashboardWidgetDataRequests,
  dashboardWidgetDataRefreshRequests,
  dashboardWidgetDataRefreshRequestsForDatasets,
  dashboardWidgetDataSelectionKey,
  mergeDashboardWidgetData,
  runDashboardWidgetDataQueue,
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
  const runtimeRef = useRef(runtime);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const activePageKeyRef = useRef<string | null>(null);
  runtimeRef.current = runtime;

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
    }

    void runDashboardWidgetDataQueue(requests, async (request) => {
      if (controller.signal.aborted) return;
      await queryDashboardWidgets(dashboardId, mode, request.widgetIds, {
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
    });

    return () => controller.abort();
  }, [active, dashboardId, loadStateKey, mode, setRuntime]);

  const refreshCurrentPageWidgetData = useCallback(async () => {
    const current = runtimeRef.current;
    if (!active || !current || current.dashboard.id !== dashboardId) return false;
    const refreshRequests = dashboardWidgetDataRefreshRequests(current, selectedPageId);
    if (refreshRequests.length === 0) return true;

    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    refreshControllerRef.current = controller;
    let succeeded = true;

    await runDashboardWidgetDataQueue(refreshRequests, async (request) => {
      if (controller.signal.aborted) return;
      try {
        const response = await queryDashboardWidgets(dashboardId, mode, request.widgetIds, {
          signal: controller.signal,
          timeoutMs: DASHBOARD_WIDGET_DATA_TIMEOUT_MS,
        });
        if (controller.signal.aborted) return;
        if (response.widgets.some((widget) => widget.dataStatus === "error")) succeeded = false;
        setRuntime((latest) => mergeDashboardWidgetData(
          latest,
          dashboardId,
          response.widgets,
          request.signatures,
        ));
      } catch {
        if (!controller.signal.aborted) succeeded = false;
      }
    });

    if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
    return !controller.signal.aborted && succeeded;
  }, [active, dashboardId, mode, selectedPageId, setRuntime]);

  const refreshWidgetDataForDatasets = useCallback(async (datasetIds: readonly string[]) => {
    const current = runtimeRef.current;
    if (!active || !current || current.dashboard.id !== dashboardId) return false;
    const refreshRequests = dashboardWidgetDataRefreshRequestsForDatasets(
      current,
      selectedPageId,
      datasetIds,
    );
    if (refreshRequests.length === 0) return true;

    let succeeded = true;
    await runDashboardWidgetDataQueue(refreshRequests, async (request) => {
      try {
        const response = await queryDashboardWidgets(dashboardId, mode, request.widgetIds, {
          timeoutMs: DASHBOARD_WIDGET_DATA_TIMEOUT_MS,
        });
        if (response.widgets.some((widget) => widget.dataStatus === "error")) succeeded = false;
        setRuntime((latest) => mergeDashboardWidgetData(
          latest,
          dashboardId,
          response.widgets,
          request.signatures,
        ));
      } catch {
        succeeded = false;
      }
    });
    return succeeded;
  }, [active, dashboardId, mode, selectedPageId, setRuntime]);

  const activePageKey = active && runtime?.dashboard.id === dashboardId && selectedPageId
    ? `${dashboardId}:${mode}:${selectedPageId}`
    : null;

  useEffect(() => {
    if (!activePageKey) {
      activePageKeyRef.current = null;
      return;
    }
    const previousPageKey = activePageKeyRef.current;
    activePageKeyRef.current = activePageKey;
    if (!previousPageKey || previousPageKey === activePageKey) return;

    const current = runtimeRef.current;
    const hasPreviouslyLoadedDatasetWidget = Boolean(
      current
      && selectedPageId
      && (current.widgetsByPageId[selectedPageId] ?? []).some((widget) => (
        Boolean(widget.datasetId)
        && widget.dataStatus !== "pending"
        && widget.dataStatus !== "loading"
      )),
    );
    if (hasPreviouslyLoadedDatasetWidget) void refreshCurrentPageWidgetData();
  }, [activePageKey, refreshCurrentPageWidgetData, selectedPageId]);

  useEffect(() => () => {
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
  }, [dashboardId, mode]);

  const retryWidgetData = useCallback((widgetId: string) => {
    setRuntime((current) => setDashboardWidgetDataStatus(current, [widgetId], "pending"));
  }, [setRuntime]);

  return { refreshCurrentPageWidgetData, refreshWidgetDataForDatasets, retryWidgetData };
}
