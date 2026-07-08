export type DashboardRuntimeMode = "published" | "draft";
export type DashboardView = "list" | "builder" | "detail" | "runtime";
export type DashboardStatus = "draft" | "published";
export type DashboardWidgetType = "kpi" | "bar" | "line" | "donut" | "table";
export type DashboardRuntimeWidgetType =
  | "metric"
  | "table"
  | "bar_chart"
  | "line_chart"
  | "area_chart"
  | "donut_chart"
  | "pie_chart"
  | "radial_bar_chart"
  | "heatmap_chart"
  | "treemap_chart";
export type DashboardWidgetAggregation = "sum" | "avg" | "count" | "min" | "max";
export type DashboardWidgetDateUnit = "day" | "month" | "year";
export type DashboardWidgetFormat = "number" | "currency" | "percent";
export type DashboardWidgetLineCurve = "smooth" | "straight" | "stepline";
export type DashboardWidgetOrientation = "vertical" | "horizontal";
export type DashboardWidgetSortDirection = "asc" | "desc";
export type DashboardSortOption = "name-asc" | "name-desc" | "updated-asc" | "updated-desc" | "created-asc" | "created-desc";
export type DashboardWidgetPlaceholderKind = "visualization_request" | "text";

export type DashboardWidgetColorConfig = {
  colors: string[];
};

export type DashboardWidgetConfigBase = {
  body?: string;
  description?: string;
  error?: string;
  errorMessage?: string;
  placeholderKind?: DashboardWidgetPlaceholderKind;
  prompt?: string;
};

export type MetricWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
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
  color: DashboardWidgetColorConfig;
  groupKey?: string;
  orientation?: DashboardWidgetOrientation;
  xKey: string;
  yKey: string;
};

export type LineChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  curve?: DashboardWidgetLineCurve;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  xKey: string;
  yKey: string;
};

export type AreaChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  dateUnit?: DashboardWidgetDateUnit;
  seriesKey?: string;
  stacked?: boolean;
  xKey: string;
  yKey: string;
};

export type DonutChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  centerLabel?: string;
  labelKey: string;
  valueKey: string;
};

export type PieChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

export type RadialBarChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  format?: DashboardWidgetFormat;
  labelKey?: string;
  max?: number;
  min?: number;
  valueKey: string;
};

export type HeatmapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  valueKey: string;
  xKey: string;
  yKey: string;
};

export type TreemapChartWidgetConfig = DashboardWidgetConfigBase & {
  aggregation: DashboardWidgetAggregation;
  color: DashboardWidgetColorConfig;
  labelKey: string;
  valueKey: string;
};

export type DashboardRuntimeWidgetConfigByType = {
  area_chart: AreaChartWidgetConfig;
  bar_chart: BarChartWidgetConfig;
  donut_chart: DonutChartWidgetConfig;
  heatmap_chart: HeatmapChartWidgetConfig;
  line_chart: LineChartWidgetConfig;
  metric: MetricWidgetConfig;
  pie_chart: PieChartWidgetConfig;
  radial_bar_chart: RadialBarChartWidgetConfig;
  table: TableWidgetConfig;
  treemap_chart: TreemapChartWidgetConfig;
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
  baseDatasetId?: string;
  dashboardId?: string;
  runtimeMode?: DashboardRuntimeMode;
  sqlResultDatasetId?: string;
  sqlRunId?: string;
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
