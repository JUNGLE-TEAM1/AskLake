import type { CatalogDataset } from "../types";
import { apiClient, apiConfig } from "./apiClient";

type QueryAiPreflightMessage = {
  text: string;
  tone: "success" | "info" | "warning" | "error";
};

export type QueryAiMode = "draft_sql";

export type QueryAiRequest = {
  baseDataset: CatalogDataset;
  mode: QueryAiMode;
  preflightMessages: QueryAiPreflightMessage[];
  prompt: string;
  query: string;
  selectedDatasets: CatalogDataset[];
};

export type QueryAiSuggestion = {
  body: string;
  mode: QueryAiMode;
  model?: string | null;
  notices: string[];
  sql?: string;
  title: string;
};

const PREVIEW_LIMIT = 100;

export async function generateQueryAiSuggestion(request: QueryAiRequest): Promise<QueryAiSuggestion> {
  if (!apiConfig.useMock) {
    return apiClient.post<QueryAiSuggestion>("/api/query/ai-suggestions", {
      baseDatasetId: request.baseDataset.id,
      currentQuery: request.query,
      mode: request.mode,
      prompt: request.prompt,
      selectedDatasetIds: request.selectedDatasets.map((dataset) => dataset.id),
    });
  }

  await new Promise((resolve) => window.setTimeout(resolve, 180));
  return draftSql(request);
}

function draftSql({ baseDataset, prompt }: QueryAiRequest): QueryAiSuggestion {
  const intent = normalizeText(prompt);
  const dimensionColumn = pickDimensionColumn(baseDataset, intent);
  const metricColumn = pickMetricColumn(baseDataset, intent);
  const wantsCount = /건수|몇\s*개|count|개수|수량/.test(intent);
  const wantsAverage = /평균|avg|average/.test(intent);
  const wantsMax = /최대|max|highest|상위/.test(intent);

  if (dimensionColumn && metricColumn && !wantsCount) {
    const metricExpression = wantsAverage
      ? `AVG(${metricColumn.name})`
      : wantsMax
        ? `MAX(${metricColumn.name})`
        : `SUM(${metricColumn.name})`;
    const metricAlias = wantsAverage ? `avg_${metricColumn.name}` : wantsMax ? `max_${metricColumn.name}` : `total_${metricColumn.name}`;
    const sql = [
      `SELECT ${dimensionColumn.name},`,
      `       ${metricExpression} AS ${metricAlias}`,
      `FROM ${baseDataset.name}`,
      `GROUP BY ${dimensionColumn.name}`,
      `ORDER BY ${metricAlias} DESC`,
      `LIMIT ${PREVIEW_LIMIT};`,
    ].join("\n");

    return {
      body: `${baseDataset.name}에서 ${dimensionColumn.name} 기준으로 ${metricColumn.name}을 집계하는 읽기 전용 SQL 초안입니다.`,
      mode: "draft_sql",
      notices: [
        "선택되지 않은 테이블은 사용하지 않았습니다.",
        "바로 실행하지 않고 편집기에 적용한 뒤 기존 점검을 다시 통과해야 합니다.",
      ],
      sql,
      title: "집계 SQL 초안",
    };
  }

  if (dimensionColumn && wantsCount) {
    const sql = [
      `SELECT ${dimensionColumn.name},`,
      "       COUNT(*) AS row_count",
      `FROM ${baseDataset.name}`,
      `GROUP BY ${dimensionColumn.name}`,
      "ORDER BY row_count DESC",
      `LIMIT ${PREVIEW_LIMIT};`,
    ].join("\n");

    return {
      body: `${baseDataset.name}에서 ${dimensionColumn.name}별 행 수를 확인하는 SQL 초안입니다.`,
      mode: "draft_sql",
      notices: [
        "COUNT 기반 초안이라 실제 지표 정의와 다를 수 있습니다.",
        "필요하면 WHERE 조건을 추가한 뒤 실행해 주세요.",
      ],
      sql,
      title: "건수 집계 SQL 초안",
    };
  }

  const columns = baseDataset.schema.slice(0, 4).map(([name]) => name);
  const sql = [
    `SELECT ${columns.length > 0 ? columns.join(", ") : "*"}`,
    `FROM ${baseDataset.name}`,
    `LIMIT ${PREVIEW_LIMIT};`,
  ].join("\n");

  return {
    body: `${baseDataset.name}의 주요 컬럼을 먼저 확인하는 기본 조회 SQL 초안입니다.`,
    mode: "draft_sql",
    notices: [
      "질문 의도가 명확하지 않아 안전한 기본 조회 형태로 제안했습니다.",
      "필요한 컬럼이나 조건을 추가한 뒤 실행해 주세요.",
    ],
    sql,
    title: "기본 조회 SQL 초안",
  };
}

function pickDimensionColumn(dataset: CatalogDataset, intent: string) {
  const targetedPatterns = [
    [/고객|customer|사용자|user/, /customer_id|user_id|customer|user/],
    [/상품|product|sku|카테고리|category/, /product_id|sku|category|product/],
    [/날짜|일별|월별|date|day|month|시간|time/, /date|day|month|time|created_at|event_time/],
    [/상태|status/, /status/],
    [/지역|region/, /region/],
  ] as const;

  const targetedPattern = targetedPatterns.find(([intentPattern]) => intentPattern.test(intent))?.[1];
  if (targetedPattern) {
    const targetedColumn = dataset.schema.find(([name]) => targetedPattern.test(name.toLowerCase()));
    if (targetedColumn) return toColumn(targetedColumn);
  }

  const fallback = dataset.schema.find(([name, type]) => {
    const lowerName = name.toLowerCase();
    const lowerType = type.toLowerCase();
    return /id|date|time|category|status|region|type|segment/.test(lowerName) || /string|date|timestamp/.test(lowerType);
  });

  return fallback ? toColumn(fallback) : null;
}

function pickMetricColumn(dataset: CatalogDataset, intent: string) {
  const targetedPatterns = [
    [/금액|매출|revenue|amount|sales|구매/, /amount|revenue|sales|price|total/],
    [/수량|재고|quantity|stock/, /quantity|stock|count/],
    [/점수|score|위험|risk/, /score|risk/],
    [/가치|value/, /value/],
  ] as const;

  const targetedPattern = targetedPatterns.find(([intentPattern]) => intentPattern.test(intent))?.[1];
  if (targetedPattern) {
    const targetedColumn = dataset.schema.find(([name]) => targetedPattern.test(name.toLowerCase()));
    if (targetedColumn) return toColumn(targetedColumn);
  }

  const fallback = dataset.schema.find(([name, type]) => {
    const lowerName = name.toLowerCase();
    const lowerType = type.toLowerCase();
    return /amount|price|total|score|value|quantity|count|sales|revenue/.test(lowerName)
      || /int|decimal|double|float|numeric|number/.test(lowerType);
  });

  return fallback ? toColumn(fallback) : null;
}

function toColumn([name, type]: [string, string]) {
  return { name, type };
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}
