import { apiClient } from "./apiClient";

export type DashboardSyncMode = "polling" | "hybrid" | "sse";

export type RealtimeFeatureConfig = {
  clickhouseContinuousJoinEnabled: boolean;
  clickhouseRealtimeConsumerOwner: "disabled" | "kafka_engine_v1" | "kafka_connect_v2";
  clickhouseRealtimeV2Enabled: boolean;
  continuousSqlJoinEnabled: boolean;
  dashboardSyncMode: DashboardSyncMode;
  fallbackReason: string | null;
  featureScope: "deployment";
  heartbeatSeconds: number;
  latestStaticPerBatchEnabled: boolean;
  kafkaConnectSinkEnabled: boolean;
  realtimeEventsEnabled: boolean;
  reconnectRetryMs: number;
  safetyPollAfterMs: number;
  staticChangeBackfillEnabled: boolean;
};

export function getRealtimeFeatureConfig() {
  return apiClient.get<RealtimeFeatureConfig>("/api/realtime/config");
}
