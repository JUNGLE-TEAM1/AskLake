import type { TrinoQueryRun, TrinoQueryRunChart } from "../../types";
import type { SqlChartConfig, SqlChartSource } from "./SqlResultChart";

export function createTrinoResultChartRequestKey({
  chartConfig,
  fullResultRun,
  retryToken,
  source,
}: {
  chartConfig: SqlChartConfig | null;
  fullResultRun: TrinoQueryRun | null;
  retryToken: number;
  source?: SqlChartSource;
}) {
  if (
    !chartConfig
    || !source
    || source.kind !== "sql_result"
    || fullResultRun?.status !== "succeeded"
    || fullResultRun.result?.storageStatus !== "available"
    || fullResultRun.mode !== "run"
  ) return "";
  return JSON.stringify({
    config: chartConfig.config,
    retryToken,
    runId: fullResultRun.runId,
    type: chartConfig.type,
  });
}

export function resolveTrinoResultChartSource(
  source: SqlChartSource | undefined,
  result: TrinoQueryRunChart | null,
) {
  if (!source || !result) return undefined;
  return {
    ...source,
    scope: "full_result" as const,
    sourceRowCount: result.sourceRowCount,
    dataset: {
      ...source.dataset,
      description: `${source.dataset.description ?? source.label} · 전체 ${result.sourceRowCount.toLocaleString()}행 서버 집계`,
      rows: result.data,
    },
  };
}
