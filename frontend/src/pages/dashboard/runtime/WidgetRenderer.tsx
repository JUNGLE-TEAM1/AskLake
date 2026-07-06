import { memo, useEffect, useState, type FormEvent } from "react";
import type { ApexOptions } from "apexcharts";
import { AlertCircle, CheckCircle2, Loader2, Send } from "lucide-react";
import Chart from "react-apexcharts";
import type {
  DashboardRuntimeWidget,
  DashboardWidgetAggregation,
  DashboardWidgetDateUnit,
  DashboardWidgetSortDirection,
} from "../../../types";
import {
  buildDashboardAssistantWidgetContext,
  dashboardAssistantEndpointLabel,
  isDashboardAssistantConfigured,
  requestDashboardAssistant,
} from "../../../services/dashboardAssistantService";
import type { DashboardAssistantRuntimeContext } from "./dashboardRuntimeTypes";

type SimpleRow = Record<string, unknown>;
type ChartPoint = {
  label: string;
  sortValue: number | string;
  value: number;
};
type RuntimeWidgetByType<Type extends DashboardRuntimeWidget["type"]> = Extract<DashboardRuntimeWidget, { type: Type }>;
type WidgetConfigPatch = Record<string, unknown>;

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

function configText(widget: DashboardRuntimeWidget, key: string) {
  const value = (widget.config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function placeholderKind(widget: DashboardRuntimeWidget) {
  const kind = (widget.config as { placeholderKind?: unknown }).placeholderKind;
  return kind === "visualization_request" || kind === "text" ? kind : null;
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

function formatAxisNumber(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits: 1,
    notation: Math.abs(value) >= 10000 ? "compact" : "standard",
  }).format(value);
}

function buildBaseChartOptions(color: string): ApexOptions {
  return {
    chart: {
      animations: {
        enabled: true,
        speed: 450,
      },
      fontFamily: "inherit",
      foreColor: "#64748b",
      redrawOnParentResize: true,
      redrawOnWindowResize: true,
      toolbar: {
        show: false,
      },
      zoom: {
        enabled: false,
      },
    },
    colors: [color],
    dataLabels: {
      enabled: false,
    },
    grid: {
      borderColor: "#e2e8f0",
      padding: {
        bottom: 4,
        left: 8,
        right: 14,
        top: 8,
      },
      strokeDashArray: 4,
    },
    legend: {
      fontSize: "12px",
      fontWeight: 700,
      labels: {
        colors: "#475569",
      },
      markers: {
        size: 6,
      },
    },
    stroke: {
      curve: "smooth",
      lineCap: "round",
      width: 3,
    },
    theme: {
      mode: "light",
    },
    tooltip: {
      theme: "light",
      y: {
        formatter: (value: number) => formatCell(value),
      },
    },
    xaxis: {
      axisBorder: {
        color: "#cbd5e1",
      },
      axisTicks: {
        color: "#cbd5e1",
      },
      labels: {
        rotate: -20,
        style: {
          colors: "#64748b",
          fontSize: "11px",
          fontWeight: 700,
        },
        trim: true,
      },
      tooltip: {
        enabled: false,
      },
    },
    yaxis: {
      labels: {
        formatter: (value: number) => formatAxisNumber(value),
        style: {
          colors: "#64748b",
          fontSize: "11px",
          fontWeight: 700,
        },
      },
    },
  };
}

function RuntimeApexChart({
  options,
  series,
  type,
}: {
  options: ApexOptions;
  series: ApexOptions["series"];
  type: "bar" | "donut" | "line";
}) {
  return (
    <div className="asklake-apex-widget">
      <Chart height="100%" options={options} series={series} type={type} width="100%" />
    </div>
  );
}

function EmptyWidgetData() {
  return <div className="asklake-widget-empty">표시할 데이터가 없습니다.</div>;
}

function WidgetDataError() {
  return <div className="asklake-widget-empty error">위젯 데이터를 불러오지 못했습니다.</div>;
}

function VisualizationRequestWidget({
  assistantContext,
  onPatchConfig,
  widget,
}: {
  assistantContext?: DashboardAssistantRuntimeContext;
  onPatchConfig?: (patch: WidgetConfigPatch) => Promise<void> | void;
  widget: DashboardRuntimeWidget;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPromptEditing, setIsPromptEditing] = useState(false);
  const [prompt, setPrompt] = useState(() => configText(widget, "prompt"));
  const [requestTone, setRequestTone] = useState<"error" | "info" | "success" | null>(null);

  useEffect(() => {
    setPrompt(configText(widget, "prompt"));
    setIsPromptEditing(false);
  }, [widget.id, widget.config]);

  useEffect(() => {
    setMessage(null);
    setRequestTone(null);
  }, [widget.id]);

  const savePrompt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || !onPatchConfig || isSaving) return;

    setMessage(null);
    setRequestTone(null);
    setIsSaving(true);
    try {
      await onPatchConfig({ prompt: nextPrompt });
      if (!isDashboardAssistantConfigured()) {
        setRequestTone("info");
        setMessage(`${dashboardAssistantEndpointLabel()} 설정 후 이 요청이 Assistant API로 전송됩니다.`);
        setIsPromptEditing(false);
        return;
      }

      const widgets = assistantContext?.widgets?.length ? assistantContext.widgets : [widget];
      const response = await requestDashboardAssistant({
        dashboardId: assistantContext?.dashboardId,
        mode: "visualization_request",
        pageId: assistantContext?.pageId ?? widget.pageId,
        prompt: nextPrompt,
        selectedWidgetId: widget.id,
        widgetId: widget.id,
        widgets: widgets.map(buildDashboardAssistantWidgetContext),
      });
      const configPatch = response.widgetPatch?.config ?? response.configPatch;
      if (configPatch && Object.keys(configPatch).length > 0) {
        await onPatchConfig({ prompt: nextPrompt, ...configPatch });
      }
      setRequestTone("success");
      setMessage(response.message?.trim() || "Assistant 요청을 보냈습니다.");
      setIsPromptEditing(false);
    } catch (error) {
      setRequestTone("error");
      setMessage(error instanceof Error ? error.message : "Assistant 요청에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="asklake-visualization-request-widget">
      <form className="asklake-visualization-request-form" onSubmit={(event) => void savePrompt(event)}>
        <input
          aria-label="시각화 요청"
          className={isPromptEditing ? "widget-control" : undefined}
          placeholder="어시스턴트에게 이 차트의 편집을 요청하세요."
          readOnly={!isPromptEditing}
          value={prompt}
          onBlur={() => setIsPromptEditing(false)}
          onChange={(event) => setPrompt(event.target.value)}
          onDoubleClick={() => setIsPromptEditing(true)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setPrompt(configText(widget, "prompt"));
            setIsPromptEditing(false);
            event.currentTarget.blur();
          }}
        />
        <button aria-label="Assistant 요청" disabled={!prompt.trim() || !onPatchConfig || isSaving} type="submit">
          {isSaving ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
        </button>
      </form>
      <p>필드를 선택하거나 요청을 입력하면 시각화 편집 흐름으로 이어집니다.</p>
      {message && (
        <div className={`asklake-visualization-request-status ${requestTone ?? "info"}`}>
          {requestTone === "success" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{message}</span>
        </div>
      )}
    </div>
  );
}

function TextPlaceholderWidget({
  onPatchConfig,
  widget,
}: {
  onPatchConfig?: (patch: WidgetConfigPatch) => Promise<void> | void;
  widget: DashboardRuntimeWidget;
}) {
  const [body, setBody] = useState(() => configText(widget, "body"));
  const [isBodyEditing, setIsBodyEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setBody(configText(widget, "body"));
    setIsBodyEditing(false);
  }, [widget.id, widget.config]);

  const saveBody = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!onPatchConfig || isSaving) return;

    setIsSaving(true);
    try {
      await onPatchConfig({ body });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form className="asklake-text-placeholder-widget" onSubmit={(event) => void saveBody(event)}>
      <textarea
        aria-label="텍스트 위젯 내용"
        className={isBodyEditing ? "widget-control" : undefined}
        placeholder="편집을 시작하려면 텍스트를 입력하세요."
        readOnly={!isBodyEditing}
        value={body}
        onBlur={() => setIsBodyEditing(false)}
        onChange={(event) => setBody(event.target.value)}
        onDoubleClick={() => setIsBodyEditing(true)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          setBody(configText(widget, "body"));
          setIsBodyEditing(false);
          event.currentTarget.blur();
        }}
      />
      <div className="asklake-text-placeholder-actions">
        <button disabled={!onPatchConfig || isSaving} type="submit">저장</button>
      </div>
    </form>
  );
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

  const color = configColor(widget.config.color);
  const baseOptions = buildBaseChartOptions(color);
  const options: ApexOptions = {
    ...baseOptions,
    chart: {
      ...baseOptions.chart,
      type: "bar",
    },
    plotOptions: {
      bar: {
        borderRadius: 5,
        columnWidth: "48%",
      },
    },
    xaxis: {
      ...baseOptions.xaxis,
      categories: points.map((point) => point.label),
    },
  };
  const series = [{ data: points.map((point) => point.value), name: aggregationLabels[aggregation] }];

  return <RuntimeApexChart options={options} series={series} type="bar" />;
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

  const color = configColor(widget.config.color);
  const baseOptions = buildBaseChartOptions(color);
  const options: ApexOptions = {
    ...baseOptions,
    chart: {
      ...baseOptions.chart,
      type: "line",
    },
    markers: {
      colors: ["#ffffff"],
      size: 4,
      strokeColors: color,
      strokeWidth: 3,
    },
    xaxis: {
      ...baseOptions.xaxis,
      categories: points.map((point) => point.label),
    },
  };
  const series = [{ data: points.map((point) => point.value), name: aggregationLabels[aggregation] }];

  return <RuntimeApexChart options={options} series={series} type="line" />;
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

  const primaryColor = configColor(widget.config.color);
  const baseOptions = buildBaseChartOptions(primaryColor);
  const colors = points.map((_, index) => index === 0 ? primaryColor : chartColors[index % chartColors.length]);
  const options: ApexOptions = {
    ...baseOptions,
    chart: {
      ...baseOptions.chart,
      type: "donut",
    },
    colors,
    labels: points.map((point) => point.label),
    legend: {
      ...baseOptions.legend,
      fontSize: "12px",
      fontWeight: 800,
      markers: {
        size: 6,
      },
      position: "right",
    },
    plotOptions: {
      pie: {
        donut: {
          labels: {
            show: true,
            total: {
              formatter: () => formatCell(total),
              label: "합계",
              show: true,
            },
            value: {
              formatter: (value: string) => formatCell(Number(value)),
            },
          },
          size: "66%",
        },
      },
    },
    stroke: {
      colors: ["#ffffff"],
      width: 3,
    },
    tooltip: {
      theme: "light",
      y: {
        formatter: (value: number) => formatCell(value),
      },
    },
  };
  const series = points.map((point) => Math.max(0, point.value));

  return <RuntimeApexChart options={options} series={series} type="donut" />;
}

export const WidgetRenderer = memo(function WidgetRenderer({
  assistantContext,
  onPatchConfig,
  widget,
}: {
  assistantContext?: DashboardAssistantRuntimeContext;
  onPatchConfig?: (patch: WidgetConfigPatch) => Promise<void> | void;
  widget: DashboardRuntimeWidget;
}) {
  const kind = placeholderKind(widget);
  if (kind === "visualization_request") return <VisualizationRequestWidget assistantContext={assistantContext} widget={widget} onPatchConfig={onPatchConfig} />;
  if (kind === "text") return <TextPlaceholderWidget widget={widget} onPatchConfig={onPatchConfig} />;

  const hasError = Boolean(widget.config.error || widget.config.errorMessage);
  if (hasError) return <WidgetDataError />;

  if (widget.type === "metric") return <MetricWidget widget={widget} />;
  if (widget.type === "table") return <TableWidget widget={widget} />;
  if (widget.type === "bar_chart") return <BarChartWidget widget={widget} />;
  if (widget.type === "line_chart") return <LineChartWidget widget={widget} />;
  if (widget.type === "donut_chart") return <DonutChartWidget widget={widget} />;

  return <EmptyWidgetData />;
});
