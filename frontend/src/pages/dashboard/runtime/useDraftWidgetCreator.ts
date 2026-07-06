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
import type { CreateDraftWidgetFormInput, ToolbarDraftWidgetKind } from "./dashboardRuntimeTypes";

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
    layout: { h: 3, minH: 2, minW: 4, w: 12, x: 0, y: 0 },
    title: "텍스트",
    type: "table",
  },
  visualization: {
    config: {
      aggregation: "sum",
      color: "blue",
      description: "",
      placeholderKind: "visualization_request",
      prompt: "",
      xKey: "label",
      yKey: "value",
    },
    data: [],
    layout: { h: 5, minH: 4, minW: 4, w: 6, x: 0, y: 0 },
    title: "시각화 요청",
    type: "bar_chart",
  },
};

function cloneWidgetData(data: Array<Record<string, unknown>>) {
  return data.map((row) => ({ ...row }));
}

function appendToolbarWidgetToRuntime({
  id,
  input,
  pageId,
  setDraftRuntime,
}: {
  id: string;
  input: {
    config: DashboardRuntimeWidgetConfig;
    data: Array<Record<string, unknown>>;
    datasetId: null;
    layout: DashboardWidgetLayout;
    title: string;
    type: DashboardRuntimeWidgetType;
  };
  pageId: string;
  setDraftRuntime: Dispatch<SetStateAction<DashboardRuntimeResponse | null>>;
}) {
  const widget = {
    config: input.config,
    data: input.data,
    datasetId: input.datasetId,
    id,
    layout: input.layout,
    pageId,
    queryId: null,
    title: input.title,
    type: input.type,
  } as DashboardRuntimeWidget;

  setDraftRuntime((currentRuntime) => {
    if (!currentRuntime) return currentRuntime;
    const pageWidgets = currentRuntime.widgetsByPageId[pageId] ?? [];
    return {
      ...currentRuntime,
      widgetsByPageId: {
        ...currentRuntime.widgetsByPageId,
        [pageId]: [...pageWidgets.filter((existingWidget) => existingWidget.id !== id), widget],
      },
    };
  });
}

export function useDraftWidgetCreator({
  dashboardId,
  defaultLayouts,
  mode,
  onAction,
  reloadDraftRuntime,
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
      const widget = await createDraftWidget(dashboardId, selectedPageId, {
        config: input.config,
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
        const widget = await createDraftWidget(dashboardId, selectedPageId, {
          config: input.config,
          data: input.data,
          datasetId: input.datasetId,
          layout: input.layout,
          title: input.title,
          type: input.type,
        });
        appendToolbarWidgetToRuntime({
          id: widget.id,
          input,
          pageId: selectedPageId,
          setDraftRuntime,
        });
        setSelectedWidgetId(widget.id);
        setWidgetScrollTargetId?.(widget.id);
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
