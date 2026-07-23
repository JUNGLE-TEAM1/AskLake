import type { DashboardRuntimeWidgetType } from "../../../types";

export type DashboardWidgetColumnKind = "any" | "dimension" | "numeric" | "time";
export type DashboardWidgetColumnRole = "label" | "series" | "value" | "x" | "y";
export type DashboardWidgetColorMode = "multi" | "range" | "series" | "single";

export type DashboardWidgetColumnRequirement = {
  helperText: string;
  kind: DashboardWidgetColumnKind;
  label: string;
  required: boolean;
  role: DashboardWidgetColumnRole;
};

export type DashboardWidgetAiHints = {
  avoidWhen: string[];
  goodFor: string[];
  promptExamples: string[];
};

export type DashboardWidgetDefinition = {
  aiHints: DashboardWidgetAiHints;
  colorMode: DashboardWidgetColorMode;
  columnRequirements: DashboardWidgetColumnRequirement[];
  defaultAggregation?: "sum" | "avg" | "count" | "min" | "max";
  description: string;
  label: string;
  type: DashboardRuntimeWidgetType;
};

export type DashboardWidgetColorPalette = {
  colors: string[];
  label: string;
};

export const dashboardWidgetColorChoices = [
  "#db1b62",
  "#f0140a",
  "#ff5722",
  "#f59e0b",
  "#cbd532",
  "#058b4f",
  "#0ca6a0",
  "#0ea5e9",
  "#3b82f6",
  "#4357b8",
  "#8e24aa",
];

export const defaultWidgetColorConfig = {
  colors: ["#2563eb"],
};

export const dashboardWidgetDefinitions: Record<DashboardRuntimeWidgetType, DashboardWidgetDefinition> = {
  area_chart: {
    aiHints: {
      avoidWhen: ["many overlapping series", "unordered categories"],
      goodFor: ["trend", "volume", "cumulative amount"],
      promptExamples: ["시간별 클릭 수를 면적으로 보여줘", "일자별 주문량 변화를 강조해줘"],
    },
    colorMode: "series",
    columnRequirements: [
      { helperText: "시간 또는 순서가 있는 컬럼을 권장합니다.", kind: "dimension", label: "X축", required: true, role: "x" },
      { helperText: "면적으로 강조할 숫자 컬럼입니다.", kind: "numeric", label: "Y축", required: true, role: "y" },
      { helperText: "여러 영역으로 나눌 때 사용합니다.", kind: "dimension", label: "시리즈", required: false, role: "series" },
    ],
    defaultAggregation: "sum",
    description: "시간 흐름이나 누적 규모를 면적으로 강조합니다.",
    label: "영역 차트",
    type: "area_chart",
  },
  bar_chart: {
    aiHints: {
      avoidWhen: ["time-series trend as primary goal"],
      goodFor: ["comparison", "ranking", "category summary"],
      promptExamples: ["카테고리별 매출을 비교해줘", "지역별 주문 수를 막대로 보여줘"],
    },
    colorMode: "series",
    columnRequirements: [
      { helperText: "세로 막대의 X축, 가로 막대의 Y축에 표시할 분류 컬럼입니다.", kind: "dimension", label: "분류", required: true, role: "x" },
      { helperText: "세로 막대의 Y축, 가로 막대의 X축에서 막대 길이를 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "y" },
      { helperText: "막대를 그룹으로 나눌 때 사용합니다.", kind: "dimension", label: "그룹", required: false, role: "series" },
    ],
    defaultAggregation: "sum",
    description: "카테고리별 값을 비교합니다.",
    label: "막대 차트",
    type: "bar_chart",
  },
  donut_chart: {
    aiHints: {
      avoidWhen: ["more than 6 categories", "precise value comparison"],
      goodFor: ["part-to-whole", "ratio", "share"],
      promptExamples: ["카테고리별 매출 비중을 도넛으로 보여줘", "상태별 주문 비율을 보여줘"],
    },
    colorMode: "multi",
    columnRequirements: [
      { helperText: "조각 이름으로 표시할 컬럼입니다.", kind: "dimension", label: "분류", required: true, role: "label" },
      { helperText: "조각 크기로 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
    ],
    defaultAggregation: "sum",
    description: "전체 중 각 분류가 차지하는 비중을 보여줍니다.",
    label: "도넛 차트",
    type: "donut_chart",
  },
  heatmap_chart: {
    aiHints: {
      avoidWhen: ["single dimension summary", "very sparse matrix"],
      goodFor: ["matrix", "intensity", "two-dimensional comparison"],
      promptExamples: ["요일과 시간대별 주문 강도를 보여줘", "지역과 카테고리별 매출 밀도를 보여줘"],
    },
    colorMode: "range",
    columnRequirements: [
      { helperText: "가로축으로 사용할 분류 컬럼입니다.", kind: "dimension", label: "X축", required: true, role: "x" },
      { helperText: "세로축으로 사용할 분류 컬럼입니다.", kind: "dimension", label: "Y축", required: true, role: "y" },
      { helperText: "색상 강도로 표시할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
    ],
    defaultAggregation: "sum",
    description: "두 기준의 조합별 값의 강도를 색상으로 보여줍니다.",
    label: "히트맵",
    type: "heatmap_chart",
  },
  line_chart: {
    aiHints: {
      avoidWhen: ["unordered categories", "part-to-whole ratio"],
      goodFor: ["trend", "time-series", "change"],
      promptExamples: ["분 단위 클릭 수 추이를 보여줘", "시간별 활성 사용자 변화를 보여줘"],
    },
    colorMode: "series",
    columnRequirements: [
      { helperText: "시간 또는 순서가 있는 컬럼을 권장합니다.", kind: "dimension", label: "X축", required: true, role: "x" },
      { helperText: "선으로 이어 표시할 숫자 컬럼입니다.", kind: "numeric", label: "Y축", required: true, role: "y" },
      { helperText: "여러 선으로 나눌 때 사용합니다.", kind: "dimension", label: "시리즈", required: false, role: "series" },
    ],
    defaultAggregation: "sum",
    description: "시간 흐름이나 순서에 따른 변화를 보여줍니다.",
    label: "라인 차트",
    type: "line_chart",
  },
  metric: {
    aiHints: {
      avoidWhen: ["category comparison", "trend over time"],
      goodFor: ["single KPI", "summary number", "headline metric"],
      promptExamples: ["총 매출 하나만 크게 보여줘", "평균 주문 금액을 지표로 보여줘"],
    },
    colorMode: "single",
    columnRequirements: [
      { helperText: "지표로 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
    ],
    defaultAggregation: "sum",
    description: "하나의 핵심 숫자를 크게 보여줍니다.",
    label: "지표",
    type: "metric",
  },
  pie_chart: {
    aiHints: {
      avoidWhen: ["more than 5 categories", "many similar values"],
      goodFor: ["part-to-whole", "simple ratio", "share"],
      promptExamples: ["결제 수단별 비율을 파이로 보여줘", "상위 카테고리 점유율을 보여줘"],
    },
    colorMode: "multi",
    columnRequirements: [
      { helperText: "조각 이름으로 표시할 컬럼입니다.", kind: "dimension", label: "분류", required: true, role: "label" },
      { helperText: "조각 크기로 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
    ],
    defaultAggregation: "sum",
    description: "전체 대비 단순 비율을 원형으로 보여줍니다.",
    label: "파이 차트",
    type: "pie_chart",
  },
  radial_bar_chart: {
    aiHints: {
      avoidWhen: ["raw category comparison with many categories"],
      goodFor: ["progress", "goal achievement", "score"],
      promptExamples: ["목표 대비 달성률을 보여줘", "품질 점수를 원형 게이지로 보여줘"],
    },
    colorMode: "single",
    columnRequirements: [
      { helperText: "달성률이나 점수로 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
      { helperText: "여러 링 이름으로 사용할 수 있습니다.", kind: "dimension", label: "분류", required: false, role: "label" },
    ],
    defaultAggregation: "avg",
    description: "진행률이나 점수를 원형 막대로 보여줍니다.",
    label: "방사형 차트",
    type: "radial_bar_chart",
  },
  table: {
    aiHints: {
      avoidWhen: ["quick visual comparison", "single KPI only"],
      goodFor: ["raw rows", "record inspection", "detail view"],
      promptExamples: ["원본 데이터를 표로 보여줘", "상위 주문 목록을 테이블로 보여줘"],
    },
    colorMode: "single",
    columnRequirements: [
      { helperText: "표에 표시할 컬럼입니다.", kind: "any", label: "컬럼", required: true, role: "value" },
    ],
    description: "행 데이터를 표 형태로 보여줍니다.",
    label: "테이블",
    type: "table",
  },
  treemap_chart: {
    aiHints: {
      avoidWhen: ["exact trend over time", "negative values"],
      goodFor: ["many category shares", "space-efficient comparison", "part-to-whole"],
      promptExamples: ["상품군별 매출 비중을 트리맵으로 보여줘", "카테고리 기여도를 사각형으로 보여줘"],
    },
    colorMode: "multi",
    columnRequirements: [
      { helperText: "사각형 이름으로 표시할 컬럼입니다.", kind: "dimension", label: "분류", required: true, role: "label" },
      { helperText: "사각형 크기로 계산할 숫자 컬럼입니다.", kind: "numeric", label: "값", required: true, role: "value" },
    ],
    defaultAggregation: "sum",
    description: "여러 카테고리의 비중을 사각형 크기로 보여줍니다.",
    label: "트리맵",
    type: "treemap_chart",
  },
};

export const dashboardWidgetTypeOptions = Object.values(dashboardWidgetDefinitions).map((definition) => ({
  label: definition.label,
  value: definition.type,
}));
