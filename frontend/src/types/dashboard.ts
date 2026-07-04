export type DashboardView = "list" | "builder" | "detail";
export type DashboardWidgetType = "kpi" | "bar" | "line" | "donut" | "table";

export type DashboardEntry = {
  source: "sidebar" | "sql" | "catalog" | "internal";
  view: DashboardView;
  version: number;
};

