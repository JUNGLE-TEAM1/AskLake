import type { DashboardRuntimeWidget, DashboardRuntimeWidgetConfig, DashboardRuntimeWidgetType } from "../../../types";

export type ToolbarDraftWidgetKind = "visualization" | "text";

export type DashboardDatasetColumn = {
  name: string;
  type: "string" | "number" | "date";
};

export type DashboardDatasetOption = {
  columns: DashboardDatasetColumn[];
  description?: string;
  id: string;
  layer: "gold";
  name: string;
  updatedAt?: string;
};

export type CreateDraftWidgetFormInput = {
  config: DashboardRuntimeWidgetConfig;
  datasetId: string;
  title: string;
  type: DashboardRuntimeWidgetType;
};

export type UpdateDraftWidgetFormInput = {
  config: DashboardRuntimeWidgetConfig;
  datasetId?: string | null;
  title: string;
  type: DashboardRuntimeWidgetType;
};

export type DashboardAssistantRuntimeContext = {
  dashboardId?: string;
  onWorkingWidgetChange?: (widgetId: string | null) => void;
  pageId: string | null;
  selectedWidgetId?: string | null;
  workingWidgetId?: string | null;
  widgets: DashboardRuntimeWidget[];
};

export type DashboardWidgetColorSlotFocus = {
  slotIndex: number;
  widgetId: string;
};
