import type { DashboardRuntimeWidget } from "../../../types";

type SimpleRow = Record<string, unknown>;

function formatCell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat("ko-KR").format(value);
  return String(value);
}

function firstNumericValue(row: SimpleRow | undefined) {
  if (!row) return null;
  const value = Object.values(row).find((cell) => typeof cell === "number");
  return typeof value === "number" ? value : null;
}

function firstLabelValue(row: SimpleRow | undefined) {
  if (!row) return "";
  const value = Object.values(row).find((cell) => typeof cell === "string");
  return typeof value === "string" ? value : "";
}

function EmptyWidgetData() {
  return <div className="asklake-widget-empty">표시할 데이터가 없습니다.</div>;
}

function MetricWidget({ rows }: { rows: SimpleRow[] }) {
  const firstRow = rows[0];
  const metricValue = firstNumericValue(firstRow) ?? Object.values(firstRow ?? {})[0];
  const label = firstLabelValue(firstRow) || "Metric";

  if (metricValue === undefined || metricValue === null) return <EmptyWidgetData />;

  return (
    <div className="asklake-metric-widget">
      <span>{label}</span>
      <strong>{formatCell(metricValue)}</strong>
    </div>
  );
}

function TableWidget({ rows }: { rows: SimpleRow[] }) {
  const columns = Object.keys(rows[0] ?? {}).slice(0, 6);
  if (!rows.length || !columns.length) return <EmptyWidgetData />;

  return (
    <div className="asklake-table-widget">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((row, rowIndex) => (
            <tr key={`runtime-row-${rowIndex}`}>
              {columns.map((column) => <td key={column}>{formatCell(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChartWidget({ rows }: { rows: SimpleRow[] }) {
  const points = rows
    .map((row) => ({
      label: firstLabelValue(row),
      value: firstNumericValue(row),
    }))
    .filter((point): point is { label: string; value: number } => point.value !== null)
    .slice(0, 10);

  if (!points.length) return <EmptyWidgetData />;

  const maxValue = Math.max(...points.map((point) => point.value), 1);

  return (
    <div className="asklake-bar-widget">
      {points.map((point, index) => (
        <span
          key={`${point.label || "point"}-${index}`}
          style={{ height: `${Math.max(12, (point.value / maxValue) * 100)}%` }}
          title={`${point.label}: ${formatCell(point.value)}`}
        >
          <i>{point.label || `#${index + 1}`}</i>
        </span>
      ))}
    </div>
  );
}

function LineChartWidget({ rows }: { rows: SimpleRow[] }) {
  const values = rows
    .map((row) => firstNumericValue(row))
    .filter((value): value is number => value !== null)
    .slice(0, 12);

  if (!values.length) return <EmptyWidgetData />;

  const maxValue = Math.max(...values, 1);

  return (
    <div className="asklake-line-widget">
      {values.map((value, index) => (
        <span
          key={`${value}-${index}`}
          style={{ height: `${Math.max(8, (value / maxValue) * 100)}%` }}
          title={formatCell(value)}
        />
      ))}
    </div>
  );
}

function DonutChartWidget({ rows }: { rows: SimpleRow[] }) {
  const points = rows
    .map((row) => ({
      label: firstLabelValue(row),
      value: firstNumericValue(row),
    }))
    .filter((point): point is { label: string; value: number } => point.value !== null)
    .slice(0, 4);

  if (!points.length) return <EmptyWidgetData />;

  return (
    <div className="asklake-donut-widget">
      <div className="asklake-donut-widget__ring" />
      <div className="asklake-donut-widget__legend">
        {points.map((point, index) => (
          <p key={`${point.label || "segment"}-${index}`}>
            <span>{point.label || `Segment ${index + 1}`}</span>
            <strong>{formatCell(point.value)}</strong>
          </p>
        ))}
      </div>
    </div>
  );
}

export function WidgetRenderer({ widget }: { widget: DashboardRuntimeWidget }) {
  const rows = Array.isArray(widget.data) ? widget.data : [];

  if (widget.type === "metric") return <MetricWidget rows={rows} />;
  if (widget.type === "table") return <TableWidget rows={rows} />;
  if (widget.type === "bar_chart") return <BarChartWidget rows={rows} />;
  if (widget.type === "line_chart") return <LineChartWidget rows={rows} />;
  if (widget.type === "donut_chart") return <DonutChartWidget rows={rows} />;

  return <EmptyWidgetData />;
}
