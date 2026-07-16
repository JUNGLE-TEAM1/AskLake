import { apiClient } from "./apiClient";

export type DashboardSyncMode = "polling" | "hybrid" | "sse";

export type RealtimeFeatureConfig = {
  continuousSqlJoinEnabled: boolean;
  dashboardSyncMode: DashboardSyncMode;
  fallbackReason: string | null;
  featureScope: "deployment";
  latestStaticPerBatchEnabled: boolean;
  realtimeEventsEnabled: boolean;
  staticChangeBackfillEnabled: boolean;
};

export function getRealtimeFeatureConfig() {
  return apiClient.get<RealtimeFeatureConfig>("/api/realtime/config");
}
