import type { DashboardRuntimeWidgetType } from "../../../types";

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
  color: string;
  datasetId: string;
  description?: string;
  title: string;
  type: DashboardRuntimeWidgetType;
  xKey: string;
  yKey: string;
};
