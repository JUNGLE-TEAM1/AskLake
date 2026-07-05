import { memo, type CSSProperties } from "react";
import type {
  DashboardRuntimeWidget,
  DashboardWidgetAggregation,
  DashboardWidgetDateUnit,
  DashboardWidgetSortDirection,
} from "../../../types";

type SimpleRow = Record<string, unknown>;
type ChartPoint = {
  label: string;
  sortValue: number | string;
  value: number;
};
type RuntimeWidgetByType<Type extends DashboardRuntimeWidget["type"]> = Extract<DashboardRuntimeWidget, { type: Type }>;

const chartColors = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];
const chartColorByConfig: Record<string, string> = {
  amber: "#f59e0b",
  blue: "#2563eb",
  green: "#16a34a",
  slate: "#475569",
};
const aggregationLabels: Record<DashboardWidgetAggregation, string> = {
  avg: "평균",
  count: "개수",
  max: "최대",
  min: "최소",
  sum: "합계",
};
const validAggregations = new Set<DashboardWidgetAggregation>(["avg", "count", "max", "min", "sum"]);

function isSimpleRow(value: unknown): value is SimpleRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsFromWidget(widget: DashboardRuntimeWidget) {
  return Array.isArray(widget.data) ? widget.data.filter(isSimpleRow) : [];
}

export function formatCell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat("ko-KR").format(value);
  return String(value);
}

function firstNumericKey(row: SimpleRow | undefined) {
  if (!row) return null;
  return Object.keys(row).find((key) => typeof row[key] === "number") ?? null;
}

function firstTextKey(row: SimpleRow | undefined) {
  if (!row) return null;
  return Object.keys(row).find((key) => typeof row[key] === "string") ?? null;
}

function numericValue(row: SimpleRow, key: string | null) {
  const value = key ? row[key] : undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function labelValue(row: SimpleRow, key: string | null, fallback: string, dateUnit?: DashboardWidgetDateUnit) {
  const value = key ? row[key] : undefined;
  if (value === null || value === undefined || value === "") return fallback;
  if (dateUnit) return bucketDateLabel(value, dateUnit) ?? String(value);
  return String(value);
}

function aggregationValue(value: unknown, fallback: DashboardWidgetAggregation = "sum") {
  return typeof value === "string" && validAggregations.has(value as DashboardWidgetAggregation)
    ? value as DashboardWidgetAggregation
    : fallback;
}

function aggregateNumbers(values: number[], aggregation: DashboardWidgetAggregation) {
  if (aggregation === "count") return values.length;
  if (!values.length) return null;
  if (aggregation === "avg") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (aggregation === "max") return Math.max(...values);
  if (aggregation === "min") return Math.min(...values);
  return values.reduce((sum, value) => sum + value, 0);
}

function sortComparableValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const numeric = Number(trimmed.replace(/,/g, ""));
    if (Number.isFinite(numeric)) return numeric;
    const timestamp = Date.parse(trimmed);
    if (Number.isFinite(timestamp)) return timestamp;
    return trimmed.toLocaleLowerCase();
  }
  if (value instanceof Date) return value.getTime();
  return String(value ?? "");
}

function compareValues(a: unknown, b: unknown) {
  const left = sortComparableValue(a);
  const right = sortComparableValue(b);
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "ko-KR", { numeric: true });
}

function sortRows(rows: SimpleRow[], sortKey: string | undefined, sortDirection: DashboardWidgetSortDirection | undefined) {
  if (!sortKey) return rows;
  const direction = sortDirection === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => compareValues(a[sortKey], b[sortKey]) * direction);
}

function bucketDateLabel(value: unknown, dateUnit: DashboardWidgetDateUnit) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  if (dateUnit === "year") return String(year);
  if (dateUnit === "month") return `${year}-${month}`;
  return `${year}-${month}-${day}`;
}

function groupedChartPoints({
  aggregation,
  dateUnit,
  labelKey,
  limit,
  rows,
  sortByLabel = false,
  valueKey,
}: {
  aggregation: DashboardWidgetAggregation;
  dateUnit?: DashboardWidgetDateUnit;
  labelKey: string | null;
  limit: number;
  rows: SimpleRow[];
  sortByLabel?: boolean;
  valueKey: string | null;
}) {
  const groups = new Map<string, { label: string; order: number; sortValue: number | string; values: number[] }>();

  rows.forEach((row, index) => {
    const label = labelValue(row, labelKey, `#${index + 1}`, dateUnit);
    const value = aggregation === "count" ? 1 : numericValue(row, valueKey);
    if (value === null) return;

    const group = groups.get(label) ?? {
      label,
      order: index,
      sortValue: labelKey ? sortComparableValue(dateUnit ? label : row[labelKey]) : index,
      values: [],
    };
    group.values.push(value);
    groups.set(label, group);
  });

  const points = Array.from(groups.values())
    .map((group) => {
      const value = aggregateNumbers(group.values, aggregation);
      return value === null ? null : { label: group.label, sortValue: group.sortValue, value };
    })
    .filter((point): point is ChartPoint => point !== null);

  points.sort((a, b) => {
    if (sortByLabel) return compareValues(a.sortValue, b.sortValue);
    const first = groups.get(a.label)?.order ?? 0;
    const second = groups.get(b.label)?.order ?? 0;
    return first - second;
  });

  return points.slice(0, limit);
}

function configColor(color: string | undefined) {
  return color ? chartColorByConfig[color] ?? color : chartColorByConfig.blue;
}

function gradientFromColor(color: string) {
  return `linear-gradient(180deg, ${color} 0%, ${color} 100%)`;
}

function EmptyWidgetData() {
  return <div className="asklake-widget-empty">표시할 데이터가 없습니다.</div>;
}

function WidgetDataError() {
  return <div className="asklake-widget-empty error">위젯 데이터를 불러오지 못했습니다.</div>;
}

function MetricWidget({ widget }: { widget: RuntimeWidgetByType<"metric"> }) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const aggregation = aggregationValue(widget.config.aggregation);
  const valueKey = widget.config.valueKey || firstNumericKey(firstRow);
  const values = aggregation === "count"
    ? rows.map(() => 1)
    : rows.map((row) => numericValue(row, valueKey)).filter((value): value is number => value !== null);
  const metricValue = aggregateNumbers(values, aggregation);
  const label = valueKey ? `${aggregationLabels[aggregation]} ${valueKey}` : aggregationLabels[aggregation];

  if (metricValue === null) return <EmptyWidgetData />;

  return (
    <div className="asklake-metric-widget">
      <span>{label}</span>
      <strong>{formatCell(metricValue)}</strong>
    </div>
  );
}

function TableWidget({ widget }: { widget: RuntimeWidgetByType<"table"> }) {
  const rows = rowsFromWidget(widget);
  const availableColumns = Object.keys(rows[0] ?? {});
  const configuredColumns = Array.isArray(widget.config.columns)
    ? widget.config.columns.filter((column) => availableColumns.includes(column))
    : [];
  const columns = (configuredColumns.length ? configuredColumns : availableColumns).slice(0, 8);
  const limit = Math.max(1, Math.min(widget.config.limit ?? 10, 100));
  if (!rows.length || !columns.length) return <EmptyWidgetData />;
  const sortedRows = sortRows(rows, widget.config.sortKey, widget.config.sortDirection);

  return (
    <div className="asklake-table-widget">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {sortedRows.slice(0, limit).map((row, rowIndex) => (
            <tr key={`runtime-row-${rowIndex}`}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChartWidget({ widget }: { widget: RuntimeWidgetByType<"bar_chart"> }) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const aggregation = aggregationValue(widget.config.aggregation);
  const labelKey = widget.config.xKey || firstTextKey(firstRow);
  const valueKey = widget.config.yKey || firstNumericKey(firstRow);
  const points = groupedChartPoints({ aggregation, labelKey, limit: 10, rows, valueKey });
  if (!points.length) return <EmptyWidgetData />;

  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const color = configColor(widget.config.color);

  return (
    <div className="asklake-bar-widget">
      {points.map((point, index) => (
        <span
          key={`${point.label}-${index}`}
          style={{
            background: gradientFromColor(color),
            height: `${Math.max(10, (point.value / maxValue) * 100)}%`,
          }}
          title={`${point.label}: ${formatCell(point.value)}`}
        >
          <i>{point.label}</i>
        </span>
      ))}
    </div>
  );
}

function LineChartWidget({ widget }: { widget: RuntimeWidgetByType<"line_chart"> }) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const aggregation = aggregationValue(widget.config.aggregation);
  const labelKey = widget.config.xKey || firstTextKey(firstRow);
  const valueKey = widget.config.yKey || firstNumericKey(firstRow);
  const points = groupedChartPoints({
    aggregation,
    dateUnit: widget.config.dateUnit,
    labelKey,
    limit: 12,
    rows,
    sortByLabel: true,
    valueKey,
  });
  if (!points.length) return <EmptyWidgetData />;

  const values = points.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = Math.max(1, maxValue - minValue);
  const width = 100;
  const height = 72;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const coordinates = points.map((point, index) => {
    const x = points.length > 1 ? index * step : width / 2;
    const y = height - ((point.value - minValue) / range) * (height - 8) - 4;
    return { ...point, x, y };
  });
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  const color = configColor(widget.config.color);

  return (
    <div className="asklake-line-widget">
      <svg aria-label="라인 차트" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <polyline points={polyline} style={{ stroke: color }} />
        {coordinates.map((point, index) => (
          <circle key={`${point.label}-${index}`} cx={point.x} cy={point.y} r="2.5" style={{ stroke: color }}>
            <title>{`${point.label}: ${formatCell(point.value)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function DonutChartWidget({ widget }: { widget: RuntimeWidgetByType<"donut_chart"> }) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const aggregation = aggregationValue(widget.config.aggregation);
  const labelKey = widget.config.labelKey || firstTextKey(firstRow);
  const valueKey = widget.config.valueKey || firstNumericKey(firstRow);
  const points = groupedChartPoints({ aggregation, labelKey, limit: 6, rows, valueKey });
  if (!points.length) return <EmptyWidgetData />;

  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  if (total <= 0) return <EmptyWidgetData />;

  let cursor = 0;
  const segments = points.map((point, index) => {
    const start = cursor;
    const size = (Math.max(0, point.value) / total) * 100;
    cursor += size;
    const color = index === 0 ? configColor(widget.config.color) : chartColors[index % chartColors.length];
    return `${color} ${start}% ${cursor}%`;
  });
  const ringStyle = {
    "--asklake-donut-segments": segments.join(", "),
  } as CSSProperties;

  return (
    <div className="asklake-donut-widget">
      <div className="asklake-donut-widget__ring" style={ringStyle} />
      <div className="asklake-donut-widget__legend">
        {points.map((point, index) => (
          <p key={`${point.label}-${index}`}>
            <i style={{ background: index === 0 ? configColor(widget.config.color) : chartColors[index % chartColors.length] }} />
            <span>{point.label}</span>
            <strong>{formatCell(point.value)}</strong>
          </p>
        ))}
      </div>
    </div>
  );
}

export const WidgetRenderer = memo(function WidgetRenderer({ widget }: { widget: DashboardRuntimeWidget }) {
  const hasError = Boolean(widget.config.error || widget.config.errorMessage);
  if (hasError) return <WidgetDataError />;

  if (widget.type === "metric") return <MetricWidget widget={widget} />;
  if (widget.type === "table") return <TableWidget widget={widget} />;
  if (widget.type === "bar_chart") return <BarChartWidget widget={widget} />;
  if (widget.type === "line_chart") return <LineChartWidget widget={widget} />;
  if (widget.type === "donut_chart") return <DonutChartWidget widget={widget} />;

  return <EmptyWidgetData />;
});
