import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRealtimeFeatureConfig } from "../../../services/realtimeConfigApi";
import { RealtimeEventClient } from "../../../services/realtimeEvents";
import type { DashboardRuntimeResponse } from "../../../types";
import {
  dashboardAutoRefreshPreferenceKey,
  readDashboardAutoRefreshPreference,
  writeDashboardAutoRefreshPreference,
  type DashboardAutoRefreshStatus,
} from "./dashboardAutoRefresh";
import { dashboardPageDatasetIds } from "./dashboardWidgetDataState";

const AUTO_REFRESH_DEBOUNCE_MS = 700;

export function useDashboardAutoRefresh({
  active,
  currentUserId,
  dashboardId,
  refreshCurrentPageWidgetData,
  refreshWidgetDataForDatasets,
  runtime,
  selectedPageId,
}: {
  active: boolean;
  currentUserId: string;
  dashboardId: string;
  refreshCurrentPageWidgetData: () => Promise<boolean>;
  refreshWidgetDataForDatasets: (datasetIds: readonly string[]) => Promise<boolean>;
  runtime: DashboardRuntimeResponse | null;
  selectedPageId: string | null;
}) {
  const [enabled, setEnabledState] = useState(false);
  const [status, setStatus] = useState<DashboardAutoRefreshStatus>("manual");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [documentVisible, setDocumentVisible] = useState(() => (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  ));
  const clientRef = useRef<RealtimeEventClient | null>(null);
  const cursorRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const pendingDatasetIdsRef = useRef(new Set<string>());
  const shouldReportAutoStateRef = useRef(active && enabled && documentVisible);
  const refreshCurrentPageRef = useRef(refreshCurrentPageWidgetData);
  const refreshDatasetsRef = useRef(refreshWidgetDataForDatasets);
  const preferenceIdentity = dashboardAutoRefreshPreferenceKey(currentUserId, dashboardId);
  const datasetIds = useMemo(
    () => dashboardPageDatasetIds(runtime, selectedPageId),
    [runtime, selectedPageId],
  );
  const datasetSelectionKey = datasetIds.join("|");

  refreshCurrentPageRef.current = refreshCurrentPageWidgetData;
  refreshDatasetsRef.current = refreshWidgetDataForDatasets;
  shouldReportAutoStateRef.current = active && enabled && documentVisible;
  cursorRef.current = Math.max(cursorRef.current, runtime?.eventCursor ?? 0);

  useEffect(() => {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    const preferred = readDashboardAutoRefreshPreference(currentUserId, dashboardId, storage);
    setEnabledState(preferred);
    setStatus(preferred ? "connecting" : "manual");
    setErrorMessage(null);
    cursorRef.current = runtime?.eventCursor ?? 0;
  }, [currentUserId, dashboardId, preferenceIdentity]);

  const setEnabled = useCallback((nextEnabled: boolean) => {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    writeDashboardAutoRefreshPreference(currentUserId, dashboardId, nextEnabled, storage);
    setEnabledState(nextEnabled);
    shouldReportAutoStateRef.current = active && nextEnabled && documentVisible;
    setStatus(nextEnabled ? "connecting" : "manual");
    setErrorMessage(null);
  }, [active, currentUserId, dashboardId, documentVisible]);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current === null || typeof window === "undefined") return;
    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
  }, []);

  const flushPendingRefresh = useCallback(async function flushPendingRefreshTask() {
    if (inFlightRef.current) return;
    const pendingDatasetIds = Array.from(pendingDatasetIdsRef.current);
    if (pendingDatasetIds.length === 0) return;
    pendingDatasetIdsRef.current.clear();
    inFlightRef.current = true;
    const succeeded = await refreshDatasetsRef.current(pendingDatasetIds);
    inFlightRef.current = false;

    if (!shouldReportAutoStateRef.current) return;
    if (!succeeded) {
      setStatus("error");
      setErrorMessage("자동 갱신 중 일부 위젯을 불러오지 못했습니다. 마지막 성공 결과를 유지합니다.");
    } else {
      setStatus("active");
      setErrorMessage(null);
    }
    if (pendingDatasetIdsRef.current.size > 0 && typeof window !== "undefined") {
      clearDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        void flushPendingRefreshTask();
      }, AUTO_REFRESH_DEBOUNCE_MS);
    }
  }, [clearDebounce]);

  const queueDatasetRefresh = useCallback((datasetId: string) => {
    pendingDatasetIdsRef.current.add(datasetId);
    if (inFlightRef.current || typeof window === "undefined") return;
    clearDebounce();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void flushPendingRefresh();
    }, AUTO_REFRESH_DEBOUNCE_MS);
  }, [clearDebounce, flushPendingRefresh]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const handleVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      shouldReportAutoStateRef.current = active && enabled && visible;
      setDocumentVisible(visible);
      if (!visible) {
        clientRef.current?.close();
        if (enabled) setStatus("paused");
        return;
      }
      if (enabled) {
        setStatus("connecting");
        void refreshCurrentPageRef.current().then((succeeded) => {
          if (!succeeded && shouldReportAutoStateRef.current) {
            setStatus("error");
            setErrorMessage("화면 복귀 후 위젯을 최신화하지 못했습니다. 수동 새로고침을 시도해 주세요.");
          }
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [active, enabled]);

  useEffect(() => {
    clientRef.current?.close();
    clearDebounce();
    pendingDatasetIdsRef.current.clear();

    if (!active || !enabled) {
      setStatus("manual");
      return undefined;
    }
    if (!documentVisible) {
      setStatus("paused");
      return undefined;
    }
    if (datasetIds.length === 0) {
      setStatus("active");
      setErrorMessage(null);
      return undefined;
    }

    let disposed = false;
    const watchedDatasetIds = new Set(datasetIds);
    const client = new RealtimeEventClient();
    clientRef.current = client;
    setStatus("connecting");
    setErrorMessage(null);

    void getRealtimeFeatureConfig().then((config) => {
      if (disposed) return;
      if (
        !config.dashboardAutoRefreshEnabled
        || !config.realtimeEventsEnabled
        || config.dashboardSyncMode === "polling"
      ) {
        setStatus("error");
        setErrorMessage(config.fallbackReason
          ?? "현재 환경에서 Dashboard 자동 갱신이 활성화되어 있지 않습니다. 수동 새로고침은 계속 사용할 수 있습니다.");
        return;
      }

      let connection: ReturnType<RealtimeEventClient["connect"]> | null = null;
      connection = client.connect({
        cursor: cursorRef.current,
        dashboardId,
        datasetIds,
        heartbeatTimeoutMs: Math.max(10_000, config.heartbeatSeconds * 3_000),
        reconnectRetryMs: config.reconnectRetryMs,
        onEvent: (event) => {
          cursorRef.current = Math.max(cursorRef.current, event.eventId);
          if (
            event.eventType === "dataset.revision.committed"
            && watchedDatasetIds.has(event.resourceId)
          ) {
            queueDatasetRefresh(event.resourceId);
          }
        },
        onReady: (cursor) => {
          if (cursor !== null) cursorRef.current = Math.max(cursorRef.current, cursor);
        },
        onResyncRequired: () => {
          setStatus("connecting");
          void refreshCurrentPageRef.current().then((succeeded) => {
            if (disposed || !shouldReportAutoStateRef.current) return;
            if (succeeded) {
              connection?.restart(cursorRef.current);
            } else {
              setStatus("error");
              setErrorMessage("실시간 이벤트 기준점이 변경되어 전체 최신화가 필요합니다. 수동 새로고침을 시도해 주세요.");
            }
          });
        },
        onStateChange: (connectionState) => {
          if (disposed) return;
          if (connectionState === "open") {
            setStatus("active");
            setErrorMessage(null);
          } else if (connectionState === "connecting") {
            setStatus("connecting");
          } else if (connectionState === "degraded" || connectionState === "fallback_polling") {
            setStatus("error");
            setErrorMessage("자동 갱신 연결이 끊겼습니다. 재연결을 시도하며 수동 새로고침은 계속 사용할 수 있습니다.");
          }
        },
      });
    }).catch(() => {
      if (disposed) return;
      setStatus("error");
      setErrorMessage("자동 갱신 설정을 확인하지 못했습니다. 수동 새로고침은 계속 사용할 수 있습니다.");
    });

    return () => {
      disposed = true;
      client.close();
      if (clientRef.current === client) clientRef.current = null;
      clearDebounce();
      pendingDatasetIdsRef.current.clear();
    };
  }, [
    active,
    clearDebounce,
    dashboardId,
    datasetSelectionKey,
    documentVisible,
    enabled,
    queueDatasetRefresh,
  ]);

  useEffect(() => () => {
    clientRef.current?.close();
    clearDebounce();
    pendingDatasetIdsRef.current.clear();
  }, [clearDebounce]);

  return { enabled, errorMessage, setEnabled, status };
}
