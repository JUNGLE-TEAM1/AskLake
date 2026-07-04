import { useMemo } from "react";
import { noCompactor, Responsive, useContainerWidth, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { DashboardRuntimeWidget } from "../../../types";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetFrame } from "./WidgetFrame";

export function DashboardCanvas({
  editable,
  onLayoutCommit,
  onSelectWidget,
  selectedWidgetId,
  widgets,
}: {
  editable: boolean;
  onLayoutCommit?: (layout: LayoutItem[]) => void;
  onSelectWidget?: (widgetId: string) => void;
  selectedWidgetId?: string | null;
  widgets: DashboardRuntimeWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 1200 });
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
          key={editable ? "draft" : "published"}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          className={editable ? "asklake-dashboard-rgl edit" : "asklake-dashboard-rgl"}
          cols={{ lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 }}
          compactor={noCompactor}
          containerPadding={[0, 0]}
          dragConfig={{ enabled: editable, threshold: 3 }}
          layouts={{ lg: layout }}
          margin={[12, 12]}
          resizeConfig={{ enabled: editable, handles: ["se"] }}
          rowHeight={48}
          width={width}
          onDragStop={(nextLayout) => onLayoutCommit?.([...nextLayout])}
          onResizeStop={(nextLayout) => onLayoutCommit?.([...nextLayout])}
        >
          {widgets.map((widget) => (
            <div key={widget.id}>
              <WidgetFrame
                editable={editable}
                selected={selectedWidgetId === widget.id}
                widget={widget}
                onSelect={onSelectWidget}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
