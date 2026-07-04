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

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function WidgetFrame({
  editable = false,
  onSelect,
  selected = false,
  widget,
}: {
  editable?: boolean;
  onSelect?: (widgetId: string) => void;
  selected?: boolean;
  widget: DashboardRuntimeWidget;
}) {
  const columnSpan = clampSpan(widget.layout?.w, 4);
  const rowSpan = clampSpan(widget.layout?.h, 4);

  return (
    <article
      className={cx("asklake-widget-frame", editable && "editable", selected && "selected")}
      style={{
        gridColumn: editable ? undefined : `span ${columnSpan}`,
        minHeight: editable ? undefined : `${Math.max(160, rowSpan * 56)}px`,
      }}
      onClick={(event) => {
        if (!editable) return;
        event.stopPropagation();
        onSelect?.(widget.id);
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
