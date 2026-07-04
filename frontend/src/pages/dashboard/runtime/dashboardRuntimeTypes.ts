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
