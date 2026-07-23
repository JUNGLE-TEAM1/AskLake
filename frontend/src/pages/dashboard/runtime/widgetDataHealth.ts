import type { DashboardRuntimeWidget } from "../../../types";

type RuntimeRow = Record<string, unknown>;

type RequiredField = {
  key: string;
  label: string;
  numeric?: boolean;
};

function rowsFromWidget(widget: DashboardRuntimeWidget): RuntimeRow[] {
  return Array.isArray(widget.data)
    ? widget.data.filter((row): row is RuntimeRow => typeof row === "object" && row !== null && !Array.isArray(row))
    : [];
}

function configString(widget: DashboardRuntimeWidget, key: string) {
  const value = (widget.config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function usesCount(widget: DashboardRuntimeWidget) {
  return configString(widget, "aggregation") === "count";
}

function requiredFields(widget: DashboardRuntimeWidget): RequiredField[] {
  const count = usesCount(widget);
  const field = (key: string, label: string, numeric = false): RequiredField[] => {
    const value = configString(widget, key);
    return value ? [{ key: value, label, numeric }] : [];
  };

  switch (widget.type) {
    case "metric":
    case "radial_bar_chart":
      return count ? [] : field("valueKey", "값", true);
    case "bar_chart":
    case "line_chart":
    case "area_chart":
      return [...field("xKey", "분류"), ...(count ? [] : field("yKey", "값", true))];
    case "donut_chart":
    case "pie_chart":
    case "treemap_chart":
      return [...field("labelKey", "분류"), ...(count ? [] : field("valueKey", "값", true))];
    case "heatmap_chart":
      return [
        ...field("xKey", "X축"),
        ...field("yKey", "Y축"),
        ...(count ? [] : field("valueKey", "값", true)),
      ];
    default:
      return [];
  }
}

function hasNumericValue(rows: RuntimeRow[], key: string) {
  return rows.some((row) => {
    const value = row[key];
    return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
  });
}

export function widgetDataHealthMessage(widget: DashboardRuntimeWidget): string | null {
  const rows = rowsFromWidget(widget);
  if (!rows.length) return null;

  const availableColumns = new Set(rows.flatMap((row) => Object.keys(row)));
  for (const field of requiredFields(widget)) {
    if (!availableColumns.has(field.key)) return `설정한 ${field.label} 컬럼 '${field.key}'을(를) 데이터에서 찾을 수 없습니다.`;
    if (field.numeric && !hasNumericValue(rows, field.key)) return `설정한 ${field.label} 컬럼 '${field.key}'에 표시할 숫자 데이터가 없습니다.`;
  }

  return null;
}
