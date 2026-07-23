import { useEffect, useMemo, useRef, useState } from "react";
import { Responsive, noCompactor, useContainerWidth, verticalCompactor, type Layout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { DashboardRuntimeWidget } from "../../../types";
import type { DashboardAssistantWidgetPatch } from "../../../services/dashboardAssistantService";
import type { DashboardAssistantRuntimeContext } from "./dashboardRuntimeTypes";
import { EmptyDashboardCanvas } from "./EmptyDashboardCanvas";
import { WidgetFrame } from "./WidgetFrame";
import { hasAnyLayoutCollision, hasLayoutOutOfBounds } from "./dashboardLayoutUtils";

const breakpointCols = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 };
type DashboardBreakpoint = keyof typeof breakpointCols;
const gridMargin: [number, number] = [12, 12];
const gridRowHeight = 48;
const editGridTrailingRows = 1;
// Free-form desktop layouts preserve intentional gaps and reject drops that overlap another widget.
const fixedDesktopCompactor = { ...noCompactor, preventCollision: true };

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
  assistantContext,
  deletingWidgetId,
  editable,
  onDeleteWidget,
  onApplyWidgetPatch,
  onLayoutCommit,
  onLayoutRejected,
  onPatchWidgetConfig,
  onRetryWidgetData,
  onScrollTargetHandled,
  onSelectWidget,
  onSelectWidgetColorSlot,
  scrollTargetWidgetId,
  selectedWidgetId,
  widgets,
}: {
  assistantContext?: DashboardAssistantRuntimeContext;
  deletingWidgetId?: string | null;
  editable: boolean;
  onDeleteWidget?: (widgetId: string) => void;
  onApplyWidgetPatch?: (widget: DashboardRuntimeWidget, patch: DashboardAssistantWidgetPatch) => Promise<boolean>;
  onLayoutCommit?: (layout: LayoutItem[]) => void;
  onLayoutRejected?: () => void;
  onPatchWidgetConfig?: (widget: DashboardRuntimeWidget, patch: Record<string, unknown>) => Promise<boolean>;
  onRetryWidgetData?: (widgetId: string) => void;
  onScrollTargetHandled?: () => void;
  onSelectWidget?: (widgetId: string) => void;
  onSelectWidgetColorSlot?: (widgetId: string, slotIndex: number) => void;
  scrollTargetWidgetId?: string | null;
  selectedWidgetId?: string | null;
  widgets: DashboardRuntimeWidget[];
}) {
  const { containerRef, mounted, width } = useContainerWidth({ initialWidth: 1200 });
  const [resetKey, setResetKey] = useState(0);
  const [activeBreakpoint, setActiveBreakpoint] = useState<DashboardBreakpoint>("lg");
  const widgetNodeById = useRef(new Map<string, HTMLDivElement>());
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
  const commitLayout = (nextLayout: readonly LayoutItem[]) => {
    if (hasLayoutOutOfBounds(nextLayout, breakpointCols.lg) || hasAnyLayoutCollision(nextLayout)) {
      setResetKey((key) => key + 1);
      onLayoutRejected?.();
      return;
    }

    onLayoutCommit?.([...nextLayout]);
  };

  useEffect(() => {
    if (!mounted || !scrollTargetWidgetId) return undefined;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const widgetNode = widgetNodeById.current.get(scrollTargetWidgetId);
        if (!widgetNode) return;
        widgetNode.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        onScrollTargetHandled?.();
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [mounted, onScrollTargetHandled, scrollTargetWidgetId, widgets.length]);

  if (widgets.length === 0) {
    return (
      <div className={editable ? "asklake-dashboard-empty-canvas edit" : "asklake-dashboard-empty-canvas"}>
        <EmptyDashboardCanvas editable={editable} />
      </div>
    );
  }

  // Draft layouts are persisted in the canonical 12-column coordinate system.
  const editorBreakpoint: DashboardBreakpoint | undefined = editable ? "lg" : undefined;
  const preservesManualPlacement = editable || activeBreakpoint === "lg" || activeBreakpoint === "md";

  return (
    <div className="asklake-dashboard-rgl-shell" ref={containerRef}>
      {mounted && (
        <Responsive<DashboardBreakpoint>
          key={`${editable ? "draft" : "published"}-${resetKey}`}
          breakpoint={editorBreakpoint}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          className={editable ? "asklake-dashboard-rgl edit" : "asklake-dashboard-rgl"}
          cols={breakpointCols}
          compactor={preservesManualPlacement ? fixedDesktopCompactor : verticalCompactor}
          containerPadding={[0, 0]}
          dragConfig={{
            bounded: true,
            cancel: ".widget-control, button, select, a",
            enabled: editable,
            threshold: 6,
          }}
          layouts={responsiveLayouts}
          margin={gridMargin}
          resizeConfig={{ enabled: editable, handles: ["n", "s", "e", "w", "ne", "nw", "se", "sw"] }}
          rowHeight={gridRowHeight}
          style={editGridMinHeight ? { minHeight: editGridMinHeight } : undefined}
          width={width}
          onBreakpointChange={(breakpoint) => setActiveBreakpoint(breakpoint)}
          onDragStop={(nextLayout) => commitLayout([...nextLayout])}
          onResizeStop={(nextLayout) => commitLayout([...nextLayout])}
        >
          {widgets.map((widget) => (
            <div
              key={widget.id}
              ref={(node) => {
                if (node) {
                  widgetNodeById.current.set(widget.id, node);
                  return;
                }
                widgetNodeById.current.delete(widget.id);
              }}
            >
              <WidgetFrame
                assistantContext={assistantContext}
                deleteDisabled={deletingWidgetId === widget.id}
                editable={editable}
                selected={selectedWidgetId === widget.id}
                widget={widget}
                onDelete={onDeleteWidget}
                onApplyWidgetPatch={onApplyWidgetPatch}
                onPatchConfig={onPatchWidgetConfig}
                onRetryData={onRetryWidgetData}
                onSelect={onSelectWidget}
                onSelectColorSlot={onSelectWidgetColorSlot}
              />
            </div>
          ))}
        </Responsive>
      )}
    </div>
  );
}
