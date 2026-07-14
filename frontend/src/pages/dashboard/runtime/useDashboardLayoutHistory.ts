import { useEffect, useState } from "react";
import type { LayoutItem } from "react-grid-layout";
import type {
  AuditResult,
  DashboardRuntimeMode,
  DashboardRuntimeWidget,
} from "../../../types";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

export type RuntimeLayoutSnapshot = Array<
  Pick<LayoutItem, "h" | "i" | "minH" | "minW" | "w" | "x" | "y">
>;

const maxLayoutHistoryEntries = 5;

function normalizeLayoutSnapshot(layout: readonly LayoutItem[]): RuntimeLayoutSnapshot {
  return layout
    .map((item) => ({
      h: item.h,
      i: item.i,
      minH: item.minH,
      minW: item.minW,
      w: item.w,
      x: item.x,
      y: item.y,
    }))
    .sort((first, second) => first.i.localeCompare(second.i));
}

function widgetLayoutSnapshot(widgets: DashboardRuntimeWidget[]): RuntimeLayoutSnapshot {
  return normalizeLayoutSnapshot(widgets.map((widget) => ({
    h: widget.layout.h,
    i: widget.id,
    minH: widget.layout.minH,
    minW: widget.layout.minW,
    w: widget.layout.w,
    x: widget.layout.x,
    y: widget.layout.y,
  })));
}

function layoutSnapshotsEqual(first: RuntimeLayoutSnapshot, second: RuntimeLayoutSnapshot) {
  if (first.length !== second.length) return false;
  return first.every((item, index) => {
    const next = second[index];
    return item.i === next.i
      && item.x === next.x
      && item.y === next.y
      && item.w === next.w
      && item.h === next.h;
  });
}

function pushLayoutHistory(stack: RuntimeLayoutSnapshot[], snapshot: RuntimeLayoutSnapshot) {
  return [...stack, snapshot].slice(-maxLayoutHistoryEntries);
}

export function useDashboardLayoutHistory({
  dashboardId,
  mode,
  onAction,
  onNotice,
  selectedPageId,
  selectedWidgetIdsKey,
  selectedWidgets,
  updateLayouts,
}: {
  dashboardId: string;
  mode: DashboardRuntimeMode;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  onNotice: (notice: RuntimeNotice) => void;
  selectedPageId: string | null;
  selectedWidgetIdsKey: string;
  selectedWidgets: DashboardRuntimeWidget[];
  updateLayouts: (layout: LayoutItem[]) => void;
}) {
  const [redoStack, setRedoStack] = useState<RuntimeLayoutSnapshot[]>([]);
  const [undoStack, setUndoStack] = useState<RuntimeLayoutSnapshot[]>([]);

  useEffect(() => {
    setRedoStack([]);
    setUndoStack([]);
  }, [dashboardId, mode, selectedPageId, selectedWidgetIdsKey]);

  const commit = (layout: LayoutItem[]) => {
    const previousLayout = widgetLayoutSnapshot(selectedWidgets);
    const nextLayout = normalizeLayoutSnapshot(layout);
    if (layoutSnapshotsEqual(previousLayout, nextLayout)) return;

    setUndoStack((stack) => pushLayoutHistory(stack, previousLayout));
    setRedoStack([]);
    updateLayouts(nextLayout);
  };

  const undo = () => {
    const previousLayout = undoStack.at(-1);
    if (!previousLayout) return;

    const currentLayout = widgetLayoutSnapshot(selectedWidgets);
    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => pushLayoutHistory(stack, currentLayout));
    updateLayouts(previousLayout);
    onNotice({ message: "레이아웃 변경을 실행 취소했습니다.", tone: "info" });
    onAction(
      "dashboard.layout.undo",
      `/api/dashboards/${dashboardId}/draft/layouts`,
      selectedPageId ?? dashboardId,
    );
  };

  const redo = () => {
    const nextLayout = redoStack.at(-1);
    if (!nextLayout) return;

    const currentLayout = widgetLayoutSnapshot(selectedWidgets);
    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => pushLayoutHistory(stack, currentLayout));
    updateLayouts(nextLayout);
    onNotice({ message: "레이아웃 변경을 다시 실행했습니다.", tone: "info" });
    onAction(
      "dashboard.layout.redo",
      `/api/dashboards/${dashboardId}/draft/layouts`,
      selectedPageId ?? dashboardId,
    );
  };

  return {
    canRedo: redoStack.length > 0,
    canUndo: undoStack.length > 0,
    commit,
    redo,
    undo,
  };
}
