import { useState } from "react";
import { createDraftWidget } from "../../../services/dashboardRuntimeApi";
import type {
  AuditResult,
  DashboardRuntimeMode,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetType,
  DashboardWidgetLayout,
} from "../../../types";
import { findNextAvailableLayout, toCollisionLayout } from "./dashboardLayoutUtils";
import type { CreateDraftWidgetFormInput } from "./dashboardRuntimeTypes";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type UseDraftWidgetCreatorParams = {
  dashboardId: string;
  defaultLayouts: Record<DashboardRuntimeWidgetType, DashboardWidgetLayout>;
  mode: DashboardRuntimeMode;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  reloadDraftRuntime: (dashboardId: string) => Promise<unknown>;
  selectedPageId: string | null;
  selectedWidgets: DashboardRuntimeWidget[];
  setDraftError: (message: string | null) => void;
  setSelectedWidgetId: (widgetId: string) => void;
  setRuntimeNotice: (notice: RuntimeNotice) => void;
};

export function useDraftWidgetCreator({
  dashboardId,
  defaultLayouts,
  mode,
  onAction,
  reloadDraftRuntime,
  selectedPageId,
  selectedWidgets,
  setDraftError,
  setRuntimeNotice,
  setSelectedWidgetId,
}: UseDraftWidgetCreatorParams) {
  const [isCreatingDatasetWidget, setIsCreatingDatasetWidget] = useState(false);

  const createDatasetDraftWidget = async (input: CreateDraftWidgetFormInput) => {
    if (mode !== "draft" || !selectedPageId || isCreatingDatasetWidget) return;
    const layout = findNextAvailableLayout(
      toCollisionLayout(selectedWidgets),
      defaultLayouts[input.type],
    );

    setIsCreatingDatasetWidget(true);
    setDraftError(null);
    try {
      const widget = await createDraftWidget(dashboardId, selectedPageId, {
        config: input.config,
        data: input.data,
        datasetId: input.datasetId,
        layout,
        title: input.title,
        type: input.type,
      });
      await reloadDraftRuntime(dashboardId);
      setSelectedWidgetId(widget.id);
      setRuntimeNotice({ message: "데이터셋 기반 위젯을 추가했습니다.", tone: "success" });
      onAction("dashboard.widget.dataset_added", `/api/dashboards/${dashboardId}/draft/pages/${selectedPageId}/widgets`, input.datasetId);
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Failed to create a dataset widget.");
      setRuntimeNotice({ message: "데이터셋 기반 위젯을 추가하지 못했습니다.", tone: "error" });
    } finally {
      setIsCreatingDatasetWidget(false);
    }
  };

  return {
    createDatasetDraftWidget,
    isCreatingDatasetWidget,
  };
}
