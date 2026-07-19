import { useMemo } from "react";

import type {
  CatalogDataset,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetConfig,
  DashboardRuntimeWidgetType,
  SqlResultDraft,
} from "../../types";
import {
  catalogDatasetToDashboardOption,
  sqlResultToDashboardOption,
} from "../dashboard/runtime/dashboardDatasetAdapters";
import type { DashboardDatasetOption } from "../dashboard/runtime/dashboardRuntimeTypes";
import {
  dashboardWidgetDefinitions,
  defaultWidgetColorConfig,
} from "../dashboard/runtime/widgetDefinitions";
import { WidgetRenderer } from "../dashboard/runtime/WidgetRenderer";

export type SqlChartType = DashboardRuntimeWidgetType;

export type SqlChartSource = {
  dataset: DashboardDatasetOption;
  id: string;
  kind: "dataset" | "sql_result";
  label: string;
  scope?: "full_result";
  sourceRowCount?: number;
};

export type SqlChartConfig = {
  config: DashboardRuntimeWidgetConfig;
  sourceId: string;
  title: string;
  type: SqlChartType;
};

export function createSqlResultChartSource(resultDraft: SqlResultDraft): SqlChartSource {
  return {
    dataset: sqlResultToDashboardOption(resultDraft),
    id: `sql-result:${resultDraft.runId}`,
    kind: "sql_result",
    label: `${resultDraft.datasetName} · SQL 결과`,
  };
}

export function createCatalogChartSource(dataset: CatalogDataset): SqlChartSource {
  return {
    dataset: catalogDatasetToDashboardOption(dataset),
    id: `dataset:${dataset.id}`,
    kind: "dataset",
    label: dataset.name,
  };
}

export function buildSqlChartSources(
  resultDraft: SqlResultDraft,
  selectedDatasets: CatalogDataset[] = [],
) {
  const seen = new Set<string>();
  const datasetSources = selectedDatasets.flatMap((dataset) => {
    if (dataset.status !== "available" || dataset.schema.length === 0 || seen.has(dataset.id)) return [];
    seen.add(dataset.id);
    return [createCatalogChartSource(dataset)];
  });

  return [createSqlResultChartSource(resultDraft), ...datasetSources];
}

export function createDefaultSqlChartConfig(
  source: SqlChartSource,
): SqlChartConfig {
  const categoryColumn = source.dataset.columns.find((column) => column.type !== "number")
    ?? source.dataset.columns[0];
  const valueColumn = source.dataset.columns.find((column) => column.type === "number");

  return {
    config: {
      aggregation: valueColumn ? "sum" : "count",
      color: defaultWidgetColorConfig,
      orientation: "vertical",
      xKey: categoryColumn?.name ?? "",
      yKey: valueColumn?.name ?? "",
    },
    sourceId: source.id,
    title: source.label,
    type: "bar_chart",
  };
}

export function getSqlChartConfigError(
  config: SqlChartConfig,
  source: SqlChartSource | undefined,
) {
  if (!source) return "차트에 사용할 데이터 소스를 선택해 주세요.";
  if (config.sourceId !== source.id) return "차트 데이터 소스를 다시 선택해 주세요.";
  if (source.dataset.columns.length === 0) return "차트에 사용할 컬럼이 없습니다.";
  return null;
}

export function buildSqlChartWidget(
  source: SqlChartSource,
  config: SqlChartConfig,
): DashboardRuntimeWidget {
  const common = {
    data: source.dataset.rows?.map((row) => ({ ...row })) ?? [],
    datasetId: source.dataset.id,
    id: `sql-chart-${source.id}`,
    layout: { h: 8, minH: 4, minW: 4, w: 12, x: 0, y: 0 },
    pageId: "sql-chart-preview",
    queryId: null,
    title: config.title || source.label,
  };
  return {
    ...common,
    config: config.config,
    type: config.type,
  } as DashboardRuntimeWidget;
}

export function SqlResultChart({
  chartConfig,
  resultDraft,
  source,
}: {
  chartConfig?: SqlChartConfig;
  resultDraft?: SqlResultDraft;
  source?: SqlChartSource;
}) {
  const resolvedSource = useMemo(
    () => source ?? (resultDraft ? createSqlResultChartSource(resultDraft) : undefined),
    [resultDraft, source],
  );
  const resolvedConfig = useMemo(
    () => chartConfig ?? (resolvedSource ? createDefaultSqlChartConfig(resolvedSource) : undefined),
    [chartConfig, resolvedSource],
  );
  const widget = useMemo(
    () => resolvedSource && resolvedConfig ? buildSqlChartWidget(resolvedSource, resolvedConfig) : null,
    [resolvedConfig, resolvedSource],
  );

  if (!resolvedSource || !resolvedConfig || !widget) return null;

  const widgetDefinition = dashboardWidgetDefinitions[resolvedConfig.type];
  return (
    <section className="grid min-h-[320px] min-w-[720px] grid-rows-[max-content_minmax(0,1fr)] gap-2 px-4 pb-3 pt-2" aria-label="SQL 결과 차트">
      <div className="sql-result-chart-header flex min-w-0 items-center gap-2">
        <strong className="text-base">{resolvedConfig.title || resolvedSource.label}</strong>
        <span className="shrink-0 text-sm text-muted-foreground">{widgetDefinition.label}</span>
        {resolvedSource.scope === "full_result" ? (
          <span className="shrink-0 text-sm text-muted-foreground">
            전체 {(resolvedSource.sourceRowCount ?? 0).toLocaleString()}행 서버 집계
          </span>
        ) : null}
      </div>
      <div className="h-[280px] min-h-0 overflow-hidden rounded-lg border bg-background">
        <WidgetRenderer widget={widget} />
      </div>
    </section>
  );
}
