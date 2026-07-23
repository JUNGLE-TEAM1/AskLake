import type { ApexOptions } from "apexcharts";
import type { DashboardWidgetOrientation } from "../../../types";
import type { ChartValueAxisRange } from "./chartAxisRange";

const VERTICAL_CATEGORY_LABEL_MAX_LENGTH = 10;
const HORIZONTAL_CATEGORY_LABEL_MAX_LENGTH = 24;

export function barChartFieldLabels(orientation: DashboardWidgetOrientation = "vertical") {
  return orientation === "horizontal"
    ? { category: "분류 컬럼 (Y축)", value: "값 컬럼 (X축)" }
    : { category: "분류 컬럼 (X축)", value: "값 컬럼 (Y축)" };
}

export function formatChartCategoryAxisLabel(value: unknown, maxLength = VERTICAL_CATEGORY_LABEL_MAX_LENGTH) {
  const text = String(value ?? "");
  const dayMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dayMatch) return `${dayMatch[1].slice(2)}.${dayMatch[2]}.${dayMatch[3]}`;

  const monthMatch = text.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) return `${monthMatch[1].slice(2)}.${monthMatch[2]}`;

  if (text.length > maxLength) return `${text.slice(0, Math.max(1, maxLength - 1))}...`;
  return text;
}

export function formatChartAxisNumber(value: unknown) {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : Number.NaN;

  if (!Number.isFinite(numericValue)) return String(value ?? "");

  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 1,
    notation: Math.abs(numericValue) >= 10000 ? "compact" : "standard",
  }).format(numericValue);
}

export function barChartAxisLabelFormatters(orientation: DashboardWidgetOrientation = "vertical") {
  if (orientation === "horizontal") {
    return {
      x: formatChartAxisNumber,
      y: (value: unknown) => formatChartCategoryAxisLabel(value, HORIZONTAL_CATEGORY_LABEL_MAX_LENGTH),
    };
  }

  return {
    x: (value: unknown) => formatChartCategoryAxisLabel(value, VERTICAL_CATEGORY_LABEL_MAX_LENGTH),
    y: formatChartAxisNumber,
  };
}

export function buildBarChartAxes(
  baseOptions: ApexOptions,
  categories: string[],
  orientation: DashboardWidgetOrientation,
  valueAxisRange: ChartValueAxisRange,
): Pick<ApexOptions, "xaxis" | "yaxis"> {
  const isHorizontal = orientation === "horizontal";
  const axisFormatters = barChartAxisLabelFormatters(orientation);
  const baseYAxis = Array.isArray(baseOptions.yaxis) ? baseOptions.yaxis[0] : baseOptions.yaxis;
  return {
    xaxis: {
      ...baseOptions.xaxis,
      categories,
      ...(isHorizontal ? valueAxisRange : {}),
      labels: {
        ...baseOptions.xaxis?.labels,
        formatter: axisFormatters.x,
      },
    },
    yaxis: {
      ...baseYAxis,
      ...(isHorizontal ? {} : valueAxisRange),
      labels: {
        ...baseYAxis?.labels,
        formatter: axisFormatters.y,
        ...(isHorizontal ? { maxWidth: 220 } : {}),
      },
    },
  };
}
