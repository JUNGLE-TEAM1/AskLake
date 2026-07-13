import type {
  CatalogDataset,
  DashboardWidgetType,
  SqlResultDraft,
} from "../../../types";

export type DashboardLegacyWidgetOption = {
  desc: string;
  id: DashboardWidgetType;
  label: string;
};

export type DashboardLegacyWidgetConfig = Record<
  DashboardWidgetType,
  { fields: Array<[string, string]>; title: string }
>;

export type DashboardLegacyModel = {
  hasRealResult: boolean;
  barSeries: number[];
  categorySales: Array<[string, number]>;
  channelRows: Array<[string, string, string, string]>;
  columns: string[];
  dashboardId: string;
  dashboardTitle: string;
  metricCards: Array<[string, string, string, string]>;
  rowsPreview: string[][];
  snapshotWidgets: DashboardWidgetType[];
  sourceRunId?: string;
  sqlResultSnapshot?: {
    columns: string[];
    query: string;
    rowCount: number;
    runId: string;
  };
  widgetConfig: DashboardLegacyWidgetConfig;
  widgetTypes: DashboardLegacyWidgetOption[];
};

export function createDashboardLegacyModel({
  activeSqlResult,
  builderWidgets,
  dataset,
}: {
  activeSqlResult: SqlResultDraft | null;
  builderWidgets: DashboardWidgetType[];
  dataset: CatalogDataset;
}): DashboardLegacyModel {
  const columns = activeSqlResult?.columns.length
    ? activeSqlResult.columns
    : dataset.schema.slice(0, 5).map(([column]) => column);
  const primaryColumn = columns[0] ?? "id";
  const secondaryColumn = columns[1] ?? primaryColumn;
  const metricColumn = columns[2] ?? secondaryColumn;
  const sourceRunId = activeSqlResult?.runId;
  const dashboardTitle = activeSqlResult
    ? `${activeSqlResult.datasetName} SQL Result Dashboard`
    : `${dataset.name} Dashboard`;

  const widgetTypes: DashboardLegacyWidgetOption[] = [
    { id: "kpi", label: "KPI", desc: "핵심 수치 카드" },
    { id: "bar", label: "막대 차트", desc: "카테고리 비교" },
    { id: "line", label: "라인 차트", desc: "시간 추이" },
    { id: "donut", label: "도넛 차트", desc: "비중 분포" },
    { id: "table", label: "결과 테이블", desc: "행 데이터" },
  ];
  const widgetConfig: DashboardLegacyWidgetConfig = {
    kpi: {
      title: `${metricColumn} KPI`,
      fields: [["Metric", metricColumn], ["Aggregation", "COUNT"], ["Format", "Number"]],
    },
    bar: {
      title: `${secondaryColumn}별 ${metricColumn}`,
      fields: [["X축", secondaryColumn], ["Y축", metricColumn], ["집계", "SUM"]],
    },
    line: {
      title: `${primaryColumn} 추이`,
      fields: [["X축", primaryColumn], ["Y축", metricColumn], ["Granularity", "Auto"]],
    },
    donut: {
      title: `${secondaryColumn} 비중`,
      fields: [["Dimension", secondaryColumn], ["Metric", metricColumn], ["Aggregation", "SUM"]],
    },
    table: {
      title: "SQL 결과 테이블",
      fields: [
        ["Columns", columns.slice(0, 4).join(", ")],
         ["Rows", activeSqlResult ? String(activeSqlResult.rowCount) : "-"],
        ["Sort", `${primaryColumn} ASC`],
      ],
    },
  };

  return {
    hasRealResult: Boolean(activeSqlResult),
    barSeries: [],
    categorySales: [],
    channelRows: [],
    columns,
    dashboardId: `dash_${dataset.id}_${activeSqlResult?.runId ?? "draft"}`,
    dashboardTitle,
    metricCards: [],
    rowsPreview: activeSqlResult?.rows ?? [],
    snapshotWidgets: builderWidgets.length
      ? builderWidgets
      : activeSqlResult
        ? ["table", "bar"]
      : [],
    sourceRunId,
    sqlResultSnapshot: activeSqlResult
      ? {
        columns: activeSqlResult.columns,
        query: activeSqlResult.query,
        rowCount: activeSqlResult.rowCount,
        runId: activeSqlResult.runId,
      }
      : undefined,
    widgetConfig,
    widgetTypes,
  };
}
