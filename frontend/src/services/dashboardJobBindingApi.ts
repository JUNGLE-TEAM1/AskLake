import { apiClient } from "./apiClient";
import { createDashboard } from "./dashboardApi";

export type DashboardJobBinding = {
  id: string;
  dashboardId: string;
  jobId: string;
  jobKind: "etl" | "continuous_sql";
  outputDatasetId: string;
  mode: "managed" | "detached";
  enabled: boolean;
  outputDataset?: {
    id: string;
    name: string;
    layer: "RAW" | "BRONZE" | "SILVER" | "GOLD";
    status: "preparing" | "available" | "approval_required";
    schema: Array<[string, string]>;
  } | null;
};

export function createDashboardJobBinding(input: {
  dashboardId: string;
  jobId: string;
  jobKind: "etl" | "continuous_sql";
  outputDatasetId: string;
}) {
  return apiClient.post<DashboardJobBinding>("/api/dashboard-job-bindings", input);
}

export async function createManagedJobDashboard(input: {
  jobId: string;
  jobKind: "etl" | "continuous_sql";
  outputDatasetId: string;
  title: string;
}) {
  const { dashboard } = await createDashboard({ source: "manual", title: input.title });
  const binding = await createDashboardJobBinding({
    dashboardId: dashboard.id,
    jobId: input.jobId,
    jobKind: input.jobKind,
    outputDatasetId: input.outputDatasetId,
  });
  return { binding, dashboard };
}

export async function getDashboardJobBinding(dashboardId: string) {
  const response = await apiClient.get<{ items: DashboardJobBinding[] }>(
    `/api/dashboard-job-bindings?dashboardId=${encodeURIComponent(dashboardId)}`,
  );
  return response.items[0] ?? null;
}
