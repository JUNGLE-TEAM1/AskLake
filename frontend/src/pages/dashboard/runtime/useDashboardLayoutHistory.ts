import { useEffect, useState } from "react";
import type { LayoutItem } from "react-grid-layout";
import type {
  AuditResult,
  DashboardRuntimeMode,
  DashboardRuntimeWidget,
} from "../../../types";
import {
  layoutSnapshotsEqual,
  normalizeLayoutSnapshot,
  widgetLayoutSnapshot,
  type DraftLayoutUpdateResult,
  type RuntimeLayoutSnapshot,
} from "./draftWidgetLayoutPersistence";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

const maxLayoutHistoryEntries = 5;

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
  updateLayouts: (layout: LayoutItem[]) => Promise<DraftLayoutUpdateResult>;
}) {
  const [redoStack, setRedoStack] = useState<RuntimeLayoutSnapshot[]>([]);
  const [undoStack, setUndoStack] = useState<RuntimeLayoutSnapshot[]>([]);

  useEffect(() => {
    setRedoStack([]);
    setUndoStack([]);
  }, [dashboardId, mode, selectedPageId, selectedWidgetIdsKey]);

  const commit = async (layout: LayoutItem[]) => {
    const previousLayout = widgetLayoutSnapshot(selectedWidgets);
    const nextLayout = normalizeLayoutSnapshot(layout);
    if (layoutSnapshotsEqual(previousLayout, nextLayout)) return;

    const result = await updateLayouts(nextLayout);
    if (result.status !== "saved" || layoutSnapshotsEqual(result.previousSavedLayout, nextLayout)) return;

    setUndoStack((stack) => pushLayoutHistory(stack, result.previousSavedLayout));
    setRedoStack([]);
  };

  const undo = async () => {
    const previousLayout = undoStack.at(-1);
    if (!previousLayout) return;

    const result = await updateLayouts(previousLayout);
    if (result.status !== "saved") return;

    setUndoStack((stack) => stack.slice(0, -1));
    setRedoStack((stack) => pushLayoutHistory(stack, result.previousSavedLayout));
    onNotice({ message: "레이아웃 변경을 실행 취소했습니다.", tone: "info" });
    onAction(
      "dashboard.layout.undo",
      `/api/dashboards/${dashboardId}/draft/layouts`,
      selectedPageId ?? dashboardId,
    );
  };

  const redo = async () => {
    const nextLayout = redoStack.at(-1);
    if (!nextLayout) return;

    const result = await updateLayouts(nextLayout);
    if (result.status !== "saved") return;

    setRedoStack((stack) => stack.slice(0, -1));
    setUndoStack((stack) => pushLayoutHistory(stack, result.previousSavedLayout));
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
