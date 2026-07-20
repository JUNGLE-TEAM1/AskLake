type ProcessingModeRequest = {
  continuousConfig?: unknown;
  executionMode?: string;
};

export function describeProcessingMode(request: ProcessingModeRequest): string {
  if (request.executionMode !== "continuous") return "배치 · Spark";
  const runtimeEngine = (request.continuousConfig as { runtimeEngine?: string } | undefined)?.runtimeEngine;
  return runtimeEngine === "kafka_connect_clickhouse_v2"
    ? "실시간 · ClickHouse"
    : "실시간 · Spark (기존 V1)";
}
