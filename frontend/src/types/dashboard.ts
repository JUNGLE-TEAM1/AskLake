export type DashboardView = "list" | "builder" | "detail";
export type DashboardStatus = "draft" | "published";
export type DashboardWidgetType = "kpi" | "bar" | "line" | "donut" | "table";
export type DashboardSortOption = "name-asc" | "name-desc" | "updated-asc" | "updated-desc" | "created-asc" | "created-desc";

export type SavedDashboardCard = {
  datasetId?: string;
  id: string;
  meta: string;
  name: string;
  owner: string;
  createdAt?: string;
  createdAtValue?: string;
  sourceRunId?: string;
  sqlResult?: {
    columns: string[];
    query: string;
    rowCount: number;
    runId: string;
  };
  status: DashboardStatus;
  tags: string;
  updated: string;
  updatedAtValue?: string;
  widgets?: DashboardWidgetType[];
};

export type DashboardListQuery = {
  owner?: string;
  page: number;
  pageSize: number;
  search?: string;
  sort: DashboardSortOption;
  tags?: string[];
};

export type DashboardListFilterOptions = {
  owners: string[];
  tags: string[];
};

export type DashboardListResponse = {
  filterOptions: DashboardListFilterOptions;
  items: SavedDashboardCard[];
  page: number;
  pageSize: number;
  total: number;
};

export type DashboardEntry = {
  source: "sidebar" | "sql" | "catalog" | "internal";
  view: DashboardView;
  version: number;
};
