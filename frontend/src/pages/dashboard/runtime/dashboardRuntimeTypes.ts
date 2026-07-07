import type { DashboardRuntimeWidgetConfig, DashboardRuntimeWidgetType } from "../../../types";

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
  rows?: Array<Record<string, unknown>>;
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
  datasetId?: string | null;
  title: string;
  type: DashboardRuntimeWidgetType;
};
