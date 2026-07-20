import { apiClient } from "./apiClient";

export type DashboardJobBinding = {
  id: string;
  dashboardId: string;
  jobId: string;
  jobKind: "etl" | "continuous_sql";
  outputDatasetId: string;
  mode: "managed" | "detached";
  enabled: boolean;
};

export function createDashboardJobBinding(input: {
  dashboardId: string;
  jobId: string;
  jobKind: "etl" | "continuous_sql";
  outputDatasetId: string;
}) {
  return apiClient.post<DashboardJobBinding>("/api/dashboard-job-bindings", input);
}

export async function getDashboardJobBinding(dashboardId: string) {
  const response = await apiClient.get<{ items: DashboardJobBinding[] }>(
    `/api/dashboard-job-bindings?dashboardId=${encodeURIComponent(dashboardId)}`,
  );
  return response.items[0] ?? null;
}
