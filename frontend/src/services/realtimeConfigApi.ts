import { apiClient } from "./apiClient";

export type DashboardSyncMode = "polling" | "hybrid" | "sse";

export type RealtimeFeatureConfig = {
  continuousSqlJoinEnabled: boolean;
  continuousSqlServingMode: "iceberg" | "clickhouse";
  dashboardSyncMode: DashboardSyncMode;
  fallbackReason: string | null;
  featureScope: "deployment";
  heartbeatSeconds: number;
  latestStaticPerBatchEnabled: boolean;
  realtimeEventsEnabled: boolean;
  reconnectRetryMs: number;
  safetyPollAfterMs: number;
  staticChangeBackfillEnabled: boolean;
};

export function getRealtimeFeatureConfig() {
  return apiClient.get<RealtimeFeatureConfig>("/api/realtime/config");
}
