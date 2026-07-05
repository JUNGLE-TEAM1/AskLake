import { memo, type CSSProperties } from "react";
import type { DashboardRuntimeWidget } from "../../../types";

type SimpleRow = Record<string, unknown>;
type ChartPoint = {
  label: string;
  value: number;
};

const chartColors = ["#2563eb", "#16a34a", "#f59e0b", "#dc2626", "#7c3aed", "#0891b2"];

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

function getConfigString(config: object, key: string) {
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function getConfigNumber(config: object, key: string) {
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getConfigColumns(config: object) {
  const columns = (config as Record<string, unknown>).columns;
  if (Array.isArray(columns)) {
    return columns.filter((column): column is string => typeof column === "string" && column.trim().length > 0);
  }
  return null;
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

function labelValue(row: SimpleRow, key: string | null, fallback: string) {
  const value = key ? row[key] : undefined;
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function chartPoints(widget: DashboardRuntimeWidget) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const labelKey =
    getConfigString(widget.config, "xKey")
    ?? getConfigString(widget.config, "xAxis")
    ?? getConfigString(widget.config, "labelKey")
    ?? getConfigString(widget.config, "categoryField")
    ?? firstTextKey(firstRow);
  const valueKey =
    getConfigString(widget.config, "yKey")
    ?? getConfigString(widget.config, "yAxis")
    ?? getConfigString(widget.config, "valueKey")
    ?? getConfigString(widget.config, "valueField")
    ?? firstNumericKey(firstRow);

  return rows
    .map((row, index) => ({
      label: labelValue(row, labelKey, `#${index + 1}`),
      value: numericValue(row, valueKey),
    }))
    .filter((point): point is ChartPoint => point.value !== null)
    .slice(0, 12);
}

function EmptyWidgetData() {
  return <div className="asklake-widget-empty">표시할 데이터가 없습니다.</div>;
}

function WidgetDataError() {
  return <div className="asklake-widget-empty error">위젯 데이터를 불러오지 못했습니다.</div>;
}

function MetricWidget({ widget }: { widget: DashboardRuntimeWidget }) {
  const rows = rowsFromWidget(widget);
  const firstRow = rows[0];
  const valueKey =
    getConfigString(widget.config, "valueKey")
    ?? getConfigString(widget.config, "valueField")
    ?? getConfigString(widget.config, "yKey")
    ?? firstNumericKey(firstRow);
  const labelKey = getConfigString(widget.config, "labelKey") ?? getConfigString(widget.config, "xKey") ?? firstTextKey(firstRow);
  const metricValue = firstRow ? numericValue(firstRow, valueKey) ?? Object.values(firstRow)[0] : null;
  const label = firstRow ? labelValue(firstRow, labelKey, "지표") : "지표";

  if (metricValue === undefined || metricValue === null) return <EmptyWidgetData />;

  return (
    <div className="asklake-metric-widget">
      <span>{label}</span>
      <strong>{formatCell(metricValue)}</strong>
    </div>
  );
}

function TableWidget({ widget }: { widget: DashboardRuntimeWidget }) {
  const rows = rowsFromWidget(widget);
  const configuredColumns = getConfigColumns(widget.config);
  const columns = (configuredColumns?.length ? configuredColumns : Object.keys(rows[0] ?? {})).slice(0, 8);
  const limit = Math.max(1, Math.min(getConfigNumber(widget.config, "limit") ?? 10, 100));
  if (!rows.length || !columns.length) return <EmptyWidgetData />;

  return (
    <div className="asklake-table-widget">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row, rowIndex) => (
            <tr key={`runtime-row-${rowIndex}`}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChartWidget({ widget }: { widget: DashboardRuntimeWidget }) {
  const points = chartPoints(widget).slice(0, 10);
  if (!points.length) return <EmptyWidgetData />;

  const maxValue = Math.max(...points.map((point) => point.value), 1);

  return (
    <div className="asklake-bar-widget">
      {points.map((point, index) => (
        <span
          key={`${point.label}-${index}`}
          style={{ height: `${Math.max(10, (point.value / maxValue) * 100)}%` }}
          title={`${point.label}: ${formatCell(point.value)}`}
        >
          <i>{point.label}</i>
        </span>
      ))}
    </div>
  );
}

function LineChartWidget({ widget }: { widget: DashboardRuntimeWidget }) {
  const points = chartPoints(widget);
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

  return (
    <div className="asklake-line-widget">
      <svg aria-label="라인 차트" preserveAspectRatio="none" viewBox={`0 0 ${width} ${height}`}>
        <polyline points={polyline} />
        {coordinates.map((point, index) => (
          <circle key={`${point.label}-${index}`} cx={point.x} cy={point.y} r="2.5">
            <title>{`${point.label}: ${formatCell(point.value)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function DonutChartWidget({ widget }: { widget: DashboardRuntimeWidget }) {
  const points = chartPoints(widget).slice(0, 6);
  if (!points.length) return <EmptyWidgetData />;

  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  if (total <= 0) return <EmptyWidgetData />;

  let cursor = 0;
  const segments = points.map((point, index) => {
    const start = cursor;
    const size = (Math.max(0, point.value) / total) * 100;
    cursor += size;
    return `${chartColors[index % chartColors.length]} ${start}% ${cursor}%`;
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
            <i style={{ background: chartColors[index % chartColors.length] }} />
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
