import { useCallback } from "react";
import type { DashboardRuntimeResponse } from "../../../types";
import type { DashboardAutoRefreshStatus } from "./dashboardAutoRefresh";

/**
 * Dashboard data is intentionally refresh-only.
 *
 * Kafka/Trino work continues in the backend and publishes only a verified
 * Catalog revision. The browser never subscribes to Dataset events and never
 * starts upstream processing; page entry and the explicit refresh button are
 * the only widget-query triggers.
 */
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
  void active;
  void currentUserId;
  void dashboardId;
  void refreshCurrentPageWidgetData;
  void refreshWidgetDataForDatasets;
  void runtime;
  void selectedPageId;

  const setEnabled = useCallback((_enabled: boolean) => {
    // Compatibility no-op while callers migrate away from the former toggle.
  }, []);
  const status: DashboardAutoRefreshStatus = "manual";

  return { enabled: false, errorMessage: null, setEnabled, status };
}
