import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { deleteDraftWidget, updateDraftWidget } from "../../../services/dashboardRuntimeApi";
import type {
  AuditResult,
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
} from "../../../types";
import type { UpdateDraftWidgetFormInput } from "./dashboardRuntimeTypes";
import { removeRuntimeWidget, upsertRuntimeWidget } from "./dashboardRuntimeMutations";
import { dashboardRuntimeErrorMessage } from "./dashboardRuntimeErrors";

type RuntimeNotice = { message: string; tone: "success" | "info" | "error" };

export function useDraftWidgetMutations({
  dashboardId,
  mode,
  onAction,
  previewWidget,
  selectedWidgetId,
  selectedWidgets,
  setDraftRuntime,
  setNotice,
  setPreviewWidget,
  setSelectedWidgetId,
}: {
  dashboardId: string;
  mode: DashboardRuntimeMode;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  previewWidget: DashboardRuntimeWidget | null;
  selectedWidgetId: string | null;
  selectedWidgets: DashboardRuntimeWidget[];
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setNotice: (notice: RuntimeNotice) => void;
  setPreviewWidget: (widget: DashboardRuntimeWidget | null) => void;
  setSelectedWidgetId: (widgetId: string | null) => void;
}) {
  const [deletingWidgetId, setDeletingWidgetId] = useState<string | null>(null);
  const [updatingWidgetId, setUpdatingWidgetId] = useState<string | null>(null);

  const deleteWidget = async (widgetId: string) => {
    if (mode !== "draft" || deletingWidgetId) return;
    const targetWidget = selectedWidgets.find((widget) => widget.id === widgetId);
    const targetTitle = targetWidget?.title || "제목 없는 위젯";
    if (!window.confirm(`'${targetTitle}' 위젯을 삭제할까요? 삭제 후에는 되돌릴 수 없습니다.`)) return;

    setDeletingWidgetId(widgetId);
    setNotice({ message: "위젯을 삭제하는 중입니다.", tone: "info" });
    try {
      await deleteDraftWidget(dashboardId, widgetId);
      if (selectedWidgetId === widgetId) setSelectedWidgetId(null);
      if (previewWidget?.id === widgetId) setPreviewWidget(null);
      setDraftRuntime((runtime) => runtime ? removeRuntimeWidget(runtime, widgetId) : runtime);
      setNotice({ message: "위젯을 삭제했습니다.", tone: "success" });
      onAction("dashboard.widget.deleted", `/api/dashboards/${dashboardId}/draft/widgets/${widgetId}`, widgetId);
    } catch (error) {
      setNotice({
        message: dashboardRuntimeErrorMessage(error, "위젯을 삭제하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.widget.delete_failed", `/api/dashboards/${dashboardId}/draft/widgets/${widgetId}`, widgetId, "failed");
    } finally {
      setDeletingWidgetId(null);
    }
  };

  const updateWidget = async (widgetId: string, input: UpdateDraftWidgetFormInput) => {
    if (mode !== "draft" || updatingWidgetId) return false;
    setUpdatingWidgetId(widgetId);
    setNotice({ message: "위젯 변경사항을 저장하는 중입니다.", tone: "info" });
    try {
      const response = await updateDraftWidget(dashboardId, widgetId, input);
      setPreviewWidget(null);
      setDraftRuntime((runtime) => runtime ? upsertRuntimeWidget(runtime, response.widget) : runtime);
      setSelectedWidgetId(widgetId);
      setNotice({ message: "위젯 변경사항을 저장했습니다.", tone: "success" });
      onAction("dashboard.widget.updated", `/api/dashboards/${dashboardId}/draft/widgets/${widgetId}`, widgetId);
      return true;
    } catch (error) {
      setNotice({
        message: dashboardRuntimeErrorMessage(error, "위젯 변경사항을 저장하지 못했습니다."),
        tone: "error",
      });
      onAction("dashboard.widget.update_failed", `/api/dashboards/${dashboardId}/draft/widgets/${widgetId}`, widgetId, "failed");
      return false;
    } finally {
      setUpdatingWidgetId(null);
    }
  };

  return { deleteWidget, deletingWidgetId, updateWidget, updatingWidgetId };
}
