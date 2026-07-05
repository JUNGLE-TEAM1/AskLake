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
};

export type CreateDraftWidgetFormInput = {
  config: DashboardRuntimeWidgetConfig;
  datasetId: string;
  title: string;
  type: DashboardRuntimeWidgetType;
};
