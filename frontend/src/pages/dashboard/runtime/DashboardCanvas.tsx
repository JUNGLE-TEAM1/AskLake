import { useMemo, useState } from "react";
import { MoreVertical, Pencil, Send, Sparkles } from "lucide-react";
import { noCompactor, Responsive, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { DashboardRuntimeWidget, DashboardWidgetLayout } from "../../../types";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetFrame } from "./WidgetFrame";
import { hasAnyLayoutCollision } from "./dashboardLayoutUtils";

const breakpointCols = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
const noReflowCompactor = {
  ...noCompactor,
  preventCollision: true,
};

export type DashboardCanvasToolItemType = "assistant_visualization" | "text_box";

export type DashboardCanvasToolItem = {
  id: string;
  layout: DashboardWidgetLayout;
  text?: string;
  type: DashboardCanvasToolItemType;
};

function scaleLayout(layout: LayoutItem[], cols: number) {
  return layout.map((item) => {
    const minW = Math.min(cols, item.minW ?? 1);
    const scaledWidth = Math.max(minW, Math.round((item.w / 12) * cols));
    const w = Math.min(cols, scaledWidth);
    const x = Math.min(Math.max(0, Math.round((item.x / 12) * cols)), Math.max(0, cols - w));
    return {
      ...item,
      minW,
      w,
      x,
    };
  });
}

function hasLayoutChanges(nextLayout: readonly LayoutItem[], startById: Map<string, LayoutItem>) {
  return nextLayout.some((item) => {
    const startItem = startById.get(item.i);
    return startItem && (
      item.x !== startItem.x ||
      item.y !== startItem.y ||
      item.w !== startItem.w ||
      item.h !== startItem.h
    );
  });
}

function CanvasToolCard({
  item,
  onSelect,
  selected,
}: {
  item: DashboardCanvasToolItem;
  onSelect?: (itemId: string) => void;
  selected?: boolean;
}) {
  return (
    <article
      className={`asklake-canvas-tool-card ${item.type === "text_box" ? "text" : "assistant"} ${selected ? "selected" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(item.id);
      }}
    >
      {item.type === "assistant_visualization" ? (
        <div className="asklake-canvas-assistant-card">
          <div className="asklake-canvas-assistant-prompt">
            <Sparkles size={18} />
            <span>어시스턴트에게 이 차트의 편집을 요청하세요.</span>
            <button aria-label="어시스턴트 요청 보내기" className="widget-control" type="button">
              <Send size={18} />
            </button>
          </div>
          <div className="asklake-canvas-assistant-preview" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="asklake-canvas-assistant-scroll" aria-hidden="true">
            <i />
          </div>
          <p>또는 시각화를 수동으로 생성하려면 시각화 편집기에서 필드를 하나 이상 선택합니다</p>
        </div>
      ) : (
        <div className="asklake-canvas-text-card">
          <textarea
            aria-label="대시보드 텍스트"
            className="widget-control"
            defaultValue={item.text ?? "편집을 시작하려면 두 번 클릭하고 저장하려면 클릭하세요."}
          />
          <div className="asklake-canvas-text-actions" aria-hidden="true">
            <Pencil size={18} />
            <MoreVertical size={18} />
          </div>
        </div>
      )}
    </article>
  );
}

export function DashboardCanvas({
  deletingWidgetId,
  editable,
  onDeleteWidget,
  onLayoutCommit,
  onLayoutRejected,
  onToolItemLayoutCommit,
  onSelectToolItem,
  onSelectWidget,
  selectedWidgetId,
  selectedToolItemId,
  toolItems = [],
  widgets,
}: {
  deletingWidgetId?: string | null;
  editable: boolean;
  onDeleteWidget?: (widgetId: string) => void;
  onLayoutCommit?: (layout: LayoutItem[]) => void;
  onLayoutRejected?: () => void;
  onToolItemLayoutCommit?: (layout: LayoutItem[]) => void;
  onSelectToolItem?: (itemId: string) => void;
  onSelectWidget?: (widgetId: string) => void;
  selectedWidgetId?: string | null;
  selectedToolItemId?: string | null;
  toolItems?: DashboardCanvasToolItem[];
  widgets: DashboardRuntimeWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 1200 });
  const [resetKey, setResetKey] = useState(0);
  const layout = useMemo(
    () =>
      [
        ...widgets.map((widget) => ({
          h: widget.layout.h,
          i: widget.id,
          isDraggable: editable,
          isResizable: editable,
          minH: widget.layout.minH ?? 2,
          minW: widget.layout.minW ?? 2,
          static: !editable,
          w: widget.layout.w,
          x: widget.layout.x,
          y: widget.layout.y,
        })),
        ...toolItems.map((item) => ({
          h: item.layout.h,
          i: item.id,
          isDraggable: editable,
          isResizable: editable,
          minH: item.layout.minH ?? (item.type === "text_box" ? 2 : 4),
          minW: item.layout.minW ?? (item.type === "text_box" ? 4 : 4),
          static: !editable,
          w: item.layout.w,
          x: item.layout.x,
          y: item.layout.y,
        })),
      ] satisfies Layout,
    [editable, toolItems, widgets],
  );
  const responsiveLayouts = useMemo(
    () => ({
      lg: layout,
      md: layout,
      sm: scaleLayout([...layout], breakpointCols.sm),
      xs: scaleLayout([...layout], breakpointCols.xs),
      xxs: scaleLayout([...layout], breakpointCols.xxs),
    }),
    [layout],
  );
  const changedMultipleItems = (nextLayout: readonly LayoutItem[]) => {
    const startById = new Map(layout.map((item) => [item.i, item]));
    let changedCount = 0;

    for (const item of nextLayout) {
      const startItem = startById.get(item.i);
      if (!startItem) continue;
      const changed = item.x !== startItem.x || item.y !== startItem.y || item.w !== startItem.w || item.h !== startItem.h;
      if (changed) changedCount += 1;
      if (changedCount > 1) return true;
    }

    return false;
  };
  const commitLayout = (nextLayout: readonly LayoutItem[]) => {
    const startById = new Map(layout.map((item) => [item.i, item]));
    const widgetIds = new Set(widgets.map((widget) => widget.id));
    const toolItemIds = new Set(toolItems.map((item) => item.id));
    const widgetLayout = nextLayout.filter((item) => widgetIds.has(item.i));
    const toolItemLayout = nextLayout.filter((item) => toolItemIds.has(item.i));
    const hasWidgetLayoutChanges = hasLayoutChanges(widgetLayout, startById);

    if ((hasWidgetLayoutChanges && hasAnyLayoutCollision(widgetLayout)) || changedMultipleItems(nextLayout)) {
      setResetKey((key) => key + 1);
      onLayoutRejected?.();
      return;
    }

    if (hasWidgetLayoutChanges) onLayoutCommit?.([...widgetLayout]);
    if (hasLayoutChanges(toolItemLayout, startById)) onToolItemLayoutCommit?.([...toolItemLayout]);
  };

  if (widgets.length === 0 && toolItems.length === 0) {
    return (
      <div className={editable ? "asklake-dashboard-empty-canvas edit" : "asklake-dashboard-empty-canvas"}>
        <EmptyDashboardCanvas editable={editable} />
      </div>
    );
  }

  return (
    <div className="asklake-dashboard-rgl-shell" ref={containerRef}>
      {mounted && (
        <Responsive
          key={`${editable ? "draft" : "published"}-${resetKey}`}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          className={editable ? "asklake-dashboard-rgl edit" : "asklake-dashboard-rgl"}
          cols={breakpointCols}
          compactor={noReflowCompactor}
          containerPadding={[0, 0]}
          dragConfig={{
            bounded: true,
            cancel: ".widget-control, button, input, select, textarea, a",
            enabled: editable,
            threshold: 6,
          }}
          layouts={responsiveLayouts}
          margin={[12, 12]}
          resizeConfig={{ enabled: editable, handles: ["se"] }}
          rowHeight={48}
          width={width}
          onDragStop={(nextLayout) => commitLayout([...nextLayout])}
          onResizeStop={(nextLayout) => commitLayout([...nextLayout])}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetFrame
                deleteDisabled={deletingWidgetId === widget.id}
                editable={editable}
                selected={selectedWidgetId === widget.id}
                widget={widget}
                onDelete={onDeleteWidget}
                onSelect={onSelectWidget}
              />
            </div>
          ))}
          {toolItems.map((item) => (
            <div key={item.id}>
              <CanvasToolCard
                item={item}
                selected={selectedToolItemId === item.id}
                onSelect={onSelectToolItem}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
