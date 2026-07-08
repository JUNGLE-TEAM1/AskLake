import type { CatalogDataset, DashboardRuntimeWidget, DashboardRuntimeWidgetConfig, DashboardRuntimeWidgetType } from "../../../types";

export type ToolbarDraftWidgetKind = "visualization" | "text";

export type DashboardDatasetColumn = {
  name: string;
  type: "string" | "number" | "date";
};

export type DashboardDatasetOption = {
  columns: DashboardDatasetColumn[];
  description?: string;
  id: string;
  layer: CatalogDataset["layer"];
  name: string;
  rows?: Array<Record<string, unknown>>;
  status: CatalogDataset["status"];
  updatedAt?: string;
};

export type CreateDraftWidgetFormInput = {
  config: DashboardRuntimeWidgetConfig;
  data?: Array<Record<string, unknown>>;
  datasetId: string;
  title: string;
  type: DashboardRuntimeWidgetType;
};

export type UpdateDraftWidgetFormInput = {
  config: DashboardRuntimeWidgetConfig;
  data?: Array<Record<string, unknown>>;
  datasetId?: string | null;
  title: string;
  type: DashboardRuntimeWidgetType;
};

export type DashboardAssistantRuntimeContext = {
  dashboardId?: string;
  onWorkingWidgetChange?: (widgetId: string | null) => void;
  pageId: string | null;
  promptInsertion?: { id: number; text: string; widgetId?: string | null } | null;
  selectedWidgetId?: string | null;
  workingWidgetId?: string | null;
  widgets: DashboardRuntimeWidget[];
};

export type DashboardWidgetColorSlotFocus = {
  slotIndex: number;
  widgetId: string;
};
