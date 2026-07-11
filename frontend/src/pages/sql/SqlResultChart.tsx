import { useMemo } from "react";

import type {
  CatalogDataset,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetType,
  DashboardWidgetAggregation,
  SqlResultDraft,
} from "../../types";
import {
  catalogDatasetToDashboardOption,
  sqlResultToDashboardOption,
} from "../dashboard/runtime/dashboardDatasetAdapters";
import type { DashboardDatasetOption } from "../dashboard/runtime/dashboardRuntimeTypes";
import { defaultWidgetColorConfig } from "../dashboard/runtime/widgetDefinitions";
import { WidgetRenderer } from "../dashboard/runtime/WidgetRenderer";

export type SqlChartType = Extract<
  DashboardRuntimeWidgetType,
  "area_chart" | "bar_chart" | "donut_chart" | "line_chart"
>;

export type SqlChartSource = {
  dataset: DashboardDatasetOption;
  id: string;
  kind: "dataset" | "sql_result";
  label: string;
};

export type SqlChartConfig = {
  aggregation: DashboardWidgetAggregation;
  categoryKey: string;
  sourceId: string;
  type: SqlChartType;
  valueKey: string;
};

export const sqlChartTypes: SqlChartType[] = [
  "bar_chart",
  "line_chart",
  "area_chart",
  "donut_chart",
];

export const sqlChartAggregations: DashboardWidgetAggregation[] = [
  "sum",
  "avg",
  "count",
  "min",
  "max",
];

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
  type: SqlChartType = "bar_chart",
): SqlChartConfig {
  const categoryColumn = source.dataset.columns.find((column) => column.type !== "number")
    ?? source.dataset.columns[0];
  const valueColumn = source.dataset.columns.find((column) => column.type === "number");

  return {
    aggregation: valueColumn ? "sum" : "count",
    categoryKey: categoryColumn?.name ?? "",
    sourceId: source.id,
    type,
    valueKey: valueColumn?.name ?? "",
  };
}

export function getSqlChartConfigError(
  config: SqlChartConfig,
  source: SqlChartSource | undefined,
) {
  if (!source) return "차트에 사용할 데이터 소스를 선택해 주세요.";
  const columnNames = new Set(source.dataset.columns.map((column) => column.name));
  if (!config.categoryKey || !columnNames.has(config.categoryKey)) return "분류 또는 X축 컬럼을 선택해 주세요.";
  if (config.aggregation !== "count") {
    const valueColumn = source.dataset.columns.find((column) => column.name === config.valueKey);
    if (!valueColumn || valueColumn.type !== "number") return "숫자 값 컬럼을 선택해 주세요.";
  }
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
    title: source.label,
  };
  const chartBase = {
    aggregation: config.aggregation,
    color: defaultWidgetColorConfig,
  };

  if (config.type === "line_chart") {
    return {
      ...common,
      config: {
        ...chartBase,
        curve: "smooth",
        xKey: config.categoryKey,
        yKey: config.valueKey,
      },
      type: "line_chart",
    };
  }

  if (config.type === "area_chart") {
    return {
      ...common,
      config: {
        ...chartBase,
        stacked: false,
        xKey: config.categoryKey,
        yKey: config.valueKey,
      },
      type: "area_chart",
    };
  }

  if (config.type === "donut_chart") {
    return {
      ...common,
      config: {
        ...chartBase,
        labelKey: config.categoryKey,
        valueKey: config.valueKey,
      },
      type: "donut_chart",
    };
  }

  return {
    ...common,
    config: {
      ...chartBase,
      orientation: "vertical",
      xKey: config.categoryKey,
      yKey: config.valueKey,
    },
    type: "bar_chart",
  };
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

  const valueLabel = resolvedConfig.aggregation === "count" ? "행 개수" : resolvedConfig.valueKey;
  return (
    <section className="grid min-h-[360px] min-w-[720px] grid-rows-[max-content_minmax(0,1fr)] gap-3 p-4" aria-label="SQL 결과 차트">
      <div className="grid gap-1">
        <strong className="text-base">{resolvedSource.label}</strong>
        <span className="text-sm text-muted-foreground">
          {resolvedConfig.categoryKey} 기준 · {valueLabel} · {resolvedConfig.aggregation}
        </span>
      </div>
      <div className="h-[360px] min-h-0 overflow-hidden rounded-lg border bg-background">
        <WidgetRenderer widget={widget} />
      </div>
    </section>
  );
}
