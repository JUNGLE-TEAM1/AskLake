import { useMemo } from "react";
import { mockDashboardDatasets } from "./dashboardDatasetOptions";

export function useDashboardDatasets() {
  return useMemo(
    () => ({
      datasets: mockDashboardDatasets,
      error: null as Error | null,
      isLoading: false,
    }),
    [],
  );
}
