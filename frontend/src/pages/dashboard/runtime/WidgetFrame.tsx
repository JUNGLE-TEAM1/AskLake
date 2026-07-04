import type { DashboardRuntimeWidget } from "../../../types";
import { WidgetRenderer } from "./WidgetRenderer";

const widgetTypeLabels: Record<DashboardRuntimeWidget["type"], string> = {
  bar_chart: "막대 차트",
  donut_chart: "도넛 차트",
  line_chart: "라인 차트",
  metric: "지표",
  table: "테이블",
};

function clampSpan(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(12, Math.max(1, Math.round(value ?? fallback)));
}

export function WidgetFrame({ widget }: { widget: DashboardRuntimeWidget }) {
  const columnSpan = clampSpan(widget.layout?.w, 4);
  const rowSpan = clampSpan(widget.layout?.h, 4);

  return (
    <article
      className="asklake-widget-frame"
      style={{
        gridColumn: `span ${columnSpan}`,
        minHeight: `${Math.max(160, rowSpan * 56)}px`,
      }}
    >
      <header>
        <div>
          <span>{widgetTypeLabels[widget.type]}</span>
          <h2>{widget.title || "제목 없는 위젯"}</h2>
        </div>
      </header>
      <WidgetRenderer widget={widget} />
    </article>
  );
}
