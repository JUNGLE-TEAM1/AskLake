export type DashboardRuntimeMode = "published" | "draft";
export type DashboardView = "list" | "builder" | "detail" | "runtime";
export type DashboardStatus = "draft" | "published";
export type DashboardWidgetType = "kpi" | "bar" | "line" | "donut" | "table";
export type DashboardRuntimeWidgetType = "metric" | "bar_chart" | "line_chart" | "donut_chart" | "table";
export type DashboardWidgetAggregation = "sum" | "avg" | "count" | "min" | "max";
export type DashboardWidgetDateUnit = "day" | "month" | "year";
export type DashboardWidgetFormat = "number" | "currency" | "percent";
export type DashboardWidgetSortDirection = "asc" | "desc";
export type DashboardSortOption = "name-asc" | "name-desc" | "updated-asc" | "updated-desc" | "created-asc" | "created-desc";
export type DashboardWidgetPlaceholderKind = "visualization_request" | "text";

export type DashboardWidgetConfigBase = {
  body?: string;
  color?: string;
  description?: string;
  error?: string;
  errorMessage?: string;
  placeholderKind?: DashboardWidgetPlaceholderKind;
  prompt?: string;
};

export type MetricWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  format?: DashboardWidgetFormat;
  valueKey: string;
};

export type TableWidgetConfig = DashboardWidgetConfigBase & {
  columns: string[];
  limit?: number;
  sortDirection?: DashboardWidgetSortDirection;
  sortKey?: string;
};

export type BarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  groupKey?: string;
  xKey: string;
  yKey: string;
};

export type LineChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  xKey: string;
  yKey: string;
};

export type DonutChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: string;
  labelKey: string;
  valueKey: string;
};

export type DashboardRuntimeWidgetConfigByType = {
  bar_chart: BarChartWidgetConfig;
  donut_chart: DonutChartWidgetConfig;
  line_chart: LineChartWidgetConfig;
  metric: MetricWidgetConfig;
  table: TableWidgetConfig;
};

export type DashboardRuntimeWidgetConfig = DashboardRuntimeWidgetConfigByType[DashboardRuntimeWidgetType];

export type SavedDashboardCard = {
  datasetId?: string;
  id: string;
  hasPublishedRevision?: boolean;
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
  dashboardId?: string;
  runtimeMode?: DashboardRuntimeMode;
  source: "sidebar" | "sql" | "catalog" | "internal";
  view: DashboardView;
  version: number;
};

export type DashboardMeta = {
  hasPublishedRevision: boolean;
  id: string;
  status: DashboardStatus;
  title: string;
  updatedAt: string;
};

export type DashboardRevision = {
  id: string;
  kind: DashboardRuntimeMode;
  publishedAt?: string | null;
  version: number;
};

export type DashboardRuntimePage = {
  id: string;
  orderIndex: number;
  title: string;
};

export type DashboardWidgetLayout = {
  h: number;
  minH?: number;
  minW?: number;
  w: number;
  x: number;
  y: number;
};

type DashboardRuntimeWidgetBase = {
  data: Array<Record<string, unknown>>;
  datasetId?: string | null;
  id: string;
  layout: DashboardWidgetLayout;
  pageId: string;
  queryId?: string | null;
  title: string | null;
};

export type DashboardRuntimeWidget = {
  [Type in DashboardRuntimeWidgetType]: DashboardRuntimeWidgetBase & {
    config: DashboardRuntimeWidgetConfigByType[Type];
    type: Type;
  };
}[DashboardRuntimeWidgetType];

export type DashboardFilter = {
  id: string;
  label: string;
  value: unknown;
};

export type DashboardRuntimeResponse = {
  dashboard: DashboardMeta;
  filters: DashboardFilter[];
  mode: DashboardRuntimeMode;
  pages: DashboardRuntimePage[];
  revision: DashboardRevision | null;
  widgetsByPageId: Record<string, DashboardRuntimeWidget[]>;
};
