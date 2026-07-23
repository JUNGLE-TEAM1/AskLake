import type {
  DashboardRuntimeWidgetType,
  DashboardWidgetAggregation,
  DashboardWidgetAxisRangeMode,
  DashboardWidgetDateUnit,
  DashboardWidgetFilter,
  DashboardWidgetFormat,
  DashboardWidgetLineCurve,
  DashboardWidgetOrientation,
  DashboardWidgetSortDirection,
} from "../../../types";
import type { DashboardDatasetColumn } from "./dashboardRuntimeTypes";
import { validateChartValueAxisRange } from "./chartAxisRange";
import { validateDashboardWidgetFilters } from "./widgetFilters";

export type WidgetConfigDraft = {
  aggregation?: DashboardWidgetAggregation;
  columns?: string[];
  curve?: DashboardWidgetLineCurve;
  dateUnit?: DashboardWidgetDateUnit;
  format?: DashboardWidgetFormat;
  filters?: DashboardWidgetFilter[];
  groupKey?: string;
  labelKey?: string;
  limit?: number;
  max?: number;
  min?: number;
  orientation?: DashboardWidgetOrientation;
  seriesKey?: string;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
  stacked?: boolean;
  valueKey?: string;
  valueAxisMax?: number;
  valueAxisMin?: number;
  valueAxisRangeMode?: DashboardWidgetAxisRangeMode;
  xKey?: string;
  yKey?: string;
};

export function validateWidgetConfig(
  type: DashboardRuntimeWidgetType,
  config: WidgetConfigDraft,
  columns: DashboardDatasetColumn[] = [],
) {
  const usesCount = config.aggregation === "count";
  if (type === "metric" && !usesCount && !config.valueKey) return "값 컬럼을 선택해 주세요.";
  if (type === "table" && (!config.columns || config.columns.length === 0)) return "표시할 컬럼을 1개 이상 선택해 주세요.";
  if (type === "bar_chart" && (!config.xKey || (!usesCount && !config.yKey))) {
    return "분류 컬럼과 값 컬럼을 선택해 주세요.";
  }
  if ((type === "line_chart" || type === "area_chart") && (!config.xKey || (!usesCount && !config.yKey))) {
    return "X축과 Y축 컬럼을 선택해 주세요.";
  }
  if (type === "bar_chart" || type === "line_chart" || type === "area_chart") {
    const axisRangeError = validateChartValueAxisRange(config);
    if (axisRangeError) return axisRangeError;
  }
  if ((type === "donut_chart" || type === "pie_chart" || type === "treemap_chart") && (!config.labelKey || (!usesCount && !config.valueKey))) {
    return "분류와 값 컬럼을 선택해 주세요.";
  }
  if (type === "radial_bar_chart" && !usesCount && !config.valueKey) return "값 컬럼을 선택해 주세요.";
  if (type === "radial_bar_chart" && (config.min ?? 0) >= (config.max ?? 100)) return "최솟값은 최댓값보다 작아야 합니다.";
  if (type === "heatmap_chart" && (!config.xKey || !config.yKey || (!usesCount && !config.valueKey))) {
    return "X축, Y축, 값 컬럼을 선택해 주세요.";
  }
  return validateDashboardWidgetFilters(config.filters ?? [], columns);
}
