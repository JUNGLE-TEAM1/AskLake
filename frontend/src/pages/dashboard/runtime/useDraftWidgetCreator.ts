import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { createDraftWidget } from "../../../services/dashboardRuntimeApi";
import type {
  AuditResult,
  DashboardRuntimeMode,
  DashboardRuntimeResponse,
  DashboardRuntimeWidget,
  DashboardRuntimeWidgetType,
  DashboardRuntimeWidgetConfig,
  DashboardWidgetLayout,
} from "../../../types";
import { findNextAvailableLayout, toCollisionLayout } from "./dashboardLayoutUtils";
import { upsertRuntimeWidget } from "./dashboardRuntimeMutations";
import type { CreateDraftWidgetFormInput, ToolbarDraftWidgetKind } from "./dashboardRuntimeTypes";
import { defaultWidgetColorConfig } from "./widgetDefinitions";

type RuntimeNotice = {
  message: string;
  tone: "success" | "info" | "error";
};

type UseDraftWidgetCreatorParams = {
  dashboardId: string;
  defaultLayouts: Record<DashboardRuntimeWidgetType, DashboardWidgetLayout>;
  mode: DashboardRuntimeMode;
  onAction: (action: string, apiPath: string, targetId: string, result?: AuditResult) => void;
  selectedPageId: string | null;
  selectedWidgets: DashboardRuntimeWidget[];
  setDraftError: (message: string | null) => void;
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
  setSelectedWidgetId: (widgetId: string) => void;
  setWidgetScrollTargetId?: (widgetId: string | null) => void;
  setRuntimeNotice: (notice: RuntimeNotice) => void;
};

const toolbarWidgetDefaults: Record<ToolbarDraftWidgetKind, {
  config: DashboardRuntimeWidgetConfig;
  data: Array<Record<string, unknown>>;
  layout: DashboardWidgetLayout;
  title: string;
  type: DashboardRuntimeWidgetType;
}> = {
  text: {
    config: {
      body: "",
      columns: [],
      description: "",
      limit: 1,
      placeholderKind: "text",
    },
    data: [],
    layout: { h: 4, minH: 3, minW: 2, w: 12, x: 0, y: 0 },
    title: "텍스트",
    type: "table",
  },
  visualization: {
    config: {
      aggregation: "sum",
      color: defaultWidgetColorConfig,
      description: "",
      placeholderKind: "visualization_request",
      prompt: "",
      xKey: "label",
      yKey: "value",
    },
    data: [],
    layout: { h: 8, minH: 6, minW: 3, w: 6, x: 0, y: 0 },
    title: "시각화 요청",
    type: "bar_chart",
  },
};

function cloneWidgetData(data: Array<Record<string, unknown>>) {
  return data.map((row) => ({ ...row }));
}

function applySavedWidget(
  widget: DashboardRuntimeWidget,
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>,
) {
  setDraftRuntime((currentRuntime) => {
    if (!currentRuntime) return currentRuntime;
    return upsertRuntimeWidget(currentRuntime, widget);
  });
}

export function useDraftWidgetCreator({
  dashboardId,
  defaultLayouts,
  mode,
  onAction,
  selectedPageId,
  selectedWidgets,
  setDraftError,
  setDraftRuntime,
  setRuntimeNotice,
  setSelectedWidgetId,
  setWidgetScrollTargetId,
}: UseDraftWidgetCreatorParams) {
  const [isCreatingDatasetWidget, setIsCreatingDatasetWidget] = useState(false);
  const [isCreatingToolbarWidget, setIsCreatingToolbarWidget] = useState(false);

  const createDatasetDraftWidget = async (input: CreateDraftWidgetFormInput) => {
    if (mode !== "draft" || !selectedPageId || isCreatingDatasetWidget) return;
    const layout = findNextAvailableLayout(
      toCollisionLayout(selectedWidgets),
      defaultLayouts[input.type],
    );

    setIsCreatingDatasetWidget(true);
    setDraftError(null);
    try {
      const response = await createDraftWidget(dashboardId, selectedPageId, {
        config: input.config,
        data: input.data,
        datasetId: input.datasetId,
        layout,
        title: input.title,
        type: input.type,
      });
      applySavedWidget(response.widget, setDraftRuntime);
      setSelectedWidgetId(response.widget.id);
      setWidgetScrollTargetId?.(response.widget.id);
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
    createToolbarDraftWidget: async (kind: ToolbarDraftWidgetKind) => {
      if (mode !== "draft" || !selectedPageId || isCreatingToolbarWidget) return;
      const defaults = toolbarWidgetDefaults[kind];
      const layout = findNextAvailableLayout(
        toCollisionLayout(selectedWidgets),
        defaults.layout,
      );
      const input = {
        config: { ...defaults.config } as DashboardRuntimeWidgetConfig,
        data: cloneWidgetData(defaults.data),
        datasetId: null,
        layout,
        title: defaults.title,
        type: defaults.type,
      };

      setIsCreatingToolbarWidget(true);
      setDraftError(null);
      try {
        const response = await createDraftWidget(dashboardId, selectedPageId, {
          config: input.config,
          data: input.data,
          datasetId: input.datasetId,
          layout: input.layout,
          title: input.title,
          type: input.type,
        });
        applySavedWidget(response.widget, setDraftRuntime);
        setSelectedWidgetId(response.widget.id);
        setWidgetScrollTargetId?.(response.widget.id);
        setRuntimeNotice({
          message: kind === "text" ? "텍스트 위젯을 추가했습니다." : "시각화 요청 위젯을 추가했습니다.",
          tone: "success",
        });
        onAction("dashboard.widget.toolbar_added", `/api/dashboards/${dashboardId}/draft/pages/${selectedPageId}/widgets`, kind);
      } catch (error) {
        setDraftError(error instanceof Error ? error.message : "Failed to create a toolbar widget.");
        setRuntimeNotice({ message: "위젯을 추가하지 못했습니다.", tone: "error" });
      } finally {
        setIsCreatingToolbarWidget(false);
      }
    },
    isCreatingDatasetWidget,
    isCreatingToolbarWidget,
  };
}
