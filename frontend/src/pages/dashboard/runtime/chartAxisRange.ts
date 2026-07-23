import type {
  DashboardWidgetAxisRangeMode,
  DashboardWidgetValueAxisRangeConfig,
} from "../../../types";

export const DATA_FOCUS_AXIS_PADDING_RATIO = 0.08;

export type ChartValueAxisRange = {
  max?: number;
  min?: number;
};

type ChartSeries = {
  data: unknown[];
};

const valueAxisRangeModes = new Set<DashboardWidgetAxisRangeMode>([
  "default",
  "data_focus",
  "manual",
]);

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function niceStep(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const fraction = value / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
}

export function dataFocusValueAxisRange(values: number[]): ChartValueAxisRange {
  const finiteValues = values.filter(Number.isFinite);
  if (!finiteValues.length) return {};

  const dataMin = Math.min(...finiteValues);
  const dataMax = Math.max(...finiteValues);
  const dataSpan = dataMax - dataMin;
  const padding = dataSpan > 0
    ? dataSpan * DATA_FOCUS_AXIS_PADDING_RATIO
    : (Math.abs(dataMin) > 0 ? Math.abs(dataMin) * 0.05 : 1);
  const rawMin = dataMin - padding;
  const rawMax = dataMax + padding;
  const step = niceStep((rawMax - rawMin) / 10);
  const min = normalizeZero(Math.floor(rawMin / step) * step);
  const max = normalizeZero(Math.ceil(rawMax / step) * step);

  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return {};
  return { max, min };
}

export function chartSeriesValues(series: ChartSeries[], stacked = false) {
  if (!stacked) {
    return series.flatMap(({ data }) => data.flatMap((value) => {
      const numeric = finiteNumber(value);
      return numeric === undefined ? [] : [numeric];
    }));
  }

  const values: number[] = [];
  const pointCount = Math.max(0, ...series.map(({ data }) => data.length));
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    let negativeTotal = 0;
    let positiveTotal = 0;
    for (const item of series) {
      const value = finiteNumber(item.data[pointIndex]);
      if (value === undefined) continue;
      if (value < 0) {
        negativeTotal += value;
        values.push(negativeTotal);
      } else {
        positiveTotal += value;
        values.push(positiveTotal);
      }
    }
  }
  return values;
}

export function resolveChartValueAxisRange(
  config: DashboardWidgetValueAxisRangeConfig,
  series: ChartSeries[],
  options: { stacked?: boolean } = {},
): ChartValueAxisRange {
  const mode = config.valueAxisRangeMode ?? "default";
  if (mode === "default") return {};

  if (mode === "manual") {
    const min = finiteNumber(config.valueAxisMin);
    const max = finiteNumber(config.valueAxisMax);
    if ((min === undefined && max === undefined) || (min !== undefined && max !== undefined && min >= max)) {
      return {};
    }
    return {
      ...(max === undefined ? {} : { max }),
      ...(min === undefined ? {} : { min }),
    };
  }

  return dataFocusValueAxisRange(chartSeriesValues(series, options.stacked));
}

export function validateChartValueAxisRange(config: DashboardWidgetValueAxisRangeConfig) {
  const mode = config.valueAxisRangeMode ?? "default";
  if (!valueAxisRangeModes.has(mode)) return "지원하지 않는 값 축 범위 방식입니다.";
  if (mode !== "manual") return null;

  const { valueAxisMax, valueAxisMin } = config;
  if (valueAxisMin === undefined && valueAxisMax === undefined) {
    return "직접 설정할 최솟값 또는 최댓값을 입력해 주세요.";
  }
  if (
    (valueAxisMin !== undefined && !Number.isFinite(valueAxisMin))
    || (valueAxisMax !== undefined && !Number.isFinite(valueAxisMax))
  ) {
    return "값 축 범위에는 유효한 숫자를 입력해 주세요.";
  }
  if (valueAxisMin !== undefined && valueAxisMax !== undefined && valueAxisMin >= valueAxisMax) {
    return "값 축 최솟값은 최댓값보다 작아야 합니다.";
  }
  return null;
}
