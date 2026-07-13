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
    : "Sales Analytics Demo 2026-06-26 22:04:05";

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
        ["Rows", String(activeSqlResult?.rowCount ?? dataset.sampleRows.length)],
        ["Sort", `${primaryColumn} ASC`],
      ],
    },
  };

  return {
    barSeries: [62, 84, 71, 96, 78, 88, 104],
    categorySales: [
      ["전자제품", 124500],
      ["의류", 93375],
      ["식료품", 62250],
      ["가구", 31125],
      ["취미용품", 68500],
    ],
    channelRows: [
      ["Mobile", "62,140", "₩3.9억", "48.4%"],
      ["Web", "41,880", "₩2.7억", "32.6%"],
      ["Partner", "24,400", "₩1.6억", "19.0%"],
    ],
    columns,
    dashboardId: `dash_${dataset.id}_${activeSqlResult?.runId ?? "draft"}`,
    dashboardTitle,
    metricCards: [
      ["총 주문", "128,420", "+12.4%", "SQL 결과 기준"],
      ["매출", "₩8.2억", "+8.1%", "집계 mart 반영"],
      ["전환율", "4.8%", "-0.3%", "모바일 유입 감소"],
      ["품질 점수", dataset.quality, "안정", dataset.lastUpdated],
    ],
    rowsPreview: activeSqlResult?.rows.length ? activeSqlResult.rows : dataset.sampleRows,
    snapshotWidgets: builderWidgets.length
      ? builderWidgets
      : activeSqlResult
        ? ["table", "bar"]
        : ["bar", "line", "donut", "table"],
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
