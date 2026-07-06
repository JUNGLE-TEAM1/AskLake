import { useMemo, useState } from "react";
import { noCompactor, Responsive, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { DashboardRuntimeWidget } from "../../../types";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetFrame } from "./WidgetFrame";
import { hasAnyLayoutCollision } from "./dashboardLayoutUtils";

const breakpointCols = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
const gridMargin: [number, number] = [12, 12];
const gridRowHeight = 48;
const editGridTrailingRows = 1;
const noReflowCompactor = {
  ...noCompactor,
  preventCollision: true,
};

function layoutHeight(layout: LayoutItem[], trailingRows = 0) {
  const bottomRow = layout.reduce((bottom, item) => Math.max(bottom, item.y + item.h), 0);
  const rows = bottomRow + trailingRows;
  if (rows <= 0) return 0;
  return rows * (gridRowHeight + gridMargin[1]) - gridMargin[1];
}

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

export function DashboardCanvas({
  deletingWidgetId,
  editable,
  onDeleteWidget,
  onLayoutCommit,
  onLayoutRejected,
  onPatchWidgetConfig,
  onSelectWidget,
  selectedWidgetId,
  widgets,
}: {
  deletingWidgetId?: string | null;
  editable: boolean;
  onDeleteWidget?: (widgetId: string) => void;
  onLayoutCommit?: (layout: LayoutItem[]) => void;
  onLayoutRejected?: () => void;
  onPatchWidgetConfig?: (widget: DashboardRuntimeWidget, patch: Record<string, unknown>) => Promise<void> | void;
  onSelectWidget?: (widgetId: string) => void;
  selectedWidgetId?: string | null;
  widgets: DashboardRuntimeWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 1200 });
  const [resetKey, setResetKey] = useState(0);
  const layout = useMemo(
    () =>
      widgets.map((widget) => ({
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
      })) satisfies Layout,
    [editable, widgets],
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
  const editGridMinHeight = useMemo(
    () => editable ? `max(100%, ${layoutHeight(layout, editGridTrailingRows)}px)` : undefined,
    [editable, layout],
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
    if (hasAnyLayoutCollision(nextLayout) || changedMultipleItems(nextLayout)) {
      setResetKey((key) => key + 1);
      onLayoutRejected?.();
      return;
    }

    onLayoutCommit?.([...nextLayout]);
  };

  if (widgets.length === 0) {
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
            cancel: ".widget-control, button, select, a",
            enabled: editable,
            threshold: 6,
          }}
          layouts={responsiveLayouts}
          margin={gridMargin}
          resizeConfig={{ enabled: editable, handles: ["se"] }}
          rowHeight={gridRowHeight}
          style={editGridMinHeight ? { minHeight: editGridMinHeight } : undefined}
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
                onPatchConfig={onPatchWidgetConfig}
                onSelect={onSelectWidget}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
